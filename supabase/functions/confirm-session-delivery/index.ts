// confirm-session-delivery — the only path for an instructor to self-confirm
// they delivered a camp session.
//
// Scope: camps only for v1. After-school confirmation needs a program_assignments
// table that doesn't exist yet. If camp_assignments has no matching row for
// (camp_session_id, instructor_id), this function 400s rather than falling
// back to instructors.contractor_tier — per-engagement role accuracy matters
// for pay.
//
// Anti-enumeration: a confirmation that belongs to a different instructor
// returns the same 403 as a missing confirmation, so an attacker can't probe
// valid confirmation IDs.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

interface ConfirmDeliveryBody {
  confirmation_id?: string;
}

type Role = 'lead' | 'developing';
type SessionType = 'morning' | 'afternoon' | 'full_day' | 'after_school';

// Pay table — cents. After-school is intentionally absent: chunk 3 scope is
// camps-only for v1. If a confirmation row has session_type='after_school'
// somehow, the lookup below returns undefined and we 400.
const PAY: Record<Role, Record<SessionType, number | undefined>> = {
  lead: {
    morning: 8000,
    afternoon: 8000,
    full_day: 16000,
    after_school: undefined,
  },
  developing: {
    morning: 6500,
    afternoon: 6500,
    full_day: 13000,
    after_school: undefined,
  },
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: ConfirmDeliveryBody;
    try {
      body = (await req.json()) as ConfirmDeliveryBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const confirmationId = body.confirmation_id?.trim();
    if (!confirmationId) return json({ error: 'confirmation_id_required' }, 400);

    const supabase = adminClient();

    // Fetch the confirmation row.
    const { data: row, error: rowErr } = await supabase
      .from('session_delivery_confirmations')
      .select(
        'id, instructor_id, organization_id, camp_session_id, program_id, session_date, session_type, confirmed_by, admin_override',
      )
      .eq('id', confirmationId)
      .maybeSingle();

    if (rowErr) {
      console.error('confirmation lookup failed:', rowErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Anti-enumeration: same 403 for missing-row + belongs-to-someone-else.
    if (!row || row.instructor_id !== me.id) {
      return json({ error: 'forbidden' }, 403);
    }

    if (row.confirmed_by !== 'pending') {
      return json({ error: 'already_confirmed', confirmed_by: row.confirmed_by }, 400);
    }
    if (row.admin_override === true) {
      return json({ error: 'admin_overridden' }, 400);
    }

    // session_date must be today or earlier.
    const today = new Date().toISOString().slice(0, 10);
    if (row.session_date > today) {
      return json({ error: 'future_session', session_date: row.session_date }, 400);
    }

    // Camps only for v1.
    if (!row.camp_session_id) {
      return json({ error: 'after_school_not_supported_v1' }, 400);
    }

    // Find the camp_assignment row for (instructor_id, camp_session_id) → role.
    const { data: assignment, error: assignErr } = await supabase
      .from('camp_assignments')
      .select('role')
      .eq('camp_session_id', row.camp_session_id)
      .eq('instructor_id', row.instructor_id)
      .maybeSingle();

    if (assignErr) {
      console.error('camp_assignments lookup failed:', assignErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!assignment?.role) {
      // No matching assignment — likely deleted between scheduling and today,
      // or the instructor was reassigned. Flag for admin review.
      console.warn('no camp_assignment for confirmation', {
        confirmation_id: confirmationId,
        camp_session_id: row.camp_session_id,
        instructor_id: row.instructor_id,
      });
      return json({ error: 'no_assignment_for_session' }, 400);
    }

    const role = assignment.role as Role;
    const sessionType = row.session_type as SessionType;

    if (role !== 'lead' && role !== 'developing') {
      console.warn('unexpected camp_assignment role', { role, confirmation_id: confirmationId });
      return json({ error: 'unsupported_role', role }, 400);
    }

    const payCents = PAY[role]?.[sessionType];
    if (payCents === undefined) {
      // session_type is after_school (out of scope) or otherwise unmapped.
      console.warn('no pay mapping for session', { role, sessionType, confirmation_id: confirmationId });
      return json({ error: 'no_pay_rate_for_session', role, session_type: sessionType }, 400);
    }

    // Update the confirmation row.
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('session_delivery_confirmations')
      .update({
        confirmed_by: 'self',
        confirmed_at: nowIso,
        pay_status: 'approved',
        pay_amount_cents: payCents,
        updated_at: nowIso,
      })
      .eq('id', confirmationId);

    if (updErr) {
      console.error('confirmation update failed:', updErr);
      return json({ error: 'update_failed' }, 500);
    }

    return json({
      success: true,
      pay_amount_cents: payCents,
      role,
      session_type: sessionType,
    });
  } catch (err) {
    console.error('confirm-session-delivery fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
