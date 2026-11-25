// ennie-help: Ennie's help chat for providers (onboarding chunk 3).
//
// Answers ONLY from the provider guides (src/content/guides, copied into
// guides.generated.ts by scripts/build-ennie-guides.mjs). Jessica 11/19 + 11/24:
//   - no general knowledge, no made-up steps, never promise a feature the guides
//     don't describe;
//   - every answer names the guide section it used (the page links to
//     /admin/help#<id>);
//   - when the guides don't cover it, a fixed reply offers a person
//     (the page then sends the chat through submit-feedback);
//   - every question is logged in ennie_questions (answered or not).
//
// Input (POST JSON): { organization_id, conversation_id, question, page_path? }
// Auth: verify_jwt is on, but that is NOT authorization (the anon key passes it).
// The caller must be an accepted member of organization_id, or a platform admin.
// Earlier turns are loaded from ennie_questions by (caller, org, conversation),
// never taken from the request body.
//
// Output: { id, answered, answer, sources: [{ id, title, guide, label }] }
//         429 { error, limit: true } past the daily cap.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import Anthropic from "npm:@anthropic-ai/sdk@0.96.0";
import { GUIDE_TEXT } from "./guides.generated.ts";
import { NO_ANSWER, shapeReply, type Source } from "./reply.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("ENNIE_MODEL") ?? "claude-opus-5-5";

