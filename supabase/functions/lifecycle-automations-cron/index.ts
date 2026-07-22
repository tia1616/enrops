// lifecycle-automations-cron — fires informational automations (Welcome,
// Mid-recap, etc.) once per day. Reads enabled automations across all orgs,
// resolves per-trigger audience, and sends via Resend with idempotency.
//
// Wired triggers (resolve a real audience and send):
//   - days_before_first_session    (welcome_camp, welcome_afterschool)
//   - event_registration_abandoned (abandoned_registration, 24h pending)
//   - days_after_first_session     (check_in)
//   - session_midpoint             (mid_recap)
//   - session_last_day             (final_recap)
//   - birthday                     (birthday — family/student audience)
//   - instructor_birthday          (instructor_birthday — active instructors, by
//                                   instructors.date_of_birth; instructor audience)
//   - contact_added                (welcome_contact)
//   - days_after_engagement        (review_request — dual anchor: N days after a
//                                   first session OR after a contact was added)
//   - days_before_no_school        (no_school_day — CALENDAR-anchored: N days
//                                   before a district closure, to the affected
//                                   afterschool families AND assigned instructor)
//
//   - partner_roster            (partner_roster — SPECIAL: invokes
//                                   email-program-roster via system-auth for
//                                   each qualifying afterschool program, 7 days
//                                   before and morning-of first session)
//
// Intentionally not fired here:
//   - event_registration_confirmed (handled by stripe-webhook, not cron)
//   - survey_pending (template stays is_v1_enabled=false until surveys ship)
//
// Idempotency: automation_run_recipients has UNIQUE(automation_id, context_key).
// Re-running this cron same day is safe — duplicates fail the insert silently.
//
// Multi-tenant: all .from() queries filter by organization_id from the
// automation row. Resume URLs use org.slug (not hardcoded). No tenant strings
// in this file.
//
// Mailing-type: informational templates (welcome, recaps, birthday) reach every
// family regardless of marketing opt-out — they're service comms. Marketing
// templates (review_request) are promotional: their resolvers filter
// marketing_suppressions, and sendOne appends a CAN-SPAM unsubscribe link via
// wrapInShell. So mailing_type drives BOTH suppression filtering (in the
// resolver) and the unsubscribe footer (at send).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { loadOrgBrand, formatFromAddress, renderSignatureBlock, type OrgBrand } from "../_shared/orgBrand.ts";
import {
  parseEmailAttachments,
  loadCommsAttachments,
  renderDownloadButtonsHtml,
  renderDownloadButtonsText,
  buildResendAttachments,
  type CommsAttachment,
} from "../_shared/attachments.ts";
import { cleanNoSchoolDates, toClosurePeriods, termToSchoolYear, nsdWeekdayLower, nsdDate, periodFires, formatDateList } from "./noSchoolDates.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const PUBLIC_SITE_URL = Deno.env.get("PUBLIC_SITE_URL") ?? "https://enrops.com";
// Shared with the marketing send path — the same secret + the same
// marketing-unsubscribe endpoint verify the HMAC token, so a link generated here
// unsubscribes correctly. Empty when the secret isn't set: computeUnsubscribeUrl
// then returns "" and a marketing send proceeds WITHOUT a link but still honors
// marketing_suppressions. We never block a send on a missing secret, and never
// render a broken unsubscribe link.
const UNSUBSCRIBE_SECRET = Deno.env.get("MARKETING_UNSUBSCRIBE_SECRET") ?? "";
const UNSUBSCRIBE_ENDPOINT = `${SUPABASE_URL}/functions/v1/marketing-unsubscribe`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// A send that fails is recorded (status='failed') and re-attempted on the next
// daily run — as long as the recipient is still in the automation's audience
// window. MAX_SEND_ATTEMPTS caps that cross-run retry so a hard bounce (bad
// address) isn't hammered forever; a permanent 4xx from Resend caps immediately.
// 5 gives ~5 daily chances to clear a transient provider blip, comfortably inside
// the default 7-day welcome window, before we stop and leave it for the operator.
const MAX_SEND_ATTEMPTS = 5;
// In-run retry for a single send: absorbs a momentary Resend hiccup within THIS
// run instead of waiting a full day. Only transient failures (429 / 5xx / network)
// are retried; a 4xx like an invalid address is permanent and fails fast.
const IN_RUN_MAX_TRIES = 3;

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

interface TemplateRow {
  id: string;
  key: string;
  display_name: string;
  trigger_type: string;
  applies_to_program_type: "camps" | "afterschool" | "both" | "all";
  mailing_type: "informational" | "marketing";
  default_subject: string;
  default_body: string;
  default_timing: Record<string, unknown>;
  time_saved_minutes_per_send: number;
  is_v1_enabled: boolean;
}

interface AutomationRow {
  id: string;
  organization_id: string;
  template_id: string;
  enabled: boolean;
  subject_override: string | null;
  body_override: string | null;
  timing_override: Record<string, unknown> | null;
  enabled_at: string | null;
  email_attachments: unknown; // jsonb: [{ id, attach }]
  template: TemplateRow;
  org: { id: string; slug: string; name: string };
}

interface TestSendParams {
  organization_id: string;
  template_key: string;
  test_to_email: string;
  preview_subject: string | null;
  preview_body: string | null;
  // When the operator picks a real camp/program in the editor, the test send
  // resolves REAL content (curriculum, dates, location, skills) from that row
  // instead of the hardcoded sample — a true preview. Only one is set at a time.
  test_camp_session_id: string | null;
  test_program_id: string | null;
  // For no_school_day, which role variant to render/send. "instructor" swaps in
  // the tailored instructor copy; anything else = the parent (default) copy.
  audience?: "parent" | "instructor";
  preview_attachments?: unknown; // DRAFT email_attachments jsonb, so the test send matches the editor
}

interface TestSendResult {
  ok: boolean;
  error?: string;
  message_id?: string;
}

interface PreviewParams {
  organization_id: string;
  template_key: string;
  preview_subject: string | null;
  preview_body: string | null;
  test_camp_session_id: string | null;
  test_program_id: string | null;
  audience?: "parent" | "instructor";
  preview_attachments?: unknown; // DRAFT email_attachments jsonb, so the preview matches the editor
}

interface PreviewResult {
  ok: boolean;
  error?: string;
  subject?: string;
  body_html?: string;
  used_real_data?: boolean;
}

interface AudienceEntry {
  context_key: string;
  parent_id: string | null;
  parent_email: string;
  parent_first_name: string | null;
  child_first_name: string | null;
  program_name: string;
  program_start_date: string;   // formatted, e.g. "Monday, June 17"
  program_end_date: string;     // formatted or ""
  location_name: string;
  abandoned_resume_url: string; // empty unless workflow uses it
  age_turning: string;          // empty unless birthday
  final_showcase_raw: string;   // raw curricula.final_showcase text (block HTML built in buildTokens where brand is known)
  mid_term_skills_raw: string[]; // raw curricula.mid_term_skills array — drives {{mid_term_skills_block}}
  final_recap_skills_raw: string[]; // raw curricula.final_recap_skills array — drives {{final_recap_skills_block}}
  arrival_instructions_raw: string; // raw program_locations.PARENT_arrival_instructions — drives {{arrival_dismissal_block}}. Parent-safe only — never pulled from the instructor-facing arrival_instructions column.
  dismissal_instructions_raw: string; // raw program_locations.PARENT_dismissal_instructions — drives {{arrival_dismissal_block}}
  session_dates_raw: string[];  // derive_program_session_dates output for afterschool — drives {{session_dates_block}}. Empty for camps.
  register_url: string;         // org's base registration URL
  next_term_available: boolean; // true if org has programs/camps starting >14 days out — drives {{next_term_link_block}}
  program_time?: string;        // drives {{program_time}} — a clean time range (e.g. "9:00 AM – 12:00 PM") or "" when unknown. Set by the Welcome, check-in, and recap resolvers.
  // ── no_school_day only ──
  // recipient_role distinguishes the two audiences of the SAME automation. When
  // set to "instructor" the resolver also sets subject_template/body_template so
  // sendOne renders the tailored instructor copy instead of the operator-editable
  // parent copy. Parent entries leave these undefined → sendOne falls back to the
  // operator's subject_override/body_override (the editable path). This keeps the
  // engine generic: any resolver can override per-entry copy without sendOne
  // knowing template specifics.
  recipient_role?: "parent" | "instructor";
  subject_template?: string;
  body_template?: string;
  no_school_dates_display?: string; // drives {{no_school_dates}} — the affected class day(s), formatted (e.g. "Monday, September 7")
  no_school_reason?: string;        // drives {{no_school_reason}} — always readable; falls back to "a no-school day"
}

// Tailored instructor copy for no_school_day. Parents get the operator-editable
// subject/body; instructors get this fixed-but-role-appropriate version. Both
// are informational (no unsubscribe). {{first_name}} = the instructor's first
// name. Kept as module constants (not seeded on the template) because the
// automations row stores only ONE editable body; per-audience editable copy is
// a scoped fast-follow once afterschool assignments (and thus instructor sends)
// actually exist.
const NO_SCHOOL_INSTRUCTOR_SUBJECT = "No class at {{location_name}} on {{no_school_dates}}";
const NO_SCHOOL_INSTRUCTOR_BODY =
  `<p style="margin:0 0 16px;">Hi {{first_name}},</p>
<p style="margin:0 0 16px;">Heads up: {{location_name}} has no school on {{no_school_dates}}, so your {{program_name}} class will not meet then. You are off that day.</p>
<p style="margin:0 0 16px;">Class picks back up as usual the following week.</p>
<p style="margin:0;">Thanks,<br>{{sender_name}}</p>`;

