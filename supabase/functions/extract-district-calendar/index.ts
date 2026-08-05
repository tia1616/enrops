// extract-district-calendar: takes a district school calendar as a PDF (uploaded
// base64 or a URL we fetch), a WEB PAGE (URL we fetch and read as text), or
// PASTED TEXT, and asks Claude to extract the structured no-school + early-release
// date list the admin reviews before saving to district_calendars.
//
// Input:
//   {
//     organization_id: string,   // the org this calendar is for
//     url?: string,              // PDF URL *or* a calendar web page URL (fetched server-side)
//     pdf_base64?: string,       // PDF bytes as base64 (data: prefix allowed)
//     text?: string,             // pasted calendar text
//     filename?: string,         // optional hint for prompts/logs
//     school_year_hint?: string, // optional, e.g. "2026-2027"
//   }
//   Exactly one source (url | pdf_base64 | text) is used, in that precedence.
//
// Output:
//   {
//     school_year, first_day_of_school, last_day_of_school,
//     no_school_dates: [{ date, reason }],
//     early_release_dates: [{ date, reason }],
//     model_notes,
//     source_kind: "pdf" | "webpage" | "text",   // what we actually read
//   }
//
// Auth: caller must be owner/admin of organization_id. No tenant DB reads/writes;
// the UI persists after review.
//
// SSRF: url fetches are limited to http/https and reject obvious internal hosts
// (loopback, private ranges, link-local incl. the cloud metadata IP). Residual
// risk is low: the fetched content is only handed to Claude and ONLY structured
// date JSON is returned to the caller - the raw response body is never returned.
// The final URL after redirects is re-checked too. (Known gap: a hostname that
// RESOLVES to a private IP via DNS is not caught - literal-host checks only.
// Acceptable given the limited return.)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB (Anthropic doc limit is 32 MB)
const MAX_TEXT_CHARS = 200_000;         // cap web/pasted text sent to the model
const MAX_FETCH_BYTES = MAX_PDF_BYTES;  // hard cap on any URL response we buffer
const URL_FETCH_TIMEOUT_MS = 30_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You extract structured school calendar data from a district's school calendar. The source may be a PDF (a visual month-grid with a color legend), a web page's text, or text an admin pasted. Read whatever you are given and produce structured JSON. For a PDF, read it visually - colors, legends, callouts. For web-page or pasted TEXT, read the words, tables, and lists; there is no image to inspect, so rely only on the text present.

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
   - Full closure (students do not attend): "no school", "schools closed", "non-contract day", "teacher in-service", "PD day", "grade prep", "holiday", "winter break", "spring break", "conferences" with no student attendance, family connections/transitions days where students don't attend -> no_school_dates
   - Shorter day (students attend, just dismissed early): "early release", "early dismissal", "half day" -> early_release_dates
3. A date may appear in EITHER no_school_dates OR early_release_dates, never both. If both could apply, the more restrictive category wins - no-school > early-release.
4. End-of-quarter / end-of-semester markers alone do NOT mean no school. Only include if the date is also marked no-school.
5. For a PDF, use the legend to interpret colors and codes; different colors can mean different things. For text sources, use the words/labels next to each date.
6. For multi-day breaks (winter break, spring break), enumerate each weekday individually. Skip Saturdays and Sundays.
7. Do not include weekends, summer break, or any date outside the school year.
8. Teacher-only / PD days BEFORE the first day of school or AFTER the last day are not relevant - skip them.
9. The "reason" field MUST quote the calendar's exact label text where readable ("Thanksgiving", "MLK Day", "Winter Break", "Teacher Grade Prep"). Keep under 40 chars. Do NOT paraphrase or invent a label.
10. If the school year is not stated explicitly, derive it from the dates (Fall start year + next year). If you cannot determine it confidently, return null.
11. All dates ISO 8601 (YYYY-MM-DD) with explicit year. Do not guess years.
12. **WHEN UNSURE, OMIT.** It is far better to miss one closure the admin can add manually than to invent one. If you cannot tell whether a marking means no-school vs early-release, or cannot determine the year, leave that date out and flag it in model_notes. For a web page or pasted text that clearly is NOT a school calendar (or has no dates), return empty date lists and say so in model_notes.

