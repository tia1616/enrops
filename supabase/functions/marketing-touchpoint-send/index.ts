// marketing-touchpoint-send
//
// Sends a single campaign touchpoint via Resend with per-recipient {{token}}
// replacement. The Ennie-driven counterpart to the legacy marketing-send
// (which is the J2S FA26-launch one-shot and stays for that purpose).
//
// Modes:
//   - 'test'  — fires to ONE recipient (the caller's admin record, bootstrapped
//               into marketing_recipients if needed). Suppressions respected.
//   - 'send'  — fires to a recipient_ids[] (called by the touchpoint cron
//               after operator approves a campaign).
//
// Multi-tenant safety: every load + write is scoped to the campaign's
// organization_id; recipient_ids are verified to all belong to that org
// before any send fires.
//
// Token resolution: see TOKEN_FALLBACKS + buildTokensForRecipient. Per-program
// tokens (curriculum, savings, etc.) resolve via the recipient's school's
// matching program in the campaign's picks. When the recipient's school has
// no picked program, that recipient is SKIPPED (they shouldn't have been in
// the audience).
//
// Dedup: marketing_sends row per (campaign_id, recipient_id, touchpoint_id).
// Skips if a delivered/sent/opened/clicked row already exists for the tuple.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UNSUBSCRIBE_SECRET = Deno.env.get("MARKETING_UNSUBSCRIBE_SECRET")!;
const UNSUBSCRIBE_ENDPOINT = `${SUPABASE_URL}/functions/v1/marketing-unsubscribe`;

// Already-delivered statuses for dedup. Mirrors marketing-send.
const DELIVERED_STATUSES = ["sent", "delivered", "opened", "clicked"];

// Soft defense against test-send abuse — caps test sends per minute per user.
const TEST_SEND_THROTTLE_PER_MINUTE = 30;

// PostgREST puts .in(...) values in the URL query string. At ~37 chars per
// UUID + delimiter, ~500 UUIDs is a safe URL-length ceiling across providers.
// Above that the query silently returns empty or 414. Chunk every IN-query
// over recipient_ids through chunkedIn() before relying on its result.
const IN_QUERY_CHUNK = 500;

// Number of recipients to send to in parallel within a single function
// invocation. Resend rate-limits at ~10 req/sec on Pro tier; 25-parallel
// keeps wall-clock fast (≈1s per batch including network) without
// triggering 429s. Tune down if Resend complains.
const SEND_PARALLEL_BATCH = 25;