// ───────────────────────────────────────────────────────────────────────────
// Entry point
// ───────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Three modes:
  //   cron mode      → POST {} (or no body) — scan all enabled automations
  //   event mode     → POST {registration_id: "UUID"} — fire eligible Welcome
  //                    for a specific registration (stripe-webhook → late
  //                    registrants who confirm inside the 7-day window)
  //   test_send mode → POST {mode: "test_send", organization_id, template_key,
  //                    test_to_email, preview_subject, preview_body} —
  //                    operator-initiated preview send from the editor drawer.
  //                    Validates test_to_email belongs to an org admin so this
  //                    can't be abused to spam non-admins. Doesn't write to
  //                    automation_run_recipients or time_saved_events.
  let eventRegistrationId: string | null = null;
  let testSendParams: TestSendParams | null = null;
  let previewParams: PreviewParams | null = null;
  if (req.method === "POST") {
    try {
      const body = await req.json().catch(() => ({}));
      const parsedAudience = body?.audience === "instructor" ? "instructor" : undefined;
      if (body?.mode === "test_send") {
        testSendParams = {
          organization_id: body.organization_id,
          template_key: body.template_key,
          test_to_email: body.test_to_email,
          preview_subject: typeof body.preview_subject === "string" ? body.preview_subject : null,
          preview_body: typeof body.preview_body === "string" ? body.preview_body : null,
          test_camp_session_id: typeof body.test_camp_session_id === "string" ? body.test_camp_session_id : null,
          test_program_id: typeof body.test_program_id === "string" ? body.test_program_id : null,
          audience: parsedAudience,
          preview_attachments: body.preview_attachments,
        };
      } else if (body?.mode === "preview") {
        previewParams = {
          organization_id: body.organization_id,
          template_key: body.template_key,
          preview_subject: typeof body.preview_subject === "string" ? body.preview_subject : null,
          preview_body: typeof body.preview_body === "string" ? body.preview_body : null,
          test_camp_session_id: typeof body.test_camp_session_id === "string" ? body.test_camp_session_id : null,
          test_program_id: typeof body.test_program_id === "string" ? body.test_program_id : null,
          audience: parsedAudience,
          preview_attachments: body.preview_attachments,
        };
      } else if (typeof body?.registration_id === "string") {
        eventRegistrationId = body.registration_id;
      }
    } catch { /* empty body — cron mode */ }
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Test send shortcut — different shape (single recipient, no audit log,
  // no idempotency tracking) so handled before the cron-mode automation loop.
  if (testSendParams) {
    const result = await runTestSend(supabase, testSendParams);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // On-screen preview — render only, nothing sent.
  if (previewParams) {
    const result = await runPreview(supabase, previewParams);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const summary: { mode: string; automations: unknown[]; errors: unknown[] } = {
    mode: eventRegistrationId ? "event" : "cron",
    automations: [],
    errors: [],
  };

  // Load all enabled automations whose template is v1-enabled. In event mode
  // we filter again per-org inside the audience resolver, so loading globally
  // is fine — typically one row per (org, template_key) and we have few orgs.
  const { data: automations, error: loadErr } = await supabase
    .from("automations")
    .select(`
      id, organization_id, template_id, enabled, subject_override, body_override, timing_override, enabled_at, email_attachments,
      template:automation_templates!inner (
        id, key, display_name, trigger_type, applies_to_program_type, mailing_type,
        default_subject, default_body, default_timing, time_saved_minutes_per_send, is_v1_enabled
      ),
      org:organizations!inner ( id, slug, name )
    `)
    .eq("enabled", true)
    .eq("template.is_v1_enabled", true);

  if (loadErr) {
    return new Response(JSON.stringify({ ok: false, error: loadErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  for (const a of (automations ?? []) as AutomationRow[]) {
    // In event mode, only run Welcome workflows — other triggers are time-based.
    if (eventRegistrationId && a.template.trigger_type !== "days_before_first_session") continue;
    try {
      const result = await runAutomation(supabase, a, eventRegistrationId);
      summary.automations.push({ automation_id: a.id, key: a.template.key, org_slug: a.org.slug, ...result });
    } catch (e) {
      summary.errors.push({ automation_id: a.id, error: (e as Error).message });
      console.error(`[lifecycle-automations-cron] automation ${a.id} failed:`, e);
    }
  }

  return new Response(JSON.stringify({ ok: true, summary }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Per-automation runner
// ───────────────────────────────────────────────────────────────────────────

async function runAutomation(
  supabase: SupabaseClient,
  a: AutomationRow,
  eventRegistrationId: string | null = null,
) {
  // 1. Resolve audience by trigger type
  let audience: AudienceEntry[] = [];
  switch (a.template.trigger_type) {
    case "days_before_first_session":
      audience = await resolveWelcomeAudience(supabase, a, eventRegistrationId);
      break;
    case "event_registration_abandoned":
      audience = await resolveAbandonedAudience(supabase, a);
      break;
    case "days_after_first_session":
      audience = await resolveCheckInAudience(supabase, a);
      break;
    case "session_midpoint":
      audience = await resolveMidRecapAudience(supabase, a);
      break;
    case "session_last_day":
      audience = await resolveFinalRecapAudience(supabase, a);
      break;
    case "birthday":
      audience = await resolveBirthdayAudience(supabase, a);
      break;
    case "instructor_birthday":
      audience = await resolveInstructorBirthdayAudience(supabase, a);
      break;
    case "contact_added":
      audience = await resolveContactAddedAudience(supabase, a);
      break;
    case "days_after_engagement":
      audience = await resolveReviewRequestAudience(supabase, a);
      break;
    case "days_before_no_school":
      audience = await resolveNoSchoolDayAudience(supabase, a);
      break;
    case "partner_roster":
      return await runPartnerRosterAutomation(supabase, a);
    case "event_registration_confirmed":
      // Handled by stripe-webhook (registration table → confirmation email).
      // Cron isn't the right trigger here — checkout completion is event-driven.
      return { skipped: "handled_by_stripe_webhook" };
    case "survey_pending":
      // Survey feature not built yet — template stays is_v1_enabled=false.
      return { skipped: "template_disabled_v1" };
    default:
      return { skipped: "unknown_trigger", trigger: a.template.trigger_type };
  }

  // 2. Create automation_runs row
  const { data: runRow, error: runErr } = await supabase
    .from("automation_runs")
    .insert({
      automation_id: a.id,
      organization_id: a.organization_id,
      audience_size: audience.length,
      status: audience.length === 0 ? "skipped_no_audience" : "sending",
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    throw new Error(`Failed to create automation_runs row: ${runErr?.message}`);
  }

  if (audience.length === 0) {
    return { audience: 0, sent: 0, failed: 0, skipped: 0, run_id: runRow.id };
  }

  // 3. Load brand once per org
  const brand = await loadOrgBrand(supabase, a.organization_id);

  // 4. Pre-check prior recipient rows (one query, not N). A row is "done" — and
  // therefore skipped — only when it already SENT, or when it has FAILED enough
  // times to exhaust MAX_SEND_ATTEMPTS. A failed row under the cap is NOT done:
  // it stays eligible so this and future runs retry it. (Previously ANY existing
  // row counted as done, but failures wrote no row at all, so this set only ever
  // held successes; now that failures are recorded, the status filter is what
  // keeps them retryable instead of being mistaken for "already handled".)
  const contextKeys = audience.map((e) => e.context_key);
  const { data: priorRows } = await supabase
    .from("automation_run_recipients")
    .select("context_key, status, attempts")
    .eq("automation_id", a.id)
    .in("context_key", contextKeys);
  const priorByKey = new Map<string, { status: string; attempts: number }>(
    (priorRows ?? []).map((r: { context_key: string; status: string; attempts: number | null }) =>
      [r.context_key, { status: r.status, attempts: r.attempts ?? 0 }]),
  );
  const isDone = (contextKey: string): boolean => {
    const p = priorByKey.get(contextKey);
    if (!p) return false;
    if (p.status === "sent") return true;
    if (p.status === "failed" && p.attempts >= MAX_SEND_ATTEMPTS) return true; // exhausted — leave for operator
    return false;
  };

  // 5. Per-recipient: send, then UPSERT the outcome (status='sent' or 'failed').
  // Recording failures (not writing nothing) makes silent misses visible AND
  // keeps them retryable via the status-aware pre-check above. Batch of 5
  // concurrent sends to stay within the edge function 150s timeout at
  // scale-target audience sizes.
  let sent = 0, failed = 0, skipped = 0;
  const BATCH_SIZE = 5;
  const toSend = audience.filter((e) => !isDone(e.context_key));
  skipped = audience.length - toSend.length;

  // Resolve this automation's comms attachments ONCE (shared across recipients).
  // Every entry -> a Download button appended to the bottom of the email; entries
  // flagged attach:true also ride the raw file along (base64). Org-scoped load.
  const emailAtts = parseEmailAttachments(a.email_attachments);
  const attachmentsById = await loadCommsAttachments(supabase, a.organization_id, emailAtts.map((e) => e.id));
  const buttonRows = emailAtts.map((e) => attachmentsById.get(e.id)).filter((x): x is CommsAttachment => !!x);
  const attachRows = emailAtts.filter((e) => e.attach).map((e) => attachmentsById.get(e.id)).filter((x): x is CommsAttachment => !!x);
  const { attachments: resendAttachments, skipped: skippedAttachments } =
    await buildResendAttachments(supabase, attachRows);
  if (skippedAttachments.length) {
    console.warn(`[lifecycle-automations-cron] attachments skipped (too large/unavailable): ${skippedAttachments.join(", ")}`);
  }
  const downloadButtonsHtml = renderDownloadButtonsHtml(buttonRows, supabase, brand);
  const downloadButtonsText = renderDownloadButtonsText(buttonRows, supabase);

  for (let i = 0; i < toSend.length; i += BATCH_SIZE) {
    const batch = toSend.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((entry) =>
      sendOne(supabase, a, brand, runRow.id, entry, downloadButtonsHtml, downloadButtonsText, resendAttachments,
        priorByKey.get(entry.context_key)?.attempts ?? 0),
    ));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value === "sent") sent += 1;
      else failed += 1;
    }
  }

  // 5. Finalize run row
  const finalStatus = failed > 0 && sent === 0 ? "failed" : "sent";
  const timeSavedMinutes = sent * a.template.time_saved_minutes_per_send;
  await supabase.from("automation_runs")
    .update({
      status: finalStatus,
      time_saved_minutes: timeSavedMinutes,
      error_message: failed > 0 ? `${failed} of ${audience.length} sends failed` : null,
    })
    .eq("id", runRow.id);

  // 6. Contribute to the org's lifetime time-saved tally (read by the
  // AdminLayout sidebar pill). Per project_enrops_time_saved memory rule:
  // every action that fires a time-saved pill also INSERTs here. CHECK
  // constraint requires hours_saved > 0, so skip when 0 sends.
  if (sent > 0) {
    const hoursSaved = timeSavedMinutes / 60;
    const familyWord = sent === 1 ? "family" : "families";
    const { error: tseErr } = await supabase.from("time_saved_events").insert({
      organization_id: a.organization_id,
      action_type: "automation_fired",
      action_label: `Sent ${a.template.display_name} to ${sent} ${familyWord}`,
      hours_saved: hoursSaved,
      related_entity_type: "automation",
      related_entity_id: a.id,
    });
    if (tseErr) {
      // Non-fatal — log but don't fail the run. The main delivery happened.
      console.error("[lifecycle-automations-cron] time_saved_events insert failed:", tseErr);
    }
  }

  return { audience: audience.length, sent, failed, skipped, run_id: runRow.id, time_saved_minutes: timeSavedMinutes };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-recipient send + log
// ───────────────────────────────────────────────────────────────────────────

async function sendOne(
  supabase: SupabaseClient,
  a: AutomationRow,
  brand: OrgBrand,
  runId: string,
  entry: AudienceEntry,
  downloadButtonsHtml: string,
  downloadButtonsText: string,
  resendAttachments: { filename: string; content: string }[],
  priorAttempts: number,
): Promise<"sent" | "failed"> {
  const tokens = buildTokens(entry, brand);
  // A resolver may attach per-entry copy (entry.subject_template/body_template)
  // to tailor a message by recipient role — no_school_day uses this to send
  // instructor-specific copy. When unset (every other automation, and the parent
  // half of no_school_day) we fall back to the operator's editable override, then
  // the template default. Generic: sendOne stays template-agnostic.
  const subject = renderTokens(entry.subject_template ?? a.subject_override ?? a.template.default_subject, tokens);
  const bodySrc = entry.body_template ?? a.body_override ?? a.template.default_body;
  const renderedHtml = renderTokens(bodySrc, tokens);
  // Download buttons are appended to the BOTTOM of the body (they land above the
  // signature, which wrapInShell adds) — not placed inline by the operator.
  const innerBody = renderedHtml + downloadButtonsHtml;
  // Promotional templates (mailing_type='marketing', e.g. review_request) carry a
  // CAN-SPAM unsubscribe link keyed to this recipient; informational sends pass
  // "" so their HTML + text stay byte-for-byte unchanged.
  const unsubscribeUrl = a.template.mailing_type === "marketing"
    ? await computeUnsubscribeUrl(entry.parent_email, a.organization_id)
    : "";
  // Fail-closed compliance: never send a promotional email without a working
  // unsubscribe link. If the secret is unset, computeUnsubscribeUrl returns "" —
  // skip (don't record) so it retries once configured, rather than permanently
  // recording a CAN-SPAM-noncompliant send under an idempotency key.
  if (a.template.mailing_type === "marketing" && !unsubscribeUrl) {
    console.error("[lifecycle-automations-cron] marketing send skipped — no unsubscribe URL (MARKETING_UNSUBSCRIBE_SECRET unset)");
    return "failed";
  }
  const fullHtml = wrapInShell(innerBody, brand, unsubscribeUrl);
  const plainBody = htmlToPlainText(renderedHtml) + downloadButtonsText;
  const plainText = unsubscribeUrl
    ? `${plainBody}\n\nUnsubscribe: ${unsubscribeUrl}`
    : plainBody;

  // Send with a short in-run retry: a transient Resend failure (429 rate-limit,
  // 5xx, or a network blip) is retried a few times with exponential backoff so a
  // provider hiccup no longer costs a whole day. A 4xx (e.g. invalid address) is
  // permanent — fail fast, don't burn retries.
  const send = await sendResendEmail({
    from: formatFromAddress(brand),
    to: entry.parent_email,
    reply_to: brand.reply_to,
    subject,
    html: fullHtml,
    text: plainText,
    tags: [
      { name: "type", value: "lifecycle" },
      { name: "automation", value: a.template.key },
    ],
    ...(resendAttachments.length ? { attachments: resendAttachments } : {}),
  });

  const nowIso = new Date().toISOString();
  const status: "sent" | "failed" = send.ok ? "sent" : "failed";
  // A permanent (4xx) failure will never succeed on retry, so cap its attempts
  // immediately (won't be re-tried). A transient failure just increments, so it
  // retries on the next daily run until it clears or exhausts MAX_SEND_ATTEMPTS.
  const attempts = send.ok
    ? priorAttempts + 1
    : (send.permanent ? MAX_SEND_ATTEMPTS : priorAttempts + 1);

  // UPSERT on the (automation_id, context_key) unique key. This records EVERY
  // outcome — success or failure — instead of the old "write nothing on failure"
  // (which made misses invisible and unretriable-by-tracking). A prior 'failed'
  // row flips to 'sent' on success, or refreshes its error/attempts on another
  // failure. Upsert (not insert) also sidesteps the 23505 race a concurrent run
  // could hit.
  const row: Record<string, unknown> = {
    automation_run_id: runId,
    automation_id: a.id,
    organization_id: a.organization_id,
    parent_id: entry.parent_id,
    context_key: entry.context_key,
    email: entry.parent_email,
    resend_message_id: send.ok ? send.id : null,
    status,
    error_message: send.ok ? null : send.error,
    attempts,
    last_attempt_at: nowIso,
  };
  // sent_at is NOT NULL (defaults now()). Stamp it only on success so it means
  // "when it actually sent"; last_attempt_at carries the honest last touch for a
  // still-failing row.
  if (send.ok) row.sent_at = nowIso;

  const { error: recErr } = await supabase
    .from("automation_run_recipients")
    .upsert(row, { onConflict: "automation_id,context_key" });
  if (recErr) {
    // The email may already have gone out; log but return the true send result so
    // the run tally is honest. A missing row just means the next cron re-attempts.
    console.error("[lifecycle-automations-cron] recipient upsert failed:", recErr);
  }
  return status;
}

// ── Resend send with in-run retry ───────────────────────────────────────────
type ResendSendResult =
  | { ok: true; id: string | null }
  | { ok: false; error: string; permanent: boolean };

// POSTs one email to Resend, retrying transient failures with exponential
// backoff. `permanent` on failure means a non-retryable 4xx (e.g. invalid
// address); transient (429/5xx/network) exhausted its in-run tries and should be
// retried on the next daily run.
async function sendResendEmail(payload: Record<string, unknown>): Promise<ResendSendResult> {
  let lastError = "unknown send error";
  for (let attempt = 1; attempt <= IN_RUN_MAX_TRIES; attempt++) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        const json = await resp.json() as { id?: string };
        return { ok: true, id: json.id ?? null };
      }
      const errText = await resp.text();
      lastError = `Resend ${resp.status}: ${errText.slice(0, 400)}`;
      // 429 (rate limit) and 5xx are transient → retry; other 4xx are permanent.
      const transient = resp.status === 429 || resp.status >= 500;
      if (!transient) {
        console.error(`[lifecycle-automations-cron] ${lastError}`);
        return { ok: false, error: lastError, permanent: true };
      }
      if (attempt === IN_RUN_MAX_TRIES) {
        console.error(`[lifecycle-automations-cron] ${lastError} (gave up after ${attempt} tries)`);
        return { ok: false, error: lastError, permanent: false };
      }
      await sleep(backoffMs(attempt, resp.headers.get("retry-after")));
    } catch (e) {
      lastError = (e as Error).message.slice(0, 500);
      if (attempt === IN_RUN_MAX_TRIES) {
        console.error(`[lifecycle-automations-cron] send network error: ${lastError} (gave up after ${attempt} tries)`);
        return { ok: false, error: lastError, permanent: false };
      }
      await sleep(backoffMs(attempt, null));
    }
  }
  return { ok: false, error: lastError, permanent: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff — 0.5s, 1s, 2s… capped at 5s. Honors a Resend Retry-After
// header (seconds) on a 429 when present.
function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 5000);
  return Math.min(500 * 2 ** (attempt - 1), 5000);
}

// ───────────────────────────────────────────────────────────────────────────
// Test send (operator-initiated preview from the editor drawer)
// ───────────────────────────────────────────────────────────────────────────

// Shared render — the SINGLE place that turns (org, template, chosen
// camp/program, draft subject/body) into a finished subject + full HTML email.
// Used by BOTH the test send AND the live on-screen preview so the preview pane,
// the test email, and a real send all come out of the exact same pipeline
// (buildTokens → renderTokens → wrapInShell). Mirrors marketing-touchpoint-send's
// shared preview/send render. When a camp/program is chosen, real content is
// resolved; otherwise a sample entry fills the blocks so operators still see a
// styled email. Family names are always sample (a preview isn't one real family).
interface RenderInput {
  organization_id: string;
  template_key: string;
  preview_subject: string | null;
  preview_body: string | null;
  test_camp_session_id: string | null;
  test_program_id: string | null;
  to_email?: string; // only used to seed entry.parent_email for a test send
  audience?: "parent" | "instructor"; // no_school_day: which role variant to render
  preview_attachments?: unknown; // the DRAFT email_attachments jsonb ([{id,attach}]) so the preview/test reflects unsaved changes
}
interface RenderOutput {
  ok: boolean;
  error?: string;
  subject?: string;
  html?: string;
  brand?: OrgBrand;
  template_key?: string;
  used_real_data?: boolean;
  resend_attachments?: { filename: string; content: string }[]; // for test send only
}

async function renderLifecycleEmail(supabase: SupabaseClient, input: RenderInput): Promise<RenderOutput> {
  if (!input.organization_id || !input.template_key) {
    return { ok: false, error: "missing_required_params" };
  }

  const { data: template, error: tErr } = await supabase
    .from("automation_templates")
    .select("*")
    .eq("key", input.template_key)
    .maybeSingle();
  if (tErr || !template) {
    return { ok: false, error: "template_not_found" };
  }

  const { data: org, error: oErr } = await supabase
    .from("organizations")
    .select("id, slug, name")
    .eq("id", input.organization_id)
    .maybeSingle();
  if (oErr || !org) {
    return { ok: false, error: "org_not_found" };
  }

  const brand = await loadOrgBrand(supabase, input.organization_id);

  // Sample entry — exercises the real pipeline and fills blocks when no real
  // camp/program is chosen (or for templates that aren't program-based).
  const entry: AudienceEntry = {
    context_key: "test:preview",
    parent_id: null,
    parent_email: input.to_email ?? "preview@example.com",
    parent_first_name: "Sarah",
    child_first_name: "Mia",
    program_name: "Mini Robotics",
    program_start_date: "Monday, June 17",
    program_end_date: "Friday, June 21",
    program_time: "9:00 AM – 12:00 PM",
    location_name: "Beaverton STEAM Hub",
    abandoned_resume_url: "#",
    age_turning: "8",
    arrival_instructions_raw: "Doors open at 8:45am. Drop off at the lobby — instructors will check kids in and walk them to the room. Please park in the visitor lot, not the loading zone.",
    dismissal_instructions_raw: "Pickup is at the lobby at 12:30pm sharp. Please be on time — instructors need to leave for the afternoon session.",
    session_dates_raw: ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16", "2026-12-07"],
    final_showcase_raw: "Campers host a Playtest Arcade where every kid loads their finished platformer onto a Chromebook and the whole group rotates through playing each other's games.",
    mid_term_skills_raw: [
      "Physics simulation: coding velocity, gravity, and friction with variables",
      "Collision detection: triggering game events when sprites touch",
      "Platformer level design: sketching and building jumpable layouts",
      "Game logic with conditional statements and loops",
    ],
    final_recap_skills_raw: [
      "Physics simulation: velocity, gravity, and friction using variables",
      "Event-driven programming with broadcasts and receivers across multiple sprites",
      "Variable management for score, lives, and game state",
      "Multi-scene architecture: warp pipes and backdrop switching for multiple levels",
      "Game design process: sketch, build, playtest, and iterate",
    ],
    register_url: `${PUBLIC_SITE_URL}/${org.slug}/register`,
    next_term_available: true,
    // no_school_day sample content so its preview reads naturally.
    no_school_dates_display: "Monday, September 7",
    no_school_reason: "Labor Day",
  };

  // True preview: when the operator picked a real camp/program, overwrite the
  // sample CONTENT fields with real data resolved by the same logic the live
  // cron uses — so the preview pane and a real send can't drift. Empty real
  // values are kept: an honest preview of what parents would actually get.
  let usedRealData = false;
  if (input.test_camp_session_id || input.test_program_id) {
    const real = await resolveTestEntryContent(
      supabase,
      input.organization_id,
      org.slug,
      input.test_camp_session_id,
      input.test_program_id,
    );
    if (real) { Object.assign(entry, real); usedRealData = true; }
  }

  const tokens = buildTokens(entry, brand);
  // stripe-webhook fills the real registration table on a live send; show a
  // clear placeholder here so operators know where it lands.
  tokens["registration_summary_block"] =
    '<div style="background:#f5f4ee;padding:16px;margin:16px 0;border-radius:6px;color:#6b6880;font-style:italic;">[Auto-generated registration details would appear here on a real send.]</div>';

  // Editor passes the current draft; fall back to template defaults so the
  // unmodified template can also be previewed/tested.
  let subjectTpl = input.preview_subject ?? template.default_subject;
  let bodyTpl = input.preview_body ?? template.default_body;
  // no_school_day instructor variant: swap in the fixed instructor copy (not the
  // operator's parent draft) and render {{first_name}} as an instructor. Lets the
  // editor preview + test-send BOTH role variants of a two-audience automation.
  if (template.key === "no_school_day" && input.audience === "instructor") {
    subjectTpl = NO_SCHOOL_INSTRUCTOR_SUBJECT;
    bodyTpl = NO_SCHOOL_INSTRUCTOR_BODY;
    tokens["first_name"] = "Alex"; // sample instructor first name (parent sample is "Sarah")
  }

  const subject = renderTokens(subjectTpl, tokens);
  // Render the Download-buttons block from the DRAFT's attachment list so the
  // preview + test send show exactly what a real send will — the buttons land at
  // the bottom of the email, never as a token in the body.
  const emailAtts = parseEmailAttachments(input.preview_attachments);
  const attachmentsById = await loadCommsAttachments(supabase, org.id, emailAtts.map((e) => e.id));
  const buttonRows = emailAtts.map((e) => attachmentsById.get(e.id)).filter((x): x is CommsAttachment => !!x);
  const attachRows = emailAtts.filter((e) => e.attach).map((e) => attachmentsById.get(e.id)).filter((x): x is CommsAttachment => !!x);
  const { attachments: resendAttachments } = await buildResendAttachments(supabase, attachRows);
  const innerBody = renderTokens(bodyTpl, tokens) + renderDownloadButtonsHtml(buttonRows, supabase, brand);
  // Marketing templates show the unsubscribe footer in preview/test too. Real
  // link for a test send (to_email present); a visible "#" placeholder for the
  // on-screen preview so the operator sees the footer without minting a working
  // token for a sample address.
  const unsubscribeUrl = template.mailing_type === "marketing"
    ? (input.to_email ? await computeUnsubscribeUrl(input.to_email, org.id) : "#")
    : "";
  const fullHtml = wrapInShell(innerBody, brand, unsubscribeUrl);

  return { ok: true, subject, html: fullHtml, brand, template_key: template.key, used_real_data: usedRealData, resend_attachments: resendAttachments };
}

async function runTestSend(supabase: SupabaseClient, params: TestSendParams): Promise<TestSendResult> {
  if (!params.organization_id || !params.template_key || !params.test_to_email) {
    return { ok: false, error: "missing_required_params" };
  }
  if (!params.test_to_email.includes("@")) {
    return { ok: false, error: "invalid_test_email" };
  }

  // Anti-spam: the test recipient must be an admin on this org. Service-role
  // bypass exists for delivery, but the check is enforced in code so the
  // endpoint can't be used to spam arbitrary addresses.
  const { data: member } = await supabase
    .from("org_members")
    .select("email")
    .eq("organization_id", params.organization_id)
    .ilike("email", params.test_to_email)
    .maybeSingle();
  if (!member) {
    return { ok: false, error: "test_email_not_an_org_admin" };
  }

  const rendered = await renderLifecycleEmail(supabase, {
    organization_id: params.organization_id,
    template_key: params.template_key,
    preview_subject: params.preview_subject,
    preview_body: params.preview_body,
    test_camp_session_id: params.test_camp_session_id,
    test_program_id: params.test_program_id,
    to_email: params.test_to_email,
    audience: params.audience,
    preview_attachments: params.preview_attachments,
  });
  if (!rendered.ok) return { ok: false, error: rendered.error };

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: formatFromAddress(rendered.brand!),
        to: params.test_to_email,
        reply_to: rendered.brand!.reply_to,
        subject: `[TEST] ${rendered.subject}`,
        html: rendered.html,
        tags: [
          { name: "type", value: "lifecycle_test" },
          { name: "automation", value: rendered.template_key! },
        ],
        ...(rendered.resend_attachments?.length ? { attachments: rendered.resend_attachments } : {}),
      }),
    });
    if (resp.ok) {
      const json = await resp.json() as { id?: string };
      return { ok: true, message_id: json.id };
    }
    const errText = await resp.text();
    return { ok: false, error: `Resend ${resp.status}: ${errText.slice(0, 240)}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// On-screen preview — same render as a test/real send, returned as HTML for the
// editor's iframe instead of emailed. No email sent, no Resend call, no admin
// check (nothing leaves the system). Mirrors marketing-touchpoint-send mode:"preview".
async function runPreview(supabase: SupabaseClient, params: PreviewParams): Promise<PreviewResult> {
  const rendered = await renderLifecycleEmail(supabase, {
    organization_id: params.organization_id,
    template_key: params.template_key,
    preview_subject: params.preview_subject,
    preview_body: params.preview_body,
    test_camp_session_id: params.test_camp_session_id,
    test_program_id: params.test_program_id,
    audience: params.audience,
    preview_attachments: params.preview_attachments,
  });
  if (!rendered.ok) return { ok: false, error: rendered.error };
  return { ok: true, subject: rendered.subject, body_html: rendered.html, used_real_data: rendered.used_real_data };
}

// Resolve the REAL content fields for a test send from one chosen camp/program.
// Mirrors the field mappings in resolveWelcomeAudience exactly so the preview
// matches a live send. Returns only the content fields (family names + resume
// URL stay sample); null if the row isn't found or doesn't belong to the org.
async function resolveTestEntryContent(
  supabase: SupabaseClient,
  organizationId: string,
  orgSlug: string,
  campSessionId: string | null,
  programId: string | null,
): Promise<Partial<AudienceEntry> | null> {
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, organizationId);

  if (campSessionId) {
    const { data: c, error } = await supabase
      .from("camp_sessions")
      .select(`id, curriculum_name, starts_on, ends_on, start_time, end_time, location_name, curriculum_id,
        curricula ( final_showcase, mid_term_skills, final_recap_skills ),
        program_locations ( parent_arrival_instructions, parent_dismissal_instructions )`)
      .eq("id", campSessionId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error || !c) return null;
    const camp = c as any;
    return {
      program_name: camp.curriculum_name ?? "your camp",
      program_start_date: camp.starts_on ? formatDate(camp.starts_on) : "",
      program_end_date: camp.ends_on ? formatDate(camp.ends_on) : "",
      program_time: timeClause(camp.start_time, camp.end_time, false),
      location_name: camp.location_name ?? "",
      final_showcase_raw: camp.curricula?.final_showcase ?? "",
      mid_term_skills_raw: (camp.curricula?.mid_term_skills as string[] | null) ?? [],
      final_recap_skills_raw: (camp.curricula?.final_recap_skills as string[] | null) ?? [],
      arrival_instructions_raw: camp.program_locations?.parent_arrival_instructions ?? "",
      dismissal_instructions_raw: camp.program_locations?.parent_dismissal_instructions ?? "",
      session_dates_raw: [],
      register_url: `${PUBLIC_SITE_URL}/${orgSlug}/register`,
      next_term_available: nextTermAvailable,
    };
  }

  if (programId) {
    const { data: p, error } = await supabase
      .from("programs")
      .select(`id, curriculum, first_session_date, start_time, end_time, program_location_id, curriculum_id,
        program_locations ( name, parent_arrival_instructions, parent_dismissal_instructions ),
        curricula ( final_showcase, mid_term_skills, final_recap_skills )`)
      .eq("id", programId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (error || !p) return null;
    const prog = p as any;
    let sessions: string[] = [];
    try {
      const { data: s } = await supabase.rpc("derive_program_session_dates", { p_program_id: prog.id });
      sessions = (s as string[] | null) ?? [];
    } catch { sessions = []; }
    return {
      program_name: prog.curriculum ?? "your program",
      program_start_date: prog.first_session_date ? formatDate(prog.first_session_date) : "",
      program_end_date: sessions.length > 0 ? formatDate(sessions[sessions.length - 1]) : "",
      program_time: timeClause(prog.start_time, prog.end_time, true),
      location_name: prog.program_locations?.name ?? "",
      final_showcase_raw: prog.curricula?.final_showcase ?? "",
      mid_term_skills_raw: (prog.curricula?.mid_term_skills as string[] | null) ?? [],
      final_recap_skills_raw: (prog.curricula?.final_recap_skills as string[] | null) ?? [],
      arrival_instructions_raw: prog.program_locations?.parent_arrival_instructions ?? "",
      dismissal_instructions_raw: prog.program_locations?.parent_dismissal_instructions ?? "",
      session_dates_raw: sessions,
      register_url: `${PUBLIC_SITE_URL}/${orgSlug}/register`,
      next_term_available: nextTermAvailable,
    };
  }

  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Audience resolvers
// ───────────────────────────────────────────────────────────────────────────

async function resolveWelcomeAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
  eventRegistrationId: string | null = null,
): Promise<AudienceEntry[]> {
  const days = pickNumber(a.timing_override?.days_before, a.template.default_timing?.days_before, 7);
  const today = new Date().toISOString().slice(0, 10);
  const windowEnd = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, a.organization_id);

  // Audience window: programs starting between today and today + days_before.
  // BETWEEN + idempotency (UNIQUE constraint) handles late registrants without
  // duplicate sends. Programs already started (before today) are excluded —
  // backstop against an automation re-enabled after a long pause.
  //
  // Context key includes student_id — siblings in the SAME program get
  // separate emails, each personalized to their kid. Same parent might
  // receive 2 welcomes for 2 enrolled kids, which is the right behavior.

  if (a.template.applies_to_program_type === "afterschool") {
    let q = supabase
      .from("registrations")
      .select(`
        id, parent_id,
        students!inner ( id, first_name ),
        parents!inner ( id, first_name, email ),
        programs!inner ( id, curriculum, first_session_date, start_time, end_time, program_location_id, curriculum_id, program_locations ( name, parent_arrival_instructions, parent_dismissal_instructions ), curricula ( final_showcase, mid_term_skills, final_recap_skills ) )
      `)
      .eq("organization_id", a.organization_id)
      .eq("status", "confirmed")
      .not("program_id", "is", null)
      .gte("programs.first_session_date", today)
      .lte("programs.first_session_date", windowEnd);
    if (eventRegistrationId) q = q.eq("id", eventRegistrationId);
    const { data, error } = await q;
    if (error) throw error;

    // Batch-fetch session dates for every unique program in the audience —
    // {{session_dates_block}} renders "12 weekly sessions, starting Sep 9..."
    // for afterschool programs. derive_program_session_dates honors location
    // + district closures, so no per-row math here.
    const sessionsByProgram = new Map<string, string[]>();
    const uniqueProgramIds = Array.from(new Set((data ?? []).map((r: any) => r.programs?.id).filter(Boolean)));
    for (const pid of uniqueProgramIds) {
      try {
        const { data: sessions } = await supabase.rpc("derive_program_session_dates", { p_program_id: pid });
        sessionsByProgram.set(pid, (sessions as string[] | null) ?? []);
      } catch {
        sessionsByProgram.set(pid, []);
      }
    }

    return (data ?? [])
      .filter((r: any) => r.parents?.email && r.students?.id)
      .map((r: any) => ({
        context_key: `program:${r.programs.id}:parent:${r.parents.id}:student:${r.students.id}`,
        parent_id: r.parents.id,
        parent_email: r.parents.email,
        parent_first_name: r.parents.first_name,
        child_first_name: r.students?.first_name ?? null,
        program_name: r.programs.curriculum ?? "your program",
        program_start_date: formatDate(r.programs.first_session_date),
        program_end_date: "",
        // programs.start_time/end_time are already human text ("3:25 PM"); use as-is.
        program_time: timeClause(r.programs.start_time, r.programs.end_time, true),
        location_name: r.programs.program_locations?.name ?? "",
        abandoned_resume_url: "",
        age_turning: "",
        final_showcase_raw: r.programs.curricula?.final_showcase ?? "",
        mid_term_skills_raw: (r.programs.curricula?.mid_term_skills as string[] | null) ?? [],
        final_recap_skills_raw: (r.programs.curricula?.final_recap_skills as string[] | null) ?? [],
        arrival_instructions_raw: r.programs.program_locations?.parent_arrival_instructions ?? "",
        dismissal_instructions_raw: r.programs.program_locations?.parent_dismissal_instructions ?? "",
        session_dates_raw: sessionsByProgram.get(r.programs.id) ?? [],
        register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
        next_term_available: nextTermAvailable,
      }));
  }

  if (a.template.applies_to_program_type === "camps") {
    let q = supabase
      .from("registrations")
      .select(`
        id, parent_id,
        students!inner ( id, first_name ),
        parents!inner ( id, first_name, email ),
        camp_sessions!inner ( id, curriculum_name, starts_on, ends_on, start_time, end_time, location_id, location_name, curriculum_id, curricula ( final_showcase, mid_term_skills, final_recap_skills ), program_locations ( parent_arrival_instructions, parent_dismissal_instructions ) )
      `)
      .eq("organization_id", a.organization_id)
      .eq("status", "confirmed")
      .not("camp_session_id", "is", null)
      .gte("camp_sessions.starts_on", today)
      .lte("camp_sessions.starts_on", windowEnd);
    if (eventRegistrationId) q = q.eq("id", eventRegistrationId);
    const { data, error } = await q;
    if (error) throw error;

    const rows = (data ?? []).filter((r: any) => r.parents?.email && r.students?.id);
    if (rows.length === 0) return [];

    // One welcome per child per camp — where a "camp" is a curriculum at a venue.
    // A multi-week camp is stored as N weekly camp_sessions rows sharing the same
    // (curriculum, location); without this a family gets a fresh welcome as EACH
    // week enters the window (a child in a 4-week camp got 4 welcomes). Collapse
    // each (parent, student, camp) to the child's EARLIEST session — that single
    // session is the one welcome. Grouping is by curriculum + venue, NOT venue
    // alone: a child doing two DIFFERENT camps at the same venue (different
    // curricula, e.g. LEGO one week and Robotics another) still gets a heads-up
    // for each. Earlier weeks may already be past today's window, so we look at
    // ALL of the child's confirmed camp sessions — not just the windowed ones —
    // so a later week whose earlier week already fired is correctly skipped.
    const venueKey = (locId: string | null, locName: string | null) =>
      locId ? `loc:${locId}` : `name:${(locName ?? "").trim().toLowerCase()}`;
    // A camp run = a curriculum at a venue. Prefer curriculum_id; fall back to
    // curriculum_name so rows missing the id still group by the named camp.
    const runKey = (locId: string | null, locName: string | null, currId: string | null, currName: string | null) =>
      `${venueKey(locId, locName)}|${currId ? `c:${currId}` : `cn:${(currName ?? "").trim().toLowerCase()}`}`;
    const studentIds = Array.from(new Set(rows.map((r: any) => r.students.id)));
    const { data: allCampRegs, error: allErr } = await supabase
      .from("registrations")
      .select("parent_id, student_id, camp_sessions!inner ( id, starts_on, location_id, location_name, curriculum_id, curriculum_name )")
      .eq("organization_id", a.organization_id)
      .eq("status", "confirmed")
      .not("camp_session_id", "is", null)
      .in("student_id", studentIds);
    if (allErr) throw allErr;

    // keeper = the (earliest starts_on, then lowest id) session per (parent, student, camp)
    const keeper = new Map<string, { starts_on: string; id: string }>();
    for (const cr of (allCampRegs ?? []) as any[]) {
      const cs = cr.camp_sessions;
      if (!cs?.id || !cs.starts_on) continue;
      const k = `${cr.parent_id}|${cr.student_id}|${runKey(cs.location_id, cs.location_name, cs.curriculum_id, cs.curriculum_name)}`;
      const cur = keeper.get(k);
      if (!cur || cs.starts_on < cur.starts_on || (cs.starts_on === cur.starts_on && cs.id < cur.id)) {
        keeper.set(k, { starts_on: cs.starts_on, id: cs.id });
      }
    }

    return rows
      .filter((r: any) => {
        const cs = r.camp_sessions;
        const k = `${r.parents.id}|${r.students.id}|${runKey(cs.location_id, cs.location_name, cs.curriculum_id, cs.curriculum_name)}`;
        return keeper.get(k)?.id === cs.id;
      })
      .map((r: any) => ({
        context_key: `camp:${r.camp_sessions.id}:parent:${r.parents.id}:student:${r.students.id}`,
        parent_id: r.parents.id,
        parent_email: r.parents.email,
        parent_first_name: r.parents.first_name,
        child_first_name: r.students?.first_name ?? null,
        program_name: r.camp_sessions.curriculum_name ?? "your camp",
        program_start_date: formatDate(r.camp_sessions.starts_on),
        program_end_date: r.camp_sessions.ends_on ? formatDate(r.camp_sessions.ends_on) : "",
        // camp_sessions.start_time/end_time are Postgres `time` values → format.
        program_time: timeClause(r.camp_sessions.start_time, r.camp_sessions.end_time, false),
        location_name: r.camp_sessions.location_name ?? "",
        abandoned_resume_url: "",
        age_turning: "",
        final_showcase_raw: r.camp_sessions.curricula?.final_showcase ?? "",
        mid_term_skills_raw: (r.camp_sessions.curricula?.mid_term_skills as string[] | null) ?? [],
        final_recap_skills_raw: (r.camp_sessions.curricula?.final_recap_skills as string[] | null) ?? [],
        arrival_instructions_raw: r.camp_sessions.program_locations?.parent_arrival_instructions ?? "",
        dismissal_instructions_raw: r.camp_sessions.program_locations?.parent_dismissal_instructions ?? "",
        session_dates_raw: [],
        register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
        next_term_available: nextTermAvailable,
      }));
  }

  // applies_to='both' — currently no template uses this for Welcome, but
  // handle gracefully by running both queries and concatenating.
  return [];
}

// ─── Check-in (afterschool only, fires N days after first session) ──────────
async function resolveCheckInAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  const days = pickNumber(a.timing_override?.days_after, a.template.default_timing?.days_after, 14);
  // 3-day grace window so a slightly-delayed cron still catches recent starts.
  // Idempotency UNIQUE constraint handles dedup across days.
  const earliest = new Date(Date.now() - (days + 3) * 86400000).toISOString().slice(0, 10);
  const latest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, a.organization_id);

  const { data, error } = await supabase
    .from("registrations")
    .select(`
      id, parent_id,
      students!inner ( id, first_name ),
      parents!inner ( id, first_name, email ),
      programs!inner ( id, curriculum, first_session_date, start_time, end_time, program_location_id, curriculum_id, program_locations ( name, parent_arrival_instructions, parent_dismissal_instructions ), curricula ( final_showcase, mid_term_skills, final_recap_skills ) )
    `)
    .eq("organization_id", a.organization_id)
    .eq("status", "confirmed")
    .not("program_id", "is", null)
    .gte("programs.first_session_date", earliest)
    .lte("programs.first_session_date", latest);
  if (error) throw error;

  return (data ?? [])
    .filter((r: any) => r.parents?.email && r.students?.id)
    .map((r: any) => ({
      context_key: `program:${r.programs.id}:parent:${r.parents.id}:student:${r.students.id}:check_in`,
      parent_id: r.parents.id,
      parent_email: r.parents.email,
      parent_first_name: r.parents.first_name,
      child_first_name: r.students?.first_name ?? null,
      program_name: r.programs.curriculum ?? "your program",
      program_start_date: formatDate(r.programs.first_session_date),
      program_end_date: "",
      // programs.start_time/end_time are already human text ("3:25 PM").
      program_time: timeClause(r.programs.start_time, r.programs.end_time, true),
      location_name: r.programs.program_locations?.name ?? "",
      abandoned_resume_url: "",
      age_turning: "",
      final_showcase_raw: r.programs.curricula?.final_showcase ?? "",
      mid_term_skills_raw: (r.programs.curricula?.mid_term_skills as string[] | null) ?? [],
      final_recap_skills_raw: (r.programs.curricula?.final_recap_skills as string[] | null) ?? [],
      arrival_instructions_raw: r.programs.program_locations?.parent_arrival_instructions ?? "",
      dismissal_instructions_raw: r.programs.program_locations?.parent_dismissal_instructions ?? "",
      session_dates_raw: [],
      register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
      next_term_available: nextTermAvailable,
    }));
}

// ─── Mid recap (camps + afterschool) ────────────────────────────────────────
// For camps: midpoint = (starts_on + ends_on) / 2.
// For afterschool: calls derive_program_session_dates(program_id) and picks
//   the middle index — honors district + location closures per the
//   feedback-session-date-function memory rule.
async function resolveMidRecapAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  const todayStr = new Date().toISOString().slice(0, 10);
  return resolveRecapAudience(supabase, a, todayStr, "mid_recap", (sessions) => {
    if (!sessions || sessions.length === 0) return null;
    return sessions[Math.floor(sessions.length / 2)] ?? null;
  }, (startsOn, endsOn) => {
    const startMs = new Date(startsOn + "T00:00:00").getTime();
    const endMs = new Date(endsOn + "T00:00:00").getTime();
    return new Date(startMs + (endMs - startMs) / 2).toISOString().slice(0, 10);
  });
}

// ─── Final recap (camps + afterschool) ──────────────────────────────────────
// For camps: last day = ends_on.
// For afterschool: last element of derive_program_session_dates.
async function resolveFinalRecapAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  const todayStr = new Date().toISOString().slice(0, 10);
  return resolveRecapAudience(supabase, a, todayStr, "final_recap",
    (sessions) => (sessions && sessions.length > 0 ? sessions[sessions.length - 1] : null),
    (_startsOn, endsOn) => endsOn,
  );
}

// Shared resolver for mid_recap + final_recap. Different from Welcome because
// the date we care about is COMPUTED from the program/camp, not stored on
// programs.first_session_date directly.
async function resolveRecapAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
  todayStr: string,
  contextSuffix: string,
  pickProgramDate: (sessions: string[] | null) => string | null,
  pickCampDate: (startsOn: string, endsOn: string) => string,
): Promise<AudienceEntry[]> {
  const entries: AudienceEntry[] = [];
  const includeCamps = a.template.applies_to_program_type === "camps" || a.template.applies_to_program_type === "both";
  const includeAfterschool = a.template.applies_to_program_type === "afterschool" || a.template.applies_to_program_type === "both";
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, a.organization_id);

  // 1. Camps — recap dates are computed at the CAMP-RUN level, not per weekly
  // session. A multi-week camp is stored as N weekly camp_sessions sharing
  // (cycle_id, location_name, curriculum_name); a family enrolls in a span of
  // those weeks. Both recaps fire ONCE for the whole run, on the child's actual
  // span — not once per week:
  //   - final_recap: run's last day  = max(ends_on) over the child's weeks
  //   - mid_recap:   run's midpoint   = halfway between first start & last end
  // A single-week camp is just a one-week run (window == that session), so its
  // dates and idempotency key are unchanged from the per-session behavior.
  if (includeCamps) {
    const { data: camps, error: cErr } = await supabase
      .from("camp_sessions")
      .select("id, cycle_id, starts_on, ends_on, start_time, end_time, curriculum_name, location_name, curriculum_id, curricula ( final_showcase, mid_term_skills, final_recap_skills )")
      .eq("organization_id", a.organization_id)
      .not("starts_on", "is", null)
      .not("ends_on", "is", null);
    if (cErr) throw cErr;

    if ((camps ?? []).length > 0) {
      const campById = new Map<string, any>((camps ?? []).map((c: any) => [c.id, c]));
      const { data: regs, error: rErr } = await supabase
        .from("registrations")
        .select(`
          id, parent_id, camp_session_id,
          students!inner ( id, first_name ),
          parents!inner ( id, first_name, email )
        `)
        .eq("organization_id", a.organization_id)
        .eq("status", "confirmed")
        .in("camp_session_id", (camps ?? []).map((c: any) => c.id));
      if (rErr) throw rErr;

      // Group each family's confirmed weeks into camp-runs, one entry per
      // (student, run). Two families in the same run can have different spans,
      // so the run window is computed per-student from their own weeks.
      const runKeyOf = (c: any) => `${c.cycle_id ?? ""}|${c.location_name ?? ""}|${c.curriculum_name ?? ""}`;
      const runs = new Map<string, { parent: any; student: any; sessions: any[] }>();
      for (const r of (regs ?? []) as any[]) {
        if (!r.parents?.email || !r.students?.id) continue;
        const camp = campById.get(r.camp_session_id);
        if (!camp) continue;
        const key = `${r.students.id}::${runKeyOf(camp)}`;
        let agg = runs.get(key);
        if (!agg) { agg = { parent: r.parents, student: r.students, sessions: [] }; runs.set(key, agg); }
        agg.sessions.push(camp);
      }

      for (const agg of runs.values()) {
        const sorted = agg.sessions.slice().sort((x, y) => (x.starts_on < y.starts_on ? -1 : x.starts_on > y.starts_on ? 1 : 0));
        const first = sorted[0];
        const runStart = sorted.reduce((m, s) => (s.starts_on < m ? s.starts_on : m), first.starts_on);
        const runEnd = sorted.reduce((m, s) => (s.ends_on > m ? s.ends_on : m), first.ends_on);
        if (pickCampDate(runStart, runEnd) !== todayStr) continue;
        // Idempotency anchor: final keys on the LAST week, mid on the FIRST.
        // Single-week runs are unaffected (first == last == the one session).
        // For a multi-week run it lets the true final still send even if an
        // earlier week already sent one under the old per-session logic, and
        // dedups a mid against a mid already sent for an earlier week.
        const anchor = contextSuffix === "final_recap" ? sorted[sorted.length - 1] : first;
        entries.push({
          context_key: `camp:${anchor.id}:parent:${agg.parent.id}:student:${agg.student.id}:${contextSuffix}`,
          parent_id: agg.parent.id,
          parent_email: agg.parent.email,
          parent_first_name: agg.parent.first_name,
          child_first_name: agg.student.first_name,
          program_name: first.curriculum_name ?? "your camp",
          program_start_date: formatDate(runStart),
          program_end_date: formatDate(runEnd),
          // Weekly sessions in a run share a daily time; the first week is the anchor.
          program_time: timeClause(first.start_time, first.end_time, false),
          location_name: first.location_name ?? "",
          abandoned_resume_url: "",
          age_turning: "",
          final_showcase_raw: first.curricula?.final_showcase ?? "",
          mid_term_skills_raw: (first.curricula?.mid_term_skills as string[] | null) ?? [],
          final_recap_skills_raw: (first.curricula?.final_recap_skills as string[] | null) ?? [],
          arrival_instructions_raw: first.program_locations?.parent_arrival_instructions ?? "",
          dismissal_instructions_raw: first.program_locations?.parent_dismissal_instructions ?? "",
          session_dates_raw: [],
          register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
          next_term_available: nextTermAvailable,
        });
      }
    }
  }

  // 2. Afterschool — derive_program_session_dates per program
  if (includeAfterschool) {
      const { data: programs, error: pErr } = await supabase
      .from("programs")
      .select("id, curriculum, first_session_date, start_time, end_time, program_location_id, curriculum_id, program_locations ( name, parent_arrival_instructions, parent_dismissal_instructions ), curricula ( final_showcase, mid_term_skills, final_recap_skills )")
      .eq("organization_id", a.organization_id);
    if (pErr) throw pErr;

    const matchingProgramIds: string[] = [];
    const programMeta = new Map<string, any>();
    for (const p of (programs ?? []) as any[]) {
      const { data: sessions, error: dErr } = await supabase
        .rpc("derive_program_session_dates", { p_program_id: p.id });
      if (dErr || !sessions) continue;
      const targetDate = pickProgramDate(sessions as string[]);
      if (targetDate !== todayStr) continue;
      matchingProgramIds.push(p.id);
      programMeta.set(p.id, {
        curriculum: p.curriculum,
        location_name: p.program_locations?.name ?? "",
        program_time: timeClause(p.start_time, p.end_time, true),
        first_session_date: p.first_session_date,
        last_session_date: (sessions as string[])[sessions.length - 1] ?? null,
        final_showcase: p.curricula?.final_showcase ?? "",
        mid_term_skills: (p.curricula?.mid_term_skills as string[] | null) ?? [],
        final_recap_skills: (p.curricula?.final_recap_skills as string[] | null) ?? [],
        arrival_instructions: p.program_locations?.parent_arrival_instructions ?? "",
        dismissal_instructions: p.program_locations?.parent_dismissal_instructions ?? "",
        session_dates: (sessions as string[]) ?? [],
      });
    }

    if (matchingProgramIds.length > 0) {
      const { data: regs, error: rErr } = await supabase
        .from("registrations")
        .select(`
          id, parent_id, program_id,
          students!inner ( id, first_name ),
          parents!inner ( id, first_name, email )
        `)
        .eq("organization_id", a.organization_id)
        .eq("status", "confirmed")
        .in("program_id", matchingProgramIds);
      if (rErr) throw rErr;

      for (const r of (regs ?? []) as any[]) {
        if (!r.parents?.email || !r.students?.id) continue;
        const meta = programMeta.get(r.program_id);
        if (!meta) continue;
        entries.push({
          context_key: `program:${r.program_id}:parent:${r.parents.id}:student:${r.students.id}:${contextSuffix}`,
          parent_id: r.parents.id,
          parent_email: r.parents.email,
          parent_first_name: r.parents.first_name,
          child_first_name: r.students.first_name,
          program_name: meta.curriculum ?? "your program",
          program_start_date: meta.first_session_date ? formatDate(meta.first_session_date) : "",
          program_end_date: meta.last_session_date ? formatDate(meta.last_session_date) : "",
          program_time: meta.program_time ?? "",
          location_name: meta.location_name,
          abandoned_resume_url: "",
          age_turning: "",
          final_showcase_raw: meta.final_showcase ?? "",
          mid_term_skills_raw: meta.mid_term_skills ?? [],
          final_recap_skills_raw: meta.final_recap_skills ?? [],
          arrival_instructions_raw: meta.arrival_instructions ?? "",
          dismissal_instructions_raw: meta.dismissal_instructions ?? "",
          session_dates_raw: meta.session_dates ?? [],
          register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
          next_term_available: nextTermAvailable,
        });
      }
    }
  }

  return entries;
}

// ─── Birthday (camps + afterschool, fires when student DOB matches today) ───
// ─── Instructor birthday (fires on an active instructor's birthday) ──────────
// The instructor-audience sibling of resolveBirthdayAudience. Reads
// instructors.date_of_birth (not students), and messages only ACTIVE instructors
// who have an email. Single-audience automation: the operator-editable body IS
// the instructor copy, so it sets NO per-entry subject_template/body_template
// (unlike no_school_day's two-audience split) — sendOne falls back to the
// override/default, which is what we want. {{first_name}} = the instructor's
// first name; no age is referenced. Org-scoped; no hardcoded tenant. Idempotent
// per instructor per year via the context_key.
async function resolveInstructorBirthdayAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = now.getFullYear();

  // PostgREST can't easily filter on EXTRACT(month/day FROM date_of_birth), so
  // fetch active instructors with a birthdate in this org and match month/day in
  // TS (mirrors resolveBirthdayAudience). At tenant scale this is a small list.
  const { data: instructors, error } = await supabase
    .from("instructors")
    .select("id, first_name, preferred_name, email, date_of_birth")
    .eq("organization_id", a.organization_id)
    .eq("is_active", true)
    .not("date_of_birth", "is", null)
    .not("email", "is", null);
  if (error) throw error;

  return (instructors ?? [])
    .filter((i: any) => {
      if (!i.date_of_birth || !i.email) return false;
      const parts = String(i.date_of_birth).split("-").map(Number);
      return parts[1] === month && parts[2] === day;
    })
    .map((i: any) => ({
      // parent_* are the engine's GENERIC recipient fields (just named "parent").
      // parent_id stays null: automation_run_recipients.parent_id has no FK, and
      // an instructor id is not a parent id — writing one would be a lie.
      context_key: `instructor:${i.id}:year:${year}`,
      parent_id: null,
      parent_email: i.email,
      // Prefer the name the instructor goes by — a birthday note is the most
      // personal send there is, so "Bo" must not get "Happy birthday, Rebecca!"
      // (mirrors the roster/contacts display rule: preferred_name ?? first_name).
      parent_first_name: i.preferred_name?.trim() || i.first_name,
      child_first_name: null,
      program_name: "",
      program_start_date: "",
      program_end_date: "",
      location_name: "",
      abandoned_resume_url: "",
      age_turning: "",
      final_showcase_raw: "",
      mid_term_skills_raw: [],
      final_recap_skills_raw: [],
      arrival_instructions_raw: "",
      dismissal_instructions_raw: "",
      session_dates_raw: [],
      register_url: "",
      next_term_available: false,
    }));
}

// ─── Partner roster (afterschool only, we-run-registration, to partner sites) ─
// This automation is SPECIAL: it doesn't use the normal audience→sendOne pipeline.
// Instead it finds qualifying programs and invokes email-program-roster (which
// builds a branded PDF and sends it). Two fires per program: 7 days before
// first_session_date (snapshot) + morning of the first day (final). Idempotent
// per program per day via roster_email_sends. Records in automation_runs for the
// Automations UI stats, and in roster_email_sends for per-send tracking.
async function runPartnerRosterAutomation(
  supabase: SupabaseClient,
  a: AutomationRow,
) {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const sevenOut = new Date(now);
  sevenOut.setDate(sevenOut.getDate() + 7);
  const sevenDayStr = sevenOut.toISOString().split("T")[0];

  // Find afterschool programs starting in 7 days OR today, where WE run
  // registration (not partner-run) and the location has a partner.
  const { data: programs, error: pErr } = await supabase
    .from("programs")
    .select(`
      id, organization_id, program_location_id, curriculum,
      first_session_date, program_type, runs_own_registration,
      program_locations!inner ( id, partner_id, contact_email )
    `)
    .eq("organization_id", a.organization_id)
    .eq("program_type", "afterschool")
    .eq("runs_own_registration", false)
    .not("program_locations.partner_id", "is", null)
    .or(`first_session_date.eq.${sevenDayStr},first_session_date.eq.${todayStr}`);

  if (pErr) throw pErr;

  if (!programs || programs.length === 0) {
    await supabase.from("automation_runs").insert({
      automation_id: a.id,
      organization_id: a.organization_id,
      audience_size: 0,
      status: "skipped_no_audience",
    });
    return { audience: 0, sent: 0, failed: 0, skipped: 0 };
  }

  // Idempotency: check which programs already had a roster sent today
  const programIds = programs.map((p: any) => p.id);
  const { data: sentToday } = await supabase
    .from("roster_email_sends")
    .select("program_id")
    .in("program_id", programIds)
    .gte("sent_at", `${todayStr}T00:00:00+00:00`)
    .eq("status", "sent");
  const alreadySent = new Set((sentToday ?? []).map((r: any) => r.program_id));

  let sent = 0;
  let failed = 0;
  let skippedCount = 0;

  for (const prog of programs as any[]) {
    if (alreadySent.has(prog.id)) {
      skippedCount++;
      continue;
    }

    const partnerId = prog.program_locations?.partner_id;
    if (!partnerId) { skippedCount++; continue; }

    // Resolve partner_contacts for this partner
    const { data: contacts } = await supabase
      .from("partner_contacts")
      .select("id")
      .eq("partner_id", partnerId)
      .eq("organization_id", a.organization_id);

    const contactIds = (contacts ?? []).map((c: any) => c.id);
    if (contactIds.length === 0 && !prog.program_locations?.contact_email) {
      skippedCount++;
      continue;
    }

    // Invoke email-program-roster with service-role auth
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/email-program-roster`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({
          program_id: prog.id,
          recipient_contact_ids: contactIds,
          include_location_contact: true,
          mode: "send",
        }),
      });

      if (resp.ok) {
        sent++;
      } else {
        const errBody = await resp.text().catch(() => "");
        console.error(`[partner-roster] send failed for program ${prog.id}: ${errBody.slice(0, 300)}`);
        failed++;
      }
    } catch (err) {
      console.error(`[partner-roster] invoke failed for program ${prog.id}:`, err);
      failed++;
    }
  }

  // Track the automation run
  const totalAudience = sent + failed;
  const timeSavedMinutes = sent * a.template.time_saved_minutes_per_send;
  const finalStatus = totalAudience === 0 ? "skipped_no_audience" : (failed > 0 && sent === 0 ? "failed" : "sent");
  await supabase.from("automation_runs").insert({
    automation_id: a.id,
    organization_id: a.organization_id,
    audience_size: totalAudience,
    status: finalStatus,
    time_saved_minutes: timeSavedMinutes,
    error_message: failed > 0 ? `${failed} of ${programs.length} roster sends failed` : null,
  });

  if (sent > 0) {
    const siteWord = sent === 1 ? "site" : "sites";
    await supabase.from("time_saved_events").insert({
      organization_id: a.organization_id,
      action_type: "automation_fired",
      action_label: `Sent roster to ${sent} partner ${siteWord}`,
      hours_saved: timeSavedMinutes / 60,
      related_entity_type: "automation",
      related_entity_id: a.id,
    });
  }

  return { programs_found: programs.length, sent, failed, skipped: skippedCount, time_saved_minutes: timeSavedMinutes };
}

