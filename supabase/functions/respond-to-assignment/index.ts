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
  action?: 'accept' | 'request_change';
  message?: string;
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

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

    const action = body.action;
    const assignmentId = body.camp_assignment_id?.trim();
    if (action !== 'accept' && action !== 'request_change') {
      return json({ error: 'invalid_action' }, 400);
    }
    if (!assignmentId) {
      return json({ error: 'camp_assignment_id_required' }, 400);
    }

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
      .from('camp_assignments')
      .select('id, instructor_id, status, published_at, organization_id, camp_session_id')
      .eq('id', assignmentId)
      .maybeSingle();
    if (fetchErr) {
      console.error('assignment lookup failed:', fetchErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    // Anti-enumeration: missing row + wrong instructor both 403, same body.
    if (!assignment) return FORBIDDEN;
    if (assignment.instructor_id !== me.id) return FORBIDDEN;

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
          camp_assignment_id: assignment.id,
          sender_role: 'instructor',
          sender_instructor_id: me.id,
          message,
        });
      if (msgErr) {
        console.error('message insert failed:', msgErr);
        return json({ error: 'message_insert_failed' }, 500);
      }

      // Step 2: update the assignment status. If THIS fails, we leave the
      // orphan message in place — admin-visible, instructor can retry.
      const { error: updErr } = await supabase
        .from('camp_assignments')
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
      .from('camp_assignments')
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
