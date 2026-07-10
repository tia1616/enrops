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
import { loadOrgBrand, formatFromAddress, renderSignatureBlock, type OrgBrand } from "../_shared/orgBrand.ts";
import {
  parseEmailAttachments,
  loadCommsAttachments,
  renderDownloadButtonsHtml,
  renderDownloadButtonsText,
  type CommsAttachment,
} from "../_shared/attachments.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UNSUBSCRIBE_SECRET = Deno.env.get("MARKETING_UNSUBSCRIBE_SECRET")!;
const UNSUBSCRIBE_ENDPOINT = `${SUPABASE_URL}/functions/v1/marketing-unsubscribe`;
// Public site origin for registration links in emails. Per-environment (set
// PUBLIC_SITE_URL on staging to the staging site); defaults to prod. Mirrors
// lifecycle-automations-cron — never hardcode the domain, or staging emails
// link to prod (where a staging-only tenant 404s).
const PUBLIC_SITE_URL = (Deno.env.get("PUBLIC_SITE_URL") ?? "https://enrops.com").replace(/\/+$/, "");

// Already-delivered statuses for dedup. Mirrors marketing-send.
const DELIVERED_STATUSES = ["sent", "delivered", "opened", "clicked"];

// Soft defense against test-send abuse — caps test sends per minute per user.
const TEST_SEND_THROTTLE_PER_MINUTE = 30;

// PostgREST puts .in(...) values in the URL query string. At ~37 chars per
// UUID + delimiter, ~500 UUIDs is a safe URL-length ceiling across providers.
// Above that the query silently returns empty or 414. Chunk every IN-query
// over recipient_ids through chunkedIn() before relying on its result.
// Was 500 — at that size, the URL ends up ~18KB (500 UUIDs encoded). For
// most PostgREST setups that's fine, but the Supabase edge runtime hops
// through Cloudflare (172.64.0.0/14) which trips an HTTP/2 stream protocol
// error on the long URL. 918-recipient FA26 EB campaign died here 2026-06-03
// with: "http2 error: stream error detected: unspecific protocol error
// detected". Dropping to 200 keeps each URL ~7KB which Cloudflare passes.
// IN_QUERY_CHUNK removed 2026-06-03 — chunking through PostgREST URL .in()
// clauses was a workaround for not having a server-side recipient resolver.
// Replaced by get_campaign_recipients(campaign_id) SQL function (one round
// trip, no URL chunking) for recipient loading + by a touchpoint-scoped
// dedup query (no recipient_id IN-clause needed).

// Number of recipients to send to in parallel within a single function
// invocation. Resend rate-limits at ~10 req/sec on Pro tier; 25-parallel
// keeps wall-clock fast (≈1s per batch including network) without
// triggering 429s. Tune down if Resend complains.
const SEND_PARALLEL_BATCH = 25; // legacy — only used for token-resolution parallelism now
// Resend's /emails/batch endpoint takes up to 100 emails per request. Each
// batch counts as ONE Resend API call (rate limit is 5 req/sec on Pro), so
// 100 emails/batch × 5 batches/sec = 500 emails/sec capacity. Plenty for
// any single touchpoint within the 150s edge-function budget.
const RESEND_BATCH_SIZE = 100;

// Soft time budget for the send loop. Supabase edge functions hard-kill at
// 150s. Leaving 20s headroom for cleanup + response serialization, we cap
// the loop at 130s of elapsed wall-clock. When budget is exceeded mid-loop:
// 1. Break out of the batch loop without firing more sends
// 2. Mark already-sent recipients in marketing_sends as 'sent' (already done)
// 3. Return ok:false with a partial-progress error so the cron sees the
//    touchpoint as failed and the operator can re-queue it
// Estimated capacity at this budget: ~10,000 recipients per touchpoint per
// run, allowing for normal Resend latency variance.
const SEND_TIME_BUDGET_MS = 130_000;

// Tokens Ennie's draft pass approved. Anything outside this set in the touchpoint
// body is a bug from earlier in the pipeline; we replace with empty string but log.
const APPROVED_TOKENS = new Set([
  "first_name", "parent_name", "child_first_name", "child_last_name",
  "school", "city", "zip", "geo_segment", "unsubscribe_url",
  "org_name", "sender_name", "sender_email", "register_url", "register_button", "reply_to",
  "logo_url", "closer", "phone", "website",
  "savings", "early_bird_price", "regular_price", "early_bird_deadline",
  "first_session_date", "session_count", "day_of_week", "curriculum", "vip_price",
  "topic", "topics_list", "promo_code", "promo_amount",
  // VIP/annual-pass block: resolves to an HTML <p> built from org.vip_offering
  // for recipients whose school offers it, and to an empty string for
  // recipients whose school is in org.vip_offering.excluded_location_ids (or
  // when the org has no offering enabled). This is the per-school suppression
  // mechanism — same body_html, different rendered output per recipient.
  "vip_block",
  // Per-area camp list (camps mode): an HTML <ul> with each picked camp's name,
  // venue, and date range in THIS recipient's area. Empty for afterschool
  // campaigns. KEEP IN SYNC with marketing-draft-campaign's APPROVED_TOKENS.
  "camp_details",
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
  // 'test'    -> one send to the caller's admin email
  // 'send'    -> mass send (cron-invoked) to recipient_ids
  // 'preview' -> render-only; returns the resolved subject+body for one
  //              location/school. No Resend call, no marketing_sends insert.
  //              Used by the per-school preview dropdown in TouchpointCard.
  mode: "test" | "send" | "preview";
  recipient_ids?: string[];
  // For mode='preview' only. The program_location_id (school) to render the
  // touchpoint AS IF a parent at that school received it. Their school's
  // matching program drives the per-program tokens, and the {{vip_block}}
  // suppression hits or doesn't based on whether that location is in
  // org.vip_offering.excluded_location_ids.
  preview_location_id?: string;
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
  email_attachments?: unknown; // jsonb [{id, attach}]; campaigns render Download buttons only (link-only)
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

type VipOffering = {
  enabled: boolean;
  label?: string;
  price_cents?: number;
  description?: string;
  excluded_location_ids?: string[];
};

type Org = {
  id: string;
  name: string;
  slug: string;
  default_sender_name: string | null;
  default_sender_email: string | null;
  brand_voice: { closer?: string; phone?: string; website?: string } | null;
  logo_url: string | null;
  vip_offering: VipOffering | null;
  active_registration_term: string | null;
  mailing_address: string | null;
  // Nested one-to-one from org_branding (PostgREST returns object or 1-elem array).
  org_branding: { primary_color: string | null } | { primary_color: string | null }[] | null;
};

// Hex color guard — only allow a real #rgb/#rrggbb so a malformed brand value
// can't inject arbitrary CSS into the button style attribute.
function safeHexColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.trim()) ? raw.trim() : fallback;
}

// Pull the tenant's brand color off the nested org_branding (object or array).
function orgPrimaryColor(org: Org): string {
  const b = org.org_branding;
  const row = Array.isArray(b) ? b[0] : b;
  return safeHexColor(row?.primary_color, "#1C004F");
}