async function resolveBirthdayAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const year = now.getFullYear();
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, a.organization_id);

  // PostgREST doesn't easily filter on EXTRACT(month/day FROM birthdate), so
  // fetch all students with a birthdate in this org and filter month/day in TS.
  // At J2S scale (~200 students) this is fine; larger orgs may want an RPC.
  const { data: studentsAll, error: sErr } = await supabase
    .from("students")
    .select(`
      id, first_name, birthdate, parent_id,
      parents!inner ( id, first_name, email )
    `)
    .eq("organization_id", a.organization_id)
    .not("birthdate", "is", null);
  if (sErr) throw sErr;

  const birthdayStudents = (studentsAll ?? []).filter((s: any) => {
    if (!s.birthdate) return false;
    const parts = s.birthdate.split("-").map(Number);
    return parts[1] === month && parts[2] === day;
  });

  // ── Enrolled students (reg-gated) — behavior UNCHANGED for reg tenants (J2S).
  // Only message families with at least one confirmed registration — avoids
  // sending happy-birthday to a student record that never registered for anything.
  let studentEntries: AudienceEntry[] = [];
  if (birthdayStudents.length > 0) {
    const studentIds = birthdayStudents.map((s: any) => s.id);
    const { data: regs, error: rErr } = await supabase
      .from("registrations")
      .select("student_id")
      .eq("organization_id", a.organization_id)
      .eq("status", "confirmed")
      .in("student_id", studentIds);
    if (rErr) throw rErr;
    const registeredStudentIds = new Set((regs ?? []).map((r: any) => r.student_id));
    studentEntries = birthdayStudents
      .filter((s: any) => registeredStudentIds.has(s.id) && s.parents?.email)
      .map((s: any) => {
        const birthYear = Number(s.birthdate.split("-")[0]);
        return {
          context_key: `student:${s.id}:year:${year}`,
          parent_id: s.parents.id,
          parent_email: s.parents.email,
          parent_first_name: s.parents.first_name,
          child_first_name: s.first_name,
          program_name: "",
          program_start_date: "",
          program_end_date: "",
          location_name: "",
          abandoned_resume_url: "",
          age_turning: String(year - birthYear),
          final_showcase_raw: "",
          mid_term_skills_raw: [],
          final_recap_skills_raw: [],
          arrival_instructions_raw: "",
          dismissal_instructions_raw: "",
          session_dates_raw: [],
          register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
          // ⓘ default-zero defaults for resolvers that don't carry per-program
          // arrival/dismissal/session data (birthday, abandoned).
          next_term_available: nextTermAvailable,
        };
      });
  }

  // ── Contacts (marketing_recipients) — relationship automation, NO registration
  // required, so subscription/non-reg tenants (Richelle, Demetrius) get birthdays
  // off their uploaded list. ADDITIVE to the student path above. Deduped by child
  // first name + email (seeded from the student entries), so a family present as
  // both a student and a contact under the SAME email is emailed once. Cross-email
  // dedup is best-effort: a HYBRID tenant that runs registration AND uploads the
  // same family as a contact under a DIFFERENT email could get two — no current
  // tenant does (reg tenants have no contact birthdates; non-reg tenants have no
  // students). Matching on child-name-only is deliberately avoided: it would wrongly
  // merge two different families with a same-named child and drop one's birthday.
  // Honors marketing_suppressions (deliverability). Does NOT honor suppress_welcome
  // — that flag is welcome-specific; a family skipped from the welcome should still
  // get a birthday note. Runs even when there are 0 birthday students (Richelle).
  const { data: contactsAll, error: cErr } = await supabase
    .from("marketing_recipients")
    .select("id, email, parent_name, child_first_name, child_birthdate")
    .eq("organization_id", a.organization_id)
    .not("child_birthdate", "is", null);
  if (cErr) throw cErr;
  const birthdayContacts = (contactsAll ?? []).filter((c: any) => {
    if (!c.child_birthdate || !c.email) return false;
    const p = String(c.child_birthdate).split("-").map(Number);
    return p[1] === month && p[2] === day;
  });

  let contactEntries: AudienceEntry[] = [];
  if (birthdayContacts.length > 0) {
    // Deliverability suppression (org-scoped). Fail-closed: throw so the run is
    // skipped + retried rather than send blind and re-hit a hard bounce/complaint.
    const { data: supp, error: suppErr } = await supabase
      .from("marketing_suppressions")
      .select("email")
      .eq("organization_id", a.organization_id);
    if (suppErr) throw suppErr;
    const suppressed = new Set(((supp ?? []) as Array<{ email: string }>).map((s) => (s.email || "").toLowerCase()));
    // Dedup key = child first name + recipient email, seeded with the student
    // entries so a student-and-contact family is only emailed once.
    const dedupKey = (child: string | null, email: string) =>
      `${(child || "").toLowerCase().trim()}|${email.toLowerCase().trim()}`;
    const seen = new Set(studentEntries.map((e) => dedupKey(e.child_first_name, e.parent_email)));
    contactEntries = birthdayContacts
      .filter((c: any) => {
        const email = String(c.email);
        if (suppressed.has(email.toLowerCase())) return false;
        const key = dedupKey(c.child_first_name, email);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c: any) => {
        const birthYear = Number(String(c.child_birthdate).split("-")[0]);
        return {
          context_key: `contact:${c.id}:birthday:year:${year}`,
          parent_id: null,
          parent_email: String(c.email),
          parent_first_name: firstNameFromFull(c.parent_name),
          child_first_name: c.child_first_name ?? null,
          program_name: "",
          program_start_date: "",
          program_end_date: "",
          location_name: "",
          abandoned_resume_url: "",
          age_turning: String(year - birthYear),
          final_showcase_raw: "",
          mid_term_skills_raw: [],
          final_recap_skills_raw: [],
          arrival_instructions_raw: "",
          dismissal_instructions_raw: "",
          session_dates_raw: [],
          register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
          next_term_available: nextTermAvailable,
        };
      });
  }

  return [...studentEntries, ...contactEntries];
}

