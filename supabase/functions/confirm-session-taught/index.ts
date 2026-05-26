// confirm-session-taught — instructor day-of check-in endpoint.
//
// Instructor Portal: closes the schedule loop by letting an instructor
// mark a specific day of camp as "I taught this." Writes a row into
// session_delivery_confirmations with confirmed_by='self', pay_status
// 'pending', and pay_amount_cents computed from the org's pay-rate
// config (or null when the tenant hasn't configured rates yet).
//
// Body: { camp_assignment_id: string, session_date: 'YYYY-MM-DD' }
//
// Idempotent: a second call for the same (instructor, camp_session,
// session_date) returns the existing row instead of duplicating. There's
// no unique index on the table yet, so we check existence first inside
// a single function call. If two clients race the check, we may briefly
// produce two rows — acceptable for an MVP; the admin can clean up.
//
// Weekly completion bonus: when this insert covers the LAST weekday in
// the camp's range AND every other weekday is also confirmed for the
// same instructor, the org's pay_camp_weekly_bonus_cents is written into
// pay_adjustment_cents on this row with reason "Week completion bonus."
// Per-tenant config keeps the rule generic — no J2S-specific values
// hardcoded.
//
// Anti-enumeration: missing row + wrong instructor both return identical
// 403 with no detail.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

interface RequestBody {
  camp_assignment_id?: string;
  session_date?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const assignmentId = body.camp_assignment_id?.trim();
    const sessionDate = body.session_date?.trim();
    if (!assignmentId) return json({ error: 'camp_assignment_id_required' }, 400);
    if (!sessionDate || !DATE_RE.test(sessionDate)) {
      return json({ error: 'session_date_invalid' }, 400);
    }

    const supabase = adminClient();

