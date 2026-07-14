// submit-training — advance the onboarding 'training_completed' step once the
// instructor has completed EVERY active required training video (watched AND
// quiz-passed). The server re-verifies against the live completion rows — the
// client cannot claim completion. Runs the gate check so finishing the last
// requirement flips overall_status (complete / pending_*).
//
// Auth: instructor JWT (resolveInstructor). verify_jwt = true.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, resolveInstructor, adminClient, clientIp } from '../_shared/instructor.ts';
import { advanceOnboardingStep } from '../_shared/onboardingStep.ts';
import { runGateCheck } from '../_shared/gateCheck.ts';

// Position of the training step in the full step order. current_step is a
// vestigial integer (wizard navigation is key-based); advanceOnboardingStep
// Math.max()es it so this never regresses a further-along contractor.
const TRAINING_STEP_NUMBER = 7;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;
    const supabase = adminClient();

    // Active required videos for this instructor's org.
    const { data: videos, error: vErr } = await supabase
      .from('instructor_training_videos')
      .select('id')
      .eq('organization_id', me.organization_id)
      .eq('active', true)
      .eq('is_required', true);
    if (vErr) {
      console.error('[submit-training] videos lookup failed:', vErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    const required = (videos ?? []).map((v) => v.id as string);

    // Only gate when there's actually something required (enabled-but-empty is a
    // no-op — mirrors the gate check, which drops the step in that case).
    if (required.length > 0) {
      const { data: comps, error: cErr } = await supabase
        .from('instructor_training_completions')
        .select('training_video_id, watched_completed_at, quiz_passed')
        .eq('instructor_id', me.id)
        .in('training_video_id', required);
      if (cErr) {
        console.error('[submit-training] completions lookup failed:', cErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      const passed = new Set(
        (comps ?? [])
          .filter((c) => c.watched_completed_at && c.quiz_passed)
          .map((c) => c.training_video_id),
      );
      const remaining = required.filter((id) => !passed.has(id));
      if (remaining.length > 0) {
        return json({ error: 'training_incomplete', remaining }, 400);
      }
    }

    const { error: stepErr } = await advanceOnboardingStep(supabase, {
      instructorId: me.id,
      orgId: me.organization_id,
      stepKey: 'training_completed',
      nextStep: TRAINING_STEP_NUMBER,
      ip: clientIp(req),
    });
    if (stepErr) {
      console.error('[submit-training] step advance failed:', stepErr);
      return json({ error: 'step_advance_failed' }, 500);
    }

    const gate = await runGateCheck(supabase, me.id);
    return json({ success: true, gate });
  } catch (err) {
    console.error('[submit-training] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
