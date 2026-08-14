// The training step's client-side config, in ONE place.
//
// WHY THIS IS A SHARED MODULE AND NOT INLINE CODE. The wizard has two doors —
// /:slug/onboarding (OnboardingRouter) and the portal-embedded WizardHost
// (InstructorPortal) — and WizardHost defaults `trainingEnabled` to false. So a
// door that simply does not pass it drops the training step silently, with no
// error anywhere, while the SERVER gate keeps requiring `training_completed`.
// The instructor then finishes every screen and can never reach 'complete'.
//
// That is not hypothetical: it is the live state of staging `j2s` today —
// training on, 1 active required video, 3 open onboardings that had never been
// shown the step. InstructorPortal.jsx has now missed a config value on this
// exact path three times (slug, then stripePayEnabled, now training), which is
// why the logic moved out of both callers instead of being copied into the
// second one.
//
// MUST STAY IN LOCKSTEP WITH gateCheck.ts (supabase/functions/_shared). The
// server computes `trainingRequired` as "training_config.enabled === true AND at
// least one active, required video exists". If this function ever disagrees, the
// wizard and the gate disagree about whether the step exists, and one of the two
// directions strands the instructor:
//   client says NO, server says YES -> step never rendered, never completable.
//   client says YES, server says NO -> a step they must do that counts for nothing.
export async function loadTrainingConfig(supabase, organizationId, trainingEnabledFlag) {
  const empty = { trainingEnabled: false, trainingVideos: [] };
  if (!organizationId || !trainingEnabledFlag) return empty;

  // NB: never select the `quiz` column here — RLS is row-level, not
  // column-level, so it would ship every correct_index to the browser. The
  // player fetches an answer-stripped quiz from get-training-video-url.
  //
  // The filters mirror gateCheck.ts's count exactly: active AND is_required.
  const { data: vids, error } = await supabase
    .from('instructor_training_videos')
    .select('id, title, duration_seconds')
    .eq('organization_id', organizationId)
    .eq('active', true)
    .eq('is_required', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  // A FAILED READ IS NOT AN EMPTY LIBRARY. Falling through to "no videos" would
  // drop a step the server still requires — the precise stranding this module
  // exists to prevent. Report it so the caller can fail visibly instead.
  if (error) {
    console.error('[loadTrainingConfig] training video read failed', { organizationId, error });
    return { ...empty, error };
  }

  const trainingVideos = (vids ?? []).map((v) => ({
    id: v.id,
    title: v.title,
    duration_seconds: v.duration_seconds,
  }));

  // Enabled-but-empty resolves to OFF, matching gateCheck.ts. An org that turned
  // training on and has not uploaded a required video yet asks nothing of its
  // instructors — on both sides.
  return { trainingEnabled: trainingVideos.length > 0, trainingVideos };
}
