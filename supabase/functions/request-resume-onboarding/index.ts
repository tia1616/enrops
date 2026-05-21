// request-resume-onboarding — the "Request to resume" button on the
// abandoned-state page. Sends an email to the org admin so they can re-invite.
//
// Auth: verify_jwt: true. Bypass both is_active and terminal-status guards —
// the whole point is that an abandoned (and possibly deactivated) contractor
// wants to re-engage. Still require a matching instructors row to prevent
// random JWTs from spamming admins.
//
// Rate limit: one request per 24h, tracked via
// contractor_onboarding_status.resume_requested_at.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

interface RequestResumeBody {
  note?: string;
}

const RATE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24h

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // Bypass both guards: abandoned / deactivated instructors should reach this.
    const { instructor, error } = await resolveInstructor(req, {
      requireActive: false,
      checkTerminalStatus: false,
    });
    if (error) return error;
    const me = instructor!;

    let body: RequestResumeBody;
    try {
      body = (await req.json()) as RequestResumeBody;
    } catch {
      body = {};
    }
    const note = (body.note ?? '').trim().slice(0, 500);

    const supabase = adminClient();

    // Rate limit check: read resume_requested_at from the onboarding row.
    const { data: onboardingRow, error: onbErr } = await supabase
      .from('contractor_onboarding_status')
      .select('resume_requested_at')
      .eq('instructor_id', me.id)
      .maybeSingle();
    if (onbErr) {
      console.error('onboarding lookup failed:', onbErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    if (onboardingRow?.resume_requested_at) {
      const last = new Date(onboardingRow.resume_requested_at).getTime();
      const ageMs = Date.now() - last;
      if (ageMs < RATE_LIMIT_MS) {
        const retryAfter = new Date(last + RATE_LIMIT_MS).toISOString();
        return json(
          { error: 'already_requested_recently', retry_after: retryAfter },
          429,
        );
      }
    }

    // Look up org for sender + recipient
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('name, alert_email, default_sender_name, default_sender_email')
      .eq('id', me.organization_id)
      .maybeSingle();
    if (orgErr) {
      console.error('org lookup failed:', orgErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!org?.alert_email || !org.default_sender_email) {
      console.error('org missing alert_email or sender config:', me.organization_id);
      return json({ error: 'org_missing_admin_email' }, 500);
    }

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      console.error('RESEND_API_KEY not set');
      return json({ error: 'email_not_configured' }, 500);
    }

    const instructorName = `${me.first_name ?? ''} ${me.last_name ?? ''}`.trim() || me.email;
    const text = [
      `${instructorName} has requested to resume contractor onboarding.`,
      ``,
      `Name: ${instructorName}`,
      `Email: ${me.email}`,
      `Phone: ${me.phone ?? '(not provided)'}`,
      ``,
      `Note from contractor: ${note || '(none)'}`,
      ``,
      `Their current overall_status is '${me.onboarding?.overall_status ?? '(no onboarding row)'}'. Re-invite them from the admin panel if you want them to continue.`,
    ].join('\n');

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${org.default_sender_name ?? org.name ?? 'enrops'} <${org.default_sender_email}>`,
        to: org.alert_email,
        subject: `Resume request: ${instructorName}`,
        text,
        tags: [{ name: 'type', value: 'resume_request' }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend resume-request send failed:', resp.status, errText);
      return json({ error: 'email_send_failed' }, 502);
    }

    // Stamp resume_requested_at
    const nowIso = new Date().toISOString();
    if (onboardingRow) {
      await supabase
        .from('contractor_onboarding_status')
        .update({ resume_requested_at: nowIso, updated_at: nowIso })
        .eq('instructor_id', me.id);
    } else {
      // No onboarding row exists yet — create a minimal one to track the rate limit.
      await supabase.from('contractor_onboarding_status').insert({
        instructor_id: me.id,
        organization_id: me.organization_id,
        resume_requested_at: nowIso,
        overall_status: 'abandoned', // matches the state they came from
      });
    }

    return json({ success: true });
  } catch (err) {
    console.error('request-resume-onboarding fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});
