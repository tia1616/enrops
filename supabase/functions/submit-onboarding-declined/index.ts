// submit-onboarding-declined — wizard's "I don't qualify" path.
//
// Called from Screen 3 (ORS) after the contractor confirms they don't meet
// 3 of 5 criteria. Sets overall_status = 'declined' (sync trigger updates
// instructors.onboarding_status) and emails the org's alert_email.
//
// IMPORTANT: this function does NOT use the terminal-state guard from
// resolveInstructor — it would 410 itself, since it's about to set the very
// status the guard checks for. Use { checkTerminalStatus: false }.
//
// Idempotency: if called twice (double-click, network retry), the second
// call sees overall_status already === 'declined' and exits early without
// sending a second email.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import {
  corsHeaders,
  json,
  resolveInstructor,
  adminClient,
} from '../_shared/instructor.ts';

interface SubmitDeclineBody {
  reason?: string;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // Bypass the terminal-state guard — we're SETTING the status, not reacting to it.
    // Still require is_active = true (deactivated instructors shouldn't be able
    // to flip status either way).
    const { instructor, error } = await resolveInstructor(req, { checkTerminalStatus: false });
    if (error) return error;
    const me = instructor!;

    let body: SubmitDeclineBody;
    try {
      body = (await req.json()) as SubmitDeclineBody;
    } catch {
      body = {};
    }

    const reason = body.reason?.trim().slice(0, 500) ?? 'unspecified';

    const supabase = adminClient();

    // Idempotency check: if already declined, skip the email.
    if (me.onboarding?.overall_status === 'declined') {
      return json({ success: true, already_declined: true });
    }

    // Flip status. The trigger trg_sync_onboarding_status will mirror this
    // into instructors.onboarding_status automatically.
    const nowIso = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('contractor_onboarding_status')
      .update({
        overall_status: 'declined',
        completed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('instructor_id', me.id);

    if (updateErr) {
      console.error('decline update failed:', updateErr);
      return json({ error: 'update_failed' }, 500);
    }

    // Email the org's alert_email.
    const { data: org } = await supabase
      .from('organizations')
      .select('name, alert_email, default_sender_name, default_sender_email')
      .eq('id', me.organization_id)
      .maybeSingle();

    if (org?.alert_email && org.default_sender_email) {
      await sendAdminEmail({
        to: org.alert_email,
        fromName: org.default_sender_name ?? org.name ?? 'enrops',
        fromEmail: org.default_sender_email,
        instructorName: `${me.first_name ?? ''} ${me.last_name ?? ''}`.trim() || me.email,
        instructorEmail: me.email,
        reason,
      });
    } else {
      console.warn('cannot send decline alert — org missing alert_email or sender', {
        org_id: me.organization_id,
      });
    }

    return json({ success: true });
  } catch (err) {
    console.error('submit-onboarding-declined fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

async function sendAdminEmail(args: {
  to: string;
  fromName: string;
  fromEmail: string;
  instructorName: string;
  instructorEmail: string;
  reason: string;
}): Promise<void> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    console.error('RESEND_API_KEY not set — cannot send decline alert');
    return;
  }

  const text = [
    `${args.instructorName} declined contractor onboarding.`,
    ``,
    `Email: ${args.instructorEmail}`,
    `Reason: ${args.reason}`,
    ``,
    `Their onboarding status has been set to 'declined'. They will see the declined-state page if they log back in.`,
  ].join('\n');

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${args.fromName} <${args.fromEmail}>`,
        to: args.to,
        subject: `Contractor declined onboarding: ${args.instructorName}`,
        text,
        tags: [{ name: 'type', value: 'contractor_declined' }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Resend decline-alert send failed:', resp.status, errText);
    }
  } catch (err) {
    console.error('decline-alert email exception:', err);
  }
}