// Cost guard: questions per person per rolling 24 hours.
const DAILY_CAP = 40;
// Earlier turns sent back to the model so "and how do I undo that?" makes sense.
const HISTORY_TURNS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const RULES = `You are Ennie, the helper inside enrops, software that after-school and enrichment program providers use to run classes, camps, registration and payments. You answer a provider's question about how to use enrops.

Answer ONLY from the guides below. They are the whole truth about enrops for you.
- Never use outside knowledge about enrops, Stripe, or other software. Never guess a button name, a menu path, a fee, a number or a date that the guides do not state.
- Never describe a feature, setting or step the guides do not describe. If the guides say something can't be done yet, say that plainly.
- If the guides do not answer the question, set "answered" to false and leave "answer" empty. Do not answer partly from memory. A question that is not about using enrops (for example general business, legal or tax advice) is not answered.
- When you answer: plain, warm, short. Two to six sentences, or a short numbered list of the guide's own steps. Use the exact words on the screen as the guide gives them. Say "site" not "location", "school partner" not "client". Lowercase "enrops". No em dashes. No markdown headings.
- "sources" lists the id of every guide section your answer used: the text inside {#...} at the end of that section's heading, without the braces or #. At least one when answered is true.
- You can't see the provider's account, classes or families. If they ask about their own data, answer with the guide steps to find it themselves.

<guides>
${GUIDE_TEXT}
</guides>`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answered: { type: "boolean" },
    answer: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["answered", "answer", "sources"],
  additionalProperties: false,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not signed in" }, 401);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userResp, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userResp?.user) return json({ error: "Not signed in" }, 401);
    const userId = userResp.user.id;

    const body = await req.json().catch(() => ({}));
    const organizationId = String(body.organization_id ?? "").trim();
    const conversationId = String(body.conversation_id ?? "").trim();
    const question = String(body.question ?? "").trim();
    const pagePath = body.page_path ? String(body.page_path).slice(0, 500) : null;

    if (!UUID.test(organizationId) || !UUID.test(conversationId)) return json({ error: "Missing organization" }, 400);
    if (!question) return json({ error: "Type a question first." }, 400);
    if (question.length > 1000) return json({ error: "That question is too long. Keep it under 1,000 characters." }, 400);

    // Authorization: an accepted member of this org, or a platform admin. Read
    // under the CALLER's JWT, so RLS decides; an error is a refusal (fail closed).
    const [memberRes, adminRes] = await Promise.all([
      userClient.rpc("is_org_member", { org_id: organizationId }),
      userClient.rpc("is_platform_admin"),
    ]);
    if (memberRes.error || adminRes.error) {
      console.error("ennie-help: membership check failed", memberRes.error?.message, adminRes.error?.message);
      return json({ error: "Could not check your access. Try again." }, 500);
    }
    if (memberRes.data !== true && adminRes.data !== true) return json({ error: "Not allowed" }, 403);

    // SERVICE ROLE, narrow: ennie_questions has no authenticated INSERT (so a
    // provider can't forge "what Ennie said" into a later email to Jessica).
    // Every query below is pinned to the verified userId + organizationId.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Daily cap. A failed count fails CLOSED: an unknown count could be over.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: countErr } = await admin
      .from("ennie_questions")
      .select("id", { count: "exact", head: true })
      .eq("auth_user_id", userId)
      .gte("created_at", since);
    if (countErr) {
      console.error("ennie-help: cap count failed", countErr.message);
      return json({ error: "Ennie couldn't answer just now. Try again in a minute." }, 500);
    }
    if ((count ?? 0) >= DAILY_CAP) {
      return json({
        error: `You've asked Ennie ${DAILY_CAP} questions today, the daily limit. Send this to the enrops team instead and we'll email you back.`,
        limit: true,
      }, 429);
    }

    // Earlier turns of THIS conversation, by this caller, in this org. An error
    // here only costs context, so it degrades to no history (logged).
    const { data: prior, error: priorErr } = await admin
      .from("ennie_questions")
      .select("question, answer, answered")
      .eq("auth_user_id", userId)
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_TURNS);
    if (priorErr) console.error("ennie-help: history load failed", priorErr.message);
    const messages: Anthropic.MessageParam[] = [];
    for (const t of (prior ?? []).slice().reverse()) {
      messages.push({ role: "user", content: t.question });
      messages.push({ role: "assistant", content: JSON.stringify({ answered: t.answered, answer: t.answered ? t.answer : "", sources: [] }) });
    }
    messages.push({ role: "user", content: question });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    let reply: { answered: boolean; answer: string; sources: Source[] } = { answered: false, answer: NO_ANSWER, sources: [] };
    let usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null } = {};
    try {
      // output_config is newer than this SDK pin's types; the API accepts it.
      // deno-lint-ignore no-explicit-any
      const params: any = {
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        system: [{ type: "text", text: RULES, cache_control: { type: "ephemeral" } }],
        messages,
      };
      const res: Anthropic.Message = await client.messages.create(params);
      usage = res.usage ?? {};
      // refusal / max_tokens / anything else: no trustworthy answer -> the person offer.
      if (res.stop_reason === "end_turn") {
        let text = "";
        for (const b of res.content) if (b.type === "text") text += b.text;
        try {
          reply = shapeReply(JSON.parse(text));
        } catch {
          console.error("ennie-help: model output was not JSON");
        }
      } else {
        console.error("ennie-help: stop_reason", res.stop_reason);
      }
    } catch (e) {
      // A typed API error carries the HTTP status (429 / 5xx / 400); anything
      // else is a network or SDK failure. Both end in the same reply.
      const status = e instanceof Anthropic.APIError ? (e as InstanceType<typeof Anthropic.APIError>).status : "network";
      console.error("ennie-help: model call failed", status, e instanceof Error ? e.message : String(e));
      return json({ error: "Ennie couldn't answer just now. Try again, or send this to the enrops team." }, 502);
    }

    const { data: row, error: insErr } = await admin
      .from("ennie_questions")
      .insert({
        organization_id: organizationId,
        auth_user_id: userId,
        conversation_id: conversationId,
        question,
        answer: reply.answer,
        answered: reply.answered,
        sources: reply.sources.map((s) => s.id),
        page_path: pagePath,
        model: MODEL,
        input_tokens: usage.input_tokens ?? null,
        cache_read_tokens: usage.cache_read_input_tokens ?? null,
        output_tokens: usage.output_tokens ?? null,
      })
      .select("id")
      .single();
    // The answer still goes back if the log write fails, but without an id the
    // page can't rate it or attach it to a "send to a person" email. Logged.
    if (insErr) console.error("ennie-help: log insert failed", insErr.message);

    return json({ id: row?.id ?? null, ...reply }, 200);
  } catch (e) {
    console.error("ennie-help unexpected error:", String(e));
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
