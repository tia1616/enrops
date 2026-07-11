// confirm-session-delivery — the only path for an instructor to self-confirm
// they delivered a session.
//
// Handles both camps (camp_session_id set) and afterschool (program_id set).
// The confirmation row carries one or the other; we branch on which is
// populated and look up the matching assignment row to read the role.
//
// If the assignment row is missing for (instructor_id, parent), this function
// 400s rather than falling back to instructors.contractor_tier — per-engagement
// role accuracy matters for pay.
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
import { resolvePayAmount } from '../_shared/payRates.ts';

interface ConfirmDeliveryBody {
  confirmation_id?: string;
}

type Role = 'lead' | 'developing';
type SessionType = 'morning' | 'afternoon' | 'full_day' | 'after_school';

// Pay is resolved per-tenant from tenant_pay_rates via resolvePayAmount(),
// keyed by role + session_type. When the tenant hasn't configured a rate we
// record the confirmation with null pay and the admin sets the amount on
// Payroll (previously this path 400'd on an unmapped rate).

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

    // Branch on whether this is a camp or program (afterschool) confirmation.
    // The confirmation row has either camp_session_id or program_id populated;
    // we look up the matching assignment to read the per-engagement role.
    if (!row.camp_session_id && !row.program_id) {
      console.warn('confirmation has neither camp_session_id nor program_id', {
        confirmation_id: confirmationId,
      });
      return json({ error: 'invalid_confirmation_no_parent' }, 400);
    }

    let role: Role | null = null;

    if (row.camp_session_id) {
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
        console.warn('no camp_assignment for confirmation', {
          confirmation_id: confirmationId,
          camp_session_id: row.camp_session_id,
          instructor_id: row.instructor_id,
        });
        return json({ error: 'no_assignment_for_session' }, 400);
      }
      role = assignment.role as Role;
    } else {
      // Afterschool path — look up program_assignments instead.
      const { data: assignment, error: assignErr } = await supabase
        .from('program_assignments')
        .select('role')
        .eq('program_id', row.program_id!)
        .eq('instructor_id', row.instructor_id)
        .maybeSingle();

      if (assignErr) {
        console.error('program_assignments lookup failed:', assignErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!assignment?.role) {
        console.warn('no program_assignment for confirmation', {
          confirmation_id: confirmationId,
          program_id: row.program_id,
          instructor_id: row.instructor_id,
        });
        return json({ error: 'no_assignment_for_session' }, 400);
      }
      role = assignment.role as Role;
    }

    const sessionType = row.session_type as SessionType;

    if (role !== 'lead' && role !== 'developing') {
      console.warn('unexpected assignment role', { role, confirmation_id: confirmationId });
      return json({ error: 'unsupported_role', role }, 400);
    }

    // Per-tenant rate lookup. null when the tenant hasn't configured this cell
    // — we still confirm delivery and let the admin set the amount on Payroll,
    // rather than blocking the confirmation over missing pay config.
    const payCents = await resolvePayAmount(supabase, row.organization_id, role, sessionType);

    // Update the confirmation row. Guard on confirmed_by='pending' so a race
    // with an admin confirm-on-behalf (admin-confirm-session) or a sub confirm
    // can't be clobbered: whoever writes first wins, and we return
    // already_confirmed if this write lands on an already-settled row. (The
    // read above catches the common case; this closes the read→write window.)
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .from('session_delivery_confirmations')
      .update({
        confirmed_by: 'self',
        confirmed_at: nowIso,
        pay_status: 'approved',
        pay_amount_cents: payCents,
        updated_at: nowIso,
      })
      .eq('id', confirmationId)
      .eq('confirmed_by', 'pending')
      .select('id')
      .maybeSingle();

    if (updErr) {
      console.error('confirmation update failed:', updErr);
      return json({ error: 'update_failed' }, 500);
    }
    if (!updated) {
      return json({ error: 'already_confirmed' }, 400);
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
