// extract-district-calendar: takes a PDF district calendar (uploaded as
// base64, or as a URL we fetch) and asks Claude to extract the structured
// no-school + early-release date list that the admin can review before
// saving to district_calendars.
//
// Input:
//   {
//     organization_id: string, // the org this calendar is being extracted for
//     url?: string,           // PDF URL (will be fetched server-side)
//     pdf_base64?: string,    // PDF bytes as base64 (data: prefix allowed)
//     filename?: string,      // optional hint for prompts/logs
//     school_year_hint?: string, // optional, e.g. "2026-2027"
//   }
//
// Output:
//   {
//     school_year: string | null,
//     first_day_of_school: string | null,
//     last_day_of_school: string | null,
//     no_school_dates: [{ date: string, reason: string }],
//     early_release_dates: [{ date: string, reason: string }],
//     model_notes: string | null,
//   }
//
// Auth: caller must be owner/admin of the specified organization_id (mirrors
// import-partners-extract). No tenant DB reads or writes; UI persists after
// review. The org gate scopes the call to the target tenant.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB. Anthropic doc limit is 32 MB.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You extract structured school calendar data from district calendar PDFs. PDFs vary in layout (month grids, legends with color keys, side annotations). Read the PDF visually — colors, legends, callouts — and produce structured JSON.

Return ONLY valid JSON in this exact shape (no markdown, no commentary):
{
  "school_year": "YYYY-YYYY" | null,
  "first_day_of_school": "YYYY-MM-DD" | null,
  "last_day_of_school": "YYYY-MM-DD" | null,
  "no_school_dates": [
    { "date": "YYYY-MM-DD", "reason": "exact label from the calendar" }
  ],
  "early_release_dates": [
    { "date": "YYYY-MM-DD", "reason": "exact label from the calendar" }
  ],
  "model_notes": "string or null"
}

Rules:
1. Include EVERY weekday during the school year when students do not attend full classes.
2. Categorize each closure:
   - Full closure (students do not attend): "no school", "schools closed", "non-contract day", "teacher in-service", "PD day", "grade prep", "holiday", "winter break", "spring break", "conferences" with no student attendance, family connections/transitions days where students don't attend → no_school_dates
   - Shorter day (students attend, just dismissed early): "early release", "early dismissal", "half day" → early_release_dates
3. A date may appear in EITHER no_school_dates OR early_release_dates, never both. If both could apply (e.g., last day is early release AND end of year), the more restrictive category wins — no-school > early-release.
4. End-of-quarter / end-of-semester markers alone do NOT mean no school. Only include if the date is also marked no-school.
5. Use the calendar's legend to interpret colors and codes. Read the legend carefully — different colors can mean different things in the same calendar (e.g., pink = no school, yellow = family conference no-school, gray = early release).
6. For multi-day breaks (winter break, spring break), enumerate each weekday individually. Skip Saturdays and Sundays.
7. Do not include weekends, summer break, or any date outside the school year.
8. Teacher-only / PD days BEFORE the first day of school or AFTER the last day are not relevant — skip them.
9. The "reason" field MUST quote the calendar's exact label text where readable ("Thanksgiving", "MLK Day", "Winter Break", "Teacher Grade Prep", "Family Conferences"). This lets the admin cross-reference each date against the PDF at a glance. Keep under 40 chars. Do NOT paraphrase, summarize, or invent a label — if the calendar says "Non-Contract Day," write "Non-Contract Day," not "Staff day off."
10. If the school year is not stated explicitly on the calendar, derive it from the dates (Fall start year + next year, e.g., "2026-2027"). If you cannot determine it confidently, return null.
11. All dates ISO 8601 (YYYY-MM-DD) with explicit year. Do not guess years.
12. **WHEN UNSURE, OMIT.** It is far better to miss one closure the admin can add manually than to invent one. If you cannot read a cell, cannot tell whether a marking means no-school vs. early-release, or cannot determine the year, leave that date out of the structured output and flag it in model_notes.

