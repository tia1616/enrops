// respond-to-assignment — instructor accept / request-change endpoint.
//
// Instructor Portal v1, Chunk B. Sole instructor write path to
// camp_assignments after the direct UPDATE RLS policy gets dropped in
// Chunk F. Statuses reachable through this function: 'confirmed',
// 'change_requested' only. Never 'withdrawn' / 'declined' / 'proposed'.
//
// Body: { camp_assignment_id: string, action: 'accept' | 'request_change', message?: string }
//
// Critical ordering for request_change (see §4.3 step 7 of the spec):
// insert into instructor_offer_messages FIRST, then update camp_assignments.
// A status flip with no message is unacceptable; an orphan message after a
// failed status update is acceptable (admin-visible, instructor retries).
//
// Anti-enumeration: no row + wrong instructor both return identical 403.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

interface RequestBody {
  camp_assignment_id?: string;
  program_assignment_id?: string;
  action?: 'accept' | 'request_change';
  message?: string;
  // Admin-impersonation: when an org owner/admin acts from an instructor's
  // portal (?as=), this is the instructor they're acting for. Authorized via
  // org_members, not the JWT being that instructor.
  acting_instructor_id?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const action = body.action;
    if (action !== 'accept' && action !== 'request_change') {
      return json({ error: 'invalid_action' }, 400);
    }
    // Polymorphic: a camp assignment OR an after-school program assignment.
    const campId = body.camp_assignment_id?.trim();
    const programId = body.program_assignment_id?.trim();
    if (!campId && !programId) {
      return json({ error: 'assignment_id_required' }, 400);
    }
    const isProgram = !!programId;
    const table = isProgram ? 'program_assignments' : 'camp_assignments';
    const fkCol = isProgram ? 'program_assignment_id' : 'camp_assignment_id';
    const sessionCol = isProgram ? 'program_id' : 'camp_session_id';
    const assignmentId = (isProgram ? programId : campId)!;

    let message: string | null = null;
    if (action === 'request_change') {
      const raw = typeof body.message === 'string' ? body.message.trim() : '';
      if (!raw) return json({ error: 'message_required' }, 400);
      message = raw.length > 1000 ? raw.slice(0, 1000) : raw;
    }

    const supabase = adminClient();

    // Fetch the assignment (service role bypasses RLS — we authorize via
    // instructor.id comparison below).
    const { data: assignment, error: fetchErr } = await supabase
      .from(table)
      .select(`id, instructor_id, status, published_at, organization_id, ${sessionCol}`)
      .eq('id', assignmentId)
      .maybeSingle();
    if (fetchErr) {
      console.error('assignment lookup failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Anti-enumeration: missing row + wrong instructor both 403, same body.
    if (!assignment) return FORBIDDEN;

    // Resolve who is acting. Normal path: the JWT must BE the instructor.
    // Impersonation path: an org owner/admin (per org_members) acts for the
    // assignment's instructor, passed as acting_instructor_id.
    const actingId = typeof body.acting_instructor_id === 'string' ? body.acting_instructor_id.trim() : '';
    let actorInstructorId: string;
    if (actingId) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json({ error: 'auth_required' }, 401);
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const { data: userData, error: userErr } = await supabase.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
      const { data: member } = await supabase
        .from('org_members').select('role')
        .eq('auth_user_id', userData.user.id)
        .eq('organization_id', assignment.organization_id)
        .maybeSingle();
      if (!member || !['owner', 'admin'].includes(member.role)) return FORBIDDEN;
      const { data: actInst } = await supabase
        .from('instructors').select('id, organization_id').eq('id', actingId).maybeSingle();
      if (!actInst || actInst.organization_id !== assignment.organization_id) return FORBIDDEN;
      actorInstructorId = actingId;
    } else {
      const { instructor, error } = await resolveInstructor(req);
      if (error) return error;
      actorInstructorId = instructor!.id;
    }

    if (assignment.instructor_id !== actorInstructorId) return FORBIDDEN;

    if (!assignment.published_at) {
      return json({ error: 'not_published' }, 400);
    }

    const status = assignment.status as string;
    if (status === 'confirmed') {
      return json({ error: 'already_confirmed' }, 400);
    }
    if (status === 'withdrawn' || status === 'declined' || status === 'proposed') {
      return json({ error: 'assignment_closed' }, 400);
    }
    if (status !== 'published' && status !== 'change_requested') {
      // Defensive — any other unexpected state is treated as closed.
      return json({ error: 'assignment_closed' }, 400);
    }

    const nowIso = new Date().toISOString();

    if (action === 'request_change') {
      // Step 1: insert the message FIRST. If this fails, status stays put.
      const { error: msgErr } = await supabase
        .from('instructor_offer_messages')
        .insert({
          organization_id: assignment.organization_id,
          [fkCol]: assignment.id,
          sender_role: 'instructor',
          sender_instructor_id: actorInstructorId,
          message,
        });
      if (msgErr) {
        console.error('message insert failed:', msgErr);
        return json({ error: 'message_insert_failed' }, 500);
      }

      // Step 2: update the assignment status. If THIS fails, we leave the
      // orphan message in place — admin-visible, instructor can retry.
      const { error: updErr } = await supabase
        .from(table)
        .update({
          status: 'change_requested',
          change_request_message: message,
          instructor_response_at: nowIso,
        })
        .eq('id', assignment.id);
      if (updErr) {
        console.error('status update failed (request_change):', updErr);
        return json({ error: 'status_update_failed' }, 500);
      }

      return json({ success: true, status: 'change_requested' });
    }

    // action === 'accept' — single statement, no message row.
    const { error: updErr } = await supabase
      .from(table)
      .update({
        status: 'confirmed',
        instructor_response_at: nowIso,
      })
      .eq('id', assignment.id);
    if (updErr) {
      console.error('status update failed (accept):', updErr);
      return json({ error: 'status_update_failed' }, 500);
    }

    return json({ success: true, status: 'confirmed' });
  } catch (err) {
    console.error('respond-to-assignment fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
