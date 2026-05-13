// send-offers: emails offer letters to instructors and flips their confirmed
// assignments to published. Test mode routes every send to a single inbox.
//
// Input: { cycle_id: string, instructor_ids: string[] | null, mode: 'preview' | 'test' | 'send' }
// - mode 'preview': returns rendered HTML + meta for every instructor in scope, no DB writes, no email sends
// - mode 'test':    sends each rendered email to TEST_INBOX (overrides instructor.email), still flips DB
// - mode 'send':    sends to real instructor.email, flips DB
//
// Multi-tenant: queries scoped by organization (inferred from cycle.organization_id).
// Branded copy/colors pulled from org_branding; sender domain from org config.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TEST_INBOX = 'jessica@journeytosteam.com';
const DEFAULT_PRIMARY = '#691D39';
const DEFAULT_PAGE_BG = '#EAEADD';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type AssignmentRow = {
  id: string;
  camp_session_id: string;
  instructor_id: string;
  role: string;
  status: string;
  distance_bonus_cents: number | null;
  deadline: string | null;
};

type SessionRow = {
  id: string;
  location_name: string | null;
  week_num: number | null;
  session_type: string | null;
  curriculum_name: string | null;
  starts_on: string | null;
  ends_on: string | null;
  start_time: string | null;
  end_time: string | null;
  class_days: string[] | null;
};

type InstructorRow = { id: string; first_name: string | null; last_name: string | null; email: string | null };

type Cycle = { id: string; name: string; cycle_type: string | null; starts_on: string | null; ends_on: string | null; organization_id: string };

type Org = { id: string; name: string; slug: string | null };

type Branding = { primary_color: string | null; email_from_name: string | null; email_reply_to: string | null };