    // Fetch the assignment + linked camp_session (service role bypasses RLS;
    // we authorize via instructor.id comparison below).
    const { data: assignment, error: fetchErr } = await supabase
      .from('camp_assignments')
      .select(
        `id, instructor_id, organization_id, status, camp_session_id,
         camp_sessions ( id, starts_on, ends_on, session_type )`
      )
      .eq('id', assignmentId)
      .maybeSingle();
    if (fetchErr) {
      console.error('assignment lookup failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Anti-enumeration: missing row + wrong instructor both 403, same body.
    if (!assignment) return FORBIDDEN;
    if (assignment.instructor_id !== me.id) return FORBIDDEN;

    // Must be confirmed to mark sessions taught. Other statuses (proposed,
    // published, change_requested, withdrawn, declined) get a clear 409.
    if (assignment.status !== 'confirmed') {
      return json({ error: 'assignment_not_confirmed', status: assignment.status }, 409);
    }

    const session = assignment.camp_sessions as
      | { id: string; starts_on: string; ends_on: string; session_type: string }
      | null;
    if (!session) {
      console.error('camp_session missing for assignment', assignmentId);
      return json({ error: 'session_not_found' }, 500);
    }

    // session_date must be within the camp's date range.
    if (sessionDate < session.starts_on || sessionDate > session.ends_on) {
      return json({ error: 'session_date_out_of_range' }, 400);
    }

    // session_date must be today or earlier (no marking future sessions
    // taught). "Today" is UTC here; org-timezone awareness is a v2 nice-
    // to-have. End-of-day edge cases on the West Coast may briefly block
    // a same-evening mark, which is acceptable.
    const today = new Date().toISOString().slice(0, 10);
    if (sessionDate > today) {
      return json({ error: 'session_date_in_future' }, 400);
    }

    // Idempotency: do we already have a confirmation for this trio?
    const { data: existing, error: existsErr } = await supabase
      .from('session_delivery_confirmations')
      .select('id, confirmed_by, confirmed_at, pay_status, pay_amount_cents, pay_adjustment_cents')
      .eq('instructor_id', me.id)
      .eq('camp_session_id', session.id)
      .eq('session_date', sessionDate)
      .maybeSingle();
    if (existsErr) {
      console.error('confirmation lookup failed:', existsErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (existing) {
      return json({
        confirmation: existing,
        already_confirmed: true,
      });
    }

    // Pay computation. Reads the org's configured rates; if any are
    // missing we leave pay_amount_cents null and let the admin set it
    // manually. This keeps un-configured tenants safe.
    const { data: orgRow } = await supabase
      .from('organizations')
      .select('pay_hourly_cents, pay_camp_morning_hours, pay_camp_full_day_hours, pay_camp_weekly_bonus_cents')
      .eq('id', assignment.organization_id)
      .maybeSingle();

    const payAmountCents = computePayAmount(orgRow, session.session_type);

    // Insert the new confirmation. session_type mirrors the camp_session's
    // (full_day / morning / afternoon).
    const { data: inserted, error: insErr } = await supabase
      .from('session_delivery_confirmations')
      .insert({
        instructor_id: me.id,
        organization_id: assignment.organization_id,
        camp_session_id: session.id,
        session_date: sessionDate,
        session_type: session.session_type,
        confirmed_by: 'self',
        confirmed_at: new Date().toISOString(),
        pay_status: 'pending',
        pay_amount_cents: payAmountCents,
      })
      .select('id, confirmed_by, confirmed_at, pay_status, pay_amount_cents, pay_adjustment_cents')
      .single();
    if (insErr) {
      console.error('confirmation insert failed:', insErr);
      return json({ error: 'insert_failed', detail: insErr.message }, 500);
    }

    // Weekly completion bonus. If this insert covers the FINAL weekday of
    // the camp AND every other weekday in the range is also confirmed for
    // this instructor, write the bonus as pay_adjustment_cents on this
    // row. Reason becomes the audit trail.
    let bonusApplied = false;
    if (orgRow?.pay_camp_weekly_bonus_cents && orgRow.pay_camp_weekly_bonus_cents > 0) {
      const weekdays = weekdayDatesInRange(session.starts_on, session.ends_on);
      const lastWeekday = weekdays[weekdays.length - 1];
      if (lastWeekday && sessionDate === lastWeekday) {
        // Pull all confirmations for this (instructor, camp_session) so we
        // can check completeness. The just-inserted row is included.
        const { data: allConfirms } = await supabase
          .from('session_delivery_confirmations')
          .select('session_date')
          .eq('instructor_id', me.id)
          .eq('camp_session_id', session.id);
        const confirmedDates = new Set((allConfirms ?? []).map((r) => r.session_date));
        const allCovered = weekdays.every((d) => confirmedDates.has(d));
        if (allCovered) {
          const { error: bonusErr } = await supabase
            .from('session_delivery_confirmations')
            .update({
              pay_adjustment_cents: orgRow.pay_camp_weekly_bonus_cents,
              pay_adjustment_reason: 'Week completion bonus',
            })
            .eq('id', inserted.id);
          if (bonusErr) {
            console.warn('weekly bonus apply failed (non-fatal):', bonusErr);
          } else {
            bonusApplied = true;
          }
        }
      }
    }

    return json({
      confirmation: bonusApplied
        ? {
            ...inserted,
            pay_adjustment_cents: orgRow.pay_camp_weekly_bonus_cents,
          }
        : inserted,
      already_confirmed: false,
      bonus_applied: bonusApplied,
    });
  } catch (err) {
    console.error('confirm-session-taught fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// Compute pay_amount_cents from the org's configured rates. Returns null
// if the org hasn't set their rate (so admin fills it in manually).
function computePayAmount(
  org:
    | {
        pay_hourly_cents: number | null;
        pay_camp_morning_hours: number | null;
        pay_camp_full_day_hours: number | null;
      }
    | null,
  sessionType: string,
): number | null {
  if (!org || !org.pay_hourly_cents) return null;
  let hours: number | null = null;
  if (sessionType === 'morning' || sessionType === 'afternoon') {
    hours = org.pay_camp_morning_hours ?? null;
  } else if (sessionType === 'full_day') {
    hours = org.pay_camp_full_day_hours ?? null;
  }
  if (hours === null) return null;
  return Math.round(org.pay_hourly_cents * Number(hours));
}

// Generate Mon-Fri date strings between start and end (inclusive), each
// YYYY-MM-DD. Matches the frontend weekdayRange in InstructorPortal.jsx.
function weekdayDatesInRange(start: string, end: string): string[] {
  const out: string[] = [];
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
