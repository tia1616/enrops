// confirm-session-taught — instructor day-of check-in endpoint.
//
// Instructor Portal: closes the schedule loop by letting an instructor mark a
// specific day of a CAMP or a session of an AFTER-SCHOOL program as "I taught
// this." Lands the day confirmed_by='self', pay_status='approved' (immediately
// ready for payout — the admin only has to act on days nobody confirmed),
// pay_amount_cents resolved per-tenant from tenant_pay_rates (keyed by the
// assignment's role + the session_type).
//
// Camp vs after-school (mirrors the branch in admin-confirm-session /
// confirm-sub-delivery — the codebase pattern):
//   - camp:    body { camp_assignment_id }    -> camp_assignments -> camp_sessions.
//              session_type = camp_sessions.session_type (full_day/morning/afternoon).
//              valid dates = camp_sessions.starts_on..ends_on.
//   - program: body { program_assignment_id } -> program_assignments -> programs.
//              session_type = 'after_school' (programs carry no session_type, same as
//              confirm-sub-delivery). valid dates = the program's derived session
//              schedule (derive_program_session_schedule), closures excluded.
//
// The daily cron (session-confirmation-cron) pre-seeds a placeholder row
// (confirmed_by='pending') for each CAMP day so unconfirmed days surface on the
// admin Payroll screen. When one exists, this endpoint PROMOTES it in place
// rather than treating it as already-confirmed. (After-school days are not yet
// seeded, so the program path always takes the fresh-insert branch — harmless.)
//
// Pay rates are per-tenant: resolvePayAmount() reads the org's tenant_pay_rates
// card. Shared by confirm-session-delivery, session-confirmation-cron, and
// confirm-sub-delivery so all pay-writing paths agree (see _shared/payRates.ts).
// after_school is already a first-class rate cell.
//
// If the assignment has no usable role, or the tenant hasn't configured a rate
// for this session_type, we leave pay_amount_cents null and let the admin set it
// on the Payroll screen — the check-in is still recorded so the day is never
// silently lost.
//
// Body: { camp_assignment_id | program_assignment_id, session_date: 'YYYY-MM-DD' }
//
// Idempotent per (instructor, camp_session|program, session_date) — backed by the
// partial unique indexes uq_session_delivery_confirmations_camp /
// unique_program_delivery; the promote/insert paths race-guard on confirmed_by='pending'.
//
// Anti-enumeration: missing row + wrong instructor both return identical 403.

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
  program_assignment_id?: string;
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

    const campAssignmentId = body.camp_assignment_id?.trim();
    const programAssignmentId = body.program_assignment_id?.trim();
    const sessionDate = body.session_date?.trim();

    // Exactly one of camp / program assignment id.
    if (!campAssignmentId && !programAssignmentId) {
      return json({ error: 'assignment_id_required' }, 400);
    }
    if (campAssignmentId && programAssignmentId) {
      return json({ error: 'ambiguous_assignment' }, 400);
    }
    if (!sessionDate || !DATE_RE.test(sessionDate)) {
      return json({ error: 'session_date_invalid' }, 400);
    }

    const kind: 'camp' | 'program' = campAssignmentId ? 'camp' : 'program';
    const assignmentId = (campAssignmentId ?? programAssignmentId)!;

    const supabase = adminClient();

    // Resolve the assignment into a common shape regardless of camp/program.
    // Service role bypasses RLS; we authorize via instructor.id comparison.
    let orgId: string;
    let role: string | null;
    let refCol: 'camp_session_id' | 'program_id';
    let refVal: string;
    let sessionType: string;

    if (kind === 'camp') {
      const { data: assignment, error: fetchErr } = await supabase
        .from('camp_assignments')
        .select(
          `id, instructor_id, organization_id, status, role, camp_session_id,
           camp_sessions ( id, starts_on, ends_on, session_type )`
        )
        .eq('id', assignmentId)
        .maybeSingle();
      if (fetchErr) {
        console.error('camp assignment lookup failed:', fetchErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!assignment) return FORBIDDEN;
      if (assignment.instructor_id !== me.id) return FORBIDDEN;
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
      orgId = assignment.organization_id;
      role = assignment.role;
      refCol = 'camp_session_id';
      refVal = session.id;
      sessionType = session.session_type;
    } else {
      const { data: assignment, error: fetchErr } = await supabase
        .from('program_assignments')
        .select('id, instructor_id, organization_id, status, role, program_id')
        .eq('id', assignmentId)
        .maybeSingle();
      if (fetchErr) {
        console.error('program assignment lookup failed:', fetchErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      if (!assignment) return FORBIDDEN;
      if (assignment.instructor_id !== me.id) return FORBIDDEN;
      if (assignment.status !== 'confirmed') {
        return json({ error: 'assignment_not_confirmed', status: assignment.status }, 409);
      }
      // Programs have no starts_on/ends_on range — the valid set is the derived
      // session schedule (weekly cadence minus closures). Validate the date is a
      // real 'session' entry, so a raw-API caller can't confirm an arbitrary day.
      const { data: schedule, error: schedErr } = await supabase.rpc(
        'derive_program_session_schedule',
        { p_program_id: assignment.program_id },
      );
      if (schedErr) {
        console.error('program schedule derive failed:', schedErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      const isRealSession = (schedule ?? []).some(
        (r: { entry_date?: string; kind?: string }) =>
          r.kind === 'session' && r.entry_date === sessionDate,
      );
      if (!isRealSession) {
        return json({ error: 'session_date_out_of_range' }, 400);
      }
      orgId = assignment.organization_id;
      role = assignment.role;
      refCol = 'program_id';
      refVal = assignment.program_id;
      // Programs don't carry a session_type; after-school is always after_school
      // (mirrors confirm-sub-delivery). resolvePayAmount + the CHECK both accept it.
      sessionType = 'after_school';
    }

    // session_date must be today or earlier (no marking future sessions taught).
    // "Today" is UTC here; org-timezone awareness is a v2 nice-to-have.
    const today = new Date().toISOString().slice(0, 10);
    if (sessionDate > today) {
      return json({ error: 'session_date_in_future' }, 400);
    }

    // Idempotency: do we already have a confirmation for this trio?
    const { data: existing, error: existsErr } = await supabase
      .from('session_delivery_confirmations')
      .select('id, confirmed_by, confirmed_at, pay_status, pay_amount_cents, pay_adjustment_cents')
      .eq('instructor_id', me.id)
      .eq(refCol, refVal)
      .eq('session_date', sessionDate)
      .maybeSingle();
    if (existsErr) {
      console.error('confirmation lookup failed:', existsErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    // A genuinely-confirmed row (self / admin / sub) is idempotent — return it.
    // A cron-seeded PLACEHOLDER (confirmed_by='pending') is NOT a real check-in;
    // fall through and PROMOTE it to a self-confirm below.
    if (existing && existing.confirmed_by !== 'pending') {
      return json({
        confirmation: existing,
        already_confirmed: true,
      });
    }

    // Substitution guard: if a sub was confirmed to cover THIS assignment on THIS
    // date, the assigned instructor must not self-confirm it — the sub is the
    // payee. Keyed to the assignment + date, matching assignment_substitutions.
    const { data: cover } = await supabase
      .from('assignment_substitutions')
      .select('id')
      .eq('parent_assignment_id', assignmentId)
      .eq('parent_assignment_type', kind)
      .eq('date', sessionDate)
      .in('status', ['confirmed', 'taught'])
      .maybeSingle();
    if (cover) {
      return json({ error: 'session_covered_by_substitute' }, 409);
    }

    // Pay computation: per-tenant rate from tenant_pay_rates, keyed by the
    // assignment role + session_type. Null when unconfigured — the admin sets it
    // on Payroll; the check-in is still recorded.
    const payAmountCents = await resolvePayAmount(
      supabase,
      orgId,
      role,
      sessionType,
    );

    const nowIso = new Date().toISOString();
    const RETURN_COLS =
      'id, confirmed_by, confirmed_at, pay_status, pay_amount_cents, pay_adjustment_cents';

    // Promote a pending placeholder row to a self-confirm. Race-guarded on
    // confirmed_by='pending' so a concurrent admin/sub confirm isn't clobbered —
    // if we lose the race we return the current row rather than an error.
    const promotePlaceholder = async (rowId: string) => {
      const { data: promoted, error: updErr } = await supabase
        .from('session_delivery_confirmations')
        .update({
          confirmed_by: 'self',
          confirmed_at: nowIso,
          pay_status: 'approved',
          pay_amount_cents: payAmountCents,
          updated_at: nowIso,
        })
        .eq('id', rowId)
        .eq('confirmed_by', 'pending')
        .select(RETURN_COLS)
        .maybeSingle();
      if (updErr) throw updErr;
      if (promoted) return { confirmation: promoted, already_confirmed: false };
      const { data: current } = await supabase
        .from('session_delivery_confirmations')
        .select(RETURN_COLS)
        .eq('id', rowId)
        .maybeSingle();
      return { confirmation: current, already_confirmed: true };
    };

    // Existing placeholder → promote it in place.
    if (existing) {
      try {
        return json(await promotePlaceholder(existing.id));
      } catch (e) {
        console.error('confirmation promote failed:', e);
        return json({ error: 'update_failed', detail: (e as Error).message }, 500);
      }
    }

    // No row yet — insert a fresh self-confirm. Exactly one of camp_session_id /
    // program_id is set (the CHECK one_session_reference enforces XOR).
    const insertRow: Record<string, unknown> = {
      instructor_id: me.id,
      organization_id: orgId,
      session_date: sessionDate,
      session_type: sessionType,
      confirmed_by: 'self',
      confirmed_at: nowIso,
      pay_status: 'approved',
      pay_amount_cents: payAmountCents,
    };
    insertRow[refCol] = refVal;

    const { data: inserted, error: insErr } = await supabase
      .from('session_delivery_confirmations')
      .insert(insertRow)
      .select(RETURN_COLS)
      .single();
    if (insErr) {
      // 23505 = unique_violation: the row was seeded between our check and insert.
      // Re-read and promote instead of 500-ing on a legitimate first click.
      if ((insErr as { code?: string }).code === '23505') {
        const { data: raced } = await supabase
          .from('session_delivery_confirmations')
          .select(RETURN_COLS)
          .eq('instructor_id', me.id)
          .eq(refCol, refVal)
          .eq('session_date', sessionDate)
          .maybeSingle();
        if (raced && raced.confirmed_by !== 'pending') {
          return json({ confirmation: raced, already_confirmed: true });
        }
        if (raced) {
          try {
            return json(await promotePlaceholder(raced.id));
          } catch (e) {
            console.error('confirmation promote-after-conflict failed:', e);
            return json({ error: 'update_failed', detail: (e as Error).message }, 500);
          }
        }
      }
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