// ─── Contact added (welcome_contact) ────────────────────────────────────────
// Contact-based, NOT enrollment-based: fires off marketing_recipients so it
// reaches every family a tenant loads (CRM contacts), not just those who
// registered through Enrops. Two guardrails against a blast:
//   - suppress_welcome = true  → set by the "existing families" import choice,
//     so importing an existing roster never welcomes the whole list.
//   - a short created-at window (days_window, default 2) → enabling the
//     automation only touches very recently added contacts, never months of
//     history. Idempotency (context_key) makes re-runs safe.
// Deliverability: welcome is 'informational' (exempt from the promotional
// unsubscribe filter), but we still skip anyone on marketing_suppressions so a
// hard bounce / complaint can't be re-hit and hurt the sending domain.
async function resolveContactAddedAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  // Only welcome contacts added AFTER this automation was turned on — never the
  // existing back-catalog. FAIL-CLOSED: if enabled_at is somehow unset (an enable
  // that bypassed the UI — a seed or manual SQL), skip entirely rather than fall
  // back to a time window, so we can never blast a fresh bulk import. The UI
  // always stamps enabled_at on toggle-on; idempotency keeps re-runs single-send.
  if (!a.enabled_at) return [];
  const since = a.enabled_at;

  const { data, error } = await supabase
    .from("marketing_recipients")
    .select("id, email, parent_name, child_first_name, created_at")
    .eq("organization_id", a.organization_id)
    .eq("suppress_welcome", false)
    .gte("created_at", since);
  if (error) throw error;
  if (!data || data.length === 0) return [];

  // Org-scoped suppression list (deliverability guard — see header note).
  // Fail-closed: if we can't load it, throw so this run is skipped and retried —
  // never send blind and risk re-hitting a hard bounce / complaint.
  const { data: supp, error: suppErr } = await supabase
    .from("marketing_suppressions")
    .select("email")
    .eq("organization_id", a.organization_id);
  if (suppErr) throw suppErr;
  const suppressed = new Set(((supp ?? []) as Array<{ email: string }>).map((s) => (s.email || "").toLowerCase()));

  return (data as Array<{ id: string; email: string | null; parent_name: string | null; child_first_name: string | null }>)
    .filter((r) => r.email && !suppressed.has(r.email.toLowerCase()))
    .map((r) => ({
      context_key: `contact:${r.id}:welcome`,
      parent_id: null,
      parent_email: r.email as string,
      parent_first_name: firstNameFromFull(r.parent_name),
      child_first_name: r.child_first_name ?? null,
      program_name: "",
      program_start_date: "",
      program_end_date: "",
      location_name: "",
      abandoned_resume_url: "",
      age_turning: "",
      final_showcase_raw: "",
      mid_term_skills_raw: [],
      final_recap_skills_raw: [],
      arrival_instructions_raw: "",
      dismissal_instructions_raw: "",
      session_dates_raw: [],
      register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
      next_term_available: false,
    }));
}

