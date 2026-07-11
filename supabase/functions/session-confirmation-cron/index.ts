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
// Scope: camps only for v1. Job A intentionally pulls only from
// camp_assignments + camp_sessions. After-school confirmation rows need a
// program_assignments table that doesn't exist yet.

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
    // 'confirmed' is the canonical accepted state in camp_assignments today;
    // 'accepted'/'published' are kept for forward/back compat. 'withdrawn'
    // and 'declined' are intentionally excluded.
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
      .in('status', ['accepted', 'published', 'confirmed']);

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
