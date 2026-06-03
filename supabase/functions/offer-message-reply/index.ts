// offer-message-reply: admin replies to an instructor's change-request message.
// Sends a branded email via Resend AND inserts a row in
// instructor_offer_messages so the thread is preserved in-product.
//
// Input: { camp_assignment_id: string, message: string }
// Auth: admin/owner of the assignment's org (verified via JWT).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEFAULT_PRIMARY = '#1C004F';
const DEFAULT_PAGE_BG = '#FBFBFB';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function escape(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { camp_assignment_id, message } = await req.json();
    if (!camp_assignment_id) return json({ error: 'camp_assignment_id required' }, 400);
    if (!message || !message.trim()) return json({ error: 'message required' }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const { data: assignment, error: aErr } = await supabase
      .from('camp_assignments')
      .select('id, organization_id, camp_session_id, instructor_id, change_request_message, status')
      .eq('id', camp_assignment_id)
      .maybeSingle();
    if (aErr || !assignment) return json({ error: 'assignment not found' }, 404);

    const { data: memberRow } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', assignment.organization_id)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    const { data: instructor } = await supabase
      .from('instructors')
      .select('first_name, last_name, email')
      .eq('id', assignment.instructor_id)
      .maybeSingle();
    if (!instructor?.email) return json({ error: 'instructor has no email' }, 400);

    const { data: session } = await supabase
      .from('camp_sessions')
      .select('location_name, week_num, session_type, curriculum_name, cycle_id')
      .eq('id', assignment.camp_session_id)
      .maybeSingle();

    const { data: org } = await supabase
      .from('organizations')
      .select('name, slug')
      .eq('id', assignment.organization_id)
      .maybeSingle();

    const { data: brandingRow } = await supabase
      .from('org_branding')
      .select('primary_color, email_from_name, email_reply_to')
      .eq('organization_id', assignment.organization_id)
      .maybeSingle();

    const primary = brandingRow?.primary_color ?? DEFAULT_PRIMARY;
    const fromName = brandingRow?.email_from_name ?? org?.name ?? 'Enrops';
    const fromEmail = `${fromName} <hello@updates.journeytosteam.com>`;
    const replyTo = brandingRow?.email_reply_to ?? undefined;

    const adminFirstName = userData.user.user_metadata?.full_name?.split(' ')[0] ?? 'your admin';
    const cycleName = session?.cycle_id ? '' : '';
    if (!org?.slug) throw new Error(`offer-message-reply: org ${org?.id ?? 'null'} has no slug; cannot build portal URL`);
    if (!org?.name) throw new Error(`offer-message-reply: org ${org?.id ?? 'null'} has no name; cannot build subject line`);
    const portalUrl = `https://enrops.com/${org.slug}/instructor`;
    const subject = `Re: Your ${session?.curriculum_name ?? 'schedule'} — ${org.name}`;

    const html = `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${DEFAULT_PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${DEFAULT_PAGE_BG};padding:32px 16px;"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;">
<tr><td style="padding:28px 32px 8px;">
<div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(org?.name ?? '')}</div>
<h1 style="margin:6px 0 0;font-size:20px;color:${TEXT};font-weight:700;">A message about your ${escape(session?.curriculum_name ?? 'schedule')}</h1>
${session ? `<div style="font-size:13px;color:${MUTED};margin-top:4px;">Week ${session.week_num} · ${escape(session.location_name ?? '')}</div>` : ''}
</td></tr>
<tr><td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">
Hi ${escape(instructor.first_name ?? 'there')},<br /><br />
${escape(message).replace(/\n/g, '<br />')}
</td></tr>
${assignment.change_request_message ? `<tr><td style="padding:14px 32px 0;font-size:12px;color:${MUTED};">
<div style="padding:10px;background:#f7f5f0;border-left:3px solid ${primary};border-radius:4px;font-style:italic;">
<strong>Your earlier message:</strong><br />${escape(assignment.change_request_message)}
</div>
</td></tr>` : ''}
<tr><td style="padding:20px 32px 6px;">
<a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:14px;font-weight:600;">Open my schedule</a>
</td></tr>
<tr><td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">
Just reply to this email if you want to keep the conversation going.<br /><br />— ${escape(adminFirstName)}, ${escape(org?.name ?? '')}
</td></tr>
</table></td></tr></table></body></html>`;

    const text = [
      `Hi ${instructor.first_name ?? 'there'},`,
      '',
      message,
      '',
      assignment.change_request_message ? `Your earlier message: "${assignment.change_request_message}"` : '',
      '',
      `Open your schedule: ${portalUrl}`,
      '',
      `— ${adminFirstName}, ${org?.name ?? ''}`,
    ].filter(Boolean).join('\n');

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: fromEmail,
        to: instructor.email,
        reply_to: replyTo,
        subject,
        html,
        text,
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      return json({ error: `resend ${r.status}: ${errText.slice(0, 200)}` }, 500);
    }

    await supabase.from('instructor_offer_messages').insert({
      organization_id: assignment.organization_id,
      camp_assignment_id: assignment.id,
      sender_role: 'admin',
      message: message.trim(),
    });

    return json({ sent: true, to: instructor.email });
  } catch (err: any) {
    console.error('offer-message-reply fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});
