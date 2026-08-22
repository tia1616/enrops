// Gate check — decides overall_status based on all 8 steps + checkr + stripe state.
//
// Called from:
//   - update-onboarding-step (after Screen 8 — the wizard's final step)
//   - checkr-webhook        (when checkr_status updates)
//   - stripe-connect-instructor-webhook (when stripe_payouts_enabled flips)
//   - refresh-stripe-status (manual user-triggered refresh)
//
// Status decision table (allStepsDone == every key in steps_completed):
//   allStepsDone && checkrClear && stripeReady   → complete (+ completed_at)
//   allStepsDone && !checkrClear                 → pending_background_check
//   allStepsDone && checkrClear && !stripeReady  → pending_stripe
//   else                                          → keep existing status

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { StepKey } from './onboardingStep.ts';
import { loadOrgBrand, formatFromAddress } from './orgBrand.ts';
import { stepHasEnabledDocuments } from './instructorDocumentConfig.ts';

// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so links in the gate-check admin email point at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

export const ALL_STEPS: StepKey[] = [
  'welcome',
  'checkr_submitted',
  'ors_certification',
  'agreement_signed',
  'policies_acknowledged',
  'additional_acks',
  'stripe_submitted',
  'emergency_and_prefs',
];

export interface GateResult {
  overall_status: string;
  all_steps_done: boolean;
  checkr_clear: boolean;
  stripe_ready: boolean;
}

