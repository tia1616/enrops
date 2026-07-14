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
  const [submitFailed, setSubmitFailed] = useState(false); // stops the auto-advance effect from looping on error

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

  // When everything required is done, advance the onboarding step (server
  // re-verifies every required video before marking the step complete).
  useEffect(() => {
    // Guard on submitFailed so a failed submit-training doesn't loop: flipping
    // `advancing` back to false would otherwise immediately re-trigger this.
    if (!passedIds || advancing || submitFailed) return;
    const allDone = videos.length > 0 && videos.every((v) => passedIds.has(v.id));
    if (!allDone) return;
    let cancelled = false;
    (async () => {
      setAdvancing(true); setError('');
      try {
        const { error: e } = await invokeOnboardingFn('submit-training', {}, { navigate });
        if (cancelled) return;
        if (e) { setError(e.message || 'Something went wrong finishing training.'); setAdvancing(false); setSubmitFailed(true); return; }
        onAdvance();
      } catch (err) {
        if (isHandledRedirect(err)) return;
        setError('Something went wrong finishing training.'); setAdvancing(false); setSubmitFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [passedIds, videos, advancing, submitFailed, navigate, onAdvance]);

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
      ) : submitFailed ? (
        <div>
          <div className="rounded-md bg-neutral-50 p-4 text-sm text-neutral-800">
            You’ve finished all the videos. We couldn’t save that just now — tap to try again.
          </div>
          <button
            type="button"
            onClick={() => { setSubmitFailed(false); setError(''); }}
            className="mt-4 w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800"
          >
            Try again →
          </button>
        </div>
      ) : (
        <div className="rounded-md bg-green-50 p-4 text-sm text-green-900">
          {advancing ? 'All done — finishing up…' : 'Training complete ✓'}
        </div>
      )}

      <ScreenError>{error}</ScreenError>
    </WizardLayout>
  );
}
