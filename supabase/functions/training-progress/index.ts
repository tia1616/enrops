// training-progress — server-verified watch progress for a training video.
//
// The custom player heartbeats the current playback position (~every 7s). The
// SERVER owns completion: it accumulates the furthest watched position, rejects
// advances faster than wall-clock (so a scripted client can't claim it watched a
// 30-min video in 3s), computes coverage = maxPosition/duration, and marks the
// video watched when coverage crosses the video's completion_threshold. The
// client can NEVER write these rows directly (RLS is SELECT-only) — this is the
// authorized write path.
//
// Auth: instructor JWT (resolveInstructor). verify_jwt = true.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

interface Body {
  training_video_id?: string;
  position_seconds?: number;
  ended?: boolean;
}

// The furthest-watched point can only advance as fast as REAL wall-clock time.
// Credit per heartbeat = min(real elapsed since the last beat, MAX_CREDIT_PER_BEAT).
// No additive per-request "slack" — that let a scripted client spam rapid
// heartbeats and accumulate free credit. Server-side elapsed already exceeds the
// client's playback advance (network latency), so legit 1x playback is never
// clamped. Honest-people enforcement, not DRM: a scripter can still pace requests
// to real time — matches the feature's stated bar.
const FIRST_BEAT_ALLOWANCE = 10;  // credited on the very first heartbeat (no prior reference)
const MAX_CREDIT_PER_BEAT = 60;   // one heartbeat can't credit more than this (bounds resume / idle-gap jumps)

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
    const rawPos = Number(body.position_seconds);
    if (!videoId) return json({ error: 'training_video_id_required' }, 400);
    if (!Number.isFinite(rawPos) || rawPos < 0) return json({ error: 'invalid_position' }, 400);

    const supabase = adminClient();

    const { data: video, error: vErr } = await supabase
      .from('instructor_training_videos')
      .select('id, organization_id, duration_seconds, completion_threshold, version, active')
      .eq('id', videoId)
      .maybeSingle();
    if (vErr) {
      console.error('[training-progress] video lookup failed:', vErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!video || video.organization_id !== me.organization_id || !video.active) {
      return json({ error: 'not_found' }, 404);
    }

    const { data: existing, error: eErr } = await supabase
      .from('instructor_training_completions')
      .select('id, max_position_seconds, watched_completed_at, updated_at')
      .eq('instructor_id', me.id)
      .eq('training_video_id', videoId)
      .maybeSingle();
    if (eErr) {
      console.error('[training-progress] completion lookup failed:', eErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const nowMs = Date.now();
    const prevMax = Number(existing?.max_position_seconds ?? 0);

    // Wall-clock guard (server-side backstop; forward-seek is also blocked in the
    // client). The furthest-watched point advances at most by the real time that
    // has elapsed since the last heartbeat, capped per beat so a long idle gap or
    // a resumed row can't be cashed in for a big forward jump.
    let acceptedPos: number;
    if (!existing?.updated_at) {
      acceptedPos = Math.min(rawPos, FIRST_BEAT_ALLOWANCE);
    } else {
      const elapsedSec = Math.max(0, (nowMs - new Date(existing.updated_at).getTime()) / 1000);
      const credit = Math.min(elapsedSec, MAX_CREDIT_PER_BEAT);
      acceptedPos = Math.min(rawPos, prevMax + credit);
    }
    const newMax = Math.max(prevMax, acceptedPos);

    const duration = Number(video.duration_seconds ?? 0);
    const threshold = Number(video.completion_threshold ?? 0.95);
    let coverage = duration > 0 ? Math.min(1, newMax / duration) : 0;
    let watchedNow = coverage >= threshold;
    // Fallback when duration couldn't be captured at upload: trust the player's
    // explicit ended signal (best-effort; duration is normally present).
    if (duration <= 0 && body.ended === true && newMax > 0) {
      coverage = 1;
      watchedNow = true;
    }

    const alreadyWatchedAt = existing?.watched_completed_at ?? null;
    const watchedAt = alreadyWatchedAt ?? (watchedNow ? new Date(nowMs).toISOString() : null);

    const row = {
      organization_id: me.organization_id,
      instructor_id: me.id,
      training_video_id: videoId,
      video_version: video.version ?? 1,
      max_position_seconds: newMax,
      coverage_pct: coverage,
      watched_completed_at: watchedAt,
      updated_at: new Date(nowMs).toISOString(),
    };

    const { error: upErr } = await supabase
      .from('instructor_training_completions')
      .upsert(row, { onConflict: 'instructor_id,training_video_id' });
    if (upErr) {
      console.error('[training-progress] upsert failed:', upErr);
      return json({ error: 'save_failed' }, 500);
    }

    return json({
      coverage_pct: coverage,
      watched: !!watchedAt,
      max_position_seconds: newMax,
    });
  } catch (err) {
    console.error('[training-progress] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
