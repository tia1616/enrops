// confirm-session-taught — instructor day-of check-in endpoint.
//
// Instructor Portal: closes the schedule loop by letting an instructor
// mark a specific day of camp as "I taught this." Writes a row into
// session_delivery_confirmations with confirmed_by='self', pay_status
// 'pending', and pay_amount_cents resolved per-tenant from tenant_pay_rates
// (keyed by the assignment's role + the session_type).
//
// Pay rates are per-tenant: resolvePayAmount() reads the org's tenant_pay_rates
// card. The same resolver is shared by confirm-session-delivery,
// session-confirmation-cron, and confirm-sub-delivery so all pay-writing paths
// agree (see _shared/payRates.ts).
//
// If the assignment has no usable role, or the tenant hasn't configured a rate
// for this session_type, we leave pay_amount_cents null and let the admin set
// it on the Payroll screen — the check-in is still recorded so the day is
// never silently lost.
//
// Body: { camp_assignment_id: string, session_date: 'YYYY-MM-DD' }
//
// Idempotent: a second call for the same (instructor, camp_session,
// session_date) returns the existing row instead of duplicating. There's
// no unique index on the table yet, so we check existence first inside
// a single function call. If two clients race the check, we may briefly
// produce two rows — acceptable for an MVP; the admin can clean up.
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
import { resolvePayAmount } from '../_shared/payRates.ts';

interface RequestBody {
  camp_assignment_id?: string;
  session_date?: string;
}

// Pay is resolved per-tenant from the tenant_pay_rates table via
// resolvePayAmount(), keyed by the assignment's role + the camp session_type.
// When the tenant hasn't configured a rate, resolution returns null and we
// record the check-in with null pay — the admin sets the amount on Payroll.

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
    // we authorize via instructor.id comparison below). role drives pay.
    const { data: assignment, error: fetchErr } = await supabase
      .from('camp_assignments')
      .select(
        `id, instructor_id, organization_id, status, role, camp_session_id,
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

    // Substitution guard: if a sub was confirmed to cover THIS assignment on
    // THIS date, the assigned instructor must not self-confirm it — the sub is
    // the payee (the pay-line view routes the day to the sub). The sub records
    // their own pay via confirm-sub-delivery, or an admin settles it from
    // Payroll ("Confirm & pay" → admin-confirm-session). Block with a clear 409
    // so we never create a duplicate payable row for the person who was covered.
    // (Keyed to the camp_assignment + date, matching assignment_substitutions.)
    const { data: cover } = await supabase
      .from('assignment_substitutions')
      .select('id')
      .eq('parent_assignment_id', assignment.id)
      .eq('parent_assignment_type', 'camp')
      .eq('date', sessionDate)
      .in('status', ['confirmed', 'taught'])
      .maybeSingle();
    if (cover) {
      return json({ error: 'session_covered_by_substitute' }, 409);
    }

    // Pay computation: per-tenant rate from tenant_pay_rates, keyed by the
    // assignment role + session_type. If the role is missing/unexpected or the
    // tenant hasn't configured a rate for this cell, resolvePayAmount returns
    // null so the admin sets it manually on Payroll — the check-in is still
    // recorded.
    const payAmountCents = await resolvePayAmount(
      supabase,
      assignment.organization_id,
      assignment.role,
      session.session_type,
    );

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

    return json({
      confirmation: inserted,
      already_confirmed: false,
    });
  } catch (err) {
    console.error('confirm-session-taught fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