model_notes usage:
- Use ONLY for ambiguity the admin must resolve. Examples of good notes: "March 15 cell is illegible — please verify," "Aug 26 may apply only to grades K, 8, 10-12 — calendar marks it as Family Connections," "Two colors overlap on Oct 9 — could be no-school or early-release."
- DO NOT use model_notes to narrate your reasoning, restate facts already in the structured output, explain why you excluded weekends/summer, or describe the calendar layout. If there is nothing genuinely ambiguous, return null.

Return ONLY the JSON object, starting with { and ending with }.`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.split(",", 2)[1] : b64;
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

const URL_FETCH_TIMEOUT_MS = 30_000;

async function fetchUrlAsPdfBytes(
  url: string,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: number; message: string }
> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Enrops-Calendar-Extractor/1.0" },
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      return {
        ok: false,
        status: 400,
        message: `That URL took longer than ${URL_FETCH_TIMEOUT_MS / 1000}s to respond. Try downloading the PDF and uploading it directly.`,
      };
    }
    return { ok: false, status: 400, message: `Could not fetch URL: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    return { ok: false, status: 400, message: `Fetch returned ${resp.status} ${resp.statusText}` };
  }

  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
    return {
      ok: false,
      status: 400,
      message:
        "This URL looks like a webpage, not a PDF. Find the PDF calendar link on the district's page (often labeled \"download\" or \"printable calendar\") and paste that URL instead.",
    };
  }

  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length === 0) return { ok: false, status: 400, message: "Fetched file is empty." };
  if (bytes.length > MAX_PDF_BYTES) {
    return { ok: false, status: 400, message: `PDF is too large (${(bytes.length / 1024 / 1024).toFixed(1)} MB). Max ${MAX_PDF_BYTES / 1024 / 1024} MB.` };
  }

  // Sanity check: PDFs start with "%PDF-"
  const head = String.fromCharCode(...bytes.slice(0, 5));
  if (!head.startsWith("%PDF")) {
    return { ok: false, status: 400, message: "Downloaded file is not a PDF (header check failed)." };
  }

  return { ok: true, bytes };
}

type ExtractedShape = {
  school_year?: string | null;
  first_day_of_school?: string | null;
  last_day_of_school?: string | null;
  no_school_dates?: Array<{ date?: string; reason?: string }>;
  early_release_dates?: Array<{ date?: string; reason?: string }>;
  model_notes?: string | null;
};

