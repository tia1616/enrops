import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase.js';
import { STEP_KEYS } from '../../../lib/onboardingSteps.js';
import { invokeOnboardingFn, isHandledRedirect } from '../../../lib/onboardingFetch.js';
import { useOnboardingConfig } from '../OnboardingConfigContext.jsx';
import WizardLayout, { ScreenError } from '../WizardLayout.jsx';
import TrainingPlayer from '../TrainingPlayer.jsx';

// Screen — Training.
//
// Renders each active required training video (from config.trainingVideos) one
// at a time via TrainingPlayer. A video is "done" when the server has recorded
// it watched AND quiz-passed. When every required video is done, we advance the
// onboarding step via submit-training (which re-runs the gate) and continue.
//
// This screen only renders when the org has training on AND has at least one
// required video — effectiveStepOrder drops the step otherwise, so there is no
// empty state to handle here.

export default function ScreenTraining({ slug, instructor, onboarding, onAdvance, onBack }) {
  const navigate = useNavigate();
  const { trainingVideos } = useOnboardingConfig();
  const videos = Array.isArray(trainingVideos) ? trainingVideos : [];

  const [passedIds, setPassedIds] = useState(null); // Set | null (loading)
  const [error, setError] = useState('');
  const [advancing, setAdvancing] = useState(false);

  // Load which required videos this instructor has already completed (resume).
  const loadPassed = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('instructor_training_completions')
      .select('training_video_id, quiz_passed, watched_completed_at')
      .eq('instructor_id', instructor.id);
    if (e) { setError("Couldn't load your training progress. Please refresh."); return; }
    const done = new Set(
      (data ?? [])
        .filter((r) => r.watched_completed_at && r.quiz_passed)
        .map((r) => r.training_video_id),
    );
    setPassedIds(done);
  }, [instructor.id]);

  useEffect(() => { loadPassed(); }, [loadPassed]);

  const onPassed = useCallback((videoId) => {
    setPassedIds((prev) => {
      const next = new Set(prev ?? []);
      next.add(videoId);
      return next;
    });
  }, []);

  // Finish the step — user-initiated (a "Continue" button), NOT an auto-advance.
  // Auto-advancing on completion is fragile: if the wizard's re-read hiccups the
  // screen hangs on "finishing up" with no recourse. A button is retryable and
  // always visible. submit-training is idempotent (re-verifies server-side), so
  // clicking again after a hiccup is safe.
  async function finishTraining() {
    if (advancing) return;
    setAdvancing(true); setError('');
    try {
      const { error: e } = await invokeOnboardingFn('submit-training', {}, { navigate });
      if (e) { setError(e.message || 'Something went wrong finishing training. Please try again.'); setAdvancing(false); return; }
      onAdvance(); // moves to the next step; this screen unmounts on success
    } catch (err) {
      if (isHandledRedirect(err)) return;
      setError('Something went wrong finishing training. Please try again.'); setAdvancing(false);
    }
  }

  const total = videos.length;
  const doneCount = passedIds ? videos.filter((v) => passedIds.has(v.id)).length : 0;
  const currentVideo = passedIds ? videos.find((v) => !passedIds.has(v.id)) : null;

  return (
    <WizardLayout
      slug={slug}
      currentStep={STEP_KEYS.TRAINING_COMPLETED}
      stepsCompleted={onboarding?.steps_completed}
      onBack={onBack}
      title="Training"
      subtitle={total > 1
        ? `Watch your program's training videos to continue. Video ${Math.min(doneCount + 1, total)} of ${total}.`
        : "Watch your program's training video to continue."}
    >
      {passedIds === null ? (
        <div className="rounded-md bg-neutral-100 p-6 text-center text-sm text-neutral-500">Loading…</div>
      ) : currentVideo ? (
        <>
          {total > 1 && (
            <div className="mb-4 flex gap-1" aria-label="Training progress">
              {videos.map((v) => (
                <div key={v.id} className={`h-1.5 flex-1 rounded-full ${passedIds.has(v.id) ? 'bg-neutral-900' : v.id === currentVideo.id ? 'bg-neutral-400' : 'bg-neutral-200'}`} />
              ))}
            </div>
          )}
          <div className="mb-3 text-sm font-semibold text-neutral-900">{currentVideo.title}</div>
          <TrainingPlayer key={currentVideo.id} video={currentVideo} onPassed={onPassed} />
        </>
      ) : (
        <div>
          <div className="rounded-md bg-green-50 p-4 text-sm text-green-900">
            Training complete ✓ — nice work.
          </div>
          <button
            type="button"
            onClick={finishTraining}
            disabled={advancing}
            className="mt-4 w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {advancing ? 'Finishing up…' : 'Continue →'}
          </button>
        </div>
      )}

      <ScreenError>{error}</ScreenError>
    </WizardLayout>
  );
}
