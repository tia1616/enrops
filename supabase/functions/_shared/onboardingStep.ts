// Shared helper for advancing the contractor onboarding wizard's step counter.
//
// Functions 4-8 all need the same logic: merge a step into steps_completed,
// bump current_step (never backward), promote overall_status from 'invited' /
// 'not_invited' → 'in_progress' on first save, never downgrade from later
// states like 'pending_background_check' or 'pending_stripe'.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export type StepKey =
  | 'welcome'
  | 'checkr_submitted'
  | 'ors_certification'
  | 'agreement_signed'
  | 'policies_acknowledged'
  | 'additional_acks'
  | 'stripe_submitted'
  | 'emergency_and_prefs';

export interface AdvanceArgs {
  instructorId: string;
  orgId: string;
  stepKey: StepKey;
  nextStep: number;
  ip: string | null;
}

/**
 * Mark a step as completed in contractor_onboarding_status.steps_completed
 * and bump current_step. Creates the onboarding row if missing.
 *
 * Returns null on success; the original error otherwise. Callers usually log
 * the error but don't fail the whole request — the legal record (cert,
 * agreement, ack) is already written by the time this runs.
 */
export async function advanceOnboardingStep(
  supabase: SupabaseClient,
  args: AdvanceArgs,
): Promise<{ error: unknown | null }> {
  const { instructorId, orgId, stepKey, nextStep, ip } = args;

  const { data: existing, error: fetchErr } = await supabase
    .from('contractor_onboarding_status')
    .select('steps_completed, overall_status, current_step')
    .eq('instructor_id', instructorId)
    .maybeSingle();
  if (fetchErr) return { error: fetchErr };

  const completedEntry = { completed_at: new Date().toISOString(), ip_address: ip };
  const mergedSteps = {
    ...((existing?.steps_completed as Record<string, unknown>) ?? {}),
    [stepKey]: completedEntry,
  };

  const nextOverall =
    existing?.overall_status === 'not_invited' || existing?.overall_status === 'invited'
      ? 'in_progress'
      : existing?.overall_status ?? 'in_progress';
  const newCurrent = Math.max(nextStep, existing?.current_step ?? 1);

  if (existing) {
    const { error: updErr } = await supabase
      .from('contractor_onboarding_status')
      .update({
        steps_completed: mergedSteps,
        current_step: newCurrent,
        overall_status: nextOverall,
        updated_at: new Date().toISOString(),
      })
      .eq('instructor_id', instructorId);
    if (updErr) return { error: updErr };
  } else {
    // First step submission for an instructor whose onboarding row doesn't
    // exist yet (Function 1 should have created it, but handle the edge case).
    const { error: insErr } = await supabase
      .from('contractor_onboarding_status')
      .insert({
        instructor_id: instructorId,
        organization_id: orgId,
        steps_completed: mergedSteps,
        current_step: newCurrent,
        overall_status: 'in_progress',
      });
    if (insErr) return { error: insErr };
  }

  return { error: null };
}
