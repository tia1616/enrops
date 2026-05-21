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
    .select('steps_completed, checkr_status, stripe_payouts_enabled, overall_status')
    .eq('instructor_id', instructorId)
    .maybeSingle();
  if (error || !row) {
    console.error('gate check fetch failed:', error);
    return null;
  }

  const steps = (row.steps_completed as Record<string, unknown>) ?? {};
  const allStepsDone = ALL_STEPS.every((k) => steps[k]);
  const checkrClear = row.checkr_status === 'clear';
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
  }

  return {
    overall_status: nextStatus,
    all_steps_done: allStepsDone,
    checkr_clear: checkrClear,
    stripe_ready: stripeReady,
  };
}
