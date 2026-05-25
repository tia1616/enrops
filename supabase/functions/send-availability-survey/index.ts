// send-availability-survey: opens the instructor-portal availability survey for
// a cycle and emails every active instructor a link to fill it out.
//
// Input: { cycle_id: string, mode: 'preview' | 'test' | 'send', deadline?: string }
//   - mode 'preview': returns rendered HTML for every recipient, no DB writes, no sends
//   - mode 'test':    sends each rendered email to TEST_INBOX (overrides instructor.email);
//                     does NOT flip scheduling_cycles.availability_survey_opened_at
//   - mode 'send':    sends to real instructor.email, flips opened_at + survey_deadline
//   - deadline:       optional ISO date or timestamptz. Surfaces in the email + portal banner.
//
// Multi-tenant: queries scoped by organization (inferred from cycle.organization_id).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TEST_INBOX = 'jessica@journeytosteam.com';
const DEFAULT_PRIMARY = '#1C004F';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function fmtDeadline(d: string | null): string {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function cycleDisplayName(code: string | null): string {
  if (!code) return '';
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const terms: Record<string, string> = { SU: 'Summer', FA: 'Fall', WI: 'Winter', SP: 'Spring' };
  return `${terms[m[1]]} 20${m[2]}`;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const cycleId: string | undefined = body.cycle_id;
    const mode: 'preview' | 'test' | 'send' = body.mode ?? 'preview';
    const deadline: string | null = body.deadline ?? null;

    if (!cycleId) return json({ error: 'cycle_id is required' }, 400);
    if (!['preview', 'test', 'send'].includes(mode)) {
      return json({ error: `unknown mode "${mode}"` }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Auth: caller must be admin/owner of the cycle's org.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const { data: cycle, error: cycleErr } = await supabase
      .from('scheduling_cycles')
      .select('id, name, cycle_type, starts_on, ends_on, organization_id, availability_survey_opened_at, survey_deadline')
      .eq('id', cycleId)
      .maybeSingle();
    if (cycleErr || !cycle) return json({ error: 'cycle not found' }, 404);

    const { data: memberRow } = await supabase
      .from('org_members')
      .select('role, organization_id')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', cycle.organization_id)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug')
      .eq('id', cycle.organization_id)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    const { data: brandingRow } = await supabase
      .from('org_branding')
      .select('primary_color, email_from_name, email_reply_to')
      .eq('organization_id', cycle.organization_id)
      .maybeSingle();
    const primaryColor = brandingRow?.primary_color ?? DEFAULT_PRIMARY;
    const fromName = brandingRow?.email_from_name ?? org.name;
    const replyTo = brandingRow?.email_reply_to ?? null;

    // Recipients: all active instructors for this org. Skip rows without an email.
    const { data: instructors, error: instErr } = await supabase
      .from('instructors')
      .select('id, first_name, last_name, email')
      .eq('organization_id', cycle.organization_id)
      .eq('is_active', true);
    if (instErr) return json({ error: `instructors query: ${instErr.message}` }, 500);

    const recipients = (instructors ?? []).filter((i: any) => !!i.email);
    if (recipients.length === 0) {
      return json({ sent: 0, failed: [], preview: [], note: 'No active instructors with email addresses for this org.' });
    }

    const cycleDisplay = cycleDisplayName(cycle.name);
    const portalUrl = `https://enrops.com/${org.slug ?? 'j2s'}/instructor`;
    const effectiveDeadline = deadline ?? cycle.survey_deadline ?? null;
    const deadlineLabel = fmtDeadline(effectiveDeadline);

    const previews: Array<{ instructor_id: string; to: string; subject: string; html: string; text: string }> = [];
    const sent: string[] = [];
    const failed: Array<{ instructor_id: string; reason: string }> = [];

    for (const inst of recipients) {
      const subject = `Tell ${org.name} when you can work this ${cycleDisplay} — ~2 minutes`;
      const html = renderHtml({
        instructorName: inst.first_name,
        orgName: org.name,
        cycleDisplay,
        portalUrl,
        deadlineLabel,
        primaryColor,
      });
      const text = renderText({
        instructorName: inst.first_name,
        orgName: org.name,
        cycleDisplay,
        portalUrl,
        deadlineLabel,
      });
      const recipient = mode === 'send' ? inst.email! : TEST_INBOX;
      previews.push({ instructor_id: inst.id, to: recipient, subject, html, text });

      if (mode === 'preview') continue;

      try {
        const fromDomain = 'updates.journeytosteam.com';
        const fromEmail = `${fromName} <hello@${fromDomain}>`;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: fromEmail,
            to: recipient,
            reply_to: replyTo ?? undefined,
            subject: mode === 'test' ? `[TEST] ${subject}` : subject,
            html,
            text,
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          failed.push({ instructor_id: inst.id, reason: `resend ${r.status}: ${errText.slice(0, 200)}` });
          continue;
        }
        sent.push(inst.id);
      } catch (err) {
        failed.push({ instructor_id: inst.id, reason: (err as Error).message });
      }
    }

    // Real send: flip the cycle row so the portal banner unlocks for everyone.
    // Test mode does not flip — admins can re-test as many times as they want.
    if (mode === 'send') {
      const updatePayload: Record<string, any> = {};
      if (!cycle.availability_survey_opened_at) {
        updatePayload.availability_survey_opened_at = new Date().toISOString();
      }
      if (deadline) updatePayload.survey_deadline = deadline;
      if (Object.keys(updatePayload).length > 0) {
        const { error: upErr } = await supabase
          .from('scheduling_cycles')
          .update(updatePayload)
          .eq('id', cycle.id);
        if (upErr) {
          return json({ sent: sent.length, failed, preview: [], note: `Emails sent but failed to flip opened_at: ${upErr.message}` }, 500);
        }
      }
    }

    return json({
      sent: sent.length,
      failed,
      preview: mode === 'preview' ? previews : [],
      recipient_count: recipients.length,
    });
  } catch (err) {
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function renderHtml(params: {
  instructorName: string | null;
  orgName: string;
  cycleDisplay: string;
  portalUrl: string;
  deadlineLabel: string;
  primaryColor: string;
}): string {
  const { instructorName, orgName, cycleDisplay, portalUrl, deadlineLabel, primaryColor } = params;
  const hi = instructorName ? `Hi ${instructorName}` : 'Hi there';
  const deadlineLine = deadlineLabel
    ? `<p style="margin: 16px 0 0; font-size: 14px; color: ${TEXT};"><strong>Please submit by ${deadlineLabel}.</strong></p>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8" /></head>
<body style="margin:0;padding:24px;background:#f5f4ec;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid ${BORDER};border-radius:10px;padding:28px;">
    <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:${primaryColor};letter-spacing:-0.3px;">${hi},</h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.55;">
      We're planning the ${cycleDisplay} schedule and want to know when and where you'd like to work.
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">
      The survey takes about 2 minutes. You'll set which weeks you're available, your preferred locations and subjects, and whether you want to lead a camp or support one as a developing instructor.
    </p>
    <div style="margin:24px 0;text-align:center;">
      <a href="${portalUrl}" style="display:inline-block;background:${primaryColor};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">
        Open availability survey
      </a>
    </div>
    ${deadlineLine}
    <p style="margin:24px 0 0;font-size:13px;color:${MUTED};line-height:1.5;border-top:1px solid ${BORDER};padding-top:16px;">
      You'll get to accept or request a change on each camp before anything is final. If the button doesn't work, paste this link into your browser:<br/>
      <span style="color:${TEXT};word-break:break-all;">${portalUrl}</span>
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:${MUTED};">
      Thanks,<br/>${orgName}
    </p>
  </div>
</body></html>`;
}

function renderText(params: {
  instructorName: string | null;
  orgName: string;
  cycleDisplay: string;
  portalUrl: string;
  deadlineLabel: string;
}): string {
  const { instructorName, orgName, cycleDisplay, portalUrl, deadlineLabel } = params;
  const hi = instructorName ? `Hi ${instructorName},` : 'Hi there,';
  const deadlineLine = deadlineLabel ? `\nPlease submit by ${deadlineLabel}.\n` : '';
  return `${hi}

We're planning the ${cycleDisplay} schedule and want to know when and where you'd like to work.

The survey takes about 2 minutes. You'll set which weeks you're available, your preferred locations and subjects, and whether you want to lead a camp or support one as a developing instructor.

Open the survey: ${portalUrl}
${deadlineLine}
You'll get to accept or request a change on each camp before anything is final.

Thanks,
${orgName}
`;
}
