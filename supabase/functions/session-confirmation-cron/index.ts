// session-confirmation-cron — daily cron with two jobs in one function:
//
//   Job A: create today's confirmation rows from camp_assignments + camp_sessions
//          (so instructors have something to confirm tomorrow).
//   Job B: auto-confirm yesterday's still-pending rows with auto pay (so
//          instructors who forget don't hold up payroll).
//
// Auth: verify_jwt: false. pg_cron sends X-Cron-Secret header signed against
// CRON_SECRET env var (vault entry: enrops_cron_secret). Without this check
// anyone with the URL could trigger mass auto-confirmations and pay.
//
// Scope: camps only for v1. Job A intentionally pulls only from
// camp_assignments + camp_sessions. After-school confirmation rows need a
// program_assignments table that doesn't exist yet.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

// Pay table — duplicated from confirm-session-delivery to keep the auto-pay
// path independent. If pay rates change, update both. (Future: pull from a
// tenant_pay_rates table.)
type Role = 'lead' | 'developing';
type SessionType = 'morning' | 'afternoon' | 'full_day';

const AUTO_PAY: Record<Role, Record<SessionType, number>> = {
  lead:       { morning: 8000,  afternoon: 8000,  full_day: 16000 },
  developing: { morning: 6500,  afternoon: 6500,  full_day: 13000 },
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // CRITICAL: this MUST run before any other work. Without the secret check,
  // anyone with the URL could trigger mass auto-pay across pending sessions.
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
    job_b_rows_auto_confirmed: 0,
    job_b_rows_flagged: 0,
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

    // ─────────────────────────────────────────────────────────────────────
    // Job B: auto-confirm everything pending with session_date < today.
    // WARNING: this auto-confirms the instructor assigned via camp_assignments.
    // If a substitute taught the session, admin must manually update the
    // confirmation row BEFORE payroll export. Sub request + approval flow is
    // a separate feature — when built, it will update camp_assignments so the
    // confirmed instructor reflects who actually taught.
    //
    // Camps only — Job B does not touch program_id rows (after-school is
    // deferred until program_assignments lands).
    // ─────────────────────────────────────────────────────────────────────
    const { data: pending, error: pendingErr } = await supabase
      .from('session_delivery_confirmations')
      .select('id, instructor_id, camp_session_id, session_type')
      .lt('session_date', today)
      .eq('confirmed_by', 'pending')
      .eq('admin_override', false)
      .not('camp_session_id', 'is', null);

    if (pendingErr) {
      console.error('Job B pending query failed:', pendingErr);
      summary.errors.push(`job_b_query: ${pendingErr.message}`);
    } else if (pending && pending.length > 0) {
      // For each pending row, look up role from camp_assignments and compute pay.
      // Done in JS instead of a giant SQL CASE expression for maintainability.
      const nowIso = new Date().toISOString();

      for (const row of pending) {
        const { data: assignment, error: aErr } = await supabase
          .from('camp_assignments')
          .select('role')
          .eq('camp_session_id', row.camp_session_id)
          .eq('instructor_id', row.instructor_id)
          .maybeSingle();

        if (aErr) {
          summary.errors.push(`job_b_assignment_${row.id}: ${aErr.message}`);
          continue;
        }

        const role = assignment?.role as Role | undefined;
        const sessionType = row.session_type as SessionType;

        // Skip session_type='after_school' (out of scope for v1).
        if (sessionType !== 'morning' && sessionType !== 'afternoon' && sessionType !== 'full_day') {
          continue;
        }

        if (role !== 'lead' && role !== 'developing') {
          // Assignment missing or unexpected role — flag for admin review, skip auto-pay.
          await supabase
            .from('session_delivery_confirmations')
            .update({
              pay_status: 'withheld',
              pay_adjustment_reason: 'no_assignment_or_unknown_role',
              updated_at: nowIso,
            })
            .eq('id', row.id);
          summary.job_b_rows_flagged++;
          continue;
        }

        const payCents = AUTO_PAY[role][sessionType];

        const { error: updErr } = await supabase
          .from('session_delivery_confirmations')
          .update({
            confirmed_by: 'auto',
            confirmed_at: nowIso,
            pay_status: 'approved',
            pay_amount_cents: payCents,
            updated_at: nowIso,
          })
          .eq('id', row.id);

        if (updErr) {
          summary.errors.push(`job_b_update_${row.id}: ${updErr.message}`);
          continue;
        }
        summary.job_b_rows_auto_confirmed++;
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
