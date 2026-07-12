// notify-instructor-removed — sends a warm "no longer on your schedule" email
// to an instructor whose camp assignment is being removed. Called from
// Schedule.jsx's RemoveInstructorNotifyModal AFTER the admin previews and
// edits the copy, but BEFORE the camp_assignments DELETE fires.
//
// Why a separate function: the assignment row is about to be deleted (the
// UNIQUE(session,role) constraint forces DELETE over UPDATE status='withdrawn').
// We need the email to fire while we still have the snapshot, so the modal
// passes the resolved subject + body in directly rather than re-querying.
//
// Input: {
//   instructor_id: uuid (target),
//   organization_id: uuid (must match instructor's org),
//   subject: string,
//   body_text: string,        // plain text email body, admin-edited
// }
//
// Auth: caller JWT must belong to org_members.role IN ('owner', 'admin') for
// the instructor's organization.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { encodeDisplayName } from '../_shared/orgBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

const FORBIDDEN = json({ error: 'forbidden' }, 403);

interface RequestBody {
  instructor_id?: string;
  organization_id?: string;
  subject?: string;
  body_text?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const instructorId = body.instructor_id?.trim();
    const orgId = body.organization_id?.trim();
    const subject = body.subject?.trim();
    const bodyText = body.body_text?.trim();
    if (!instructorId) return json({ error: 'instructor_id_required' }, 400);
    if (!orgId) return json({ error: 'organization_id_required' }, 400);
    if (!subject) return json({ error: 'subject_required' }, 400);
    if (!bodyText) return json({ error: 'body_text_required' }, 400);

    // Authorize caller as admin/owner in the org.
    const { data: orgMember, error: omErr } = await supabase
      .from('org_members')
      .select('organization_id')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (omErr) {
      console.error('org_members lookup failed:', omErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!orgMember) return FORBIDDEN;

    // Load instructor — must belong to the same org for tenant safety.
    const { data: instructor, error: instErr } = await supabase
      .from('instructors')
      .select('id, email, first_name, preferred_name, organization_id')
      .eq('id', instructorId)
      .maybeSingle();
    if (instErr) {
      console.error('instructor lookup failed:', instErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!instructor) return FORBIDDEN;
    if (instructor.organization_id !== orgId) return FORBIDDEN;
    if (!instructor.email) return json({ error: 'instructor_missing_email' }, 400);

    // Load org for sender identity.
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('name, default_sender_name, default_sender_email, alert_email')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr || !org?.default_sender_email) {
      return json({ error: 'org_sender_missing' }, 500);
    }

    const from = `${encodeDisplayName(org.default_sender_name ?? org.name ?? 'enrops')} <${org.default_sender_email}>`;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from,
        to: instructor.email,
        subject,
        text: bodyText,
        reply_to: org.alert_email ? [org.alert_email] : undefined,
        tags: [{ name: 'type', value: 'instructor_removed' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend removed-notice send failed:', resp.status, errText);
      return json({ error: 'email_send_failed' }, 500);
    }

    return json({ sent: true });
  } catch (err) {
    console.error('notify-instructor-removed fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
