// submit-training-quiz — grade a training video's comprehension quiz SERVER-SIDE.
//
// Correct answers never leave the server (get-training-video-url strips them), so
// grading MUST happen here. Requires the video to be watched first. All questions
// correct to pass; retries allowed; once passed it stays passed. The response tells
// the instructor WHICH questions were wrong (for retry) but never the right answer.
//
// Auth: instructor JWT (resolveInstructor). verify_jwt = true.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

interface Body {
  training_video_id?: string;
  answers?: number[];
}

interface QuizQuestion {
  correct_index?: number;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const videoId = body.training_video_id?.trim();
    const answers = Array.isArray(body.answers) ? body.answers : null;
    if (!videoId) return json({ error: 'training_video_id_required' }, 400);
    if (!answers) return json({ error: 'answers_required' }, 400);

    const supabase = adminClient();

    const { data: video, error: vErr } = await supabase
      .from('instructor_training_videos')
      .select('id, organization_id, quiz, active')
      .eq('id', videoId)
      .maybeSingle();
    if (vErr) {
      console.error('[submit-training-quiz] video lookup failed:', vErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!video || video.organization_id !== me.organization_id || !video.active) {
      return json({ error: 'not_found' }, 404);
    }

    const quiz = Array.isArray(video.quiz) ? (video.quiz as QuizQuestion[]) : [];

    // Must have watched the video before the quiz unlocks.
    const { data: existing, error: eErr } = await supabase
      .from('instructor_training_completions')
      .select('id, watched_completed_at, quiz_passed, quiz_attempts')
      .eq('instructor_id', me.id)
      .eq('training_video_id', videoId)
      .maybeSingle();
    if (eErr) {
      console.error('[submit-training-quiz] completion lookup failed:', eErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!existing?.watched_completed_at) {
      return json({ error: 'not_watched_yet' }, 409);
    }

    const nowIso = new Date().toISOString();

    // No quiz on this video → watching is the whole gate; mark trivially passed.
    if (quiz.length === 0) {
      const { error: upErr } = await supabase
        .from('instructor_training_completions')
        .update({ quiz_passed: true, quiz_score: 0, quiz_last_attempt_at: nowIso, updated_at: nowIso })
        .eq('id', existing.id);
      if (upErr) {
        console.error('[submit-training-quiz] update (no-quiz) failed:', upErr);
        return json({ error: 'save_failed' }, 500);
      }
      return json({ passed: true, score: 0, total: 0, wrong: [] });
    }

    // Grade: every question must be correct to pass.
    const wrong: number[] = [];
    let correct = 0;
    quiz.forEach((q, i) => {
      if (Number(answers[i]) === Number(q?.correct_index)) correct++;
      else wrong.push(i);
    });
    const passed = wrong.length === 0;

    const { error: upErr } = await supabase
      .from('instructor_training_completions')
      .update({
        quiz_passed: existing.quiz_passed === true ? true : passed, // once passed, stays passed
        quiz_score: correct,
        quiz_attempts: (existing.quiz_attempts ?? 0) + 1,
        quiz_last_attempt_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', existing.id);
    if (upErr) {
      console.error('[submit-training-quiz] update failed:', upErr);
      return json({ error: 'save_failed' }, 500);
    }

    return json({ passed, score: correct, total: quiz.length, wrong });
  } catch (err) {
    console.error('[submit-training-quiz] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
