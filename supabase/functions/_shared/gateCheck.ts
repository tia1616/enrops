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
import { encodeDisplayName } from './orgBrand.ts';

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

  // Per-org toggles: two optional steps.
  // - Background checks off  → drop 'checkr_submitted' from the required set AND
  //   treat the "check must be clear" condition as satisfied (else onboarding
  //   could never reach 'complete'). Default enabled=true (config/column absent).
  // - Training on            → ADD 'training_completed' to the required set, but
  //   only when the org also has at least one active REQUIRED video — an
  //   enabled-but-empty library must not block onboarding. Default off.
  let bgcEnabled = true;
  let trainingRequired = false;
  if (row.organization_id) {
    const { data: org } = await supabase
      .from('organizations')
      .select('background_check_config, training_config')
      .eq('id', row.organization_id)
      .maybeSingle();
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
  }

  const steps = (row.steps_completed as Record<string, unknown>) ?? {};
  let requiredSteps: StepKey[] = bgcEnabled
    ? ALL_STEPS
    : ALL_STEPS.filter((k) => k !== 'checkr_submitted');
  if (trainingRequired) requiredSteps = [...requiredSteps, 'training_completed'];
  const allStepsDone = requiredSteps.every((k) => steps[k]);
  const checkrClear = !bgcEnabled || row.checkr_status === 'clear';
  const stripeReady = row.stripe_payouts_enabled === true;

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
      await sendOnboardingCompleteEmails(supabase, instructorId, bgcEnabled).catch((err) => {
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
): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) return;

  const { data: instructor } = await supabase
    .from('instructors')
    .select('first_name, last_name, preferred_name, email, organization_id')
    .eq('id', instructorId)
    .maybeSingle();
  if (!instructor?.email || !instructor.organization_id) return;

  const { data: org } = await supabase
    .from('organizations')
    .select('name, slug, alert_email, default_sender_name, default_sender_email')
    .eq('id', instructor.organization_id)
    .maybeSingle();
  if (!org?.default_sender_email) return;

  const from = `${encodeDisplayName(org.default_sender_name ?? org.name ?? 'enrops')} <${org.default_sender_email}>`;
  const fullName = `${instructor.first_name ?? ''} ${instructor.last_name ?? ''}`.trim();
  const greeting = instructor.preferred_name || instructor.first_name || 'there';
  const portalUrl = `${PUBLIC_SITE_URL}/${org.slug}/instructor`;
  // Only mention the background check when this org actually requires one.
  const bgcPhrase = bgcEnabled ? 'background check cleared, ' : '';

  // 1. Contractor — "you're cleared, here's how to access your portal"
  const contractorText = [
    `Hi ${greeting},`,
    ``,
    `You're fully onboarded with ${org.name ?? 'us'} — paperwork signed, ${bgcPhrase}payouts set up.`,
    ``,
    `Sign in to your portal any time to see your schedule, accept assignments, and view your pay:`,
    portalUrl,
    ``,
    `Questions? Just reply to this email.`,
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        to: instructor.email,
        subject: `You're fully onboarded with ${org.name ?? 'us'}`,
        text: contractorText,
        tags: [{ name: 'type', value: 'onboarding_complete_contractor' }],
      }),
    });
  } catch (err) {
    console.error('contractor onboarding-complete email failed:', err);
  }

  // 2. Admin (org.alert_email) — "X is fully onboarded"
  if (!org.alert_email) return;
  const adminText = [
    `${fullName || instructor.email} is fully onboarded.`,
    ``,
    `Paperwork signed, ${bgcEnabled ? 'background check cleared, ' : ''}Stripe Connect set up. They're ready to be assigned to camps or programs.`,
    ``,
    `View their record: ${PUBLIC_SITE_URL}/admin/instructors`, // was /admin/contacts (retired 2026-06-08)
  ].join('\n');

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from,
        to: org.alert_email,
        subject: `${fullName || instructor.email} is fully onboarded`,
        text: adminText,
        tags: [{ name: 'type', value: 'onboarding_complete_admin' }],
      }),
    });
  } catch (err) {
    console.error('admin onboarding-complete email failed:', err);
  }
}