// ─── Review request (dual anchor: registrations + contacts) ─────────────────
// Fires ~N days (default 42) after a family's relationship started, asking for
// a review. TWO anchors, unioned — so it works for BOTH tenant shapes:
//   - Registration anchor: N days after the first session (afterschool program
//     first_session_date; camps earliest session of a camp-run). Serves reg
//     tenants (J2S).
//   - Contact anchor: N days after a marketing_recipients contact was added.
//     Serves contact-only tenants (Richelle's Kumon families — 0 registrations).
// Mirrors the birthday resolver's student+contact union.
//
// PROMOTIONAL (mailing_type='marketing'): both anchors filter
// marketing_suppressions (fail-closed), and sendOne appends an unsubscribe link.
//
// Dedup: ONE review ask per family (email) per CALENDAR YEAR — context_key is
// keyed on email+year, so a multi-kid family, a re-imported contact, or a family
// that's both a registrant and a contact gets a single ask, and it may recur in a
// later year. Idempotency (UNIQUE automation_id+context_key) enforces it.
//
// FORWARD-ONLY (fail-closed, mirrors resolveContactAddedAudience): fires only for
// anchors on/after the automation was enabled, so toggling it on never blasts the
// back-catalog of families who joined weeks ago. Reaching existing families needs
// a deliberate count-and-confirm send (not built). If enabled_at is unset (a seed
// or manual enable that bypassed the UI), skip entirely rather than risk a blast.
async function resolveReviewRequestAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  if (!a.enabled_at) return [];
  const days = Math.max(1, pickNumber(a.timing_override?.days_after, a.template.default_timing?.days_after, 30));
  // 3-day grace window so a slightly-delayed cron still catches the anchor date.
  const windowStart = new Date(Date.now() - (days + 3) * 86400000).toISOString().slice(0, 10);
  const latest = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // Forward-only: never anchor before the automation was enabled. Until `days`
  // days after enabling, earliest > latest so every anchor filters out (0 sends) —
  // exactly what prevents the on-enable back-catalog blast.
  const enabledDay = a.enabled_at.slice(0, 10);
  const earliest = windowStart > enabledDay ? windowStart : enabledDay;
  const year = new Date().getUTCFullYear();
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, a.organization_id);

  const regEntries: AudienceEntry[] = [];

  // ── Registration anchor, afterschool: one per (parent, student, program).
  {
    const { data, error } = await supabase
      .from("registrations")
      .select(`
        id, parent_id,
        students!inner ( id, first_name ),
        parents!inner ( id, first_name, email ),
        programs!inner ( id, curriculum, first_session_date )
      `)
      .eq("organization_id", a.organization_id)
      .eq("status", "confirmed")
      .not("program_id", "is", null)
      .gte("programs.first_session_date", earliest)
      .lte("programs.first_session_date", latest);
    if (error) throw error;
    for (const r of (data ?? []) as any[]) {
      if (!r.parents?.email || !r.students?.id) continue;
      regEntries.push(makeReviewEntry({
        year,
        parentId: r.parents.id,
        email: r.parents.email,
        parentFirstName: r.parents.first_name,
        childFirstName: r.students.first_name ?? null,
        programName: r.programs.curriculum ?? "",
        orgSlug: a.org.slug,
        nextTermAvailable,
      }));
    }
  }

  // ── Registration anchor, camps: anchor to the EARLIEST session of each
  // camp-run (a curriculum at a venue), so a multi-week camp stored as N weekly
  // sessions produces ONE review ask, timed off week 1 — mirrors the welcome
  // resolver's keeper logic. We look at ALL of the child's confirmed camp
  // sessions (not just windowed ones) to find the true earliest week.
  {
    const { data, error } = await supabase
      .from("registrations")
      .select(`
        parent_id,
        students!inner ( id, first_name ),
        parents!inner ( id, first_name, email ),
        camp_sessions!inner ( id, curriculum_name, starts_on, location_id, location_name, curriculum_id )
      `)
      .eq("organization_id", a.organization_id)
      .eq("status", "confirmed")
      .not("camp_session_id", "is", null);
    if (error) throw error;

    const venueKey = (locId: string | null, locName: string | null) =>
      locId ? `loc:${locId}` : `name:${(locName ?? "").trim().toLowerCase()}`;
    const runKey = (locId: string | null, locName: string | null, currId: string | null, currName: string | null) =>
      `${venueKey(locId, locName)}|${currId ? `c:${currId}` : `cn:${(currName ?? "").trim().toLowerCase()}`}`;
    // keeper = earliest (starts_on, then lowest id) session per (parent, student, camp-run)
    const keeper = new Map<string, any>();
    for (const r of (data ?? []) as any[]) {
      const cs = r.camp_sessions;
      if (!r.parents?.email || !r.students?.id || !cs?.id || !cs.starts_on) continue;
      const k = `${r.parents.id}|${r.students.id}|${runKey(cs.location_id, cs.location_name, cs.curriculum_id, cs.curriculum_name)}`;
      const cur = keeper.get(k);
      if (!cur || cs.starts_on < cur.cs.starts_on || (cs.starts_on === cur.cs.starts_on && cs.id < cur.cs.id)) {
        keeper.set(k, { r, cs });
      }
    }
    for (const { r, cs } of keeper.values()) {
      // Only fire when the camp-run's FIRST week lands in the anchor window.
      if (cs.starts_on < earliest || cs.starts_on > latest) continue;
      regEntries.push(makeReviewEntry({
        year,
        parentId: r.parents.id,
        email: r.parents.email,
        parentFirstName: r.parents.first_name,
        childFirstName: r.students.first_name ?? null,
        programName: cs.curriculum_name ?? "",
        orgSlug: a.org.slug,
        nextTermAvailable,
      }));
    }
  }

  // ── Contact anchor: marketing_recipients added N days ago.
  const contactEntries: AudienceEntry[] = [];
  {
    const { data, error } = await supabase
      .from("marketing_recipients")
      .select("id, email, parent_name, child_first_name, created_at")
      .eq("organization_id", a.organization_id)
      .gte("created_at", earliest);
    if (error) throw error;
    for (const c of (data ?? []) as any[]) {
      if (!c.email || !c.created_at) continue;
      const added = String(c.created_at).slice(0, 10);
      if (added < earliest || added > latest) continue;
      contactEntries.push(makeReviewEntry({
        year,
        parentId: null,
        email: c.email,
        parentFirstName: firstNameFromFull(c.parent_name),
        childFirstName: c.child_first_name ?? null,
        programName: "",
        orgSlug: a.org.slug,
        nextTermAvailable,
      }));
    }
  }

  // ── Suppression (promotional — filter BOTH anchors). Org-scoped. Fail-closed:
  // if the list can't load, throw so this run is skipped + retried rather than
  // sending a promotional email to someone who opted out.
  const { data: supp, error: suppErr } = await supabase
    .from("marketing_suppressions")
    .select("email")
    .eq("organization_id", a.organization_id);
  if (suppErr) throw suppErr;
  const suppressed = new Set(((supp ?? []) as Array<{ email: string }>).map((s) => (s.email || "").toLowerCase()));

  // ── Merge + dedup by email: one entry per family per run, registration
  // preferred over contact (processed first). context_key is email+year, so a
  // family is asked once per year regardless of which anchor or child surfaced
  // them — the in-run dedup just avoids sending twice within a single run.
  const out: AudienceEntry[] = [];
  const seenEmail = new Set<string>();
  const take = (e: AudienceEntry) => {
    const email = e.parent_email.toLowerCase();
    if (suppressed.has(email)) return;
    if (seenEmail.has(email)) return;
    seenEmail.add(email);
    out.push(e);
  };
  regEntries.forEach(take);
  contactEntries.forEach(take);
  return out;
}

