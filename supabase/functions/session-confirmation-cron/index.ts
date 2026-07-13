// session-confirmation-cron — daily cron that seeds today's confirmation rows.
//
//   Job A: create today's confirmation rows from camp_assignments + camp_sessions
//          (so instructors have something to confirm). Rows land pending; the
//          instructor confirms via the portal ("Mark taught"), which is the
//          ONLY path that marks a day taught + payable.
//
// Auto-confirm (formerly "Job B") was REMOVED 2026-07-11 (Jessica's decision):
// a day is NEVER auto-marked taught. Days an instructor doesn't confirm stay
// pending and surface on the admin Payroll screen, where an admin can confirm &
// pay them on the instructor's behalf ("Confirm & pay" → admin-confirm-session).
// Nothing here settles pay anymore.
//
// Auth: verify_jwt: false. pg_cron sends X-Cron-Secret header signed against
// CRON_SECRET env var (vault entry: enrops_cron_secret). Without this check
// anyone with the URL could seed rows for arbitrary orgs.
//
// Scope: Job A seeds CAMP days (camp_assignments + camp_sessions). Job C seeds
// AFTER-SCHOOL program session days (program_assignments + the derived program
// schedule) so a forgotten after-school session surfaces on Payroll as pending,
// exactly like a camp day — the admin can then Confirm & pay it. Both jobs seed
// ONLY accepted (confirmed) assignments and land rows confirmed_by='pending'.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // CRITICAL: this MUST run before any other work. Without the secret check,
  // anyone with the URL could seed confirmation rows across orgs.
  const cronSecret = Deno.env.get('CRON_SECRET');
  const headerSecret = req.headers.get('X-Cron-Secret');
  if (!cronSecret) {
    console.error('CRON_SECRET not set on session-confirmation-cron');
    return json({ error: 'cron_not_configured' }, 500);
  }
  if (!headerSecret || headerSecret !== cronSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const supabase = adminClient();
  const summary = {
    job_a_rows_created: 0,
    job_c_rows_created: 0,
    errors: [] as string[],
  };

  try {
    // ─────────────────────────────────────────────────────────────────────
    // Job A: create today's confirmation rows.
    // ─────────────────────────────────────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dayName = dayOfWeekLower(today); // 'monday', 'tuesday', ...

    // Pull all live camp assignments whose camp_session runs today (between
    // starts_on and ends_on, and class_days includes today's day-of-week).
    // Seed a payable day ONLY for assignments the instructor has ACCEPTED:
    // 'confirmed' is the canonical accepted state (respond-to-assignment writes
    // it on accept), 'accepted' is a legacy alias. 'published' (offer sent,
    // never accepted), 'proposed', 'change_requested', 'withdrawn', 'declined'
    // are excluded — an unaccepted offer must not surface a payable day on
    // Payroll in the first place. This mirrors the committed-status allow-list
    // in admin-confirm-session, so the two paths can't disagree.
    //
    // We do this as two queries instead of an INSERT...SELECT because the
    // class_days filter is awkward in PostgREST. Get the candidate rows in
    // JS, then INSERT with ON CONFLICT DO NOTHING.
    const { data: candidates, error: candidateErr } = await supabase
      .from('camp_assignments')
      .select(
        `instructor_id,
         organization_id,
         camp_session:camp_sessions!inner (
           id,
           session_type,
           starts_on,
           ends_on,
           class_days
         ),
         status`,
      )
      .in('status', ['accepted', 'confirmed']);

    if (candidateErr) {
      console.error('Job A candidate query failed:', candidateErr);
      summary.errors.push(`job_a_query: ${candidateErr.message}`);
    } else if (candidates && candidates.length > 0) {
      const rowsToInsert: Array<{
        instructor_id: string;
        organization_id: string;
        camp_session_id: string;
        session_date: string;
        session_type: string;
      }> = [];

      for (const row of candidates as unknown as Array<{
        instructor_id: string;
        organization_id: string;
        camp_session: {
          id: string;
          session_type: string;
          starts_on: string;
          ends_on: string;
          class_days: string[] | null;
        } | null;
      }>) {
        const cs = row.camp_session;
        if (!cs) continue;
        if (cs.starts_on > today || cs.ends_on < today) continue;
        const days = (cs.class_days ?? []).map((d) => d.toLowerCase().trim());
        if (!days.includes(dayName)) continue;
        rowsToInsert.push({
          instructor_id: row.instructor_id,
          organization_id: row.organization_id,
          camp_session_id: cs.id,
          session_date: today,
          session_type: cs.session_type,
        });
      }

      if (rowsToInsert.length > 0) {
        // De-dupe in JS rather than ON CONFLICT: the camp uniqueness index is
        // PARTIAL (WHERE camp_session_id IS NOT NULL), which PostgREST can't
        // target without the predicate — an upsert here raises 42P10. Volume
        // is a handful of camp-days, so an existence check + per-row insert is
        // cheap and avoids that. A concurrent self-check-in that beats us trips
        // 23505, which we treat as already-created.
        const { data: existingToday, error: existErr } = await supabase
          .from('session_delivery_confirmations')
          .select('instructor_id, camp_session_id')
          .eq('session_date', today)
          .not('camp_session_id', 'is', null);
        if (existErr) {
          console.error('Job A existing-lookup failed:', existErr);
          summary.errors.push(`job_a_existing: ${existErr.message}`);
        }
        const have = new Set(
          (existingToday ?? []).map((r) => `${r.instructor_id}|${r.camp_session_id}`),
        );
        const fresh = rowsToInsert.filter(
          (r) => !have.has(`${r.instructor_id}|${r.camp_session_id}`),
        );

        for (const r of fresh) {
          const { error: insErr } = await supabase
            .from('session_delivery_confirmations')
            .insert(r);
          if (insErr) {
            // 23505 = unique_violation: a concurrent insert beat us — fine.
            if ((insErr as { code?: string }).code === '23505') continue;
            console.error('Job A insert failed:', insErr);
            summary.errors.push(`job_a_insert: ${insErr.message}`);
            continue;
          }
          summary.job_a_rows_created++;
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Job C: create today's AFTER-SCHOOL program confirmation rows.
    // Mirrors Job A for programs. A program "meets today" when its derived
    // session schedule (weekly cadence minus location/district closures) has a
    // 'session' entry for today. Seed ONLY accepted (confirmed) program
    // assignments — same committed-status rule as camps + admin-confirm-session.
    // session_type is always 'after_school' (programs carry none; matches
    // confirm-session-taught + confirm-sub-delivery).
    // ─────────────────────────────────────────────────────────────────────
    // NOTE (optimization, safe to defer): this pulls every accepted assignment
    // and asks the schedule RPC per unique program, so the RPC fan-out grows with
    // historical program count (ended programs keep status='confirmed'). Fine at
    // J2S scale; if it ever matters, pre-filter to in-term programs BEFORE the RPC
    // loop — but conservatively (never exclude a program that could meet today, or
    // its session silently won't surface on Payroll).
    const { data: progCandidates, error: progErr } = await supabase
      .from('program_assignments')
      .select('instructor_id, organization_id, program_id, status')
      .in('status', ['accepted', 'confirmed']);

    if (progErr) {
      console.error('Job C candidate query failed:', progErr);
      summary.errors.push(`job_c_query: ${progErr.message}`);
    } else if (progCandidates && progCandidates.length > 0) {
      // Ask the schedule RPC once per UNIQUE program whether it meets today.
      const uniqueProgramIds = [
        ...new Set(
          (progCandidates as Array<{ program_id: string | null }>)
            .map((r) => r.program_id)
            .filter((id): id is string => !!id),
        ),
      ];
      const meetsToday = new Set<string>();
      for (const pid of uniqueProgramIds) {
        const { data: sched, error: schedErr } = await supabase.rpc(
          'derive_program_session_schedule',
          { p_program_id: pid },
        );
        if (schedErr) {
          console.error('Job C schedule derive failed:', pid, schedErr);
          summary.errors.push(`job_c_schedule:${pid}: ${schedErr.message}`);
          continue;
        }
        const meets = (sched ?? []).some(
          (e: { entry_date?: string; kind?: string }) =>
            e.kind === 'session' && e.entry_date === today,
        );
        if (meets) meetsToday.add(pid);
      }

      const progRows = (progCandidates as Array<{
        instructor_id: string;
        organization_id: string;
        program_id: string | null;
      }>)
        .filter((r) => r.program_id && meetsToday.has(r.program_id))
        .map((r) => ({
          instructor_id: r.instructor_id,
          organization_id: r.organization_id,
          program_id: r.program_id as string,
          session_date: today,
          session_type: 'after_school',
        }));

      if (progRows.length > 0) {
        // De-dupe against rows already created today (self check-in or a prior
        // cron run), then insert the rest. Same approach as Job A — the program
        // uniqueness index is partial, so an existence check + per-row insert
        // avoids the 42P10 an upsert would raise; a concurrent insert trips
        // 23505, which we treat as already-created.
        const { data: existingProg, error: existProgErr } = await supabase
          .from('session_delivery_confirmations')
          .select('instructor_id, program_id')
          .eq('session_date', today)
          .not('program_id', 'is', null);
        if (existProgErr) {
          console.error('Job C existing-lookup failed:', existProgErr);
          summary.errors.push(`job_c_existing: ${existProgErr.message}`);
        }
        const haveProg = new Set(
          (existingProg ?? []).map((r) => `${r.instructor_id}|${r.program_id}`),
        );
        const freshProg = progRows.filter(
          (r) => !haveProg.has(`${r.instructor_id}|${r.program_id}`),
        );

        for (const r of freshProg) {
          const { error: insErr } = await supabase
            .from('session_delivery_confirmations')
            .insert(r);
          if (insErr) {
            if ((insErr as { code?: string }).code === '23505') continue;
            console.error('Job C insert failed:', insErr);
            summary.errors.push(`job_c_insert: ${insErr.message}`);
            continue;
          }
          summary.job_c_rows_created++;
        }
      }
    }

    return json({ ok: true, summary });
  } catch (err) {
    console.error('session-confirmation-cron fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

function dayOfWeekLower(yyyyMmDd: string): string {
  // Parse as UTC midnight; this is a date-only value so timezone shouldn't
  // matter for day-of-week as long as we're consistent.
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[d.getUTCDay()];
}