model_notes usage:
- Use ONLY for a specific date the admin must VERIFY (a cell you genuinely could not read, or a marking you could not classify), OR to say the source did not look like a school calendar / had no dates.
- NEVER explain why you EXCLUDED a date. Out-of-school-year dates, weekends, summer, pre-service/post-service days, and end-of-quarter/grading markers are EXPECTED exclusions and need no note. NEVER restate or justify what is already in the date lists.
- If the only thing you could write is exclusion or inclusion reasoning, return null. For a clean, legible calendar this should be null.

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

// --- SSRF guard: only http/https, reject obvious internal/loopback hosts ---
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "::") return true;
  // IPv6 link-local / ULA - only for IPv6 LITERALS (contain a colon), never
  // bare hostnames. Without the colon guard this wrongly blocked real district
  // domains like fcps.edu (Fairfax County) that merely start with "fc"/"fd".
  if (h.includes(":") && (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
  }
  return false;
}

function validateUrl(raw: string): { ok: true; href: string } | { ok: false; message: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, message: "That doesn't look like a valid link." }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, message: "Only http and https links are supported." };
  }
  if (isBlockedHost(u.hostname)) {
    return { ok: false, message: "That link points to an internal address we can't fetch." };
  }
  return { ok: true, href: u.href };
}

// Read a response body into memory but never buffer more than `cap` bytes.
// Returns { tooBig: true } instead of OOM-ing on a huge/endless response.
async function readCapped(resp: Response, cap: number): Promise<Uint8Array | { tooBig: true }> {
  const reader = resp.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await resp.arrayBuffer());
    return buf.length > cap ? { tooBig: true } : buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > cap) { await reader.cancel(); return { tooBig: true }; }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|thead|tbody|section|article)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(td|th)\b[^>]*>/gi, "\t");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&rsquo;/gi, "'")
       .replace(/&quot;/gi, '"').replace(/&mdash;/gi, "-").replace(/&ndash;/gi, "-");
  s = s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

type FetchResult =
  | { ok: true; kind: "pdf"; bytes: Uint8Array }
  | { ok: true; kind: "webpage"; text: string }
  | { ok: false; status: number; message: string };