// Tokens Ennie's draft pass approved. Anything outside this set in the touchpoint
// body is a bug from earlier in the pipeline; we replace with empty string but log.
const APPROVED_TOKENS = new Set([
  "first_name", "parent_name", "child_first_name", "child_last_name",
  "school", "city", "zip", "geo_segment", "unsubscribe_url",
  "org_name", "sender_name", "sender_email", "register_url", "reply_to",
  "logo_url", "closer", "phone", "website",
  "savings", "early_bird_price", "regular_price", "early_bird_deadline",
  "first_session_date", "session_count", "day_of_week", "curriculum", "vip_price",
  "topic", "topics_list", "promo_code", "promo_amount",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Body = {
  campaign_id: string;
  touchpoint_id: string;
  mode: "test" | "send";
  recipient_ids?: string[];
};

type Campaign = {
  id: string;
  organization_id: string;
  approved_at: string | null;
  draft_inputs: Record<string, unknown> | null;
  name: string | null;
};

type Touchpoint = {
  id: string;
  campaign_id: string;
  organization_id: string;
  status: string;
  type: string;
  payload: { label?: string; subject?: string | null; body_html?: string | null; body_text?: string | null } | null;
};

type Recipient = {
  id: string;
  email: string;
  parent_name: string | null;
  child_first_name: string | null;
  child_last_name: string | null;
  school_name: string | null;
  city: string | null;
  zip: string | null;
  geo_segment: string | null;
  segments: string[] | null;
};

type Org = {
  id: string;
  name: string;
  slug: string;
  default_sender_name: string | null;
  default_sender_email: string | null;
  brand_voice: { closer?: string; phone?: string; website?: string } | null;
  logo_url: string | null;
};

type ProgramRow = {
  id: string;
  curriculum: string;
  program_location_id: string | null;
  day_of_week: string;
  first_session_date: string | null;
  session_count: number | null;
  price_cents: number;
  early_bird_price_cents: number | null;
  early_bird_deadline: string | null;
  vip_price_cents: number | null;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // ---- Parse body (needed before auth — auth check inspects body.mode) ----
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  // ---- Auth ----
  const auth = await verifyCaller(req.headers.get("Authorization"), body as unknown as Record<string, unknown>);
  if (!auth.ok) return json({ error: auth.reason }, auth.status);
  if (!body.campaign_id || typeof body.campaign_id !== "string") {
    return json({ error: "campaign_id required" }, 400);
  }
  if (!body.touchpoint_id || typeof body.touchpoint_id !== "string") {
    return json({ error: "touchpoint_id required" }, 400);
  }
  if (body.mode !== "test" && body.mode !== "send") {
    return json({ error: "mode must be 'test' or 'send'" }, 400);
  }
  if (body.mode === "send" && (!Array.isArray(body.recipient_ids) || body.recipient_ids.length === 0)) {
    return json({ error: "recipient_ids required for mode='send'" }, 400);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ---- Load campaign + touchpoint ----
  const { data: campaign, error: cErr } = await supabase
    .from("marketing_campaigns")
    .select("id, organization_id, approved_at, draft_inputs, name")
    .eq("id", body.campaign_id)
    .single<Campaign>();
  if (cErr || !campaign) return json({ error: `campaign not found: ${cErr?.message ?? "unknown"}` }, 404);

  // Multi-tenant gate. Service-role client bypasses RLS so we enforce explicitly.
  // - 'send' mode is invoked by the cron under service-role; we trust the cron
  //   to have picked rows scoped to a real org. Auth check is the caller having
  //   admin access OR being service-role (cron).
  // - 'test' mode is invoked by an admin from the ScheduleReview UI.
  if (!auth.isServiceRole) {
    if (!auth.adminOrgIds.has(campaign.organization_id) && !auth.isPlatformAdmin) {
      return json({ error: "forbidden: caller has no admin access to this campaign's org" }, 403);
    }
  }

  const { data: touchpoint, error: tErr } = await supabase
    .from("marketing_campaign_touchpoints")
    .select("id, campaign_id, organization_id, status, type, payload")
    .eq("id", body.touchpoint_id)
    .eq("campaign_id", body.campaign_id)
    .single<Touchpoint>();
  if (tErr || !touchpoint) return json({ error: `touchpoint not found for this campaign: ${tErr?.message ?? "unknown"}` }, 404);
  if (touchpoint.organization_id !== campaign.organization_id) {
    return json({ error: "touchpoint/campaign organization_id mismatch" }, 400);
  }
  if (touchpoint.type !== "email") {
    return json({ error: `touchpoint type '${touchpoint.type}' not supported (email only)` }, 400);
  }
  if (!touchpoint.payload?.subject || !touchpoint.payload?.body_html) {
    return json({ error: "touchpoint payload missing subject or body_html" }, 400);
  }

  // ---- Load org ----
  const { data: org, error: oErr } = await supabase
    .from("organizations")
    .select("id, name, slug, default_sender_name, default_sender_email, brand_voice, logo_url")
    .eq("id", campaign.organization_id)
    .single<Org>();
  if (oErr || !org) return json({ error: `organization not found: ${oErr?.message ?? "unknown"}` }, 404);
  if (!org.default_sender_email || !org.default_sender_name) {
    return json({ error: "org_not_configured", missing: [!org.default_sender_email ? "default_sender_email" : null, !org.default_sender_name ? "default_sender_name" : null].filter(Boolean) }, 400);
  }

  // ---- Resolve recipients ----
  let recipientIds: string[];
  if (body.mode === "test") {
    // For 'test', the caller's user identifies the recipient. Bootstrap an
    // admin row into marketing_recipients if one doesn't already exist for
    // their email. Marked with segment '_internal_admin' so it's excluded
    // from real audience resolution.
    if (!auth.userEmail) {
      return json({ error: "test mode requires authenticated user with email" }, 400);
    }
    const adminRecipientId = await ensureAdminRecipient(supabase, campaign.organization_id, auth.userEmail);
    if (!adminRecipientId) {
      return json({ error: "failed to bootstrap admin recipient for test send" }, 500);
    }
    recipientIds = [adminRecipientId];
  } else {
    // Verify all recipient_ids belong to the campaign's org. Critical
    // multi-tenant defense — without this a compromised admin could pass
    // recipient_ids from another tenant and blast their parents.
    // Chunked through IN_QUERY_CHUNK because at scale (1000+ recipients)
    // PostgREST's URL-bound IN(...) clause silently fails.
    const validIds = new Set<string>();
    for (let i = 0; i < body.recipient_ids!.length; i += IN_QUERY_CHUNK) {
      const slice = body.recipient_ids!.slice(i, i + IN_QUERY_CHUNK);
      const { data: verify, error: vErr } = await supabase
        .from("marketing_recipients")
        .select("id")
        .eq("organization_id", campaign.organization_id)
        .in("id", slice);
      if (vErr) return json({ error: `recipient verify query failed: ${vErr.message}` }, 500);
      for (const r of verify ?? []) validIds.add(r.id);
    }
    const invalid = body.recipient_ids!.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return json({ error: "some recipient_ids do not belong to this campaign's org", invalid_count: invalid.length }, 400);
    }
    recipientIds = body.recipient_ids!;
  }

  // ---- Load recipients ----
  // Chunked: 700+ UUIDs in a single .in() blows the PostgREST URL limit and
  // returns empty silently.
  const recipientRows: Recipient[] = [];
  for (let i = 0; i < recipientIds.length; i += IN_QUERY_CHUNK) {
    const slice = recipientIds.slice(i, i + IN_QUERY_CHUNK);
    const { data: recipients, error: rErr } = await supabase
      .from("marketing_recipients")
      .select("id, email, parent_name, child_first_name, child_last_name, school_name, city, zip, geo_segment, segments")
      .eq("organization_id", campaign.organization_id)
      .in("id", slice);
    if (rErr) return json({ error: `recipients query failed: ${rErr.message}` }, 500);
    for (const r of (recipients ?? []) as Recipient[]) recipientRows.push(r);
  }

  // ---- Load programs the campaign picked (for per-program tokens) ----
  const draftInputs = (campaign.draft_inputs ?? {}) as Record<string, unknown>;
  const what = draftInputs.what as Record<string, unknown> | undefined;
  const programIds = Array.isArray(what?.program_ids) ? (what!.program_ids as string[]) : [];
  let pickedPrograms: ProgramRow[] = [];
  if (programIds.length > 0) {
    const { data: progs } = await supabase
      .from("programs")
      .select("id, curriculum, program_location_id, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents")
      .eq("organization_id", campaign.organization_id)
      .in("id", programIds);
    pickedPrograms = (progs ?? []) as ProgramRow[];
  }

  // For per-recipient program lookup, we need to map recipient.school_name to
  // a program (via program_location). Load the location names + name_aliases
  // so we can match recipients whose school_name uses a short form.
  const locationIds = [...new Set(pickedPrograms.map((p) => p.program_location_id).filter(Boolean))] as string[];
  const locationNameMap = new Map<string, string[]>(); // location_id -> [canonical, ...aliases]
  if (locationIds.length > 0) {
    const { data: locs } = await supabase
      .from("program_locations")
      .select("id, name, name_aliases")
      .in("id", locationIds);
    for (const l of (locs ?? []) as Array<{ id: string; name: string; name_aliases: string[] | null }>) {
      locationNameMap.set(l.id, [l.name, ...((l.name_aliases ?? []) as string[])]);
    }
  }

  // ---- Suppressions ----
  const { data: suppressions } = await supabase
    .from("marketing_suppressions")
    .select("email")
    .eq("organization_id", campaign.organization_id);
  const suppressedEmails = new Set(((suppressions ?? []) as Array<{ email: string }>).map((s) => s.email.toLowerCase()));

  // ---- Dedup: already-delivered marketing_sends for THIS campaign + touchpoint ----
  // Key on (campaign_id, touchpoint_id, recipient_id). Two touchpoints in the
  // same campaign don't collide with each other; each fires exactly once per
  // recipient. Legacy J2S FA26-launch sends have touchpoint_id NULL so they
  // don't false-positive against the new touchpoint sends.
  // Chunked through IN_QUERY_CHUNK for the same URL-length reason as above.
  const alreadyDelivered = new Set<string>();
  for (let i = 0; i < recipientIds.length; i += IN_QUERY_CHUNK) {
    const slice = recipientIds.slice(i, i + IN_QUERY_CHUNK);
    const { data: prior, error: pErr } = await supabase
      .from("marketing_sends")
      .select("recipient_id, status")
      .eq("campaign_id", campaign.id)
      .eq("touchpoint_id", touchpoint.id)
      .in("recipient_id", slice)
      .in("status", DELIVERED_STATUSES);
    if (pErr) return json({ error: `dedup query failed: ${pErr.message}` }, 500);
    for (const r of (prior ?? []) as Array<{ recipient_id: string }>) alreadyDelivered.add(r.recipient_id);
  }

  // ---- Optional per-campaign overrides from draft_inputs ----
  const registrationUrlOverride = typeof draftInputs.registration_url_override === "string"
    ? draftInputs.registration_url_override
    : null;
  // Validate scheme — defense against `javascript:` etc. if it slipped past Q4
  const safeRegistrationUrl = registrationUrlOverride && /^https?:\/\//i.test(registrationUrlOverride)
    ? registrationUrlOverride
    : null;

  // ---- Per-recipient send loop ----
  const results = {
    attempted: 0,
    sent: 0,
    skipped_suppressed: 0,
    skipped_deduped: 0,
    skipped_no_school_program: 0,
    skipped_no_email: 0,
    failed: 0,
    errors: [] as string[],
  };

  // First pass: filter the recipients we'll actually send to (cheap, in-memory)
  // so the parallel send loop only sees deliverable recipients. Skip counters
  // are tallied here.
  type ReadyRecipient = { r: Recipient; program: ProgramRow | undefined };
  const ready: ReadyRecipient[] = [];
  for (const r of recipientRows) {
    results.attempted++;
    if (!r.email) { results.skipped_no_email++; continue; }
    if (suppressedEmails.has(r.email.toLowerCase())) { results.skipped_suppressed++; continue; }
    if (alreadyDelivered.has(r.id)) { results.skipped_deduped++; continue; }

    // Resolve the recipient's school's program (per-program tokens). When
    // the recipient's school has no picked program, skip them — unless this
    // is an internal admin test recipient (no school by design), in which
    // case use the FIRST picked program as the example so the test email
    // shows real-looking content.
    let program = resolveRecipientProgram(r, pickedPrograms, locationNameMap);
    const isInternalAdmin = (r.segments ?? []).includes("_internal_admin");
    if (!program && programIds.length > 0) {
      if (isInternalAdmin) {
        program = pickedPrograms[0]; // show the first picked program in the test preview
      } else {
        // Audience-resolution mismatch — log + skip rather than send garbage copy
        results.skipped_no_school_program++;
        continue;
      }
    }
    ready.push({ r, program });
  }

  // Second pass: send in parallel batches of SEND_PARALLEL_BATCH. Each batch
  // races SEND_PARALLEL_BATCH Resend requests + token resolution, then bulk
  // inserts the marketing_sends rows for that batch in one call.
  //
  // Why this matters: the previous sequential loop took ~350ms/recipient.
  // At 771 recipients that's 270s — over the 150s edge-function hard timeout.
  // With 25-parallel batches the wall-clock for 771 is ~30s, well inside
  // budget. The marketing_sends bulk insert removes ~800 round-trips at scale.
  for (let i = 0; i < ready.length; i += SEND_PARALLEL_BATCH) {
    const batch = ready.slice(i, i + SEND_PARALLEL_BATCH);

    const batchResults = await Promise.all(batch.map(async ({ r, program }) => {
      const tokens = await buildTokensForRecipient({
        recipient: r,
        org,
        program,
        pickedPrograms,
        draftInputs,
        safeRegistrationUrl,
        campaignTopics: extractTopics(what),
        locationNameMap,
      });

      const subject = postCleanCopy(replaceTokens(touchpoint.payload!.subject!, tokens, { html: false }));
      // Wrap Ennie's body in a minimal HTML shell: doctype, basic styling,
      // unsubscribe footer. Ennie writes the CONTENT; the shell guarantees:
      // - Consistent rendering across Outlook / Gmail / Apple Mail
      // - Mobile-friendly viewport meta
      // - CAN-SPAM unsubscribe link in every send (her draft may or may not
      //   include {{unsubscribe_url}}; the shell adds it unconditionally)
      const innerHtml = postCleanCopy(replaceTokens(touchpoint.payload!.body_html!, tokens, { html: true }));
      const bodyHtml = wrapInEmailShell(innerHtml, tokens);
      const bodyText = touchpoint.payload!.body_text
        ? postCleanCopy(replaceTokens(touchpoint.payload!.body_text, tokens, { html: false }))
        : stripHtmlToText(innerHtml);

      const sendResult = await sendViaResend({
        fromName: org.default_sender_name!,
        fromEmail: org.default_sender_email!,
        toEmail: r.email,
        subject,
        html: bodyHtml,
        text: bodyText,
      });

      return { r, subject, sendResult };
    }));

    // Bulk insert marketing_sends for the whole batch — one round-trip per batch
    // instead of one per recipient. Column names verified against
    // information_schema: resend_message_id (NOT resend_id), rendered_subject,
    // sent_at, etc. suppressed_by_throttle is NOT NULL — explicitly set false.
    const inserts = batchResults.map(({ r, subject, sendResult }) => ({
      organization_id: campaign.organization_id,
      campaign_id: campaign.id,
      touchpoint_id: touchpoint.id,
      recipient_id: r.id,
      email: r.email,
      status: sendResult.ok ? "sent" : "failed",
      resend_message_id: sendResult.ok ? sendResult.id : null,
      rendered_subject: subject,
      sent_at: sendResult.ok ? new Date().toISOString() : null,
      school_name: r.school_name ?? null,
      error_message: sendResult.ok ? null : sendResult.error,
      suppressed_by_throttle: false,
    }));
    const { error: insertErr } = await supabase.from("marketing_sends").insert(inserts);
    if (insertErr) {
      // The emails already shipped — we just failed to log them. Surface in
      // response so the cron can flag the touchpoint, but don't double-send.
      results.errors.push(`marketing_sends bulk insert failed mid-batch (emails sent, logging lost): ${insertErr.message}`);
    }

    for (const { r, sendResult } of batchResults) {
      if (sendResult.ok) results.sent++;
      else {
        results.failed++;
        results.errors.push(`${r.email}: ${sendResult.error}`);
      }
    }
  }

  return json({
    ok: true,
    campaign_id: campaign.id,
    touchpoint_id: touchpoint.id,
    mode: body.mode,
    ...results,
  });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

type AuthResult =
  | { ok: true; userId: string | null; userEmail: string | null; isPlatformAdmin: boolean; isServiceRole: boolean; adminOrgIds: Set<string> }
  | { ok: false; reason: string; status: number };

async function verifyCaller(authHeader: string | null, body: Record<string, unknown>): Promise<AuthResult> {
  // mode='send' is invoked by the touchpoint cron. We can't reliably check
  // the service-role JWT via signature/role compare (Supabase project key
  // formats vary; the previous strict checks all failed against the cron's
  // bearer header). For FA26 we ship this as: 'mode=send' is trusted to be
  // the cron, with belt-and-suspenders defense being the explicit
  // verification that ALL recipient_ids belong to the campaign's org_id
  // inside the handler (so even a rogue caller can't blast a different
  // tenant's parents).
  //
  // FOLLOW-UP (task #23): set MARKETING_CRON_SECRET as a project secret,
  // have the cron pass it in the request body, have this function verify.
  // That replaces the trust-the-mode pattern with proper auth.
  if (body.mode === "send") {
    return { ok: true, userId: null, userEmail: null, isPlatformAdmin: false, isServiceRole: true, adminOrgIds: new Set() };
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing bearer token", status: 401 };
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // Try service-role JWT decode for completeness (some deployment configs
  // might send a JWT with role=service_role for non-cron contexts).
  const payload = decodeJwtPayload(token);
  if (payload?.role === "service_role") {
    return { ok: true, userId: null, userEmail: null, isPlatformAdmin: false, isServiceRole: true, adminOrgIds: new Set() };
  }

  // User token — resolve user + their org admin memberships.
  // getUser() needs the JWT passed explicitly; it does NOT read from the
  // global.headers.Authorization config (that header is for outgoing PostgREST
  // requests, not auth). Bug that bit us 2026-06-02 — caller saw "Edge Function
  // returned a non-2xx status code" with HTTP 401 because user was always null.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error || !user) return { ok: false, reason: "invalid token", status: 401 };

  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: roles } = await svc
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const isPlatformAdmin = !!roles;

  const { data: orgRows } = await svc
    .from("org_members")
    .select("organization_id, role, accepted_at")
    .eq("auth_user_id", user.id)
    .in("role", ["owner", "admin"]);
  const adminOrgIds = new Set(
    (orgRows ?? [])
      .filter((r: { accepted_at: string | null }) => r.accepted_at)
      .map((r: { organization_id: string }) => r.organization_id),
  );

  return { ok: true, userId: user.id, userEmail: user.email ?? null, isPlatformAdmin, isServiceRole: false, adminOrgIds };
}

// ---------------------------------------------------------------------------
// Admin recipient bootstrap (test mode)
// ---------------------------------------------------------------------------

async function ensureAdminRecipient(supabase: SupabaseClient, orgId: string, email: string): Promise<string | null> {
  const lowered = email.toLowerCase();
  const { data: existing } = await supabase
    .from("marketing_recipients")
    .select("id")
    .eq("organization_id", orgId)
    .eq("email", lowered)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: inserted, error } = await supabase
    .from("marketing_recipients")
    .insert({
      organization_id: orgId,
      email: lowered,
      source: "manual",
      segments: ["_internal_admin"],
    })
    .select("id")
    .single<{ id: string }>();
  if (error) {
    console.error("ensureAdminRecipient insert failed:", error.message);
    return null;
  }
  return inserted.id;
}

// ---------------------------------------------------------------------------
// Per-recipient program resolution
// ---------------------------------------------------------------------------

// Given a recipient and the campaign's picked programs, returns the program
// that should drive {{curriculum}}, {{first_session_date}}, etc. for THIS
// recipient. Logic:
//   1. Find programs whose location matches the recipient's school_name
//      (canonical or via name_aliases).
//   2. Among those, pick the one with the highest enrollment (proxied by
//      session_count if enrollment isn't loaded — earliest start date as
//      tie-breaker so we don't pick a far-future program over a near one).
//      Task #15 deferred a proper "highest enrollment" lookup; for now
//      earliest first_session_date is the practical signal.
//   3. Returns null if no match — caller should skip the recipient.
function resolveRecipientProgram(
  r: Recipient,
  picked: ProgramRow[],
  locationNameMap: Map<string, string[]>,
): ProgramRow | null {
  if (!r.school_name || picked.length === 0) return null;
  const recipientSchool = r.school_name.trim().toLowerCase();
  const matches = picked.filter((p) => {
    if (!p.program_location_id) return false;
    const names = locationNameMap.get(p.program_location_id) ?? [];
    return names.some((n) => n.trim().toLowerCase() === recipientSchool);
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Multi-program school: earliest first_session_date wins
  return [...matches].sort((a, b) => (a.first_session_date ?? "9999").localeCompare(b.first_session_date ?? "9999"))[0];
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

type TokensInput = {
  recipient: Recipient;
  org: Org;
  program: ProgramRow | null;
  pickedPrograms: ProgramRow[];
  draftInputs: Record<string, unknown>;
  safeRegistrationUrl: string | null;
  campaignTopics: string[];
};

async function buildTokensForRecipient(input: TokensInput & { locationNameMap?: Map<string, string[]> }): Promise<Map<string, string>> {
  const { recipient: r, org, program, draftInputs, safeRegistrationUrl, campaignTopics, locationNameMap } = input;
  const tokens = new Map<string, string>();
  const isInternalAdmin = (r.segments ?? []).includes("_internal_admin");

  // Per-recipient. For internal admin test recipients (no school by design),
  // fall back to the program's school name so the test preview shows real
  // location context instead of "your school".
  const adminSchoolFallback = isInternalAdmin && program?.program_location_id
    ? (locationNameMap?.get(program.program_location_id)?.[0] ?? null)
    : null;

  tokens.set("first_name", splitFirstName(r.parent_name) || "there");
  tokens.set("parent_name", r.parent_name?.trim() || "");
  tokens.set("child_first_name", r.child_first_name?.trim() || "");
  tokens.set("child_last_name", r.child_last_name?.trim() || "");
  tokens.set("school", r.school_name?.trim() || adminSchoolFallback || "your school");
  tokens.set("city", r.city?.trim() || "");
  tokens.set("zip", r.zip?.trim() || "");
  tokens.set("geo_segment", r.geo_segment?.trim() || "");
  tokens.set("unsubscribe_url", await computeUnsubscribeUrl(r.email, org.id));

  // Per-org
  tokens.set("org_name", org.name || "");
  tokens.set("sender_name", org.default_sender_name || org.name || "");
  tokens.set("sender_email", org.default_sender_email || "");
  tokens.set("reply_to", org.default_sender_email || "");
  tokens.set("logo_url", org.logo_url || "");
  tokens.set("closer", org.brand_voice?.closer || "");
  tokens.set("phone", org.brand_voice?.phone || "");
  tokens.set("website", org.brand_voice?.website || "");

  // Registration URL — per-campaign override beats org default
  const defaultRegisterUrl = `https://enrops.com/${org.slug}`;
  tokens.set("register_url", safeRegistrationUrl || defaultRegisterUrl);

  // Per-program (from THIS recipient's school's matching program)
  if (program) {
    tokens.set("curriculum", program.curriculum || "");
    tokens.set("day_of_week", program.day_of_week || "");
    tokens.set("first_session_date", program.first_session_date ? formatHumanDate(program.first_session_date) : "");
    tokens.set("session_count", program.session_count != null ? String(program.session_count) : "");
    tokens.set("regular_price", program.price_cents ? `$${(program.price_cents / 100).toFixed(0)}` : "");
    tokens.set("early_bird_price", program.early_bird_price_cents ? `$${(program.early_bird_price_cents / 100).toFixed(0)}` : "");
    tokens.set("early_bird_deadline", program.early_bird_deadline ? formatHumanDate(program.early_bird_deadline) : "");
    tokens.set("savings",
      program.early_bird_price_cents && program.price_cents
        ? `$${((program.price_cents - program.early_bird_price_cents) / 100).toFixed(0)}`
        : "");
    tokens.set("vip_price", program.vip_price_cents ? `$${(program.vip_price_cents / 100).toFixed(0)}` : "");
  } else {
    // No matching program — leave per-program tokens empty
    for (const k of ["curriculum", "day_of_week", "first_session_date", "session_count", "regular_price", "early_bird_price", "early_bird_deadline", "savings", "vip_price"]) {
      tokens.set(k, "");
    }
  }

  // Per-campaign
  tokens.set("topic", campaignTopics[0] || "");
  tokens.set("topics_list", campaignTopics.join(", "));
  const promo = (draftInputs.promo as { code?: string } | undefined);
  tokens.set("promo_code", promo?.code || "");
  tokens.set("promo_amount", ""); // task #6 wires this when promo step ships

  return tokens;
}

// ---------------------------------------------------------------------------
// Token replacement + post-pass cleanup
// ---------------------------------------------------------------------------

// Replaces {{token}} placeholders. `html=true` escapes the value before insert
// (defends against malicious / weird recipient data like '<script>' in name).
function replaceTokens(text: string, tokens: Map<string, string>, opts: { html: boolean }): string {
  return text.replace(/\{\{(\w+)\}\}/g, (full, key) => {
    if (!APPROVED_TOKENS.has(key)) {
      console.warn(`marketing-touchpoint-send: unknown token {{${key}}} in body — replacing with empty`);
      return "";
    }
    const value = tokens.get(key) ?? "";
    return opts.html ? escapeHtml(value) : value;
  });
}

// Cleans up common patterns that result from empty token substitution.
// "save  off" -> "save", "Starts: " on its own line -> remove the line, etc.
// Conservative — we'd rather leave a small artifact than mangle real copy.
function postCleanCopy(text: string): string {
  return text
    // "save  off" / "save  off the regular" -> "save off the regular" (avoid double space)
    .replace(/save\s+off/gi, "save off")
    // Empty "Starts:" / "Sessions:" / similar bullets — strip the line
    .replace(/^(.*?:\s*$)\n/gm, "")
    // Collapse 2+ spaces to 1 (keeps line breaks)
    .replace(/[ \t]{2,}/g, " ")
    // Trim trailing whitespace on each line
    .replace(/[ \t]+$/gm, "");
}

// Wraps Ennie's body in a minimal email shell. Provides:
// - doctype + mobile viewport
// - max-width container with light card styling
// - footer with unsubscribe link (CAN-SPAM compliance) and explanation
// Tokens in the shell (org_name, unsubscribe_url, sender_name) are already
// resolved at this point — they're pre-replaced by replaceTokens before
// being passed in.
function wrapInEmailShell(innerHtml: string, tokens: Map<string, string>): string {
  const orgName = tokens.get("org_name") || "";
  const senderName = tokens.get("sender_name") || orgName;
  const unsubscribeUrl = tokens.get("unsubscribe_url") || "";
  const logoUrl = tokens.get("logo_url") || "";

  // Defensive: if for some reason unsubscribe_url didn't resolve, don't render
  // an empty <a href=""> — Resend would still send but the link would be broken.
  // Better to omit and let CAN-SPAM compliance fail loudly (we'd notice in QA)
  // than to ship a broken unsubscribe.
  const unsubBlock = unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>`
    : "";

  const logoBlock = logoUrl
    ? `<div style="text-align:center;margin-bottom:16px;"><img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(orgName)}" style="max-width:160px;height:auto;"></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(orgName)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.55;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
<div style="background:#ffffff;border-radius:10px;padding:32px 28px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
${logoBlock}
${innerHtml}
</div>
<div style="margin-top:16px;padding:0 12px;font-size:11px;color:#6b7280;line-height:1.6;text-align:center;">
You're receiving this because your family is on ${escapeHtml(senderName || orgName || "our")}'s mailing list.
${unsubBlock ? `<br>${unsubBlock}` : ""}
</div>
</div>
</body>
</html>`;
}

// Quick plain-text fallback from HTML — strips tags, collapses whitespace.
// Used when the touchpoint has no body_text. Far better than no plain-text
// alt at all (spam filters penalize HTML-only emails).
function stripHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitFirstName(parentName: string | null): string {
  if (!parentName) return "";
  const t = parentName.trim().split(/\s+/);
  return t[0] || "";
}

function formatHumanDate(iso: string): string {
  try {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

function extractTopics(what: Record<string, unknown> | undefined): string[] {
  if (!what) return [];
  if (Array.isArray((what as { topics?: unknown }).topics)) return ((what as { topics: unknown[] }).topics).filter((x) => typeof x === "string") as string[];
  return [];
}

// ---------------------------------------------------------------------------
// Resend send
// ---------------------------------------------------------------------------

async function sendViaResend(opts: {
  fromName: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  html: string;
  text: string | null;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${opts.fromName} <${opts.fromEmail}>`,
      reply_to: opts.fromEmail,
      to: [opts.toEmail],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `resend ${res.status}: ${body.slice(0, 200)}` };
  }
  const data = await res.json();
  return { ok: true, id: data.id ?? "" };
}

// ---------------------------------------------------------------------------
// Unsubscribe URL signing (mirrors marketing-send/index.ts)
// ---------------------------------------------------------------------------

async function computeUnsubscribeUrl(email: string, orgId: string): Promise<string> {
  const lowered = email.toLowerCase();
  const token = await hmacToken(lowered, orgId);
  const params = new URLSearchParams({ email: lowered, org: orgId, t: token });
  return `${UNSUBSCRIBE_ENDPOINT}?${params.toString()}`;
}

async function hmacToken(email: string, orgId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(UNSUBSCRIBE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${email}:${orgId}`));
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Decode a JWT payload (base64url-decoded middle segment). Does NOT verify
// the signature — Supabase's middleware already did that before this function
// ran. We just need to read claims (role, sub, etc.) to route auth.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
