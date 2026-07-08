// send-afterschool-survey: opens the afterschool availability survey for a term
// and emails active instructors a link to fill it out.
//
// Input: { organization_id, term, mode: 'preview'|'test'|'send',
//          deadline?: string, instructor_ids?: string[], intro?: string }
//   - mode 'preview': returns rendered HTML for every (filtered) recipient, no DB writes, no sends
//   - mode 'test':    sends ONE rendered email to the logged-in caller; does NOT open the survey
//   - mode 'send':    sends to real instructor.email; upserts afterschool_survey_state
//                     so the portal banner unlocks for everyone in the org
//   - deadline:       optional ISO date. Surfaces in the email + portal banner.
//   - instructor_ids: optional subset of active instructors to target (straggler / new-hire
//                     nudge). Omitted/empty = all active instructors.
//   - intro:          optional editable lead paragraph. Omitted/blank = default copy.
//
// Mirrors send-availability-survey (camps), but afterschool is term-keyed, not
// cycle-keyed. Auth: caller must be owner/admin of the org.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, renderSignatureBlock } from '../_shared/orgBrand.ts';
import { introParagraphHtml } from '../_shared/surveyEmail.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
  const date = new Date(`${d.slice(0, 10)}T00:00:00`);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function termDisplayName(code: string | null): string {
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
    const organizationId: string | undefined = body.organization_id;
    const term: string | undefined = body.term;
    const mode: 'preview' | 'test' | 'send' = body.mode ?? 'preview';
    const deadline: string | null = body.deadline ?? null;
    const instructorIds: string[] | null = Array.isArray(body.instructor_ids) && body.instructor_ids.length > 0
      ? body.instructor_ids
      : null;
    const intro: string | null = typeof body.intro === 'string' && body.intro.trim() ? body.intro.trim() : null;

    if (!organizationId) return json({ error: 'organization_id is required' }, 400);
    if (!term) return json({ error: 'term is required' }, 400);
    if (!['preview', 'test', 'send'].includes(mode)) {
      return json({ error: `unknown mode "${mode}"` }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Auth: caller must be admin/owner of the org.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const { data: memberRow } = await supabase
      .from('org_members')
      .select('role, organization_id')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug')
      .eq('id', organizationId)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    const { data: brandingRow } = await supabase
      .from('org_branding')
      .select('primary_color, email_from_name, email_reply_to')
      .eq('organization_id', organizationId)
      .maybeSingle();
    const primaryColor = brandingRow?.primary_color ?? DEFAULT_PRIMARY;
    const fromName = brandingRow?.email_from_name ?? org.name;
    const replyTo = brandingRow?.email_reply_to ?? null;

    // Tenant email signature — loaded once per org (outside the recipient loop).
    const brand = await loadOrgBrand(supabase, organizationId);

    const { data: instructors, error: instErr } = await supabase
      .from('instructors')
      .select('id, first_name, last_name, email')
      .eq('organization_id', organizationId)
      .eq('is_active', true);
    if (instErr) return json({ error: `instructors query: ${instErr.message}` }, 500);

    // Optional subset (straggler / new-hire nudge). Filter to the requested ids,
    // then drop anyone without an email.
    const idSet = instructorIds ? new Set(instructorIds) : null;
    const recipients = (instructors ?? [])
      .filter((i: any) => !idSet || idSet.has(i.id))
      .filter((i: any) => !!i.email);
    if (recipients.length === 0) {
      return json({ sent: 0, failed: [], preview: [], note: 'No active instructors with email addresses for this selection.' });
    }

    // Test mode routes to the logged-in caller — never a hardcoded inbox (multi-tenant).
    const callerEmail = userData.user.email;
    if (mode === 'test' && !callerEmail) {
      return json({ error: 'Your account has no email address to send the test to.' }, 400);
    }

    const termDisplay = termDisplayName(term);
    if (!org.slug) throw new Error(`send-afterschool-survey: org ${org.id} has no slug; cannot build portal URL`);
    const portalUrl = `https://enrops.com/${org.slug}/instructor`;
    const deadlineLabel = fmtDeadline(deadline);

    const subject = `Tell ${org.name} which days you can teach this ${termDisplay} — ~2 minutes`;
    const previews: Array<{ instructor_id: string; to: string; subject: string; html: string; text: string }> = [];
    const sent: string[] = [];
    const failed: Array<{ instructor_id: string; reason: string }> = [];

    // Render one email per (filtered) recipient. `to` is who would actually receive
    // it on a real send — the honest preview address.
    for (const inst of recipients) {
      const html = renderHtml({ instructorName: inst.first_name, orgName: org.name, termDisplay, intro, portalUrl, deadlineLabel, primaryColor, signatureHtml: renderSignatureBlock(brand) });
      const text = renderText({ instructorName: inst.first_name, orgName: org.name, termDisplay, intro, portalUrl, deadlineLabel });
      previews.push({ instructor_id: inst.id, to: inst.email!, subject, html, text });
    }

    const fromDomain = 'updates.journeytosteam.com';
    const fromEmail = `${fromName} <hello@${fromDomain}>`;
    async function sendOne(to: string, subj: string, html: string, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({ from: fromEmail, to, reply_to: replyTo ?? undefined, subject: subj, html, text }),
        });
        if (!r.ok) return { ok: false, reason: `resend ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    }

    if (mode === 'test') {
      // One representative email to the caller — instructors are not contacted.
      const p = previews[0];
      const res = await sendOne(callerEmail!, `[TEST] ${subject}`, p.html, p.text);
      if (res.ok) sent.push(p.instructor_id);
      else failed.push({ instructor_id: p.instructor_id, reason: res.reason });
    } else if (mode === 'send') {
      for (const p of previews) {
        const res = await sendOne(p.to, subject, p.html, p.text);
        if (res.ok) sent.push(p.instructor_id);
        else failed.push({ instructor_id: p.instructor_id, reason: res.reason });
      }
    }

    // Real send: open the survey for the term so the portal banner unlocks.
    // Preserve the original opened_at on a straggler re-send (don't reset it). The
    // deadline is authoritative from the caller: the drawer pre-fills the existing
    // deadline, so whatever it sends is the operator's choice — including null,
    // which clears it. This keeps the email's "submit by" line and the stored
    // deadline in lockstep.
    if (mode === 'send') {
      const { data: existing } = await supabase
        .from('afterschool_survey_state')
        .select('opened_at')
        .eq('organization_id', organizationId)
        .eq('term', term)
        .maybeSingle();
      const { error: upErr } = await supabase
        .from('afterschool_survey_state')
        .upsert(
          {
            organization_id: organizationId,
            term,
            opened_at: existing?.opened_at ?? new Date().toISOString(),
            deadline: deadline ? deadline.slice(0, 10) : null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'organization_id,term' },
        );
      if (upErr) {
        return json({ sent: sent.length, failed, preview: [], note: `Emails sent but failed to open survey: ${upErr.message}` }, 500);
      }
    }

    return json({ sent: sent.length, failed, preview: mode === 'preview' ? previews : [], recipient_count: recipients.length });
  } catch (err) {
    return json({ error: (err as Error).message ?? 'unexpected error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// The editable lead paragraph. Blank/omitted falls back to the default copy.
function introHtml(intro: string | null, termDisplay: string): string {
  const text = intro ?? `We're planning the ${termDisplay} after-school schedule and want to know which days you can teach.`;
  return introParagraphHtml(text);
}

function renderHtml(params: {
  instructorName: string | null;
  orgName: string;
  termDisplay: string;
  intro: string | null;
  portalUrl: string;
  deadlineLabel: string;
  primaryColor: string;
  signatureHtml: string;
}): string {
  const { instructorName, orgName, termDisplay, intro, portalUrl, deadlineLabel, primaryColor, signatureHtml } = params;
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
      ${introHtml(intro, termDisplay)}
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">
      The survey takes about 2 minutes. You'll pick the weekdays you're free, the time window that works for you, any dates you can't make, and which schools you prefer.
    </p>
    <div style="margin:24px 0;text-align:center;">
      <a href="${portalUrl}" style="display:inline-block;background:${primaryColor};color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">
        Open availability survey
      </a>
    </div>
    ${deadlineLine}
    <p style="margin:24px 0 0;font-size:13px;color:${MUTED};line-height:1.5;border-top:1px solid ${BORDER};padding-top:16px;">
      You'll get to accept or request a change on each class before anything is final. If the button doesn't work, paste this link into your browser:<br/>
      <span style="color:${TEXT};word-break:break-all;">${portalUrl}</span>
    </p>
    ${signatureHtml || `<p style="margin:16px 0 0;font-size:13px;color:${MUTED};">
      Thanks,<br/>${orgName}
    </p>`}
  </div>
</body></html>`;
}

function renderText(params: {
  instructorName: string | null;
  orgName: string;
  termDisplay: string;
  intro: string | null;
  portalUrl: string;
  deadlineLabel: string;
}): string {
  const { instructorName, orgName, termDisplay, intro, portalUrl, deadlineLabel } = params;
  const hi = instructorName ? `Hi ${instructorName},` : 'Hi there,';
  const introText = intro ?? `We're planning the ${termDisplay} after-school schedule and want to know which days you can teach.`;
  const deadlineLine = deadlineLabel ? `\nPlease submit by ${deadlineLabel}.\n` : '';
  return `${hi}

${introText}

The survey takes about 2 minutes. You'll pick the weekdays you're free, the time window that works for you, any dates you can't make, and which schools you prefer.

Open the survey: ${portalUrl}
${deadlineLine}
You'll get to accept or request a change on each class before anything is final.

Thanks,
${orgName}
`;
}
