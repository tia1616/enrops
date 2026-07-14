import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { invokeOnboardingFn, isHandledRedirect } from '../../lib/onboardingFetch.js';

// TrainingPlayer — one required training video + its comprehension quiz.
//
// Enforcement lives on the media element, not the UI (hiding controls is
// cosmetic — keyboard, PiP, and speed extensions bypass a hidden UI):
//   - forward seek is blocked: the `seeking` handler snaps currentTime back to
//     the furthest-watched point. Rewind/replay is allowed.
//   - playback rate is pinned to 1 in the `ratechange` handler.
// The SERVER owns completion: we heartbeat position to training-progress, which
// accumulates coverage and marks the video watched at the threshold. The quiz
// unlocks only after the server says watched; grading is server-side too. So the
// client can't fast-forward its way to "done" — this is honest-people enforcement
// with a defensible per-user record, not DRM.
//
// Props: video = { id, title, has_quiz }; onPassed(videoId) fired when the
// instructor has watched AND passed (or watched, for a no-quiz video).

const HEARTBEAT_SECONDS = 7;
const SEEK_BUFFER = 1; // allow tiny forward drift (buffering) before snapping back

function fmt(t) {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function TrainingPlayer({ video, onPassed }) {
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const maxWatchedRef = useRef(0);   // furthest point actually reached (seconds)
  const lastSentRef = useRef(-999);  // last position we heartbeated

  const [src, setSrc] = useState(null);
  const [quiz, setQuiz] = useState([]);       // [{ index, q, options[] }] — no answers
  const [loadError, setLoadError] = useState('');
  const [playbackError, setPlaybackError] = useState('');

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [watched, setWatched] = useState(false);
  const [coverage, setCoverage] = useState(0);

  const [answers, setAnswers] = useState({});   // questionIndex -> optionIndex
  const [grading, setGrading] = useState(false);
  const [quizWrong, setQuizWrong] = useState(null); // number[] | null
  const [quizError, setQuizError] = useState('');

  // 1. Fetch the signed URL + quiz (answers stripped) for this video.
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setLoadError(''); setWatched(false); setCoverage(0);
    setPlaying(false); setCurrent(0); setDuration(0);
    setAnswers({}); setQuizWrong(null); setQuizError('');
    maxWatchedRef.current = 0; lastSentRef.current = -999;
    (async () => {
      try {
        const { data, error } = await invokeOnboardingFn(
          'get-training-video-url',
          { training_video_id: video.id },
          { navigate },
        );
        if (cancelled) return;
        if (error || !data?.video?.url) {
          setLoadError("This video couldn't be loaded. Please refresh, or contact your program if it keeps happening.");
          return;
        }
        setSrc(data.video.url);
        setQuiz(Array.isArray(data.video.quiz) ? data.video.quiz : []);
      } catch (err) {
        if (isHandledRedirect(err)) return;
        setLoadError("This video couldn't be loaded. Please refresh, or contact your program if it keeps happening.");
      }
    })();
    return () => { cancelled = true; };
  }, [video.id, navigate]);

  // Send the current position to the server; update watched/coverage from reply.
  const sendProgress = useCallback(async (positionSeconds, ended = false) => {
    lastSentRef.current = positionSeconds;
    try {
      const { data, error } = await invokeOnboardingFn(
        'training-progress',
        { training_video_id: video.id, position_seconds: positionSeconds, ended },
        { navigate },
      );
      if (error || !data) return;
      if (typeof data.coverage_pct === 'number') setCoverage(data.coverage_pct);
      if (data.watched) setWatched(true);
    } catch (err) {
      if (isHandledRedirect(err)) return;
      // Non-fatal: a dropped heartbeat just means this position isn't credited
      // yet; the next one (or the ended signal) will catch up.
    }
  }, [video.id, navigate]);

  const onTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const t = el.currentTime;
    setCurrent(t);
    if (t > maxWatchedRef.current) maxWatchedRef.current = t;
    // Heartbeat off real playback (timeupdate), not a wall-clock timer that a
    // background tab would throttle.
    if (t - lastSentRef.current >= HEARTBEAT_SECONDS) sendProgress(t);
  }, [sendProgress]);

  // Block forward seeking: snap back to the furthest point actually watched.
  const onSeeking = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.currentTime > maxWatchedRef.current + SEEK_BUFFER) {
      el.currentTime = maxWatchedRef.current;
    }
  }, []);

  // Pin playback speed to 1 (defeats speed-controller extensions / PiP rate).
  const onRateChange = useCallback(() => {
    const el = videoRef.current;
    if (el && el.playbackRate !== 1) el.playbackRate = 1;
  }, []);

  const onEnded = useCallback(() => {
    setPlaying(false);
    const el = videoRef.current;
    if (el) sendProgress(el.currentTime, true);
  }, [sendProgress]);

  const onPause = useCallback(() => {
    setPlaying(false);
    const el = videoRef.current;
    if (el && el.currentTime - lastSentRef.current > 0.5) sendProgress(el.currentTime);
  }, [sendProgress]);

  function togglePlay() {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) { el.play().then(() => setPlaying(true)).catch(() => setPlaybackError('Playback was blocked. Tap play again.')); }
    else { el.pause(); }
  }
  function rewind10() {
    const el = videoRef.current;
    if (el) el.currentTime = Math.max(0, el.currentTime - 10);
  }

  // No-quiz video: watching is the whole gate. Once watched, record the pass
  // (server marks quiz_passed=true trivially) and advance.
  async function completeNoQuiz() {
    setGrading(true); setQuizError('');
    try {
      const { data, error } = await invokeOnboardingFn(
        'submit-training-quiz',
        { training_video_id: video.id, answers: [] },
        { navigate },
      );
      if (error || !data?.passed) { setQuizError('Something went wrong. Please try again.'); setGrading(false); return; }
      onPassed(video.id);
    } catch (err) {
      if (isHandledRedirect(err)) return;
      setQuizError('Something went wrong. Please try again.'); setGrading(false);
    }
  }

  async function submitQuiz() {
    // Every question must be answered.
    if (quiz.some((q) => answers[q.index] == null)) { setQuizError('Please answer every question.'); return; }
    setGrading(true); setQuizError(''); setQuizWrong(null);
    try {
      const ordered = quiz.map((q) => answers[q.index]);
      const { data, error } = await invokeOnboardingFn(
        'submit-training-quiz',
        { training_video_id: video.id, answers: ordered },
        { navigate },
      );
      if (error || !data) { setQuizError('Something went wrong grading your answers. Please try again.'); setGrading(false); return; }
      if (data.passed) { onPassed(video.id); return; }
      setQuizWrong(Array.isArray(data.wrong) ? data.wrong : []);
      setGrading(false);
    } catch (err) {
      if (isHandledRedirect(err)) return;
      setQuizError('Something went wrong grading your answers. Please try again.'); setGrading(false);
    }
  }

  if (loadError) {
    return <div className="rounded-md bg-red-50 p-4 text-sm text-red-900">{loadError}</div>;
  }
  if (!src) {
    return <div className="rounded-md bg-neutral-100 p-6 text-center text-sm text-neutral-500">Loading video…</div>;
  }

  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const watchedPct = Math.round(coverage * 100);

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-black">
        <video
          ref={videoRef}
          src={src}
          className="w-full"
          playsInline
          controlsList="nodownload noplaybackrate"
          disablePictureInPicture
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onTimeUpdate={onTimeUpdate}
          onSeeking={onSeeking}
          onRateChange={onRateChange}
          onPlay={() => setPlaying(true)}
          onPause={onPause}
          onEnded={onEnded}
          onError={() => setPlaybackError("This video couldn't play. It may be in an unsupported format — contact your program.")}
        />
      </div>

      {/* Custom controls — no scrubber (forward seek blocked), no speed control. */}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800"
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={rewind10}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-semibold text-neutral-700 hover:border-neutral-400"
        >
          ⟲ 10s
        </button>
        <div className="ml-auto text-xs font-medium text-neutral-500">
          {fmt(current)} / {fmt(duration)}
        </div>
      </div>

      {/* Read-only progress bar (not seekable). */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200">
        <div className="h-full bg-neutral-900" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-neutral-500">
        {watched ? 'Watched ✓' : `Watched ${watchedPct}% — keep going, you can’t skip ahead`}
      </div>

      {playbackError && <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-900">{playbackError}</div>}

      {/* Quiz / completion — only after the server confirms watched. */}
      {watched && (
        <div className="mt-6 border-t border-neutral-200 pt-5">
          {quiz.length === 0 ? (
            <button
              type="button"
              onClick={completeNoQuiz}
              disabled={grading}
              className="w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              {grading ? 'Saving…' : 'Mark complete →'}
            </button>
          ) : (
            <>
              <div className="text-sm font-semibold text-neutral-900">A couple quick questions</div>
              <p className="mt-1 text-xs text-neutral-500">Answer every question correctly to continue. You can retry.</p>
              <div className="mt-4 space-y-5">
                {quiz.map((q) => {
                  const isWrong = quizWrong?.includes(q.index);
                  return (
                    <div key={q.index} className={`rounded-md border p-3 ${isWrong ? 'border-red-300 bg-red-50' : 'border-neutral-200'}`}>
                      <div className="text-sm font-medium text-neutral-900">{q.q}</div>
                      <div className="mt-2 space-y-1.5">
                        {q.options.map((opt, oi) => (
                          <label key={oi} className="flex cursor-pointer items-center gap-2 text-sm text-neutral-800">
                            <input
                              type="radio"
                              name={`q-${q.index}`}
                              checked={answers[q.index] === oi}
                              onChange={() => setAnswers((a) => ({ ...a, [q.index]: oi }))}
                            />
                            {opt}
                          </label>
                        ))}
                      </div>
                      {isWrong && <div className="mt-2 text-xs font-medium text-red-700">Not quite — review and try again.</div>}
                    </div>
                  );
                })}
              </div>
              {quizError && <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-900">{quizError}</div>}
              <button
                type="button"
                onClick={submitQuiz}
                disabled={grading}
                className="mt-5 w-full rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                {grading ? 'Checking…' : quizWrong ? 'Try again →' : 'Submit answers →'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