export async function runGateCheck(
  supabase: SupabaseClient,
  instructorId: string,
): Promise<GateResult | null> {
  const { data: row, error } = await supabase
    .from('contractor_onboarding_status')
    .select('steps_completed, checkr_status, stripe_payouts_enabled, overall_status, organization_id')
    .eq('instructor_id', instructorId)
    .maybeSingle();
  if (error || !row) {
    console.error('gate check fetch failed:', error);
    return null;
  }

  // Per-org toggles: two optional steps, plus two that become optional when the
  // provider has turned off every document they contain.
  // - Background checks off  → drop 'checkr_submitted' from the required set AND
  //   treat the "check must be clear" condition as satisfied (else onboarding
  //   could never reach 'complete'). Default enabled=true (config/column absent).
  // - Training on            → ADD 'training_completed' to the required set, but
  //   only when the org also has at least one active REQUIRED video — an
  //   enabled-but-empty library must not block onboarding. Default off.
  // - Contractor status / policies / additional → each of these screens renders
  //   documents from instructor_document_config. A provider can switch individual
  //   documents off, and a screen with none left is skipped by the wizard, so its
  //   step key can never be written. It must come out of the required set too or
  //   onboarding stalls forever one step short. Absent config = every document on
  //   = all three steps required, which is exactly today's behaviour for every
  //   existing org.
  //   'contractor_status' joined this group on 2026-08-21, when Screen3ORS stopped
  //   being hardcoded and became a provider-owned document. It is ONE document on
  //   its OWN screen, so switching that single document off drops the whole
  //   'ors_certification' step — the one case in this group where a single toggle
  //   removes a step outright.
  // - Stripe pay off        → drop 'stripe_submitted' from the required set AND
  //   treat "payouts must be live" as satisfied. BOTH halves, for the same reason
  //   the background check needs both: dropping only the step leaves stripeReady
  //   false forever, so the contractor finishes everything and parks on
  //   'pending_stripe' — a status whose only recovery is a payment setup screen
  //   the wizard no longer shows them. Default true = today's behaviour.
  let bgcEnabled = true;
  let trainingRequired = false;
  let contractorStatusRequired = true;
  let policiesRequired = true;
  let additionalRequired = true;
  let stripePayRequired = true;
  if (row.organization_id) {
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('background_check_config, training_config, instructor_document_config, instructor_pay_enabled')
      .eq('id', row.organization_id)
      .maybeSingle();
    // BAIL, never proceed with org=null. This read's `error` used to be
    // discarded, and the defaults it fell back to are not all on the safe side:
    // policiesRequired/additionalRequired default to TRUE, which merely asks for
    // more than needed, but bgcEnabled defaults to TRUE, which puts
    // 'checkr_submitted' back into requiredSteps AND starts demanding
    // checkr_status === 'clear'. So a single failed read at an org that
    // deliberately switched background checks off would leave every contractor
    // finishing every screen and never reaching 'complete' — allStepsDone false,
    // status stuck, no completion email — with nothing anywhere saying why.
    //
    // Not hypothetical: this read fails for EVERY instructor on any environment
    // where migration 20260812a has not landed, the moment a function bundling
    // this module is redeployed, because instructor_document_config would not
    // exist. Returning null leaves overall_status exactly as it was, which is
    // recoverable; silently rewriting the rules is not.
    if (orgErr) {
      console.error('gate check org config read failed — status left unchanged:', orgErr);
      return null;
    }
    // A SUCCESSFUL read with a null column keeps the documented defaults below:
    // config absent means "not configured", which is a real answer.
    const cfg = (org?.background_check_config as { enabled?: boolean } | null) ?? null;
    bgcEnabled = cfg?.enabled !== false;
    const tcfg = (org?.training_config as { enabled?: boolean } | null) ?? null;
    if (tcfg?.enabled === true) {
      const { count } = await supabase
        .from('instructor_training_videos')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', row.organization_id)
        .eq('active', true)
        .eq('is_required', true);
      trainingRequired = (count ?? 0) > 0;
    }
    const docCfg = (org?.instructor_document_config as Record<string, unknown> | null) ?? null;
    contractorStatusRequired = stepHasEnabledDocuments(docCfg, 'contractor_status');
    policiesRequired = stepHasEnabledDocuments(docCfg, 'policies');
    additionalRequired = stepHasEnabledDocuments(docCfg, 'additional');
    // Strictly true, not truthy: the column is NOT NULL DEFAULT false, so only an
    // explicit true means this provider moves instructor money through Stripe.
    stripePayRequired = org?.instructor_pay_enabled === true;
  }

  const steps = (row.steps_completed as Record<string, unknown>) ?? {};
  let requiredSteps: StepKey[] = bgcEnabled
    ? ALL_STEPS
    : ALL_STEPS.filter((k) => k !== 'checkr_submitted');
  if (!contractorStatusRequired) requiredSteps = requiredSteps.filter((k) => k !== 'ors_certification');
  if (!policiesRequired) requiredSteps = requiredSteps.filter((k) => k !== 'policies_acknowledged');
  if (!additionalRequired) requiredSteps = requiredSteps.filter((k) => k !== 'additional_acks');
  if (!stripePayRequired) requiredSteps = requiredSteps.filter((k) => k !== 'stripe_submitted');
  if (trainingRequired) requiredSteps = [...requiredSteps, 'training_completed'];
  const allStepsDone = requiredSteps.every((k) => steps[k]);
  const checkrClear = !bgcEnabled || row.checkr_status === 'clear';
  // Exactly the shape of checkrClear above, and for the same reason: a provider
  // who does not pay through Stripe can never have stripe_payouts_enabled turn
  // true, so without this half 'complete' would be unreachable for all of them.
  const stripeReady = !stripePayRequired || row.stripe_payouts_enabled === true;

  let nextStatus = row.overall_status as string;
  let completedAt: string | null = null;

  if (allStepsDone && checkrClear && stripeReady) {
    nextStatus = 'complete';
    completedAt = new Date().toISOString();
  } else if (allStepsDone && !checkrClear) {
    nextStatus = 'pending_background_check';
  } else if (allStepsDone && checkrClear && !stripeReady) {
    nextStatus = 'pending_stripe';
  }

  // Only update if something changed (avoid spurious updated_at churn).
  if (nextStatus !== row.overall_status) {
    const updates: Record<string, unknown> = {
      overall_status: nextStatus,
      updated_at: new Date().toISOString(),
    };
    if (completedAt) updates.completed_at = completedAt;
    const { error: updErr } = await supabase
      .from('contractor_onboarding_status')
      .update(updates)
      .eq('instructor_id', instructorId);
    if (updErr) {
      console.error('gate check status update failed:', updErr);
    }

    // Fire onboarding-complete emails once, on the transition into 'complete'.
    if (nextStatus === 'complete') {
      await sendOnboardingCompleteEmails(supabase, instructorId, bgcEnabled, stripePayRequired).catch((err) => {
        console.error('onboarding-complete emails failed:', err);
      });
    }
  }

  return {
    overall_status: nextStatus,
    all_steps_done: allStepsDone,
    checkr_clear: checkrClear,
    stripe_ready: stripeReady,
  };
}

