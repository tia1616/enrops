// confirm-sub-delivery — sub marks their accepted sub day as taught.
//
// PR 3.5 Option A: the session_delivery_confirmations.instructor_id stays
// the REGULAR (originally scheduled) instructor — it preserves the meaning
// of "originally scheduled" forever. We set confirmed_by='sub' and compute
// pay from assignment_substitutions.sub_tier so the sub gets paid for their
// own tier, not the regular instructor's role.
//
// Input: { substitution_id: string }
//
// Algorithm:
//   1. Verify caller is the sub on the row (anti-enumeration: 403).
//   2. Verify substitution.status === 'confirmed' (must accept before
//      mark-taught).
//   3. Verify substitution.date <= today.
//   4. Look up parent assignment to get (camp_session_id | program_id),
//      regular_instructor_id, organization_id.
//   5. Look up session_type from camp_sessions or programs (program.session_type
//      defaults to 'after_school').
//   6. UPSERT session_delivery_confirmations for
//      (regular_instructor_id, target_id, date):
//        - confirmed_by = 'sub'
//        - pay_status   = 'approved'
//        - pay_amount_cents = PAY[sub_tier][session_type]
//   7. Update assignment_substitutions.status = 'taught'.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

type Tier = 'lead' | 'developing';
type SessionType = 'morning' | 'afternoon' | 'full_day' | 'after_school';

// Mirrors confirm-session-delivery PAY table.
const PAY: Record<Tier, Record<SessionType, number>> = {
  lead:       { morning: 8000, afternoon: 8000, full_day: 16000, after_school: 6000 },
  developing: { morning: 6500, afternoon: 6500, full_day: 13000, after_school: 5000 },
};

interface Body {
  substitution_id?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: Body;
    try { body = (await req.json()) as Body; } catch { return json({ error: 'invalid_body' }, 400); }
    const substitutionId = (body.substitution_id || '').trim();
    if (!substitutionId) return json({ error: 'missing_substitution_id' }, 400);

    const supabase = adminClient();

    const { data: subRow, error: rowErr } = await supabase
      .from('assignment_substitutions')
      .select('id, sub_instructor_id, status, sub_tier, date, parent_assignment_id, parent_assignment_type, organization_id')
      .eq('id', substitutionId)
      .maybeSingle();
    if (rowErr) {
      console.error('[confirm-sub-delivery] lookup failed:', rowErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!subRow || subRow.sub_instructor_id !== me.id) return json({ error: 'forbidden' }, 403);
    if (subRow.status !== 'confirmed') {
      return json({ error: 'not_confirmed', current_status: subRow.status }, 400);
    }

    const today = new Date().toISOString().slice(0, 10);
    if (subRow.date > today) return json({ error: 'future_session', session_date: subRow.date }, 400);

    // Resolve parent + session metadata.
    let regularInstructorId: string | null = null;
    let campSessionId: string | null = null;
    let programId: string | null = null;
    let sessionType: SessionType | null = null;

    if (subRow.parent_assignment_type === 'camp') {
      const { data: parent } = await supabase
        .from('camp_assignments')
        .select('instructor_id, camp_session_id')
        .eq('id', subRow.parent_assignment_id)
        .maybeSingle();
      if (!parent) return json({ error: 'parent_not_found' }, 404);
      regularInstructorId = parent.instructor_id;
      campSessionId = parent.camp_session_id;
      const { data: sess } = await supabase
        .from('camp_sessions')
        .select('session_type')
        .eq('id', parent.camp_session_id)
        .maybeSingle();
      sessionType = (sess?.session_type as SessionType) ?? null;
    } else if (subRow.parent_assignment_type === 'program') {
      const { data: parent } = await supabase
        .from('program_assignments')
        .select('instructor_id, program_id')
        .eq('id', subRow.parent_assignment_id)
        .maybeSingle();
      if (!parent) return json({ error: 'parent_not_found' }, 404);
      regularInstructorId = parent.instructor_id;
      programId = parent.program_id;
      // Programs don't carry session_type — afterschool is always after_school.
      sessionType = 'after_school';
    } else {
      return json({ error: 'invalid_parent_assignment_type' }, 400);
    }

    if (!sessionType || !(sessionType in PAY.lead)) {
      return json({ error: 'no_pay_rate_for_session', session_type: sessionType }, 400);
    }
    const subTier = subRow.sub_tier as Tier;
    if (subTier !== 'lead' && subTier !== 'developing') {
      return json({ error: 'invalid_sub_tier', sub_tier: subTier }, 400);
    }
    const payCents = PAY[subTier][sessionType];

    // Look up existing confirmation row.
    let existingQuery = supabase
      .from('session_delivery_confirmations')
      .select('id, confirmed_by')
      .eq('instructor_id', regularInstructorId!)
      .eq('session_date', subRow.date);
    existingQuery = campSessionId
      ? existingQuery.eq('camp_session_id', campSessionId)
      : existingQuery.eq('program_id', programId!);
    const { data: existing, error: exErr } = await existingQuery.maybeSingle();
    if (exErr) {
      console.error('[confirm-sub-delivery] existing lookup failed:', exErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const nowIso = new Date().toISOString();

    if (existing) {
      if (existing.confirmed_by === 'sub') {
        // Idempotent retry — already done.
      } else if (existing.confirmed_by === 'self' || existing.confirmed_by === 'admin') {
        return json({ error: 'already_confirmed_by_other', confirmed_by: existing.confirmed_by }, 409);
      } else {
        // pending row from a daily-confirmation-cron precreation — promote it.
        const { error: updErr } = await supabase
          .from('session_delivery_confirmations')
          .update({
            confirmed_by: 'sub',
            confirmed_at: nowIso,
            pay_status: 'approved',
            pay_amount_cents: payCents,
            updated_at: nowIso,
          })
          .eq('id', existing.id);
        if (updErr) {
          console.error('[confirm-sub-delivery] confirmation update failed:', updErr);
          return json({ error: 'update_failed', detail: updErr.message }, 500);
        }
      }
    } else {
      const { error: insErr } = await supabase
        .from('session_delivery_confirmations')
        .insert({
          instructor_id: regularInstructorId,
          organization_id: subRow.organization_id,
          camp_session_id: campSessionId,
          program_id: programId,
          session_date: subRow.date,
          session_type: sessionType,
          confirmed_by: 'sub',
          confirmed_at: nowIso,
          pay_status: 'approved',
          pay_amount_cents: payCents,
        });
      if (insErr) {
        console.error('[confirm-sub-delivery] insert failed:', insErr);
        return json({ error: 'insert_failed', detail: insErr.message }, 500);
      }
    }

    // Flip substitution to taught.
    const { error: subUpdErr } = await supabase
      .from('assignment_substitutions')
      .update({ status: 'taught', updated_at: nowIso })
      .eq('id', substitutionId);
    if (subUpdErr) {
      console.error('[confirm-sub-delivery] substitution update failed:', subUpdErr);
      // Confirmation row already written — leave it; admin can reconcile.
    }

    return json({ ok: true, status: 'taught', pay_amount_cents: payCents });
  } catch (err) {
    console.error('[confirm-sub-delivery] fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});