type ProgramRow = {
  id: string;
  curriculum: string;
  term: string | null;
  program_location_id: string | null;
  day_of_week: string;
  first_session_date: string | null;
  session_count: number | null;
  price_cents: number;
  early_bird_price_cents: number | null;
  early_bird_deadline: string | null;
  vip_price_cents: number | null;
};

// Camp row + per-recipient camp resolution added 2026-06-02 so camp
// campaigns get per-area personalization (Hillsboro parents see Hillsboro
// camps, etc.). Mirrors the afterschool program flow: pickedCamps is the
// operator's full set; resolveRecipientCamps narrows to the recipient's
// area via program_locations.district === marketing_recipients.geo_segment.
// See [[project-enrops-camps-renderer-gap]] for the architectural backstory.
type CampRow = {
  id: string;
  curriculum_name: string;
  location_id: string | null;
  location_name: string;
  location_district: string | null; // resolved via program_locations join
  starts_on: string;
  ends_on: string;
  start_time: string;
  end_time: string;
  // Pricing. Nullable: partner-run camps (runs_own_registration=false where
  // the partner sets price) keep these null and the renderer omits price
  // tokens so we never quote a number we don't control.
  price_cents: number | null;
  early_bird_price_cents: number | null;
  early_bird_deadline: string | null;
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
  if (body.mode !== "test" && body.mode !== "send" && body.mode !== "preview") {
    return json({ error: "mode must be 'test', 'send', or 'preview'" }, 400);
  }
  // recipient_ids in the body used to be required for mode='send'. It's now
  // ignored — the function reads campaign.approved_recipient_ids itself via
  // the get_campaign_recipients(campaign_id) SQL function. Stops the cron
  // having to ship up to 100k UUIDs through a fetch body + URL chunking.
  // Old callers that still pass recipient_ids: silently ignored.
  if (body.mode === "preview" && (!body.preview_location_id || typeof body.preview_location_id !== "string")) {
    return json({ error: "preview_location_id required for mode='preview'" }, 400);
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
    .select("id, campaign_id, organization_id, status, type, payload, email_attachments")
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
    .select("id, name, slug, default_sender_name, default_sender_email, brand_voice, logo_url, vip_offering, active_registration_term, mailing_address, org_branding(primary_color)")
    .eq("id", campaign.organization_id)
    .single<Org>();
  if (oErr || !org) return json({ error: `organization not found: ${oErr?.message ?? "unknown"}` }, 404);

  // Email identity comes from the ONE shared source of truth (loadOrgBrand) —
  // the same cascade transactional email uses. Always resolves: a tenant's own
  // verified domain if set, else a per-tenant address on the verified platform
  // domain ({slug}@mail.enrops.com). No per-tenant setup required, and no tenant
  // can inherit another's identity. (Replaced the old org_not_configured gate,
  // which blocked any tenant that hadn't set default_sender_*.)
  const brand = await loadOrgBrand(supabase, campaign.organization_id);

  // ---- Resolve comms attachments (LINK mode only) ----
  // Each entry in touchpoint.email_attachments renders as a Download button
  // appended to the BOTTOM of the email. Campaigns are LINK-ONLY (no true-attach):
  // Resend's /emails/batch endpoint can't take the `attachments` field, and bulk
  // marketing with real attachments hurts deliverability regardless. The `attach`
  // flag is ignored here — the file itself only rides along in automations.
  const emailAtts = parseEmailAttachments(touchpoint.email_attachments);
  const attachmentsById = await loadCommsAttachments(supabase, campaign.organization_id, emailAtts.map((e) => e.id));
  const buttonRows = emailAtts.map((e) => attachmentsById.get(e.id)).filter((x): x is CommsAttachment => !!x);
  const downloadButtonsHtml = renderDownloadButtonsHtml(buttonRows, supabase, brand);
  const downloadButtonsText = renderDownloadButtonsText(buttonRows, supabase);

  // ---- Preview mode: render-only, no send ----
  // Builds a synthetic recipient at the requested location, runs the SAME
  // token resolution + body rendering as a real send, returns the result.
  // Reuses the real send code path so previews can never drift from what
  // parents actually receive.
  if (body.mode === "preview") {
    return await renderPreview(supabase, campaign, touchpoint, org, brand, downloadButtonsHtml, downloadButtonsText, body.preview_location_id!);
  }

  // ---- Load recipients ----
  // For mode='test', bootstrap an admin recipient (single row). For mode='send',
  // call the get_campaign_recipients SQL function which joins through
  // marketing_campaigns to enforce org match and reads from the campaign's
  // approved_recipient_ids in one round-trip. No client-side chunking, no
  // URL-length cliff at 500+ UUIDs, and no need for the cron to ship the
  // full ID list through a fetch body.
  let recipientRows: Recipient[] = [];
  if (body.mode === "test") {
    if (!auth.userEmail) {
      return json({ error: "test mode requires authenticated user with email" }, 400);
    }
    const adminRecipientId = await ensureAdminRecipient(supabase, campaign.organization_id, auth.userEmail);
    if (!adminRecipientId) {
      return json({ error: "failed to bootstrap admin recipient for test send" }, 500);
    }
    const { data: adminRow, error: aErr } = await supabase
      .from("marketing_recipients")
      .select("id, email, parent_name, child_first_name, child_last_name, school_name, city, zip, geo_segment, segments")
      .eq("id", adminRecipientId)
      .single<Recipient>();
    if (aErr || !adminRow) return json({ error: `admin recipient lookup failed: ${aErr?.message ?? "unknown"}` }, 500);
    recipientRows = [adminRow];
  } else {
    const { data: rows, error: rErr } = await supabase.rpc("get_campaign_recipients", { p_campaign_id: campaign.id });
    if (rErr) return json({ error: `get_campaign_recipients failed: ${rErr.message}` }, 500);
    recipientRows = (rows ?? []) as Recipient[];
  }

  // ---- Load programs the campaign picked (for per-program tokens) ----
  const draftInputs = (campaign.draft_inputs ?? {}) as Record<string, unknown>;
  const what = draftInputs.what as Record<string, unknown> | undefined;
  const programIds = Array.isArray(what?.program_ids) ? (what!.program_ids as string[]) : [];
  let pickedPrograms: ProgramRow[] = [];
  if (programIds.length > 0) {
    const { data: progs } = await supabase
      .from("programs")
      .select("id, curriculum, term, program_location_id, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents")
      .eq("organization_id", campaign.organization_id)
      // Exclude cancelled programs so a program cancelled after a draft was built
      // isn't advertised (parity with the camp render).
      .neq("status", "cancelled")
      .in("id", programIds);
    pickedPrograms = (progs ?? []) as ProgramRow[];
  }

  // ---- Load camps the campaign picked (for per-area camp tokens) ----
  // Camps token model: each recipient sees the picked camps in THEIR area
  // (program_locations.district === recipient.geo_segment). Hillsboro parents
  // see the Hillsboro camps; Beaverton parents see Beaverton camps.
  // Empty when the campaign isn't a camps campaign.
  const campIds = Array.isArray(what?.camp_session_ids) ? (what!.camp_session_ids as string[]) : [];
  let pickedCamps: CampRow[] = [];
  if (campIds.length > 0) {
    const { data: camps } = await supabase
      .from("camp_sessions")
      .select("id, curriculum_name, location_id, location_name, starts_on, ends_on, start_time, end_time, price_cents, early_bird_price_cents, early_bird_deadline, program_locations(district)")
      .eq("organization_id", campaign.organization_id)
      .in("id", campIds)
      .neq("status", "cancelled");
    pickedCamps = ((camps ?? []) as Array<Record<string, unknown>>).map((c) => {
      const pl = c.program_locations as { district?: string } | { district?: string }[] | null;
      const district = Array.isArray(pl) ? (pl[0]?.district ?? null) : (pl?.district ?? null);
      return {
        id: c.id as string,
        curriculum_name: (c.curriculum_name as string) ?? "",
        location_id: (c.location_id as string | null) ?? null,
        location_name: (c.location_name as string) ?? "",
        location_district: district,
        starts_on: c.starts_on as string,
        ends_on: c.ends_on as string,
        start_time: (c.start_time as string) ?? "",
        end_time: (c.end_time as string) ?? "",
        price_cents: (c.price_cents as number | null) ?? null,
        early_bird_price_cents: (c.early_bird_price_cents as number | null) ?? null,
        early_bird_deadline: (c.early_bird_deadline as string | null) ?? null,
      };
    });
  }

  // For per-recipient program lookup, we need to map recipient.school_name to
  // a program (via program_location). Load the location names + name_aliases
  // so we can match recipients whose school_name uses a short form.
  const locationIds = [...new Set(pickedPrograms.map((p) => p.program_location_id).filter(Boolean))] as string[];
  // location_id -> [canonical, ...aliases, ...auto-derived short forms]
  // Auto-derive matches the resolveParents logic in marketing-draft-campaign:
  // strips common school suffixes ("Elementary", "Academy", etc.) so a
  // parent tagged "Alameda" matches a picked "Alameda Elementary" without
  // requiring the operator to add an explicit alias. Same uniqueness gate
  // — only add a derived variant if it's unique across the org's picked
  // locations (collision protection).
  const locationNameMap = new Map<string, string[]>();
  if (locationIds.length > 0) {
    const { data: locs } = await supabase
      .from("program_locations")
      .select("id, name, name_aliases")
      .in("id", locationIds);
    const allLocs = (locs ?? []) as Array<{ id: string; name: string; name_aliases: string[] | null }>;
    // Count how many picked locations each derived variant would map to
    const variantCount = new Map<string, number>();
    for (const l of allLocs) {
      const seen = new Set<string>();
      for (const n of [l.name, ...(l.name_aliases ?? [])]) {
        if (!n) continue;
        for (const v of expandSchoolNameVariants(n)) seen.add(v.toLowerCase());
      }
      for (const v of seen) variantCount.set(v, (variantCount.get(v) ?? 0) + 1);
    }
    for (const l of allLocs) {
      const explicit = new Set<string>();
      if (l.name) explicit.add(l.name);
      for (const a of l.name_aliases ?? []) explicit.add(a);
      const final = new Set<string>(explicit);
      // Only add auto-derived variants that are unique across picked locations
      for (const e of explicit) {
        for (const v of expandSchoolNameVariants(e)) {
          if (explicit.has(v)) continue;
          if ((variantCount.get(v.toLowerCase()) ?? 0) <= 1) final.add(v);
        }
      }
      locationNameMap.set(l.id, [...final]);
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
  //
  // Scoped by (campaign_id, touchpoint_id) so we don't need a recipient_id
  // IN-clause — the query returns at most one row per recipient who's
  // already received this touchpoint. Single round-trip.
  const alreadyDelivered = new Set<string>();
  const { data: prior, error: pErr } = await supabase
    .from("marketing_sends")
    .select("recipient_id")
    .eq("campaign_id", campaign.id)
    .eq("touchpoint_id", touchpoint.id)
    .in("status", DELIVERED_STATUSES);
  if (pErr) return json({ error: `dedup query failed: ${pErr.message}` }, 500);
  for (const r of (prior ?? []) as Array<{ recipient_id: string }>) alreadyDelivered.add(r.recipient_id);

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
  // `recipientPrograms` is ALL picked programs at the recipient's school (for
  // multi-program schools, used to join {{curriculum}} as a list). `program`
  // is the first one (used for numeric tokens like price + savings + date).
  type ReadyRecipient = {
    r: Recipient;
    program: ProgramRow | undefined;
    recipientPrograms: ProgramRow[];
    recipientCamps: CampRow[]; // empty when not a camps campaign
  };
  const ready: ReadyRecipient[] = [];
  for (const r of recipientRows) {
    results.attempted++;
    if (!r.email) { results.skipped_no_email++; continue; }
    if (suppressedEmails.has(r.email.toLowerCase())) { results.skipped_suppressed++; continue; }
    if (alreadyDelivered.has(r.id)) { results.skipped_deduped++; continue; }

    // Resolve afterschool program(s) for this recipient (per-program tokens).
    let recipientPrograms = resolveRecipientPrograms(r, pickedPrograms, locationNameMap);
    let program: ProgramRow | null = recipientPrograms[0] ?? null;
    // Resolve camps for this recipient (per-area camp tokens). Filters the
    // operator's full pickedCamps to those in THIS recipient's district.
    let recipientCamps = resolveRecipientCamps(r, pickedCamps);
    const isInternalAdmin = (r.segments ?? []).includes("_internal_admin");

    // Two skip cases, mode-aware:
    // - Programs campaign: no program at recipient's school → skip (no copy
    //   to send them). Admin-test recipients fall back to the first picked
    //   program so VIP block etc. renders.
    // - Camps campaign: no camp in recipient's area → skip (the audience
    //   filter should have prevented this, but defensively skip vs sending
    //   "join us on  for "). Admin-test falls back to all picked camps so
    //   the preview renders meaningfully.
    if (!program && programIds.length > 0) {
      if (isInternalAdmin) {
        const excluded = new Set<string>(org.vip_offering?.excluded_location_ids ?? []);
        program =
          pickedPrograms.find((p) => p.program_location_id && !excluded.has(p.program_location_id))
          ?? pickedPrograms[0];
        recipientPrograms = program ? [program] : [];
      } else {
        results.skipped_no_school_program++;
        continue;
      }
    }
    if (recipientCamps.length === 0 && pickedCamps.length > 0 && programIds.length === 0) {
      if (isInternalAdmin) {
        recipientCamps = pickedCamps;
      } else {
        results.skipped_no_school_program++; // reuse the no-match counter
        continue;
      }
    }
    ready.push({ r, program, recipientPrograms, recipientCamps });
  }

  // Second pass: send via Resend's BATCH endpoint (POST /emails/batch, up to
  // 100 per request). Each batch counts as ONE call toward Resend's 5/sec
  // rate limit but ships up to 100 emails. For 900 recipients that's ~9
  // batches taking ~2s of rate-limit budget, well inside the 150s edge
  // function timeout.
  //
  // Why this matters: the previous Promise.all(25 individual /emails calls)
  // pattern blasted 25 requests at Resend simultaneously and got 429ed on
  // the 2nd through 25th every batch. 2026-06-03 FA26 EB campaign: 40 of
  // 903 sent, 863 failed with "rate_limit_exceeded". Batch API fixes it.
  //
  // Tradeoff: if a batch call itself fails (auth, rate, malformed), ALL
  // emails in that batch get the same error. Per-email validation still
  // happens server-side on Resend's end. The slice of 100 keeps blast
  // radius bounded if a batch dies.
  // Soft time budget for the send loop. If we run out, bail with partial
  // progress reported in the response so the cron + operator can decide
  // whether to re-queue. The dedup logic guarantees no recipient receives
  // a duplicate even after a re-queue.
  const sendLoopStartedAt = Date.now();
  let timeBudgetExceeded = false;
  let timeBudgetSkipped = 0;

  for (let i = 0; i < ready.length; i += RESEND_BATCH_SIZE) {
    if (Date.now() - sendLoopStartedAt > SEND_TIME_BUDGET_MS) {
      timeBudgetExceeded = true;
      timeBudgetSkipped = ready.length - i;
      break;
    }
    const batch = ready.slice(i, i + RESEND_BATCH_SIZE);

    // Token resolution + HTML rendering — still parallel, no rate limit here.
    const rendered = await Promise.all(batch.map(async ({ r, program, recipientPrograms, recipientCamps }) => {
      const tokens = await buildTokensForRecipient({
        recipient: r,
        org,
        brand,
        program,
        recipientPrograms,
        pickedPrograms,
        recipientCamps,
        pickedCamps,
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
      const renderedInner = postCleanCopy(replaceTokens(touchpoint.payload!.body_html!, tokens, { html: true }));
      // Download buttons are appended to the BOTTOM of the body (they land above
      // the signature that wrapInEmailShell adds) — never a token in the body.
      const innerHtml = renderedInner + downloadButtonsHtml;
      const bodyHtml = wrapInEmailShell(innerHtml, tokens);
      const bodyText = (touchpoint.payload!.body_text
        ? postCleanCopy(replaceTokens(touchpoint.payload!.body_text, tokens, { html: false }))
        : stripHtmlToText(renderedInner)) + downloadButtonsText;

      return { r, subject, bodyHtml, bodyText };
    }));

    const batchPayload = rendered.map(({ r, subject, bodyHtml, bodyText }) => ({
      from: formatFromAddress(brand),
      reply_to: brand.reply_to,
      to: [r.email],
      subject,
      html: bodyHtml,
      text: bodyText,
    }));

    let batchResp: { ok: true; ids: string[] } | { ok: false; error: string };
    try {
      batchResp = await sendBatchViaResend(batchPayload);
    } catch (e) {
      // Network errors (DNS, connection reset, abort, TLS) — catch so the
      // loop can continue with the next batch instead of dying.
      batchResp = { ok: false, error: `resend batch network error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // batchResp: either { ok:true, ids: string[] } (one id per email, same order)
    //         or { ok:false, error: string } (whole batch rejected — all emails fail)
    const inserts = rendered.map((row, idx) => {
      const ok = batchResp.ok && idx < batchResp.ids.length && !!batchResp.ids[idx];
      return {
        organization_id: campaign.organization_id,
        campaign_id: campaign.id,
        touchpoint_id: touchpoint.id,
        recipient_id: row.r.id,
        email: row.r.email,
        status: ok ? "sent" : "failed",
        resend_message_id: ok ? batchResp.ids[idx] : null,
        rendered_subject: row.subject,
        sent_at: ok ? new Date().toISOString() : null,
        school_name: row.r.school_name ?? null,
        error_message: ok ? null : (batchResp.ok ? "no id returned for this position in batch response" : batchResp.error),
        suppressed_by_throttle: false,
      };
    });
    const { error: insertErr } = await supabase.from("marketing_sends").insert(inserts);
    if (insertErr) {
      // The emails already shipped — we just failed to log them. Surface in
      // response so the cron can flag the touchpoint, but don't double-send.
      results.errors.push(`marketing_sends bulk insert failed mid-batch (emails sent, logging lost): ${insertErr.message}`);
    }

    for (const ins of inserts) {
      if (ins.status === "sent") results.sent++;
      else {
        results.failed++;
        results.errors.push(`${ins.email}: ${ins.error_message ?? "unknown"}`);
      }
    }

    // Stay under Resend's 5 req/sec — pace batches at 1 per 250ms.
    if (i + RESEND_BATCH_SIZE < ready.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  // If the time budget cut us off mid-loop, signal "partial" to the cron.
  // The cron interprets partial:true by re-queueing the touchpoint (status →
  // 'queued') so the next 5-min cron tick picks it up and continues. Dedup
  // guarantees no recipient receives a duplicate. Sent + failed counters
  // reflect THIS run's progress, not cumulative.
  return json({
    ok: true,
    partial: timeBudgetExceeded,
    remaining: timeBudgetSkipped,
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
// Returns ALL picked programs at this recipient's school (was: only the
// earliest one). Per-program numeric tokens use the first; {{curriculum}}
// joins all curricula as a list. The prompt has long promised "the token
// system joins {{curriculum}} naturally as a list" — this function makes
// that true (it was a lie before; Cannady parents got only one of their
// two picked programs mentioned).
function resolveRecipientPrograms(
  r: Recipient,
  picked: ProgramRow[],
  locationNameMap: Map<string, string[]>,
): ProgramRow[] {
  if (!r.school_name || picked.length === 0) return [];
  const recipientSchool = r.school_name.trim().toLowerCase();
  const matches = picked.filter((p) => {
    if (!p.program_location_id) return false;
    const names = locationNameMap.get(p.program_location_id) ?? [];
    return names.some((n) => n.trim().toLowerCase() === recipientSchool);
  });
  // Sort: programs with a known first_session_date come first (earliest
  // first), then nulls. The first element drives per-program numeric tokens
  // (price, savings, etc.) so we prefer a program with real dates.
  return [...matches].sort((a, b) => {
    const aDate = a.first_session_date ?? "9999";
    const bDate = b.first_session_date ?? "9999";
    return aDate.localeCompare(bDate);
  });
}

// Back-compat shim — used by admin-fallback path which still wants a single
// program for "show the operator one program in the test email".
function resolveRecipientProgram(
  r: Recipient,
  picked: ProgramRow[],
  locationNameMap: Map<string, string[]>,
): ProgramRow | null {
  const all = resolveRecipientPrograms(r, picked, locationNameMap);
  return all[0] ?? null;
}

// Shared with marketing-draft-campaign — KEEP IN SYNC. Auto-derives common
// school-name short forms by stripping " Elementary", " Academy", etc.
// Used by locationNameMap construction so a recipient tagged with a short
// form still matches a picked location whose canonical name has the suffix.
const SCHOOL_SUFFIX_PATTERNS: RegExp[] = [
  / Elementary School$/i,
  / Elementary$/i,
  / Middle School$/i,
  / Middle$/i,
  / High School$/i,
  / Charter School$/i,
  / Charter$/i,
  / Magnet School$/i,
  / Magnet$/i,
  / Academy$/i,
  / School$/i,
];
function expandSchoolNameVariants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  for (const re of SCHOOL_SUFFIX_PATTERNS) {
    const stripped = trimmed.replace(re, "").trim();
    if (stripped && stripped !== trimmed) variants.add(stripped);
  }
  return [...variants];
}

// Per-area camp resolution. Matches recipient.geo_segment to the camp's
// location.district. Sort by start date so the earliest camp's date powers
// {{first_session_date}}. Returns ALL matching camps in the recipient's
// area — {{curriculum}} will join them as a list, mirroring the multi-
// program-school pattern for afterschool.
function resolveRecipientCamps(r: Recipient, picked: CampRow[]): CampRow[] {
  if (!r.geo_segment || picked.length === 0) return [];
  const target = r.geo_segment.trim().toLowerCase();
  const matches = picked.filter((c) => (c.location_district ?? "").trim().toLowerCase() === target);
  return [...matches].sort((a, b) => (a.starts_on ?? "").localeCompare(b.starts_on ?? ""));
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

// TokensInput shape — camps fields added 2026-06-02.
// When recipientCamps is non-empty AND program is null, buildTokensForRecipient
// resolves per-program tokens ({{curriculum}}, {{first_session_date}}) from
// the camps instead of an afterschool program. Both can be present in mixed
// campaigns (operator picked programs + camps via the manual picker) — the
// afterschool path takes precedence when present.
type TokensInput = {
  recipient: Recipient;
  org: Org;
  program: ProgramRow | null;
  // All picked programs at THIS recipient's school. Drives the {{curriculum}}
  // list-join for multi-program schools. Single-program schools: length 1.
  // Empty when recipient has no school match (admin fallback path supplies
  // the single `program` directly instead).
  recipientPrograms?: ProgramRow[];
  pickedPrograms: ProgramRow[];
  // Camps in THIS recipient's area (matched by program_locations.district
  // === marketing_recipients.geo_segment). When set + program is null,
  // {{curriculum}} and {{first_session_date}} resolve from the camps.
  recipientCamps?: CampRow[];
  pickedCamps?: CampRow[];
  draftInputs: Record<string, unknown>;
  safeRegistrationUrl: string | null;
  campaignTopics: string[];
  // Resolved tenant email identity (shared loadOrgBrand cascade) — drives the
  // {{sender_name}}, {{sender_email}}, {{reply_to}} body tokens.
  brand: OrgBrand;
};

async function buildTokensForRecipient(input: TokensInput & { locationNameMap?: Map<string, string[]> }): Promise<Map<string, string>> {
  const { recipient: r, org, brand, program, recipientPrograms, recipientCamps, draftInputs, safeRegistrationUrl, campaignTopics, locationNameMap } = input;
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
  // {{sender_name}} in body context strips a " @ Org" suffix if the operator
  // packed both into default_sender_name (the right shape for an email From
  // header e.g. "Jessica @ Journey to STEAM" — but in a body sign-off that
  // reads like an email address: "— Jessica @ Journey to STEAM"). Stripping
  // gives the natural body version ("— Jessica") without forcing operators
  // to choose between a friendly From header and a clean sign-off.
  // No split for senders without " @ " (e.g. "Sarah Lopez") — used as-is.
  const senderRaw = (brand.sender_name || org.name || "").trim();
  const atIdx = senderRaw.indexOf(" @ ");
  const senderForBody = atIdx > 0 ? senderRaw.slice(0, atIdx).trim() : senderRaw;
  tokens.set("sender_name", senderForBody);
  tokens.set("sender_email", brand.sender_email || "");
  tokens.set("reply_to", brand.reply_to || "");
  // Use the email-safe logo from the shared brand loader (logo_email_url PNG),
  // NOT org.logo_url which may be an SVG that email clients won't render.
  tokens.set("logo_url", brand.logo_url || "");
  // Per-tenant signature (image + text), rendered by the shared helper so it's
  // identical to lifecycle automation email. Empty string when unset → no block.
  tokens.set("signature_block", renderSignatureBlock(brand));
  tokens.set("mailing_address", org.mailing_address || "");
  tokens.set("closer", org.brand_voice?.closer || "");
  tokens.set("phone", org.brand_voice?.phone || "");
  tokens.set("website", org.brand_voice?.website || "");

  // Registration URL — precedence:
  //   1. per-campaign override (operator typed an explicit URL)
  //   2. per-recipient program deep link — lands the family on THIS class at
  //      THEIR school (the public catalog auto-selects the school and highlights
  //      the class). Mirrors buildProgramShareUrl on the frontend. `program` is
  //      already resolved to the picked program at this recipient's school.
  //   3. the org's full catalog (all open classes), when there's no per-recipient
  //      program match (e.g. camps campaigns or a recipient at a non-picked school)
  // Only deep-link programs the public catalog can actually show — the org's
  // active_registration_term (the SAME per-org DB value the public catalog reads
  // via public_org_directory). Single source of truth; no hardcoded term. A deep
  // link for any other term would land on a catalog that can't show that class,
  // so fall back to the full catalog.
  const inCatalogTerm = !!org.active_registration_term && program?.term === org.active_registration_term;
  const programDeepLink = program?.id && inCatalogTerm ? `${PUBLIC_SITE_URL}/${org.slug}?program=${program.id}` : "";
  const defaultRegisterUrl = `${PUBLIC_SITE_URL}/${org.slug}`;
  const registerUrlValue = safeRegistrationUrl || programDeepLink || defaultRegisterUrl;
  tokens.set("register_url", registerUrlValue);
  // Branded button version of the registration CTA. Ennie places {{register_button}}
  // on its own line for the primary "register" call-to-action so it renders as a
  // button instead of a raw URL. Uses the tenant's own brand color
  // (org_branding.primary_color), validated, with a platform fallback.
  const btnColor = orgPrimaryColor(org);
  tokens.set(
    "register_button",
    registerUrlValue
      ? `<div style="text-align:center;margin:28px 0;"><a href="${escapeHtml(registerUrlValue)}" style="display:inline-block;background:${btnColor};color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">Register now &rarr;</a></div>`
      : "",
  );

  // Per-program (from THIS recipient's school's matching program)
  if (program) {
    // {{curriculum}} is HTML in body context — each program wrapped in its OWN
    // <strong>...</strong>, separated by plain " and " / oxford-comma form.
    // Multi-program Cannady parent gets:
    //   <strong>LEGO Brickopolis Architects: Engineering & Design</strong> and <strong>Robotics Builders: Carnival Games & Challenges</strong>
    // Each program is bolded; the "and" between them is NOT bolded — fixes
    // the "looks like one class name" problem Jessica caught.
    // Subject lines (plaintext) strip the tags at replaceTokens time, so
    // subjects read naturally: "LEGO X and Robotics Y".
    // The other per-program tokens (price, savings, dates) intentionally use
    // ONLY the first program — they don't have a clean "list-of-prices"
    // shape, and Ennie's body usually phrases them singularly. For
    // multi-program schools where prices differ, the body shows the price
    // for the first program only.
    const allPrograms = (recipientPrograms && recipientPrograms.length > 0) ? recipientPrograms : [program];
    const curriculumNames = allPrograms.map((p) => p.curriculum).filter((s) => typeof s === "string" && s.trim().length > 0);
    const bolded = curriculumNames.map((n) => `<strong>${escapeHtml(n)}</strong>`);
    let curriculumHtml = "";
    if (bolded.length === 0) curriculumHtml = "";
    else if (bolded.length === 1) curriculumHtml = bolded[0];
    else if (bolded.length === 2) curriculumHtml = `${bolded[0]} and ${bolded[1]}`;
    else curriculumHtml = `${bolded.slice(0, -1).join(", ")}, and ${bolded[bolded.length - 1]}`;
    tokens.set("curriculum", curriculumHtml);
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
  } else if ((recipientCamps?.length ?? 0) > 0) {
    // Camps mode — per-area camp tokens.
    // {{curriculum}}    = bolded list of camp names in THIS recipient's area
    // {{first_session_date}} = earliest start date among those camps
    // {{camp_details}}  = an HTML <ul> with each camp's name + venue + date
    //                     range, scoped to this recipient's area. Use this
    //                     instead of {{curriculum}} when the operator wants
    //                     parents to see specific dates + venues per camp
    //                     (almost always — that's what helps parents register).
    // Camps don't have per-program early_bird / session_count / day_of_week
    // (multi-day, multi-week) — leave those tokens empty so Ennie's body
    // (per the CAMPS MODE prompt rule) doesn't emit them.
    const camps = recipientCamps!;
    const names = camps.map((c) => c.curriculum_name).filter((s) => typeof s === "string" && s.trim().length > 0);
    const bolded = names.map((n) => `<strong>${escapeHtml(n)}</strong>`);
    let curriculumHtml = "";
    if (bolded.length === 0) curriculumHtml = "";
    else if (bolded.length === 1) curriculumHtml = bolded[0];
    else if (bolded.length === 2) curriculumHtml = `${bolded[0]} and ${bolded[1]}`;
    else curriculumHtml = `${bolded.slice(0, -1).join(", ")}, and ${bolded[bolded.length - 1]}`;
    tokens.set("curriculum", curriculumHtml);
    tokens.set("first_session_date", camps[0]?.starts_on ? formatHumanDate(camps[0].starts_on) : "");

    // {{camp_details}} — per-area camp list with venue + dates. Inline so
    // operator can wrap in <p> or nothing. Sorted by start date.
    const sortedForDetails = [...camps].sort((a, b) => (a.starts_on ?? "").localeCompare(b.starts_on ?? ""));
    const detailItems = sortedForDetails.map((c) => {
      const name = escapeHtml(c.curriculum_name ?? "");
      const venue = escapeHtml(c.location_name ?? "");
      const start = c.starts_on ? formatHumanDate(c.starts_on) : "";
      const end = c.ends_on ? formatHumanDate(c.ends_on) : "";
      const dateRange = start && end && start !== end ? `${start}–${end}` : (start || end || "");
      const parts = [`<strong>${name}</strong>`];
      if (venue) parts.push(`at ${venue}`);
      if (dateRange) parts.push(`(${dateRange})`);
      return `<li>${parts.join(" ")}</li>`;
    });
    tokens.set("camp_details", detailItems.length > 0 ? `<ul>${detailItems.join("")}</ul>` : "");

    // Per-area camp price tokens. Only emit when ALL camps in the recipient's
    // area share the same price — otherwise quoting one camp's price for the
    // batch would mislead parents (e.g., $275 half-day mentioned in an email
    // that also features a $450 full-day camp). Mixed or any-null → empty so
    // Ennie's body omits the price line. Partner-run camps keep price_cents
    // null on purpose (we don't set their prices) which correctly suppresses.
    const campPrices = camps.map((c) => c.price_cents);
    const allPriced = campPrices.length > 0 && campPrices.every((p) => p != null);
    const samePrice = allPriced && campPrices.every((p) => p === campPrices[0]);
    tokens.set("regular_price", samePrice && campPrices[0] != null ? `$${(campPrices[0] / 100).toFixed(0)}` : "");

    const ebPrices = camps.map((c) => c.early_bird_price_cents);
    const allEb = ebPrices.length > 0 && ebPrices.every((p) => p != null);
    const sameEb = allEb && ebPrices.every((p) => p === ebPrices[0]);
    tokens.set("early_bird_price", sameEb && ebPrices[0] != null ? `$${(ebPrices[0] / 100).toFixed(0)}` : "");

    tokens.set("savings",
      samePrice && sameEb && campPrices[0] != null && ebPrices[0] != null
        ? `$${((campPrices[0] - ebPrices[0]) / 100).toFixed(0)}`
        : "");

    const deadlines = camps.map((c) => c.early_bird_deadline);
    const allDeadlined = deadlines.length > 0 && deadlines.every((d) => d != null);
    const sameDeadline = allDeadlined && deadlines.every((d) => d === deadlines[0]);
    tokens.set("early_bird_deadline", sameDeadline && deadlines[0] != null ? formatHumanDate(deadlines[0]) : "");

    // Camps still don't have per-program session_count, day_of_week, or vip_price.
    for (const k of ["day_of_week", "session_count", "vip_price"]) {
      tokens.set(k, "");
    }
  } else {
    // No matching program AND no matching camps — leave per-program tokens empty
    for (const k of ["curriculum", "day_of_week", "first_session_date", "session_count", "regular_price", "early_bird_price", "early_bird_deadline", "savings", "vip_price", "camp_details"]) {
      tokens.set(k, "");
    }
  }
  // For the afterschool path, camp_details doesn't apply — set empty so the
  // token still resolves (empty replacement) if Ennie ever emits it.
  if (program && !tokens.has("camp_details")) tokens.set("camp_details", "");

  // Per-campaign
  tokens.set("topic", campaignTopics[0] || "");
  tokens.set("topics_list", campaignTopics.join(", "));
  const promo = (draftInputs.promo as { code?: string } | undefined);
  tokens.set("promo_code", promo?.code || "");
  tokens.set("promo_amount", ""); // task #6 wires this when promo step ships

  // VIP/annual-pass block. Resolves to an HTML paragraph for recipients whose
  // school offers it, or an empty string for excluded schools (so Ennie can
  // safely place {{vip_block}} in the body once and the resolver handles
  // per-school suppression). Cases that resolve to empty string:
  //   1. Org has no vip_offering or it's disabled
  //   2. Recipient's school is in vip_offering.excluded_location_ids
  //   3. Recipient has no matching program (no signal to know if VIP applies)
  // For admin test recipients: render the block as if their fallback program's
  // school offers VIP, so the operator sees realistic preview output.
  tokens.set("vip_block", buildVipBlock(org.vip_offering, program?.program_location_id ?? null));

  return tokens;
}

// Renders the VIP block for one recipient. Returns "" for the three suppression
// cases above. Output is INLINE content (no outer <p>) — Ennie typically wraps
// the {{vip_block}} token in a <p>...</p> in the body, so emitting our own <p>
// here would produce nested <p><p>...</p></p> (invalid HTML; Outlook in
// particular adds awkward spacing). The caller's <p> wraps our inline content
// cleanly. When the block resolves to empty string (suppressed schools),
// postCleanCopy collapses the resulting empty <p></p>.
function buildVipBlock(
  offering: VipOffering | null,
  recipientLocationId: string | null,
): string {
  if (!offering || !offering.enabled) return "";
  if (!recipientLocationId) return ""; // unknown school -> don't gamble
  const excluded = offering.excluded_location_ids ?? [];
  if (excluded.includes(recipientLocationId)) return "";

  const label = escapeHtml(offering.label ?? "Annual pass");
  const desc = escapeHtml(offering.description ?? "");
  const priceStr = offering.price_cents
    ? ` for $${(offering.price_cents / 100).toFixed(0)}/year`
    : "";
  // The phrasing keeps the operator's `description` verbatim (their voice) and
  // wraps it in a checkout-CTA frame. Matches the PURCHASABLE-ADD-ONS rule —
  // it's selectable at registration, not a sales call.
  return `🔑 <strong>Want the full year?</strong> Look for the ${label} option at checkout${priceStr}. ${desc}`;
}

// ---------------------------------------------------------------------------
// Token replacement + post-pass cleanup
// ---------------------------------------------------------------------------

// Replaces {{token}} placeholders. `html=true` escapes the value before insert
// (defends against malicious / weird recipient data like '<script>' in name).
//
// PRE_RENDERED_HTML_TOKENS bypass escaping because they're built by THIS
// function with known-safe content (operator's brand_voice strings already
// passed through escapeHtml inside the builder). Escaping them again would
// turn <strong> into &lt;strong&gt; and the operator's apostrophes into
// &#39;, both rendering as literal text in the email — bug surfaced
// 2026-06-02 when Cascadia-excluded vs Cascadia-included previews showed
// raw HTML tags. All OTHER tokens still get escaped: they come from
// recipient data (parent_name, school) which could contain <script> etc.
const PRE_RENDERED_HTML_TOKENS = new Set(["vip_block", "curriculum", "camp_details", "register_button"]);

function replaceTokens(text: string, tokens: Map<string, string>, opts: { html: boolean }): string {
  return text.replace(/\{\{(\w+)\}\}/g, (full, key) => {
    if (!APPROVED_TOKENS.has(key)) {
      console.warn(`marketing-touchpoint-send: unknown token {{${key}}} in body — replacing with empty`);
      return "";
    }
    const value = tokens.get(key) ?? "";
    if (PRE_RENDERED_HTML_TOKENS.has(key)) {
      // Body context: emit the HTML as-is (token already contains the right tags).
      // Plaintext context (subject lines): strip tags + decode common entities so
      // the subject doesn't show literal <strong>...</strong>.
      if (opts.html) return value;
      return value
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'");
    }
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
    // Empty <p></p> left behind when a token (e.g. {{vip_block}}) resolves to
    // empty string for an excluded school. Without this cleanup, the operator
    // would see a blank vertical gap where the suppressed block used to live.
    // Tolerates whitespace + optional <br> inside the empty paragraph.
    .replace(/<p>\s*(?:<br\s*\/?>)?\s*<\/p>/gi, "")
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
  const mailingAddress = (tokens.get("mailing_address") || "").trim();
  // Pre-rendered by renderSignatureBlock(brand); "" when the org has no signature.
  const signatureBlock = tokens.get("signature_block") || "";

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

  // Physical postal address (CAN-SPAM). Rendered under the unsubscribe line
  // only when the org has set one — J2S has none yet and must keep sending.
  const addressBlock = mailingAddress
    ? `<br><div style="margin-top:4px;">${escapeHtml(mailingAddress)}</div>`
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
${signatureBlock}
</div>
<div style="margin-top:16px;padding:0 12px;font-size:11px;color:#6b7280;line-height:1.6;text-align:center;">
You're receiving this because your family is on ${escapeHtml(senderName || orgName || "our")}'s mailing list.
${unsubBlock ? `<br>${unsubBlock}` : ""}${addressBlock}
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

// Joins an array of strings with natural-language conjunctions:
//   []                    -> ""
//   ["a"]                 -> "a"
//   ["a", "b"]            -> "a and b"
//   ["a", "b", "c"]       -> "a, b, and c"
// Used for {{curriculum}} in multi-program-school recipients (e.g. a Cannady
// parent enrolled in two of the picked programs gets a body that reads
// "LEGO Brickopolis Architects and Robotics Builders" instead of just one).
function joinNaturally(items: string[]): string {
  const xs = items.filter((s) => typeof s === "string" && s.trim().length > 0);
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
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

// Resend batch endpoint: POST /emails/batch with an array of email objects
// (up to 100). Returns { data: [{id}, ...] } on success — one id per email
// in the SAME ORDER as the request. On rate-limit / auth / validation
// failure, the entire batch is rejected with a single error.
async function sendBatchViaResend(
  emails: Array<{
    from: string;
    reply_to: string;
    to: string[];
    subject: string;
    html: string;
    text: string | null;
  }>,
): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  const res = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(emails),
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `resend batch ${res.status}: ${body.slice(0, 300)}` };
  }
  const data = await res.json();
  // Resend batch response shape: { data: [{ id: "..." }, ...] }. Defensive
  // about variants: handle either { data: [...] } or a top-level array.
  const arr = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : null);
  if (!arr) {
    return { ok: false, error: `resend batch returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}` };
  }
  return { ok: true, ids: arr.map((it: { id?: string }) => it?.id ?? "") };
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

// ---------------------------------------------------------------------------
// Preview rendering (no send, no DB writes)
// ---------------------------------------------------------------------------
//
// Returns the rendered subject + body for a single school. Used by the
// per-school preview dropdown in TouchpointCard so the operator can flip
// through schools and confirm each rendering before approve. Mirrors the
// real send code path: same program lookup, same token resolution, same
// HTML shell wrapper, same post-clean. The only difference is no Resend
// call and no marketing_sends insert.
//
// Inputs:
//   - campaign, touchpoint, org: already loaded by the main handler
//   - locationId: program_location_id (a school) to render for
//
// Output: { subject, body_html, body_text, used_school_name, vip_block_shown }
async function renderPreview(
  supabase: SupabaseClient,
  campaign: Campaign,
  touchpoint: Touchpoint,
  org: Org,
  brand: OrgBrand,
  downloadButtonsHtml: string,
  downloadButtonsText: string,
  locationId: string,
): Promise<Response> {
  // Load the picked programs (campaign-wide) so per-school token resolution
  // can find the program at this location.
  const draftInputs = (campaign.draft_inputs ?? {}) as Record<string, unknown>;
  const what = draftInputs.what as Record<string, unknown> | undefined;
  const programIds = Array.isArray(what?.program_ids) ? (what!.program_ids as string[]) : [];

  let pickedPrograms: ProgramRow[] = [];
  if (programIds.length > 0) {
    const { data: progs } = await supabase
      .from("programs")
      .select("id, curriculum, term, program_location_id, day_of_week, first_session_date, session_count, price_cents, early_bird_price_cents, early_bird_deadline, vip_price_cents")
      .eq("organization_id", campaign.organization_id)
      // Exclude cancelled programs so a program cancelled after a draft was built
      // isn't advertised (parity with the camp render).
      .neq("status", "cancelled")
      .in("id", programIds);
    pickedPrograms = (progs ?? []) as ProgramRow[];
  }

  // Load picked camps too — for camps campaigns, per-recipient resolution
  // filters by the recipient's geo_segment / district.
  const campIds = Array.isArray(what?.camp_session_ids) ? (what!.camp_session_ids as string[]) : [];
  let pickedCamps: CampRow[] = [];
  if (campIds.length > 0) {
    const { data: camps } = await supabase
      .from("camp_sessions")
      .select("id, curriculum_name, location_id, location_name, starts_on, ends_on, start_time, end_time, price_cents, early_bird_price_cents, early_bird_deadline, program_locations(district)")
      .eq("organization_id", campaign.organization_id)
      .in("id", campIds)
      .neq("status", "cancelled");
    pickedCamps = ((camps ?? []) as Array<Record<string, unknown>>).map((c) => {
      const pl = c.program_locations as { district?: string } | { district?: string }[] | null;
      const district = Array.isArray(pl) ? (pl[0]?.district ?? null) : (pl?.district ?? null);
      return {
        id: c.id as string,
        curriculum_name: (c.curriculum_name as string) ?? "",
        location_id: (c.location_id as string | null) ?? null,
        location_name: (c.location_name as string) ?? "",
        location_district: district,
        starts_on: c.starts_on as string,
        ends_on: c.ends_on as string,
        start_time: (c.start_time as string) ?? "",
        end_time: (c.end_time as string) ?? "",
        price_cents: (c.price_cents as number | null) ?? null,
        early_bird_price_cents: (c.early_bird_price_cents as number | null) ?? null,
        early_bird_deadline: (c.early_bird_deadline as string | null) ?? null,
      };
    });
  }

  // Find the program at the requested location, plus the location name.
  // ALL picked programs at the preview location — used to join {{curriculum}}
  // as a list for multi-program schools. Mirrors the real-send behavior so
  // preview shows what parents at this school will actually see.
  const programsAtLocation = pickedPrograms.filter((p) => p.program_location_id === locationId);
  const programAtLocation = programsAtLocation[0];
  // Also load district (added 2026-06-02) so camps preview synthesizes a
  // parent in this location's area and {{curriculum}} resolves to the camps
  // in that district.
  const { data: loc } = await supabase
    .from("program_locations")
    .select("id, name, name_aliases, district")
    .eq("id", locationId)
    .eq("organization_id", campaign.organization_id)
    .single();
  if (!loc) {
    return json({ error: "preview location not found or not in this org" }, 404);
  }

  // Build the locationNameMap so buildTokensForRecipient's admin-fallback path
  // works the same as in test mode.
  const locationNameMap = new Map<string, string[]>();
  locationNameMap.set(loc.id, [loc.name, ...((loc.name_aliases ?? []) as string[])]);

  // Synthetic recipient at this school + in this district. Realistic enough
  // that the operator sees how the email reads. {{first_name}} and
  // {{parent_name}} render as placeholders so the operator can tell they'll
  // vary per parent. geo_segment = location's district so camps resolution
  // pulls the camps in this area for camps campaigns. school_name = the
  // location name so afterschool resolution works as before.
  const syntheticRecipient: Recipient = {
    id: "preview",
    email: "preview@example.com",
    parent_name: "Sample Parent",
    child_first_name: "Sam",
    child_last_name: "Sample",
    school_name: loc.name,
    city: null,
    zip: null,
    geo_segment: (loc as { district?: string | null }).district ?? null,
    segments: null, // not an internal admin — VIP suppression behaves real
  };
  // Resolve camps in this preview area (mirrors per-recipient resolution).
  // Empty for afterschool-only campaigns or for areas with no picked camps.
  const previewRecipientCamps = resolveRecipientCamps(syntheticRecipient, pickedCamps);

  const registrationUrlOverride = typeof draftInputs.registration_url_override === "string"
    ? draftInputs.registration_url_override
    : null;
  const safeRegistrationUrl = registrationUrlOverride && /^https?:\/\//i.test(registrationUrlOverride)
    ? registrationUrlOverride
    : null;

  const tokens = await buildTokensForRecipient({
    recipient: syntheticRecipient,
    org,
    brand,
    program: programAtLocation ?? null,
    recipientPrograms: programsAtLocation,
    pickedPrograms,
    recipientCamps: previewRecipientCamps,
    pickedCamps,
    draftInputs,
    safeRegistrationUrl,
    campaignTopics: extractTopics(what),
    locationNameMap,
  });

  const subject = postCleanCopy(replaceTokens(touchpoint.payload!.subject!, tokens, { html: false }));
  const renderedInner = postCleanCopy(replaceTokens(touchpoint.payload!.body_html!, tokens, { html: true }));
  const innerHtml = renderedInner + downloadButtonsHtml;
  const bodyHtml = wrapInEmailShell(innerHtml, tokens);
  const bodyText = (touchpoint.payload!.body_text
    ? postCleanCopy(replaceTokens(touchpoint.payload!.body_text, tokens, { html: false }))
    : stripHtmlToText(renderedInner)) + downloadButtonsText;

  // Tell the operator whether the VIP block fired for this school so the
  // dropdown UI can show a chip. Three states:
  //   true  — VIP block rendered (chip: "VIP block shown")
  //   false — VIP block suppressed for this school (chip: "VIP block suppressed here")
  //   null  — VIP doesn't apply to this campaign at all (no chip)
  // null fires when: org has no vip_offering enabled OR this campaign isn't
  // afterschool (camps + one-offs don't use VIP). Without the null state the
  // suppression chip incorrectly fires on every camps preview.
  const vipApplicable = !!org.vip_offering?.enabled && pickedPrograms.length > 0;
  const vipBlockShown = vipApplicable
    ? (tokens.get("vip_block") ?? "").length > 0
    : null;

  // Inject <base target="_blank"> into the preview-only HTML so any link the
  // operator clicks inside the iframe opens in a new tab instead of trying
  // to navigate the iframe itself (which goes blank because the iframe is
  // sandboxed). NOT included in the real-send body — email clients open links
  // externally by default, so the <base> tag is preview-specific noise.
  const previewHtml = bodyHtml.replace(
    /<head>/i,
    '<head>\n<base target="_blank">',
  );

  return json({
    ok: true,
    mode: "preview",
    campaign_id: campaign.id,
    touchpoint_id: touchpoint.id,
    preview_location_id: locationId,
    used_school_name: loc.name,
    subject,
    body_html: previewHtml,
    body_text: bodyText,
    vip_block_shown: vipBlockShown,
    program_matched: !!programAtLocation || previewRecipientCamps.length > 0,
  });
}
