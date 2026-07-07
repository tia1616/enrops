// send-patch-offer: emails a single instructor that one or more camps were added to
// their schedule AFTER the main offer batch went out (the "Skyler" case — admin
// drops an instructor into a previously-open slot, and that one row needs its own
// email rather than another bulk send).
//
// Input: { assignment_ids: string[], mode?: 'preview' | 'send' }
// - mode 'preview' (or omitted-then-explicit): renders the email per instructor
//   and returns { preview: [{ instructor_id, to, subject, html, text }] } without
//   touching the DB or sending. Used by the Hat tip's preview-first flow.
// - mode 'send': renders + sends via Resend + flips status→published, stamps
//   published_at, email_sent_at, and default deadline (5 business days) if none.
// - All ids must belong to the same cycle.
// - Groups by instructor: if Skyler has 2 pending rows, she gets ONE email listing
//   both, not two emails.
//
// Auth: org admin/owner on the cycle's org.
// Multi-tenant: branding + sender pulled from the assignments' cycle/org.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, renderSignatureBlock } from '../_shared/orgBrand.ts';

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

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

function escape(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function businessDaysFromTodayISO(days: number) {
  const d = new Date();
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d.toISOString().slice(0, 10);
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const assignmentIds: string[] | undefined = body.assignment_ids;
    const mode: 'preview' | 'send' = body.mode === 'preview' ? 'preview' : 'send';
    if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) {
      return json({ error: 'assignment_ids is required (non-empty array)' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    // Load target assignments. They must already exist (admin assigned them via UI).
    const { data: assignmentsRaw, error: assignErr } = await supabase
      .from('camp_assignments')
      .select('id, organization_id, camp_session_id, instructor_id, role, status, distance_bonus_cents, deadline, email_sent_at')
      .in('id', assignmentIds);
    if (assignErr) return json({ error: `assignments query: ${assignErr.message}` }, 500);
    const assignments = assignmentsRaw ?? [];
    if (assignments.length === 0) return json({ error: 'no matching assignments' }, 404);

    // Sanity: all assignments must share an org (multi-tenant safety).
    const orgIds = Array.from(new Set(assignments.map((a) => a.organization_id)));
    if (orgIds.length !== 1) return json({ error: 'assignments span multiple orgs' }, 400);
    const orgId = orgIds[0];

    // Auth: caller must be admin/owner on this org.
    const { data: memberRow } = await supabase
      .from('org_members')
      .select('role, organization_id')
      .eq('auth_user_id', userData.user.id)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) {
      return json({ error: 'forbidden' }, 403);
    }

    // Skip rows that have already been emailed or have no instructor — defensive.
    const targets = assignments.filter((a) => a.instructor_id && !a.email_sent_at);
    if (targets.length === 0) return json({ sent: 0, note: 'nothing pending — already emailed or unassigned' });

    // Pull sessions + cycle (assume all assignments share a cycle for now).
    const sessionIds = Array.from(new Set(targets.map((a) => a.camp_session_id)));
    const { data: sessions, error: sessErr } = await supabase
      .from('camp_sessions')
      .select('id, location_id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, start_time, end_time, class_days, cycle_id')
      .in('id', sessionIds);
    if (sessErr) return json({ error: `sessions query: ${sessErr.message}` }, 500);
    const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));

    // Venue details for any locations referenced — fields are optional, only set
    // ones render in the email.
    const locationIds = Array.from(new Set((sessions ?? []).map((s) => s.location_id).filter(Boolean)));
    const { data: locations } = locationIds.length
      ? await supabase
          .from('program_locations')
          .select('id, name, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes')
          .in('id', locationIds)
      : { data: [] } as any;
    const locationById = new Map<string, any>((locations ?? []).map((l: any) => [l.id, l]));

    const cycleIds = Array.from(new Set((sessions ?? []).map((s) => s.cycle_id)));
    if (cycleIds.length !== 1) return json({ error: 'assignments span multiple cycles' }, 400);
    const cycleId = cycleIds[0];

    const { data: cycle, error: cycleErr } = await supabase
      .from('scheduling_cycles')
      .select('id, name, cycle_type, starts_on, ends_on, organization_id')
      .eq('id', cycleId)
      .maybeSingle();
    if (cycleErr || !cycle) return json({ error: 'cycle not found' }, 404);

    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug')
      .eq('id', orgId)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);

    const { data: brandingRow } = await supabase
      .from('org_branding')
      .select('primary_color, email_from_name, email_reply_to')
      .eq('organization_id', orgId)
      .maybeSingle();
    const branding = {
      primary_color: brandingRow?.primary_color ?? DEFAULT_PRIMARY,
      email_from_name: brandingRow?.email_from_name ?? org.name,
      email_reply_to: brandingRow?.email_reply_to ?? null,
    };

    // Tenant email signature — loaded once per org (outside the instructor loop).
    const brand = await loadOrgBrand(supabase, orgId);

    // Group by instructor — Skyler with 2 pending camps gets one email listing both.
    const byInstructor = new Map<string, typeof targets>();
    for (const a of targets) {
      if (!byInstructor.has(a.instructor_id)) byInstructor.set(a.instructor_id, []);
      byInstructor.get(a.instructor_id)!.push(a);
    }

    const instructorIds = Array.from(byInstructor.keys());
    const { data: instructors } = await supabase
      .from('instructors')
      .select('id, first_name, last_name, email')
      .in('id', instructorIds);
    const instructorById = new Map((instructors ?? []).map((i) => [i.id, i]));

    const defaultDeadline = businessDaysFromTodayISO(5);

    const sent: string[] = [];
    const failed: Array<{ instructor_id: string; reason: string }> = [];
    const previews: Array<{ instructor_id: string; to: string; subject: string; html: string; text: string }> = [];

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

      // Use the earliest existing deadline among these rows; fall back to default.
      const existingDeadlines = theirAssignments.map((a) => a.deadline).filter(Boolean) as string[];
      const deadline = existingDeadlines.sort()[0] ?? defaultDeadline;

      const cycleDisplay = cycleDisplayName(cycle.name);
      const subject = camps.length === 1
        ? `Another ${unitLabel(cycle.cycle_type, 1)} on your ${cycleDisplay} schedule`
        : `${camps.length} more ${unitLabel(cycle.cycle_type, camps.length)} on your ${cycleDisplay} schedule`;
      if (!org.slug) throw new Error(`send-patch-offer: org ${org.id} has no slug; cannot build portal URL`);
      const portalUrl = `https://enrops.com/${org.slug}/instructor`;
      const html = renderPatchHtml({ cycle, org, branding, instructor, camps, portalUrl, deadline, locationById, signatureHtml: renderSignatureBlock(brand) });
      const text = renderPatchText({ cycle, org, instructor, camps, portalUrl, deadline, locationById });

      previews.push({ instructor_id: instructorId, to: instructor.email!, subject, html, text });

      if (mode === 'preview') continue;

      try {
        const fromName = branding.email_from_name ?? org.name;
        const fromEmail = `${fromName} <hello@updates.journeytosteam.com>`;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: fromEmail,
            to: instructor.email,
            reply_to: branding.email_reply_to ?? undefined,
            subject,
            html,
            text,
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          failed.push({ instructor_id: instructorId, reason: `resend ${r.status}: ${errText.slice(0, 200)}` });
          continue;
        }

        const ids = theirAssignments.map((a) => a.id);
        const nowIso = new Date().toISOString();
        const updatePayload: Record<string, any> = {
          status: 'published',
          published_at: nowIso,
          email_sent_at: nowIso,
        };
        // Only stamp deadline if the row didn't already have one.
        const { error: upErr1 } = await supabase
          .from('camp_assignments')
          .update(updatePayload)
          .in('id', ids);
        if (upErr1) {
          failed.push({ instructor_id: instructorId, reason: `db update: ${upErr1.message}` });
          continue;
        }
        // Backfill deadlines on rows that had none.
        const idsWithoutDeadline = theirAssignments.filter((a) => !a.deadline).map((a) => a.id);
        if (idsWithoutDeadline.length > 0) {
          await supabase
            .from('camp_assignments')
            .update({ deadline })
            .in('id', idsWithoutDeadline);
        }

        // Audit row in each assignment's message thread.
        await supabase.from('instructor_offer_messages').insert(
          ids.map((assignmentId) => ({
            organization_id: orgId,
            camp_assignment_id: assignmentId,
            sender_role: 'system',
            message: `Patch offer email sent — deadline ${deadline}`,
          }))
        );

        sent.push(instructorId);
      } catch (err: any) {
        failed.push({ instructor_id: instructorId, reason: `unexpected: ${err.message ?? String(err)}` });
      }
    }

    return json({
      mode,
      sent: sent.length,
      failed,
      instructor_count: byInstructor.size,
      preview: mode === 'preview' ? previews : undefined,
    });
  } catch (err: any) {
    console.error('send-patch-offer fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});

// Renders the optional venue-detail block under each camp row.
function renderVenueDetailsHtml(loc: any): string {
  if (!loc) return '';
  const lines: string[] = [];
  if (loc.address) lines.push(`<div>${escape(loc.address)}${loc.room_number ? ` · Room ${escape(loc.room_number)}` : ''}</div>`);
  else if (loc.room_number) lines.push(`<div>Room ${escape(loc.room_number)}</div>`);
  if (loc.arrival_instructions) lines.push(`<div><strong>Arrival:</strong> ${escape(loc.arrival_instructions)}</div>`);
  if (loc.dismissal_instructions) lines.push(`<div><strong>Dismissal:</strong> ${escape(loc.dismissal_instructions)}</div>`);
  if (loc.food_drink_policy) lines.push(`<div><strong>Food/drink:</strong> ${escape(loc.food_drink_policy)}</div>`);
  const contactParts: string[] = [];
  if (loc.contact_name) contactParts.push(escape(loc.contact_name));
  if (loc.contact_phone) contactParts.push(escape(loc.contact_phone));
  if (loc.contact_email) contactParts.push(escape(loc.contact_email));
  if (contactParts.length) lines.push(`<div><strong>Venue contact:</strong> ${contactParts.join(' · ')}</div>`);
  if (loc.notes) lines.push(`<div><strong>Notes:</strong> ${escape(loc.notes)}</div>`);
  if (lines.length === 0) return '';
  return `<div style="margin-top:6px;font-size:12px;color:${MUTED};line-height:1.5;">${lines.join('')}</div>`;
}

function renderVenueDetailsText(loc: any): string[] {
  if (!loc) return [];
  const out: string[] = [];
  if (loc.address) out.push(`  ${loc.address}${loc.room_number ? ` · Room ${loc.room_number}` : ''}`);
  else if (loc.room_number) out.push(`  Room ${loc.room_number}`);
  if (loc.arrival_instructions) out.push(`  Arrival: ${loc.arrival_instructions}`);
  if (loc.dismissal_instructions) out.push(`  Dismissal: ${loc.dismissal_instructions}`);
  if (loc.food_drink_policy) out.push(`  Food/drink: ${loc.food_drink_policy}`);
  const contactParts: string[] = [];
  if (loc.contact_name) contactParts.push(loc.contact_name);
  if (loc.contact_phone) contactParts.push(loc.contact_phone);
  if (loc.contact_email) contactParts.push(loc.contact_email);
  if (contactParts.length) out.push(`  Venue contact: ${contactParts.join(' · ')}`);
  if (loc.notes) out.push(`  Notes: ${loc.notes}`);
  return out;
}

function renderPatchHtml({ cycle, org, branding, instructor, camps, portalUrl, deadline, locationById, signatureHtml }: any) {
  const primary = branding.primary_color ?? DEFAULT_PRIMARY;
  const firstName = instructor.first_name ?? 'there';
  const cycleDisplay = cycleDisplayName(cycle.name);
  const isOne = camps.length === 1;
  const headline = isOne
    ? `You have another ${unitLabel(cycle.cycle_type, 1)} to accept`
    : `You have ${camps.length} more ${unitLabel(cycle.cycle_type, camps.length)} to accept`;

  const campRows = camps.map(({ a, s }: any) => {
    if (!s) return '';
    const loc = s.location_id ? locationById?.get(s.location_id) : undefined;
    const venue = renderVenueDetailsHtml(loc);
    const bonus = a.distance_bonus_cents ? `
      <div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">
        Includes a ${dollars(a.distance_bonus_cents)} distance bonus
      </div>
    ` : '';
    const role = a.role === 'developing' ? `<span style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-left:6px;">Developing</span>` : '';
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
          ${venue}
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
              <div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(org.name)} · ${escape(cycleDisplay)}</div>
              <h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;letter-spacing:-0.3px;">${headline}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">
              Hi ${escape(firstName)},
              <br /><br />
              ${isOne
                ? `Good news — another ${unitLabel(cycle.cycle_type, 1)} just got added to your ${escape(cycleDisplay)} schedule. <strong>Please tap Accept or Request change</strong> when you get a moment.`
                : `${camps.length} more ${unitLabel(cycle.cycle_type, camps.length)} just got added to your ${escape(cycleDisplay)} schedule. <strong>Please tap Accept or Request change on each one</strong> when you get a moment.`}
              ${deadline ? `<br /><br /><strong>Please respond by ${fmt(deadline)}.</strong>` : ''}
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
                You'll see ${isOne ? `the new ${unitLabel(cycle.cycle_type, 1)}` : 'each new ' + unitLabel(cycle.cycle_type, 1)} with an <strong>Accept</strong> and <strong>Request change</strong> button.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">
              Questions? Just reply to this email.
              ${signatureHtml || `<br /><br />
              — The ${escape(org.name)} team`}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderPatchText({ cycle, org, instructor, camps, portalUrl, deadline, locationById }: any) {
  const firstName = instructor.first_name ?? 'there';
  const cycleDisplay = cycleDisplayName(cycle.name);
  const isOne = camps.length === 1;
  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');
  if (isOne) {
    lines.push(`Good news — another ${unitLabel(cycle.cycle_type, 1)} just got added to your ${cycleDisplay} schedule. Please tap Accept or Request change when you get a moment.`);
  } else {
    lines.push(`${camps.length} more ${unitLabel(cycle.cycle_type, camps.length)} just got added to your ${cycleDisplay} schedule. Please tap Accept or Request change on each one when you get a moment.`);
  }
  if (deadline) {
    lines.push('');
    lines.push(`Please respond by ${fmt(deadline)}.`);
  }
  lines.push('');
  for (const { a, s } of camps) {
    if (!s) continue;
    const loc = s.location_id ? locationById?.get(s.location_id) : undefined;
    const role = a.role === 'developing' ? ' (Developing)' : '';
    lines.push(`• ${s.curriculum_name ?? titleCase(unitLabel(cycle.cycle_type, 1))}${role}`);
    lines.push(`  Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${classDaysSummary(s.class_days)}`);
    lines.push(`  ${s.location_name ?? ''} · ${titleCase(s.session_type)} ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`);
    for (const v of renderVenueDetailsText(loc)) lines.push(v);
    if (a.distance_bonus_cents) lines.push(`  Includes a ${dollars(a.distance_bonus_cents)} distance bonus`);
    lines.push('');
  }
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push('');
  lines.push(`Questions? Just reply to this email.`);
  lines.push('');
  lines.push(`— The ${org.name} team`);
  return lines.join('\n');
}