function fmt(date: string | null) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function fmtTime(t: string | null) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? 'pm' : 'am';
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, '0')}${ampm}`;
}

function titleCase(s: string | null) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function unitLabel(cycleType: string | null, count: number) {
  const plural = count !== 1;
  if (cycleType === 'summer_camp') return plural ? 'camps' : 'camp';
  return plural ? 'classes' : 'class';
}

function cycleDisplayName(code: string | null): string {
  if (!code) return '';
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const terms: Record<string, string> = { SU: 'Summer', FA: 'Fall', WI: 'Winter', SP: 'Spring' };
  return `${terms[m[1]]} 20${m[2]}`;
}

function classDaysSummary(days: string[] | null) {
  if (!days || days.length === 0) return '';
  const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const short: Record<string, string> = {
    monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
  };
  if (days.length === 5 && order.slice(0, 5).every((d) => days.includes(d))) return 'Mon–Fri';
  const sorted = days.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return sorted.map((d) => short[d] ?? d).join(', ');
}

function dollars(cents: number | null | undefined) {
  if (!cents) return '';
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const cycleId: string | undefined = body.cycle_id;
    const instructorIdsInput: string[] | null | undefined = body.instructor_ids;
    const mode: 'preview' | 'test' | 'send' = body.mode ?? 'preview';
    const deadline: string | null = body.deadline ?? null; // YYYY-MM-DD

    if (!cycleId) return json({ error: 'cycle_id is required' }, 400);
    if (!['preview', 'test', 'send'].includes(mode)) return json({ error: `unknown mode "${mode}"` }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Auth: require the caller to be an org admin/owner for the cycle's org.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    const { data: cycle, error: cycleErr } = await supabase
      .from('scheduling_cycles')
      .select('id, name, cycle_type, starts_on, ends_on, organization_id')
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
    const branding: Branding = {
      primary_color: brandingRow?.primary_color ?? DEFAULT_PRIMARY,
      email_from_name: brandingRow?.email_from_name ?? org.name,
      email_reply_to: brandingRow?.email_reply_to ?? null,
    };

    // Preview mode shows confirmed AND published (admin inspecting email copy after a send).
    // Test/Real send only fires on 'confirmed' so we never re-mail published rows.
    const statusFilter = mode === 'preview' ? ['confirmed', 'published'] : ['confirmed'];
    let assignmentsQuery = supabase
      .from('camp_assignments')
      .select('id, camp_session_id, instructor_id, role, status, distance_bonus_cents, deadline')
      .in('status', statusFilter)
      .in('camp_session_id', (
        await supabase
          .from('camp_sessions')
          .select('id')
          .eq('cycle_id', cycleId)
      ).data?.map((r) => r.id) ?? []);
    if (instructorIdsInput && instructorIdsInput.length > 0) {
      assignmentsQuery = assignmentsQuery.in('instructor_id', instructorIdsInput);
    }
    const { data: assignmentsRaw, error: assignErr } = await assignmentsQuery;
    if (assignErr) return json({ error: `assignments query: ${assignErr.message}` }, 500);
    const assignments = (assignmentsRaw ?? []) as AssignmentRow[];
    if (assignments.length === 0) {
      const note = mode === 'preview'
        ? 'Nothing to preview — no confirmed or published assignments in this cycle. Click Approve to confirm some first.'
        : 'No confirmed assignments to send. Either Approve some first, or roll published rows back if you re-need to send them.';
      return json({ sent: 0, failed: [], preview: [], note });
    }

    const sessionIds = Array.from(new Set(assignments.map((a) => a.camp_session_id)));
    const instructorIds = Array.from(new Set(assignments.map((a) => a.instructor_id)));

    const { data: sessions } = await supabase
      .from('camp_sessions')
      .select('id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, start_time, end_time, class_days')
      .in('id', sessionIds);
    const sessionById = new Map<string, SessionRow>((sessions ?? []).map((s) => [s.id, s as SessionRow]));

    const { data: instructors } = await supabase
      .from('instructors')
      .select('id, first_name, last_name, email')
      .in('id', instructorIds);
    const instructorById = new Map<string, InstructorRow>((instructors ?? []).map((i) => [i.id, i as InstructorRow]));

    // Group assignments by instructor.
    const byInstructor = new Map<string, AssignmentRow[]>();
    for (const a of assignments) {
      if (!byInstructor.has(a.instructor_id)) byInstructor.set(a.instructor_id, []);
      byInstructor.get(a.instructor_id)!.push(a);
    }

    const previews: Array<{ instructor_id: string; to: string; subject: string; html: string; text: string }> = [];
    const sent: string[] = [];
    const failed: Array<{ instructor_id: string; reason: string }> = [];

    for (const [instructorId, theirAssignments] of byInstructor) {
      const instructor = instructorById.get(instructorId);
      if (!instructor || !instructor.email) {
        failed.push({ instructor_id: instructorId, reason: 'instructor missing email' });
        continue;
      }
      const camps = theirAssignments
        .map((a) => ({ a, s: sessionById.get(a.camp_session_id) }))
        .filter((row) => !!row.s)
        .sort((x, y) => (x.s!.starts_on ?? '').localeCompare(y.s!.starts_on ?? ''));

      const cycleDisplay = cycleDisplayName(cycle.name);
      const subject = `Your ${cycleDisplay} schedule is ready — please review`;
      const portalUrl = `https://enrops.com/${org.slug ?? 'j2s'}/instructor`;
      const html = renderHtml({ cycle, org, branding, instructor, camps, portalUrl, deadline });
      const text = renderText({ cycle, org, instructor, camps, portalUrl, deadline });
      const recipient = mode === 'send' ? instructor.email! : TEST_INBOX;

      previews.push({ instructor_id: instructorId, to: recipient, subject, html, text });

      if (mode === 'preview') continue;

      try {
        const fromName = branding.email_from_name ?? org.name;
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
            reply_to: branding.email_reply_to ?? undefined,
            subject: mode === 'test' ? `[TEST] ${subject}` : subject,
            html,
            text,
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          failed.push({ instructor_id: instructorId, reason: `resend ${r.status}: ${errText.slice(0, 200)}` });
          continue;
        }

        // Flip every assignment in this batch to published with timestamps.
        const ids = theirAssignments.map((a) => a.id);
        const updatePayload: Record<string, any> = {
          status: 'published',
          published_at: new Date().toISOString(),
          email_sent_at: new Date().toISOString(),
        };
        if (deadline) updatePayload.deadline = deadline;
        const { error: upErr } = await supabase
          .from('camp_assignments')
          .update(updatePayload)
          .in('id', ids);
        if (upErr) {
          failed.push({ instructor_id: instructorId, reason: `db update: ${upErr.message}` });
          continue;
        }

        sent.push(instructorId);
      } catch (err: any) {
        failed.push({ instructor_id: instructorId, reason: `unexpected: ${err.message ?? String(err)}` });
      }
    }

    return json({
      mode,
      sent: sent.length,
      failed,
      preview: mode === 'preview' ? previews : undefined,
    });
  } catch (err: any) {
    console.error('send-offers fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function renderHtml({ cycle, org, branding, instructor, camps, portalUrl, deadline }: {
  cycle: Cycle;
  org: Org;
  branding: Branding;
  instructor: InstructorRow;
  camps: Array<{ a: AssignmentRow; s: SessionRow | undefined }>;
  portalUrl: string;
  deadline: string | null;
}) {
  const primary = branding.primary_color ?? DEFAULT_PRIMARY;
  const firstName = instructor.first_name ?? 'there';
  const campCount = camps.length;
  const cycleRange = (cycle.starts_on && cycle.ends_on) ? `${fmt(cycle.starts_on)} – ${fmt(cycle.ends_on)}` : '';

  const campRows = camps.map(({ a, s }) => {
    if (!s) return '';
    const bonus = a.distance_bonus_cents ? `
      <div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">
        Includes a ${dollars(a.distance_bonus_cents)} distance bonus
      </div>
    ` : '';
    const role = a.role === 'developing' ? '<span style="font-size:11px;color:' + MUTED + ';text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-left:6px;">Developing</span>' : '';
    return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
          <div style="font-size:15px;font-weight:700;color:${TEXT};line-height:1.3;">
            ${escape(s.curriculum_name ?? 'Camp')}${role}
          </div>
          <div style="font-size:13px;color:${MUTED};margin-top:4px;line-height:1.4;">
            Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${classDaysSummary(s.class_days)}<br />
            ${escape(s.location_name ?? '')} · ${titleCase(s.session_type)} ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}
          </div>
          ${bonus}
        </td>
      </tr>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:${DEFAULT_PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${DEFAULT_PAGE_BG};padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;">
          <tr>
            <td style="padding:28px 32px 8px;">
              <div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(org.name)}</div>
              <h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;letter-spacing:-0.3px;">Your ${escape(cycleDisplayName(cycle.name))} schedule is ready</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">
              Hi ${escape(firstName)},
              <br /><br />
              Your proposed schedule for ${escape(cycleDisplayName(cycle.name))} is below. <strong>Please tap Accept or Request change on each of the ${campCount} ${unitLabel(cycle.cycle_type, campCount)}</strong>${cycleRange ? ` · ${cycleRange}` : ''} — your schedule isn't confirmed until we hear back from you on every one.${deadline ? `<br /><br /><strong>Please respond by ${fmt(deadline)}.</strong>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${campRows}</table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 6px;" align="left">
              <a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:16px;font-weight:700;letter-spacing:0.2px;">
                Review and respond →
              </a>
              <div style="font-size:12px;color:${MUTED};margin-top:10px;">
                You'll see each ${unitLabel(cycle.cycle_type, 1)} with an <strong>Accept</strong> and <strong>Request change</strong> button.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">
              Once you've responded to every ${unitLabel(cycle.cycle_type, 1)}, you're set. Questions? Just reply to this email.
              <br /><br />
              — Jessica, ${escape(org.name)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderText({ cycle, org, instructor, camps, portalUrl, deadline }: {
  cycle: Cycle;
  org: Org;
  instructor: InstructorRow;
  camps: Array<{ a: AssignmentRow; s: SessionRow | undefined }>;
  portalUrl: string;
  deadline: string | null;
}) {
  const firstName = instructor.first_name ?? 'there';
  const cycleRange = (cycle.starts_on && cycle.ends_on) ? ` (${fmt(cycle.starts_on)} – ${fmt(cycle.ends_on)})` : '';
  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');
  lines.push(`Your proposed schedule for ${cycleDisplayName(cycle.name)}${cycleRange} is below. Please tap Accept or Request change on each of the ${camps.length} ${unitLabel(cycle.cycle_type, camps.length)} — your schedule isn't confirmed until we hear back from you on every one.`);
  if (deadline) {
    lines.push('');
    lines.push(`Please respond by ${fmt(deadline)}.`);
  }
  lines.push('');
  for (const { a, s } of camps) {
    if (!s) continue;
    const role = a.role === 'developing' ? ' (Developing)' : '';
    lines.push(`• ${s.curriculum_name ?? titleCase(unitLabel(cycle.cycle_type, 1))}${role}`);
    lines.push(`  Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${classDaysSummary(s.class_days)}`);
    lines.push(`  ${s.location_name ?? ''} · ${titleCase(s.session_type)} ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`);
    if (a.distance_bonus_cents) lines.push(`  Includes a ${dollars(a.distance_bonus_cents)} distance bonus`);
    lines.push('');
  }
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push(`(You'll see each ${unitLabel(cycle.cycle_type, 1)} with an Accept and Request change button.)`);
  lines.push('');
  lines.push(`Once you've responded to every ${unitLabel(cycle.cycle_type, 1)}, you're set. Questions? Just reply to this email.`);
  lines.push('');
  lines.push(`— Jessica, ${org.name}`);
  return lines.join('\n');
}

function escape(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