function sanitizeDateList(
  list: Array<{ date?: string; reason?: string }> | undefined,
): Array<{ date: string; reason: string }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ date: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const item of list) {
    const date = typeof item?.date === "string" ? item.date.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    const reason = typeof item?.reason === "string" ? item.reason.trim().slice(0, 80) : "";
    out.push({ date, reason });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = (await req.json()) as {
      organization_id?: string;
      url?: string;
      pdf_base64?: string;
      filename?: string;
      school_year_hint?: string;
    };

    const organizationId = body.organization_id ?? "";
    if (!organizationId) return json({ error: "organization_id is required." }, 400);
    if (!body.url && !body.pdf_base64) {
      return json({ error: "Provide either url or pdf_base64." }, 400);
    }

    // Auth: owner/admin of THIS organization
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Authorization required." }, 401);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData?.user) return json({ error: "Invalid session." }, 401);
    const { data: memberships } = await supabase
      .from("org_members")
      .select("role")
      .eq("auth_user_id", userData.user.id)
      .eq("organization_id", organizationId)
      .in("role", ["owner", "admin"]);
    if (!memberships || memberships.length === 0) {
      return json({ error: "Forbidden." }, 403);
    }

    // Resolve PDF bytes
    let pdfBytes: Uint8Array;
    if (body.url) {
      const result = await fetchUrlAsPdfBytes(body.url);
      if (!result.ok) return json({ error: result.message }, result.status);
      pdfBytes = result.bytes;
    } else {
      try {
        pdfBytes = base64ToBytes(body.pdf_base64!);
      } catch {
        return json({ error: "pdf_base64 is not valid base64." }, 400);
      }
      if (pdfBytes.length === 0) return json({ error: "PDF is empty." }, 400);
      if (pdfBytes.length > MAX_PDF_BYTES) {
        return json(
          { error: `PDF is too large (${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB). Max ${MAX_PDF_BYTES / 1024 / 1024} MB.` },
          400,
        );
      }
      const head = String.fromCharCode(...pdfBytes.slice(0, 5));
      if (!head.startsWith("%PDF")) {
        return json({ error: "Uploaded file is not a PDF (header check failed)." }, 400);
      }
    }

    // Build the user message: hint (if any) + PDF document block
    const userText = body.school_year_hint
      ? `Extract calendar data. School year hint from the admin: ${body.school_year_hint}.`
      : "Extract calendar data from this district calendar PDF.";

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const requestPayload = {
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "document" as const,
              source: {
                type: "base64" as const,
                media_type: "application/pdf" as const,
                data: bytesToBase64(pdfBytes),
              },
            },
            { type: "text" as const, text: userText },
          ],
        },
      ],
    };

    // Retry once on 429 (rate limit) or 529 (overloaded); user-friendly errors otherwise.
    let resp;
    try {
      resp = await anthropic.messages.create(requestPayload);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 429 || status === 529) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          resp = await anthropic.messages.create(requestPayload);
        } catch (retryErr) {
          const retryStatus = (retryErr as { status?: number })?.status;
          if (retryStatus === 429) {
            return json({ error: "Claude is rate-limited right now. Try again in a minute." }, 503);
          }
          if (retryStatus === 529) {
            return json({ error: "Anthropic is overloaded right now. Try again in a few minutes." }, 503);
          }
          console.error("[extract-district-calendar] anthropic retry failed", retryErr);
          return json({ error: "Extraction service is having trouble. Try again shortly." }, 502);
        }
      } else if (status === 401 || status === 403) {
        console.error("[extract-district-calendar] anthropic auth error", err);
        return json({ error: "Extraction service is misconfigured. Contact support." }, 500);
      } else {
        console.error("[extract-district-calendar] anthropic call failed", err);
        return json({ error: "Couldn't reach the extraction service. Try again shortly." }, 502);
      }
    }

    let raw = "";
    for (const block of resp.content) {
      if (block.type === "text") raw += block.text;
    }
    raw = raw.trim();
    if (raw.startsWith("```")) {
      raw = raw.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
    }

    // Tolerant JSON extraction: if the model wrapped the JSON in prose
    // ("Here is the JSON: {...}") or trailing notes, try to extract the
    // first {...} block before giving up.
    let parsed: ExtractedShape | null = null;
    try {
      parsed = JSON.parse(raw) as ExtractedShape;
    } catch {
      const firstBrace = raw.indexOf("{");
      const lastBrace = raw.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = raw.slice(firstBrace, lastBrace + 1);
        try {
          parsed = JSON.parse(candidate) as ExtractedShape;
        } catch { /* fall through */ }
      }
    }

    if (!parsed) {
      return json(
        { error: "The AI returned something we couldn't parse as JSON.", raw: raw.slice(0, 2000) },
        502,
      );
    }

    const sy = typeof parsed.school_year === "string" ? parsed.school_year.trim() : null;
    const first = typeof parsed.first_day_of_school === "string" ? parsed.first_day_of_school.trim() : null;
    const last = typeof parsed.last_day_of_school === "string" ? parsed.last_day_of_school.trim() : null;

    return json({
      school_year: sy && /^\d{4}-\d{4}$/.test(sy) ? sy : null,
      first_day_of_school: first && /^\d{4}-\d{2}-\d{2}$/.test(first) ? first : null,
      last_day_of_school: last && /^\d{4}-\d{2}-\d{2}$/.test(last) ? last : null,
      no_school_dates: sanitizeDateList(parsed.no_school_dates),
      early_release_dates: sanitizeDateList(parsed.early_release_dates),
      model_notes: typeof parsed.model_notes === "string" ? parsed.model_notes : null,
    });
  } catch (err) {
    console.error("[extract-district-calendar] unexpected", err);
    return json({ error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});
