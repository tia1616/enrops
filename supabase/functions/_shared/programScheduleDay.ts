// Is this date a real class day for this program, per the derived schedule?
//
// WHY IT EXISTS. A pay line may only exist for a day the class actually met.
// confirm-session-taught has always checked this (it validates against
// derive_program_session_schedule). Three other doors into pay did not:
// admin-confirm-session, confirm-session-delivery and confirm-sub-delivery.
// That was survivable while a day could only leave the schedule before its
// placeholder was seeded. "Reschedule a session" (migration 20261007c) can take
// a day off AFTER it was seeded, and withholds that placeholder - so any door
// that confirms or prices a row without asking the schedule would turn a day
// with no class back into pay.
//
// FAILS CLOSED. A lookup error is returned as an error, never as "yes": paying
// for a day nobody taught is the expensive direction.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export interface ScheduleDayCheck {
  onSchedule: boolean;
  error: string | null;
}

export async function isProgramClassDay(
  supabase: SupabaseClient,
  programId: string,
  sessionDate: string,
): Promise<ScheduleDayCheck> {
  const { data, error } = await supabase.rpc('derive_program_session_schedule', { p_program_id: programId });
  if (error) return { onSchedule: false, error: error.message || 'schedule lookup failed' };
  const day = sessionDate.slice(0, 10);
  const onSchedule = (data ?? []).some(
    (r: { entry_date?: string; kind?: string }) => r.kind === 'session' && String(r.entry_date).slice(0, 10) === day,
  );
  return { onSchedule, error: null };
}