async function sendOnboardingCompleteEmails(
  supabase: SupabaseClient,
  instructorId: string,
  bgcEnabled: boolean,
  stripePayRequired: boolean,
): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return;

  const { data: instructor } = await supabase
    .from('instructors')
    .select('first_name, last_name, preferred_name, email, organization_id')
    .eq('id', instructorId)
    .maybeSingle();
  if (!instructor?.email || !instructor.organization_id) return;

  // slug is still read from the org row (loadOrgBrand doesn't expose it) — it
  // builds the portal URL below.
  const { data: org } = await supabase
    .from('organizations')
    .select('name, slug')
    .eq('id', instructor.organization_id)
    .maybeSingle();

  // From/reply-to come from the shared cascade, which always resolves to a
  // verified address. There is no "no sender configured" state to guard.
  const brand = await loadOrgBrand(supabase, instructor.organization_id);
  const from = formatFromAddress(brand);
  const fullName = `${instructor.first_name ?? ''} ${instructor.last_name ?? ''}`.trim();
  const greeting = instructor.preferred_name || instructor.first_name || 'there';
  const orgName = org?.name ?? brand.org_name;
  // Only build the portal link when we actually have a slug. Interpolating an
  // empty one produced `https://enrops.com//instructor`, which matches no
  // route - an email whose single call to action is a dead link is worse than
  // one that omits it.
  const portalUrl = org?.slug ? `${PUBLIC_SITE_URL}/${org.slug}/instructor` : null;
  // WHAT WAS ACTUALLY DONE — named only where it is true, and joined so no
  // branch reads clipped or padded.
  //
  // 'complete' can now be reached with stripeReady true purely BECAUSE the
  // provider does not pay through Stripe, so an unconditional "payouts set up"
  // asserted a Stripe account to someone never asked for bank details. A first
  // attempt at this filled the gap with "you are all set", which after
  // "You're fully onboarding with X" is padding restating the sentence it sits
  // in. Dropping the clause entirely is the honest version: say the things that
  // happened, and stop.
  //
  // Said out loud, all four states:
  //   both  -> "paperwork signed, background check cleared, and payouts set up."
  //   bgc   -> "paperwork signed and background check cleared."
  //   pay   -> "paperwork signed and payouts set up."
  //   neither -> "paperwork signed."
  const joinClauses = (parts: string[]) =>
    parts.length > 2
      ? `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
      : parts.join(' and ');
  const contractorDone = joinClauses([
    'paperwork signed',
    ...(bgcEnabled ? ['background check cleared'] : []),
    ...(stripePayRequired ? ['payouts set up'] : []),
  ]);
  const adminDone = joinClauses([
    'Paperwork signed',
    ...(bgcEnabled ? ['background check cleared'] : []),
    ...(stripePayRequired ? ['Stripe Connect set up'] : []),
  ]);

  // 1. Contractor — "you're cleared, here's how to access your portal"
  const contractorText = [
    `Hi ${greeting},`,
    ``,
    `You're fully onboarded with ${orgName} — ${contractorDone}.`,
    ``,
    ...(portalUrl
      ? [`Sign in to your portal any time to see your schedule, accept assignments, and view your pay:`, portalUrl]
      : [`Sign in to your portal any time to see your schedule, accept assignments, and view your pay.`]),
    ``,
    `Questions? Just reply to this email.`,
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        // The body says "just reply to this email". The From is now the shared
        // platform domain, so without this the reply would not reach the
        // provider — reply_to keeps that promise true.
        reply_to: brand.reply_to,
        to: instructor.email,
        subject: `You're fully onboarded with ${orgName}`,
        text: contractorText,
        tags: [{ name: 'type', value: 'onboarding_complete_contractor' }],
      }),
    });
  } catch (err) {
    console.error('contractor onboarding-complete email failed:', err);
  }

  // 2. Admin (the org's OWN alert inbox) — "X is fully onboarded".
  //
  // tenant_alert_email, not alert_email: this body names a specific contractor
  // and their email address. alert_email cascades to the platform, so on an org
  // with no address of its own that cascade would forward one provider's
  // contractor details to Enrops. Fail closed and say so instead.
  if (!brand.tenant_alert_email) {
    console.error('no tenant alert address — onboarding-complete admin alert NOT sent', {
      organization_id: instructor.organization_id,
      instructor_id: instructorId,
    });
    return;
  }
  const adminText = [
    `${fullName || instructor.email} is fully onboarded.`,
    ``,
    // Built from the same joiner as the contractor's, so the two can never
    // disagree about what happened or drift apart in punctuation — which they
    // already had.
    `${adminDone}. They're ready to be assigned to camps or programs.`,
    ``,
    `View their record: ${PUBLIC_SITE_URL}/admin/instructors`, // was /admin/contacts (retired 2026-06-08)
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        reply_to: brand.reply_to,
        to: brand.tenant_alert_email,
        subject: `${fullName || instructor.email} is fully onboarded`,
        text: adminText,
        tags: [{ name: 'type', value: 'onboarding_complete_admin' }],
      }),
    });
  } catch (err) {
    console.error('admin onboarding-complete email failed:', err);
  }
}