// Build a review-request AudienceEntry with the program-specific blocks empty
// (a review ask carries none). Keeps the resolver terse + consistent.
function makeReviewEntry(p: {
  year: number;
  parentId: string | null;
  email: string;
  parentFirstName: string | null;
  childFirstName: string | null;
  programName: string;
  orgSlug: string;
  nextTermAvailable: boolean;
}): AudienceEntry {
  return {
    // Email+year → one review ask per family per calendar year, whichever anchor
    // (registration or contact) or child surfaced them.
    context_key: `review:${p.email.toLowerCase()}:${p.year}`,
    parent_id: p.parentId,
    parent_email: p.email,
    parent_first_name: p.parentFirstName,
    child_first_name: p.childFirstName,
    program_name: p.programName,
    program_start_date: "",
    program_end_date: "",
    location_name: "",
    abandoned_resume_url: "",
    age_turning: "",
    final_showcase_raw: "",
    mid_term_skills_raw: [],
    final_recap_skills_raw: [],
    arrival_instructions_raw: "",
    dismissal_instructions_raw: "",
    session_dates_raw: [],
    register_url: `${PUBLIC_SITE_URL}/${p.orgSlug}/register`,
    next_term_available: p.nextTermAvailable,
  };
}

// ─── Abandoned registration ─────────────────────────────────────────────────
async function resolveAbandonedAudience(supabase: SupabaseClient, a: AutomationRow): Promise<AudienceEntry[]> {
  const hours = pickNumber(a.timing_override?.hours_after_pending, a.template.default_timing?.hours_after_pending, 24);
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const oldestAcceptable = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
  const nextTermAvailable = await hasFutureProgramsForOrg(supabase, a.organization_id);

  // Don't chase pending registrations older than 7 days — those are rotten leads.
  const { data, error } = await supabase
    .from("registrations")
    .select(`
      id, parent_id, registered_at,
      students ( first_name ),
      parents ( id, first_name, email ),
      programs ( id, curriculum, program_locations ( name, parent_arrival_instructions, parent_dismissal_instructions ) ),
      camp_sessions ( id, curriculum_name, location_name )
    `)
    .eq("organization_id", a.organization_id)
    .eq("status", "pending")
    .lt("registered_at", cutoff)
    .gt("registered_at", oldestAcceptable);

  if (error) throw error;

  return (data ?? [])
    .filter((r: any) => r.parents?.email)
    .map((r: any) => ({
      context_key: `registration:${r.id}`,
      parent_id: r.parents.id,
      parent_email: r.parents.email,
      parent_first_name: r.parents.first_name,
      child_first_name: r.students?.first_name ?? null,
      program_name: r.programs?.curriculum ?? r.camp_sessions?.curriculum_name ?? "your program",
      program_start_date: "",
      program_end_date: "",
      location_name: r.programs?.program_locations?.name ?? r.camp_sessions?.location_name ?? "",
      // Multi-tenant safe — slug comes from the org row joined on automations,
      // never hardcoded. Points to the existing tenant register page; when the
      // resume route ships, the URL pattern doesn't change.
      abandoned_resume_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register?resume_reg=${r.id}`,
      age_turning: "",
      final_showcase_raw: "",
      mid_term_skills_raw: [],
      final_recap_skills_raw: [],
      arrival_instructions_raw: "",
      dismissal_instructions_raw: "",
      session_dates_raw: [],
      register_url: `${PUBLIC_SITE_URL}/${a.org.slug}/register`,
      next_term_available: nextTermAvailable,
    }));
}

// ───────────────────────────────────────────────────────────────────────────
// Token rendering + HTML shell
// ───────────────────────────────────────────────────────────────────────────

// ─── No-school day heads-up (afterschool; parents + assigned instructor) ─────
//
// CALENDAR-anchored, unlike the other resolvers. Reads the org's
// district_calendars, groups each district's no_school_dates into "closure
// periods" (consecutive dates, bridging weekends so a whole winter break is one
// period), and fires `days_before` a period's first day. It iterates the org's
// afterschool programs and, for each, resolves the applicable closures through
// the SAME canonical matcher derive_program_session_dates uses —
// matching_district_calendars (structured district_id + districts.calendar_key +
// legacy free-text, unioned) — so a closure can never be subtracted from a
// program's sessions yet miss this reminder. A program is in scope when its term
// maps to a school_year, it meets on a real weekday, and it isn't draft/cancelled.
// Its confirmed families + confirmed instructor get the heads-up.
//
// FORWARD-ONLY (no on-enable back-catalog blast): a period fires only when its
// natural send day (start − days_before) is on/after the automation's enabled_at
// AND on/before today. So toggling the automation on can never retroactively
// email families about a closure whose send window already opened — mirrors the
// review_request enabled_at gate. Without enabled_at we send nothing.
//
// Idempotency + stability: context_key embeds the period's TRUE start (grouped
// over the full calendar, NOT a today-truncated slice), so a multi-day break
// keeps ONE stable key across the whole send window and is emailed exactly once —
// never re-sent each day the break is in progress. The firing window stays open
// from (start − days) through the period end, so a delayed/missed cron still
// catches up (and dedup prevents a double-send).
//
// Dormant-safe: on a day with no closure in a send window, this returns [] after
// cheap reads. Instructor sends stay silent until program_assignments has
// confirmed rows (out of term it is empty).
//
// Pure date logic (junk-date guarding, weekend-bridging grouping, term mapping,
// date formatting) lives in ./noSchoolDates.ts and is unit-tested there.

const NSD_WEEKDAY_SET = new Set(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);

async function resolveNoSchoolDayAudience(
  supabase: SupabaseClient,
  a: AutomationRow,
): Promise<AudienceEntry[]> {
  const days = pickNumber(a.timing_override?.days_before, a.template.default_timing?.days_before, 7);
  const today = new Date().toISOString().slice(0, 10);
  // Forward-only gate: no enabled_at ⇒ never fire (prevents any send the instant
  // the automation is first toggled on). enabled_at is stamped on OFF→ON.
  const enabledDay = a.enabled_at ? a.enabled_at.slice(0, 10) : null;
  if (!enabledDay) return [];

  // All AFTERSCHOOL programs for the org (the programs table is afterschool; camps
  // live in camp_sessions and never follow the school calendar).
  const { data: progs, error: progErr } = await supabase
    .from("programs")
    .select("id, curriculum, term, day_of_week, first_session_date, program_location_id, status, program_locations!inner ( name )")
    .eq("organization_id", a.organization_id);
  if (progErr) throw progErr;

  const DEAD_STATUSES = new Set(["draft", "cancelled", "canceled", "archived", "deleted"]);
  const relevantProgs = (progs ?? []).filter((p: any) =>
    termToSchoolYear(p.term) !== null &&
    !DEAD_STATUSES.has((p.status ?? "").toLowerCase()) &&
    p.first_session_date &&
    NSD_WEEKDAY_SET.has(String(p.day_of_week ?? "").toLowerCase()),
  );
  if (relevantProgs.length === 0) return [];

  const entries: AudienceEntry[] = [];

  // Calendars per (location, term) via the canonical matcher, cached so N
  // programs that share a school+term cost ONE RPC (structured district_id +
  // calendar_key + free-text, unioned — usually one calendar). Cached as the
  // RAW rows (not pre-merged dates) because early-release exceptions are
  // weekday-specific per program, so that filtering happens per-program below
  // while the RPC itself still only runs once per location+term.
  const calendarsCache = new Map<string, any[]>();
  async function calendarsFor(locationId: string, term: string): Promise<any[]> {
    const key = `${locationId}|${term}`;
    const cached = calendarsCache.get(key);
    if (cached) return cached;
    let rows: any[] = [];
    try {
      const { data: cals } = await supabase.rpc("matching_district_calendars", {
        p_org_id: a.organization_id, p_location_id: locationId, p_term: term,
      });
      rows = (cals ?? []) as any[];
    } catch (e) {
      console.error(`[lifecycle-automations-cron] matching_district_calendars failed for location ${locationId} term ${term}:`, e);
    }
    calendarsCache.set(key, rows);
    return rows;
  }

  // Merges no_school_dates (unconditional) + early-release EXCEPTIONS for this
  // program's weekday (skipping any weekday that's consistently early-release
  // all year for a calendar — district_calendars.consistent_early_release_weekdays,
  // the same cached classification derive_program_session_dates reads via
  // resolve_district_early_release_exceptions — that's the location's normal
  // schedule, not a closure). Keeps this reminder from disagreeing with what
  // derive actually skipped. Then validates/de-junks/sorts/dedupes as before.
  // Floor 2000-01-01 keeps past dates so an in-progress break still groups to
  // its TRUE start (guards the real "0027-01-12" prod typo).
  function closuresForProgram(calendars: any[], firstSessionDate: string): { iso: string; reason: string }[] {
    const weekday = nsdWeekdayLower(firstSessionDate); // programs meet on one fixed weekday
    const weekdayNum = nsdDate(firstSessionDate).getUTCDay();
    const merged: unknown[] = [];
    for (const c of calendars) {
      if (Array.isArray(c.no_school_dates)) merged.push(...c.no_school_dates);
      const consistentWeekdays: number[] = Array.isArray(c.consistent_early_release_weekdays)
        ? c.consistent_early_release_weekdays
        : [];
      if (consistentWeekdays.includes(weekdayNum)) continue; // normal schedule here, not a closure
      if (Array.isArray(c.early_release_dates)) {
        for (const er of c.early_release_dates) {
          if (typeof er?.date === "string" && nsdWeekdayLower(er.date) === weekday) {
            merged.push({ date: er.date, reason: (typeof er?.reason === "string" && er.reason.trim()) || "Early release" });
          }
        }
      }
    }
    return cleanNoSchoolDates(merged, "2000-01-01");
  }

  // Run bounds (derive already skips closures) computed once per program. A derive
  // failure skips that program (fail-safe: never email without knowing the run).
  const sessionsByProg = new Map<string, string[]>();

  for (const p of relevantProgs as any[]) {
    const calendars = await calendarsFor(p.program_location_id, p.term);
    const clean = closuresForProgram(calendars, p.first_session_date);
    if (clean.length === 0) continue;
    const periods = toClosurePeriods(clean);

    // A period fires while today is in [start − days, end] AND its send day is on/
    // after enabled_at (forward-only). Stable key + this window ⇒ exactly one send
    // per closure, with catch-up if the cron was delayed. (periodFires is unit-tested.)
    const firing = periods.filter((pd) => periodFires(pd.startIso, pd.endIso, today, days, enabledDay));
    if (firing.length === 0) continue;

    if (!sessionsByProg.has(p.id)) {
      try {
        const { data: s } = await supabase.rpc("derive_program_session_dates", { p_program_id: p.id });
        sessionsByProg.set(p.id, (s as string[] | null) ?? []);
      } catch (e) {
        console.error(`[lifecycle-automations-cron] derive_program_session_dates failed for program ${p.id}:`, e);
        sessionsByProg.set(p.id, []);
      }
    }
    const sessions = sessionsByProg.get(p.id) ?? [];
    if (sessions.length === 0) continue;
    const lastMeeting = sessions[sessions.length - 1];
    const dow = String(p.day_of_week).toLowerCase();

    for (const period of firing) {
      // The closure dates that would have been THIS program's class days — only
      // ones still in the future (never list a day that has already passed) and
      // inside the program's run. Lower bound is the program's INTENDED start
      // (first_session_date), not derive's first meeting: a closure landing on the
      // very first session is skipped BY derive, so anchoring on derive[0] would
      // drop exactly the case that matters most (a cancelled week-1 class).
      const affected = period.dates.filter((d) =>
        nsdWeekdayLower(d.iso) === dow && d.iso >= today && d.iso >= p.first_session_date && d.iso <= lastMeeting,
      );
      if (affected.length === 0) continue;

        const datesDisplay = formatDateList(affected.map((d) => d.iso));
        const reasons = Array.from(new Set(affected.map((d) => d.reason).filter(Boolean)));
        const reasonDisplay = reasons.length > 0 ? reasons.join(" / ") : undefined;
        const programName = p.curriculum ?? "your program";
        const locationName = p.program_locations?.name ?? "";

        const base = {
          program_name: programName,
          program_start_date: "",
          program_end_date: "",
          location_name: locationName,
          abandoned_resume_url: "",
          age_turning: "",
          final_showcase_raw: "",
          mid_term_skills_raw: [] as string[],
          final_recap_skills_raw: [] as string[],
          arrival_instructions_raw: "",
          dismissal_instructions_raw: "",
          session_dates_raw: [] as string[],
          register_url: "",
          next_term_available: false,
          no_school_dates_display: datesDisplay,
          no_school_reason: reasonDisplay,
        };

        // Parents — confirmed registrations for this program. One heads-up per
        // parent per program per closure (program-centric copy, no child name),
        // so a parent with two kids in the same class isn't emailed twice.
        const { data: regs, error: regErr } = await supabase
          .from("registrations")
          .select("parents!inner ( id, first_name, email )")
          .eq("organization_id", a.organization_id)
          .eq("program_id", p.id)
          .eq("status", "confirmed");
        if (regErr) throw regErr;
        const seenParents = new Set<string>();
        for (const r of (regs ?? []) as any[]) {
          const par = r.parents;
          if (!par?.email || seenParents.has(par.id)) continue;
          seenParents.add(par.id);
          entries.push({
            ...base,
            context_key: `noschool:${period.startIso}:program:${p.id}:parent:${par.id}`,
            parent_id: par.id,
            parent_email: par.email,
            parent_first_name: par.first_name ?? null,
            child_first_name: null,
            recipient_role: "parent",
          });
        }

        // Instructor(s) — assigned + locked in via program_assignments, the single
        // source of truth. 'confirmed' = the instructor accepted the offer
        // (respond-to-assignment sets it); a still-'published' offer might yet be
        // declined, so we don't pre-notify those. instructors.email is NOT NULL, so
        // no null-email path. Armed-but-silent for J2S until FA26 scheduling writes
        // confirmed assignments. (No denormalized programs.instructor_email fallback:
        // it's empty in every environment and the legacy path risks a cross-day
        // double-send under a different context_key.)
        const { data: assigns, error: asgErr } = await supabase
          .from("program_assignments")
          .select("instructor:instructors ( id, first_name, email )")
          .eq("program_id", p.id)
          .in("status", ["confirmed"]);
        if (asgErr) throw asgErr;
        const seenInstr = new Set<string>();
        for (const asg of (assigns ?? []) as any[]) {
          const ins = asg.instructor;
          if (!ins?.email || seenInstr.has(ins.id)) continue;
          seenInstr.add(ins.id);
          entries.push({
            ...base,
            context_key: `noschool:${period.startIso}:program:${p.id}:instructor:${ins.id}`,
            parent_id: null,
            parent_email: ins.email,
            parent_first_name: ins.first_name ?? null,
            child_first_name: null,
            recipient_role: "instructor",
            subject_template: NO_SCHOOL_INSTRUCTOR_SUBJECT,
            body_template: NO_SCHOOL_INSTRUCTOR_BODY,
          });
        }
      }
    }

  return entries;
}

function buildTokens(entry: AudienceEntry, brand: OrgBrand): Record<string, string> {
  return {
    first_name: (entry.parent_first_name?.trim() || "there"),
    child_first_name: (entry.child_first_name?.trim() || "your child"),
    org_name: brand.org_name,
    // In body context, strip the " @ Org" suffix that the From header uses.
    // "Jessica @ Journey to STEAM" → "Jessica" — natural in a sign-off.
    // Mirrors the convention in marketing-touchpoint-send/index.ts.
    sender_name: senderNameForBody(brand.sender_name) || brand.org_name,
    program_name: entry.program_name,
    program_start_date: entry.program_start_date,
    program_end_date: entry.program_end_date,
    // Clean time range ("9:00 AM – 12:00 PM"), empty when unknown. The welcome
    // copy wraps it — "starts {{program_start_date}} ({{program_time}})" — and
    // renderTokens strips the bare " ()" left when it's empty.
    program_time: entry.program_time ?? "",
    location_name: entry.location_name,
    age_turning: entry.age_turning,
    abandoned_resume_url: entry.abandoned_resume_url,
    final_showcase_block: buildShowcaseBlock(entry.final_showcase_raw, brand),
    mid_term_skills_block: buildSkillsBlock(entry.mid_term_skills_raw, brand, "What they have been working on"),
    final_recap_skills_block: buildSkillsBlock(entry.final_recap_skills_raw, brand, "What they covered"),
    arrival_dismissal_block: buildArrivalDismissalBlock(entry.arrival_instructions_raw, entry.dismissal_instructions_raw, brand),
    session_dates_block: buildSessionDatesBlock(entry.session_dates_raw, brand),
    register_url: entry.register_url,
    next_term_link_block: buildNextTermLinkBlock(entry.next_term_available, entry.register_url, brand),
    // no_school_day tokens — "" for every other template (they never set these),
    // so including them here is harmless for existing automations.
    no_school_dates: entry.no_school_dates_display ?? "",
    no_school_reason: entry.no_school_reason?.trim() || "a no-school day",
  };
}

// Build a "What they have been working on" / "What they covered" block from
// curricula.mid_term_skills or curricula.final_recap_skills. Returns empty
// string when the curriculum hasn't been uploaded or has no skills set, so
// templates can include the token unconditionally without producing an
// awkward empty header. Uses brand.primary_color for the left border.
function buildSkillsBlock(skills: string[] | null | undefined, brand: OrgBrand, headerText: string): string {
  if (!skills || skills.length === 0) return "";
  const items = skills
    .filter((s) => typeof s === "string" && s.trim().length > 0)
    .map((s) => `<li style="margin-bottom:4px;">${escapeHtml(s.trim())}</li>`)
    .join("");
  if (!items) return "";
  return `<div style="background:#f5f4ee;padding:16px 20px;margin:16px 0;border-radius:6px;border-left:3px solid ${brand.primary_color};"><p style="margin:0 0 10px;font-weight:700;color:#1A1530;">${escapeHtml(headerText)}:</p><ul style="margin:0;padding-left:20px;color:#1A1530;line-height:1.6;">${items}</ul></div>`;
}

// Auto-detect cross-sell link block. Renders only when the org has at least one
// future program/camp starting more than 14 days out (caught at audience-resolve
// time via hasFutureProgramsForOrg). Empty string otherwise — tenants without
// upcoming programs don't get a dead link. Multi-tenant safe — uses brand.primary_color.
function buildNextTermLinkBlock(available: boolean, registerUrl: string, brand: OrgBrand): string {
  if (!available || !registerUrl) return "";
  return `<p style="margin-top:24px;padding-top:16px;border-top:1px solid #ede9fe;font-size:14px;color:#1A1530;">Looking ahead? <a href="${registerUrl}" style="color:${brand.primary_color};font-weight:600;text-decoration:none;">See what&apos;s coming next &rarr;</a></p>`;
}

function senderNameForBody(senderName: string): string {
  if (!senderName) return "";
  return senderName.split(" @ ")[0].trim();
}

// Tokens whose values are already valid HTML — must NOT be re-escaped during
// substitution (otherwise <p> renders as &lt;p&gt; in the parent's email).
// Mirrors the pattern in marketing-touchpoint-send/index.ts.
const PRE_RENDERED_HTML_TOKENS = new Set(["final_showcase_block", "mid_term_skills_block", "final_recap_skills_block", "arrival_dismissal_block", "session_dates_block", "next_term_link_block", "registration_summary_block"]);

// Build the upcoming-session-dates block from derive_program_session_dates
// output. Renders the program's session count + first/last dates as a tight
// summary parents can scan. Empty when there are no dates (camps, or
// afterschool programs whose session list hasn't been derived yet).
function buildSessionDatesBlock(sessions: string[] | null | undefined, brand: OrgBrand): string {
  if (!sessions || sessions.length === 0) return "";
  const valid = sessions.filter((s) => typeof s === "string" && s.trim().length > 0);
  if (valid.length === 0) return "";
  const count = valid.length;
  const labelStyle = `margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${brand.primary_color};`;
  const textStyle = "margin:0;color:#1A1530;font-size:14px;line-height:1.55;";
  if (count === 1) {
    const only = escapeHtml(`One session, on ${formatDate(valid[0])}.`);
    return `<div style="background:#f5f4ee;padding:14px 18px;margin:16px 0;border-radius:6px;border-left:3px solid ${brand.primary_color};"><p style="${labelStyle}">Schedule</p><p style="${textStyle}">${only}</p></div>`;
  }
  // List every session date so parents see exactly which days their child has
  // class (derive_program_session_dates already honors district/location
  // closures, so gaps are real). Count line + the dates — no "starting X ending
  // Y" summary, which would just repeat the first and last dates in the list.
  const header = escapeHtml(`${count} weekly sessions:`);
  const dates = escapeHtml(valid.map(formatDateShort).join(", "));
  return `<div style="background:#f5f4ee;padding:14px 18px;margin:16px 0;border-radius:6px;border-left:3px solid ${brand.primary_color};"><p style="${labelStyle}">Schedule</p><p style="${textStyle}margin-bottom:4px;font-weight:700;">${header}</p><p style="${textStyle}">${dates}</p></div>`;
}

// Build the "Arrival" / "Dismissal" location-instructions block. Renders
// either or both labeled sections when populated, empty string when both
// are null/empty. Source: program_locations.arrival_instructions and
// dismissal_instructions — pulled in welcome_camp + welcome_afterschool
// resolvers via the location join.
function buildArrivalDismissalBlock(arrival: string | null | undefined, dismissal: string | null | undefined, brand: OrgBrand): string {
  const a = typeof arrival === "string" ? arrival.trim() : "";
  const d = typeof dismissal === "string" ? dismissal.trim() : "";
  if (!a && !d) return "";
  const labelStyle = `margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${brand.primary_color};`;
  const textStyle = "margin:0;color:#1A1530;font-size:14px;line-height:1.55;";
  const arrivalSection = a ? `<p style="${labelStyle}">Arrival</p><p style="${textStyle}${d ? "margin-bottom:12px;" : ""}">${escapeHtml(a)}</p>` : "";
  const dismissalSection = d ? `<p style="${labelStyle}">Dismissal</p><p style="${textStyle}">${escapeHtml(d)}</p>` : "";
  return `<div style="background:#f5f4ee;padding:14px 18px;margin:16px 0;border-radius:6px;border-left:3px solid ${brand.primary_color};">${arrivalSection}${dismissalSection}</div>`;
}

// Auto-detect helper. Returns true when the org has at least one program OR
// camp_session starting more than 14 days from today — i.e. a real "next term"
// to point at. The 14-day cutoff filters out the very camp/program a Welcome
// is currently announcing, so welcome_camp for a camp starting in 7 days
// doesn't promote that same camp as "what's next."
async function hasFutureProgramsForOrg(supabase: SupabaseClient, orgId: string): Promise<boolean> {
  const futureCutoff = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const { data: futureProgram } = await supabase
    .from("programs")
    .select("id")
    .eq("organization_id", orgId)
    .gt("first_session_date", futureCutoff)
    .limit(1)
    .maybeSingle();
  if (futureProgram) return true;
  const { data: futureCamp } = await supabase
    .from("camp_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .gt("starts_on", futureCutoff)
    .limit(1)
    .maybeSingle();
  return !!futureCamp;
}

// Render {{tokens}} in a template string. Plain-text tokens get HTML-escaped
// so <, >, " stay safe in body text + href attribute context. HTML-pre-rendered
// tokens (e.g. {{final_showcase_block}}) are passed through verbatim.
function renderTokens(template: string, tokens: Record<string, string>): string {
  // First, collapse a token wrapped in parens for optional display — e.g. the
  // welcome "starts {{program_start_date}} ({{program_time}})" — when that token
  // is known-but-empty (a camp/program with no start/end time): drop the whole
  // " (…)" group so the sentence reads cleanly. This is keyed to the {{token}}
  // PLACEHOLDER in the template, so it never touches a literal "()" that a token
  // VALUE might contain — e.g. a curriculum showcase mentioning setup()/loop().
  // Unknown tokens (undefined) are left alone so they stay visible below.
  const collapsed = template.replace(/ ?\(\s*\{\{(\w+)\}\}\s*\)/g, (whole, key) => {
    return tokens[key] === "" ? "" : whole;
  });
  return collapsed.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const v = tokens[key];
    if (v == null) return match; // leave unknown tokens in place for visibility
    if (PRE_RENDERED_HTML_TOKENS.has(key)) return v;
    return htmlEscapeSafe(v);
  });
}

// Build the optional "On the final day:" showcase block from curricula.final_showcase.
// Returns empty string when the curriculum doesn't define one — operators
// can keep {{final_showcase_block}} in the body for ALL camps; it just
// silently vanishes for the ones that don't have a showcase.
function buildShowcaseBlock(finalShowcase: string | null | undefined, brand: OrgBrand): string {
  if (!finalShowcase || !finalShowcase.trim()) return "";
  const safe = escapeHtml(finalShowcase.trim());
  return `<div style="background:#f5f4ee;border-left:3px solid ${brand.primary_color};padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0;"><strong>On the final day:</strong> ${safe}</div>`;
}

// Escape characters that can break HTML in either text or attribute context.
// Single quote left alone — modern HTML allows it raw in double-quoted attrs.
function htmlEscapeSafe(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Builds the per-recipient unsubscribe URL with an HMAC-signed token, verified
// by the shared marketing-unsubscribe edge function before it inserts a
// suppression row (a leaked URL pattern can't unsubscribe arbitrary addresses).
// Ported verbatim from marketing-send so the same secret + endpoint verify it.
// Returns "" when the secret isn't configured — the caller then omits the link
// rather than rendering a broken one.
async function computeUnsubscribeUrl(email: string, orgId: string): Promise<string> {
  if (!UNSUBSCRIBE_SECRET) return "";
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

// unsubscribeUrl is "" for informational sends (welcome/recaps/birthday) — the
// footer then renders EXACTLY as before, so those emails are byte-for-byte
// unchanged. It's non-empty only for promotional (marketing) sends, adding a
// CAN-SPAM unsubscribe line under the footer credit.
function wrapInShell(innerBody: string, brand: OrgBrand, unsubscribeUrl = ""): string {
  // White-background shell with the tenant logo on top — no generic gradient
  // banner. Every provider will brand differently and a hardcoded purple
  // bleeds platform color into their identity. Wordmark fallback only when
  // an org hasn't set a logo yet (rare in practice).
  const logoBlock = brand.logo_url
    ? `<img src="${brand.logo_url}" alt="${escapeHtml(brand.org_name)}" style="max-height:56px;display:block;margin:0 auto;" />`
    : `<div style="color:${brand.primary_color};font-size:18px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;text-align:center;">${escapeHtml(brand.org_name)}</div>`;

  // Promotional sends only: the tenant's physical postal address (CAN-SPAM
  // requires it in commercial email) followed by a plain unsubscribe line. Both
  // gate on unsubscribeUrl so INFORMATIONAL sends keep their footer identical to
  // before this change. Address renders only when the org has set one (empty for
  // tenants who haven't — best-effort, matching the campaign path). Newlines in
  // the stored address become <br> after escaping.
  const addr = (brand.mailing_address ?? "").trim();
  const addressBlock = unsubscribeUrl && addr
    ? `<br>${escapeHtml(addr).replace(/\n/g, "<br>")}`
    : "";
  const unsubBlock = unsubscribeUrl
    ? `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#888;text-decoration:underline;">Unsubscribe</a>`
    : "";

  // color-scheme meta tags tell Gmail/Apple Mail not to auto-invert the
  // white background in dark mode. Outlook ignores but most major clients
  // respect it — prevents the brand-color border from clashing against a
  // mail-client-inverted dark background.
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(brand.org_name)}</title></head>
<body style="margin:0;padding:0;background:#fbfaf6;font-family:'Nunito Sans',Arial,sans-serif;color-scheme:light only;supported-color-schemes:light;">
<div style="max-width:600px;margin:0 auto;background:#fff;">
<div style="padding:32px 30px 8px;text-align:center;">${logoBlock}</div>
<div style="padding:16px 30px 32px;color:#1A1530;font-size:16px;line-height:1.6;">
${innerBody}
${renderSignatureBlock(brand)}
</div>
<div style="padding:18px 30px;text-align:center;color:#888;font-size:11px;border-top:1px solid #eee;">
${escapeHtml(brand.org_name)} · Powered by Enrops · ${new Date().getFullYear()}${addressBlock}${unsubBlock}
</div>
</div>
</body></html>`;
}

// Strip HTML to plain text for the multipart text/plain MIME fallback.
// Accessibility tools, plain-text-only mail readers, and Outlook in some
// configurations prefer the text version. Resend handles MIME packaging
// when both `html` and `text` are present.
function htmlToPlainText(html: string): string {
  if (!html) return "";
  return html
    // Render <br>, </p>, </div>, </li> as a newline before stripping tags
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `${text} (${href})`)
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common entities
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&middot;/g, "·")
    .replace(/&hellip;/g, "…")
    .replace(/&nbsp;/g, " ")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    // Collapse 3+ newlines to 2 (paragraph breaks)
    .replace(/\n{3,}/g, "\n\n")
    // Collapse runs of inline whitespace within a line
    .replace(/[ \t]+/g, " ")
    .trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Small utils
// ───────────────────────────────────────────────────────────────────────────

function pickNumber(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  // Last argument is the default — guaranteed number by caller convention.
  const last = candidates[candidates.length - 1];
  return typeof last === "number" ? last : 0;
}

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// Compact date for inline lists, e.g. "2026-09-02" → "Sep 2". Used by the
// Schedule block so 10–12 session dates fit on a scannable line.
function formatDateShort(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// Format a camp_sessions clock value ("HH:MM:SS", a Postgres `time`) as a
// human 12-hour string: "09:00:00" → "9:00 AM", "15:30:00" → "3:30 PM".
// Returns "" for null/unparseable so the caller can omit the time cleanly.
function formatClockTime(t: string | null | undefined): string {
  if (!t) return "";
  const parts = String(t).split(":");
  let h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] ?? "0", 10);
  if (Number.isNaN(h)) return "";
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  const mm = String(Number.isNaN(m) ? 0 : m).padStart(2, "0");
  return `${h}:${mm} ${ampm}`;
}

// Build the clean {{program_time}} range from a start/end pair, e.g.
// "9:00 AM – 12:00 PM". No surrounding punctuation, so the token is safe to drop
// standalone into any template AND to wrap in the welcome copy as
// "starts {{program_start_date}} ({{program_time}})" — an empty value there
// leaves a bare " ()" that renderTokens strips.
// Renders only when BOTH ends are present, so we never show a half-open range.
// `preformatted` = true for afterschool (programs.start_time/end_time are
// already human text like "3:25 PM"); false for camps (Postgres time values
// that need formatClockTime). Empty string when either end is missing. En dash (–).
function timeClause(start: string | null | undefined, end: string | null | undefined, preformatted: boolean): string {
  const s = preformatted ? (start ?? "").trim() : formatClockTime(start);
  const e = preformatted ? (end ?? "").trim() : formatClockTime(end);
  if (!s || !e) return "";
  return `${s} – ${e}`;
}

// Pull a first name from a contact's stored full name for {{first_name}}.
// Contacts are normalized to "First Last" on import, but tolerate a stray
// "Last, First" too. Null when there's no usable name — buildTokens then falls
// back to "there".
function firstNameFromFull(full: string | null | undefined): string | null {
  if (!full) return null;
  const t = full.trim();
  if (!t) return null;
  if (t.includes(",")) {
    const after = t.split(",")[1]?.trim();
    if (after) return after.split(/\s+/)[0];
  }
  return t.split(/\s+/)[0];
}