async function fetchUrl(href: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(href, {
      redirect: "follow",
      headers: { "User-Agent": "Enrops-Calendar-Extractor/1.0" },
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      return { ok: false, status: 400, message: `That link took longer than ${URL_FETCH_TIMEOUT_MS / 1000}s to respond. Try uploading the file or pasting the text instead.` };
    }
    return { ok: false, status: 400, message: `Couldn't fetch that link: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) return { ok: false, status: 400, message: `That link returned ${resp.status} ${resp.statusText}.` };

  // Re-check the FINAL host: redirect: "follow" may have landed on an internal
  // address the original URL didn't name. (Literal-host only; DNS rebinding still
  // out of scope - documented at top of file.)
  try {
    if (isBlockedHost(new URL(resp.url).hostname)) {
      return { ok: false, status: 400, message: "That link redirected to an internal address we can't fetch." };
    }
  } catch { /* resp.url always parses in practice; ignore */ }

  // Fast reject on a declared Content-Length before we read a byte.
  const declaredLen = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_FETCH_BYTES) {
    return { ok: false, status: 400, message: `That page/file is too large (${(declaredLen / 1024 / 1024).toFixed(1)} MB). Max ${MAX_FETCH_BYTES / 1024 / 1024} MB.` };
  }

  const contentType = (resp.headers.get("content-type") ?? "").toLowerCase();
  const read = await readCapped(resp, MAX_FETCH_BYTES);
  if ("tooBig" in read) {
    return { ok: false, status: 400, message: `That page/file is too large to read. Max ${MAX_FETCH_BYTES / 1024 / 1024} MB. Try uploading the file or pasting the text instead.` };
  }
  const buf = read;
  if (buf.length === 0) return { ok: false, status: 400, message: "That link returned an empty page." };

  const looksPdf = contentType.includes("pdf") || contentType.includes("octet-stream")
    || String.fromCharCode(...buf.slice(0, 5)).startsWith("%PDF");
  if (looksPdf) {
    // Size is already capped by readCapped (MAX_FETCH_BYTES === MAX_PDF_BYTES).
    if (!String.fromCharCode(...buf.slice(0, 5)).startsWith("%PDF")) {
      return { ok: false, status: 400, message: "That link's content type says PDF but the file isn't one." };
    }
    return { ok: true, kind: "pdf", bytes: buf };
  }

  // Otherwise treat as a web page / text.
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: false }).decode(buf); } catch { text = ""; }
  const stripped = contentType.includes("html") || /<html|<body|<table|<div/i.test(text.slice(0, 2000))
    ? htmlToText(text)
    : text.trim();
  if (!stripped) return { ok: false, status: 400, message: "Couldn't read any text from that page." };
  return { ok: true, kind: "webpage", text: stripped.slice(0, MAX_TEXT_CHARS) };
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
      text?: string;
      filename?: string;
      school_year_hint?: string;
    };

    const organizationId = body.organization_id ?? "";
    if (!organizationId) return json({ error: "organization_id is required." }, 400);

    const pastedText = typeof body.text === "string" ? body.text.trim() : "";
    if (!body.url && !body.pdf_base64 && !pastedText) {
      return json({ error: "Provide a url, a PDF, or pasted text." }, 400);
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
    if (!memberships || memberships.length === 0) return json({ error: "Forbidden." }, 403);

    // Resolve the source into either a PDF document block or a text block.
    // Precedence: pasted text -> url -> uploaded PDF.
    let sourceKind: "pdf" | "webpage" | "text";
    let pdfBytes: Uint8Array | null = null;
    let sourceText = "";

    if (pastedText) {
      sourceKind = "text";
      sourceText = pastedText.slice(0, MAX_TEXT_CHARS);
    } else if (body.url) {
      const v = validateUrl(body.url);
      if (!v.ok) return json({ error: v.message }, 400);
      const result = await fetchUrl(v.href);
      if (!result.ok) return json({ error: result.message }, result.status);
      if (result.kind === "pdf") { sourceKind = "pdf"; pdfBytes = result.bytes; }
      else { sourceKind = "webpage"; sourceText = result.text; }
    } else {
      sourceKind = "pdf";
      try { pdfBytes = base64ToBytes(body.pdf_base64!); }
      catch { return json({ error: "Uploaded file is not valid base64." }, 400); }
      if (pdfBytes.length === 0) return json({ error: "PDF is empty." }, 400);
      if (pdfBytes.length > MAX_PDF_BYTES) {
        return json({ error: `PDF is too large (${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB). Max ${MAX_PDF_BYTES / 1024 / 1024} MB.` }, 400);
      }
      if (!String.fromCharCode(...pdfBytes.slice(0, 5)).startsWith("%PDF")) {
        return json({ error: "Uploaded file is not a PDF (header check failed)." }, 400);
      }
    }

    const userText = body.school_year_hint
      ? `Extract calendar data. School year hint from the admin: ${body.school_year_hint}.`
      : "Extract the calendar data from this district school calendar.";

    const content = sourceKind === "pdf"
      ? [
          { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: bytesToBase64(pdfBytes!) } },
          { type: "text" as const, text: userText },
        ]
      : [
          { type: "text" as const, text: `Calendar source (${sourceKind === "webpage" ? "web page text" : "pasted text"}) between the markers:\n<calendar>\n${sourceText}\n</calendar>` },
          { type: "text" as const, text: userText },
        ];

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const requestPayload = {
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user" as const, content }],
    };

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
          if (retryStatus === 429) return json({ error: "Claude is rate-limited right now. Try again in a minute." }, 503);
          if (retryStatus === 529) return json({ error: "Anthropic is overloaded right now. Try again in a few minutes." }, 503);
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

    let parsed: ExtractedShape | null = null;
    try {
      parsed = JSON.parse(raw) as ExtractedShape;
    } catch {
      const firstBrace = raw.indexOf("{");
      const lastBrace = raw.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try { parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1)) as ExtractedShape; } catch { /* fall through */ }
      }
    }
    if (!parsed) {
      return json({ error: "The AI returned something we couldn't parse as JSON.", raw: raw.slice(0, 2000) }, 502);
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
      source_kind: sourceKind,
    });
  } catch (err) {
    console.error("[extract-district-calendar] unexpected", err);
    return json({ error: (err as Error).message ?? "Unexpected error" }, 500);
  }
});
