// get-training-video-url — mint a short-lived signed URL for a training video the
// calling instructor is allowed to watch, plus its metadata and the quiz WITHOUT
// correct answers.
//
// Instructors are NOT org_members, so they cannot read the private `training-videos`
// bucket through storage RLS. This service-role endpoint verifies the caller is an
// instructor of the video's org and the video is active, then signs the object. The
// quiz's correct_index is stripped here so answers never reach the client (grading
// happens server-side in submit-training-quiz).
//
// Auth: instructor JWT (resolveInstructor). verify_jwt = true.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

interface Body {
  training_video_id?: string;
}

const SIGNED_URL_TTL = 60 * 60; // 1 hour

interface QuizQuestion {
  q?: string;
  options?: unknown;
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
    if (!videoId) return json({ error: 'training_video_id_required' }, 400);

    const supabase = adminClient();
    const { data: video, error: vErr } = await supabase
      .from('instructor_training_videos')
      .select('id, organization_id, title, bucket_object_path, external_url, duration_seconds, version, quiz, active')
      .eq('id', videoId)
      .maybeSingle();
    if (vErr) {
      console.error('[get-training-video-url] lookup failed:', vErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    // same-org + active gate (enforce same-org on every referenced row)
    if (!video || video.organization_id !== me.organization_id || !video.active) {
      return json({ error: 'not_found' }, 404);
    }

    // Strip correct answers before returning to the client.
    const quiz = Array.isArray(video.quiz) ? (video.quiz as QuizQuestion[]) : [];
    const quizPublic = quiz.map((q, i) => ({
      index: i,
      q: typeof q?.q === 'string' ? q.q : '',
      options: Array.isArray(q?.options) ? q.options : [],
    }));

    let url: string | null = null;
    if (video.bucket_object_path) {
      const { data: signed, error: sErr } = await supabase
        .storage
        .from('training-videos')
        .createSignedUrl(video.bucket_object_path, SIGNED_URL_TTL);
      if (sErr || !signed?.signedUrl) {
        console.error('[get-training-video-url] sign failed:', sErr);
        return json({ error: 'sign_failed' }, 500);
      }
      url = signed.signedUrl;
    } else if (video.external_url) {
      url = video.external_url;
    } else {
      return json({ error: 'no_source' }, 422);
    }

    // Resume: hand back the furthest point this instructor has already watched
    // (and whether they've finished) so the player can seed currentTime + the
    // no-skip floor instead of forcing a re-watch from 0 each session.
    const { data: comp } = await supabase
      .from('instructor_training_completions')
      .select('max_position_seconds, watched_completed_at')
      .eq('instructor_id', me.id)
      .eq('training_video_id', video.id)
      .maybeSingle();

    return json({
      video: {
        id: video.id,
        title: video.title,
        url,
        duration_seconds: video.duration_seconds,
        version: video.version,
        has_quiz: quizPublic.length > 0,
        quiz: quizPublic,
        resume_position_seconds: Number(comp?.max_position_seconds ?? 0),
        already_watched: !!comp?.watched_completed_at,
      },
    });
  } catch (err) {
    console.error('[get-training-video-url] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
