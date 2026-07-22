// send-afterschool-patch-offer: the after-school sibling of send-patch-offer.
// Emails a single instructor that one or more AFTER-SCHOOL classes were added to
// their schedule AFTER the main offer batch went out — the "added later" case,
// so that one row gets its own email instead of re-blasting everyone.
//
// Input: { assignment_ids: string[], mode?: 'preview' | 'send' }  (program_assignment ids)
// - mode 'preview': renders per-instructor email, returns { preview: [...] }, no DB writes.
// - mode 'send': renders + sends via Resend + flips status->published, stamps
//   published_at, email_sent_at, and a default deadline (5 business days) if none.
// - All ids must belong to the same org + the same term.
// - Groups by instructor: one email listing all their new classes.
//
// Auth: org admin/owner on the org. Multi-tenant: sender via loadOrgBrand.
// Programs carry no cycle — the term (programs.term) drives the display.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, renderSignatureBlock, formatFromAddress } from '../_shared/orgBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

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
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

function fmt(date: string | null) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function fmtTime(t: string | null) {
  if (!t) return '';
  const raw = t.trim();
  let h: number;
  let m: number;
  // Programs store 12-hour TEXT ("3:30 PM"); camps store 24-hour time ("12:30:00").
  // This function renders PROGRAM times, so the 24h-only parser this used to have
  // produced "3:NaNpm" on every after-school offer email. Parse both.
  const m12 = raw.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m12) {
    h = parseInt(m12[1], 10);
    m = parseInt(m12[2], 10);
    const pm = m12[3].toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  } else {
    const parts = raw.split(':').map(Number);
    h = parts[0];
    m = parts[1];
  }
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return raw; // show raw, never "NaN"
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? 'pm' : 'am';
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, '0')}${ampm}`;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function dayName(dow: string | number | null): string {
  if (dow == null) return '';
  const n = Number(dow);
  const key = !Number.isNaN(n) ? DAY_NAMES[n] : String(dow).trim().toLowerCase();
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : '';
}

function unitLabel(count: number) {
  return count !== 1 ? 'classes' : 'class';
}

function termDisplayName(code: string | null): string {
  if (!code) return '';
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const terms: Record<string, string> = { SU: 'Summer', FA: 'Fall', WI: 'Winter', SP: 'Spring' };
  return `${terms[m[1]]} 20${m[2]}`;
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
    const introMessage: string | null = body.intro_message ?? null;
    if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) {
      return json({ error: 'assignment_ids is required (non-empty array)' }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);

    // Load target program assignments.
    const { data: assignmentsRaw, error: assignErr } = await supabase
      .from('program_assignments')
      .select('id, organization_id, program_id, instructor_id, role, status, distance_bonus_cents, deadline, email_sent_at')
      .in('id', assignmentIds);
    if (assignErr) return json({ error: `assignments query: ${assignErr.message}` }, 500);
    const assignments = assignmentsRaw ?? [];
    if (assignments.length === 0) return json({ error: 'no matching assignments' }, 404);

    // All assignments must share an org (multi-tenant safety).
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

    // Skip rows already emailed or with no instructor.
    const targets = assignments.filter((a) => a.instructor_id && !a.email_sent_at);
    if (targets.length === 0) return json({ sent: 0, note: 'nothing pending — already emailed or unassigned' });

    // Programs + venue.
    const programIds = Array.from(new Set(targets.map((a) => a.program_id)));
    const { data: programs, error: progErr } = await supabase
      .from('programs')
      .select('id, curriculum, day_of_week, start_time, end_time, term, program_location_id')
      .in('id', programIds);
    if (progErr) return json({ error: `programs query: ${progErr.message}` }, 500);
    const programById = new Map((programs ?? []).map((p) => [p.id, p]));

    // All must share one term (programs carry no cycle).
    const terms = Array.from(new Set((programs ?? []).map((p) => p.term).filter(Boolean)));
    if (terms.length !== 1) return json({ error: 'assignments span multiple terms' }, 400);
    const term = terms[0] as string;

    const locationIds = Array.from(new Set((programs ?? []).map((p) => p.program_location_id).filter(Boolean)));
    const { data: locations } = locationIds.length
      ? await supabase
          .from('program_locations')
          .select('id, name, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes')
          .in('id', locationIds)
      : { data: [] } as { data: unknown[] };
    const locationById = new Map<string, Record<string, unknown>>((locations ?? []).map((l) => [(l as { id: string }).id, l as Record<string, unknown>]));

    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug')
      .eq('id', orgId)
      .maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);
    if (!org.slug) return json({ error: `org ${org.id} has no slug; cannot build portal URL` }, 500);

    const { data: brandingRow } = await supabase
      .from('org_branding')
      .select('primary_color')
      .eq('organization_id', orgId)
      .maybeSingle();
    const primary = brandingRow?.primary_color ?? DEFAULT_PRIMARY;

    // Tenant sender + signature — loaded once per org.
    const brand = await loadOrgBrand(supabase, orgId);
    const signatureHtml = renderSignatureBlock(brand);

    // Group by instructor.
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
    const termDisplay = termDisplayName(term);
    const portalUrl = `${PUBLIC_SITE_URL}/${org.slug}/instructor`;

    const sent: string[] = [];
    const failed: Array<{ instructor_id: string; reason: string }> = [];
    const previews: Array<{ instructor_id: string; to: string; subject: string; html: string; text: string }> = [];

    for (const [instructorId, theirAssignments] of byInstructor) {
      const instructor = instructorById.get(instructorId);
      if (!instructor || !instructor.email) {
        failed.push({ instructor_id: instructorId, reason: 'instructor missing email' });
        continue;
      }
      const classes = theirAssignments
        .map((a) => ({ a, p: programById.get(a.program_id) }))
        .filter((row) => !!row.p);

      const existingDeadlines = theirAssignments.map((a) => a.deadline).filter(Boolean) as string[];
      const deadline = existingDeadlines.sort()[0] ?? defaultDeadline;

      const subject = classes.length === 1
        ? `Another after-school class on your ${termDisplay} schedule`
        : `${classes.length} more after-school classes on your ${termDisplay} schedule`;
      const html = renderPatchHtml({ termDisplay, org, primary, instructor, classes, portalUrl, deadline, locationById, signatureHtml, introMessage });
      const text = renderPatchText({ termDisplay, org, instructor, classes, portalUrl, deadline, locationById, introMessage });

      previews.push({ instructor_id: instructorId, to: instructor.email, subject, html, text });

      if (mode === 'preview') continue;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: formatFromAddress(brand),
            to: instructor.email,
            reply_to: brand.reply_to,
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
        const { error: upErr } = await supabase
          .from('program_assignments')
          .update({ status: 'published', published_at: nowIso, email_sent_at: nowIso })
          .in('id', ids);
        if (upErr) {
          failed.push({ instructor_id: instructorId, reason: `db update: ${upErr.message}` });
          continue;
        }
        const idsWithoutDeadline = theirAssignments.filter((a) => !a.deadline).map((a) => a.id);
        if (idsWithoutDeadline.length > 0) {
          await supabase.from('program_assignments').update({ deadline }).in('id', idsWithoutDeadline);
        }

        await supabase.from('instructor_offer_messages').insert(
          ids.map((assignmentId) => ({
            organization_id: orgId,
            program_assignment_id: assignmentId,
            sender_role: 'system',
            message: `Patch offer email sent — deadline ${deadline}`,
          })),
        );

        sent.push(instructorId);
      } catch (err) {
        failed.push({ instructor_id: instructorId, reason: `unexpected: ${(err as Error).message ?? String(err)}` });
      }
    }

    return json({
      mode,
      sent: sent.length,
      failed,
      instructor_count: byInstructor.size,
      preview: mode === 'preview' ? previews : undefined,
    });
  } catch (err) {
    console.error('send-afterschool-patch-offer fatal:', err);
    return json({ error: (err as Error).message ?? String(err) }, 500);
  }
});

function renderVenueDetailsHtml(loc: Record<string, unknown> | undefined): string {
  if (!loc) return '';
  const g = (k: string) => loc[k] as string | undefined;
  const lines: string[] = [];
  if (g('address')) lines.push(`<div>${escape(g('address'))}${g('room_number') ? ` · Room ${escape(g('room_number'))}` : ''}</div>`);
  else if (g('room_number')) lines.push(`<div>Room ${escape(g('room_number'))}</div>`);
  if (g('arrival_instructions')) lines.push(`<div><strong>Arrival:</strong> ${escape(g('arrival_instructions'))}</div>`);
  if (g('dismissal_instructions')) lines.push(`<div><strong>Dismissal:</strong> ${escape(g('dismissal_instructions'))}</div>`);
  const contactParts: string[] = [];
  if (g('contact_name')) contactParts.push(escape(g('contact_name')));
  if (g('contact_phone')) contactParts.push(escape(g('contact_phone')));
  if (g('contact_email')) contactParts.push(escape(g('contact_email')));
  if (contactParts.length) lines.push(`<div><strong>Venue contact:</strong> ${contactParts.join(' · ')}</div>`);
  if (lines.length === 0) return '';
  return `<div style="margin-top:6px;font-size:12px;color:${MUTED};line-height:1.5;">${lines.join('')}</div>`;
}

function renderVenueDetailsText(loc: Record<string, unknown> | undefined): string[] {
  if (!loc) return [];
  const g = (k: string) => loc[k] as string | undefined;
  const out: string[] = [];
  if (g('address')) out.push(`  ${g('address')}${g('room_number') ? ` · Room ${g('room_number')}` : ''}`);
  else if (g('room_number')) out.push(`  Room ${g('room_number')}`);
  if (g('arrival_instructions')) out.push(`  Arrival: ${g('arrival_instructions')}`);
  if (g('dismissal_instructions')) out.push(`  Dismissal: ${g('dismissal_instructions')}`);
  return out;
}

function renderPatchHtml({ termDisplay, org, primary, instructor, classes, portalUrl, deadline, locationById, signatureHtml, introMessage }: {
  termDisplay: string; org: { name: string }; primary: string; instructor: { first_name?: string | null };
  classes: Array<{ a: Record<string, unknown>; p: Record<string, unknown> | undefined }>;
  portalUrl: string; deadline: string; locationById: Map<string, Record<string, unknown>>; signatureHtml: string;
  introMessage: string | null;
}) {
  const firstName = instructor.first_name ?? 'there';
  const isOne = classes.length === 1;
  const headline = isOne ? 'You have another class to accept' : `You have ${classes.length} more classes to accept`;

  const rows = classes.map(({ a, p }) => {
    if (!p) return '';
    const loc = p.program_location_id ? locationById.get(p.program_location_id as string) : undefined;
    const venue = renderVenueDetailsHtml(loc);
    const bonus = a.distance_bonus_cents ? `
      <div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">Includes a ${dollars(a.distance_bonus_cents as number)} distance bonus</div>` : '';
    const role = a.role === 'developing' ? `<span style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-left:6px;">Developing</span>` : '';
    const when = [dayName(p.day_of_week as string) ? `${dayName(p.day_of_week as string)}s` : '', [fmtTime(p.start_time as string), fmtTime(p.end_time as string)].filter(Boolean).join('–')].filter(Boolean).join(' · ');
    return `
      <tr><td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
        <div style="font-size:15px;font-weight:700;color:${TEXT};line-height:1.3;">${escape(p.curriculum as string) || 'Class'}${role}</div>
        <div style="font-size:13px;color:${MUTED};margin-top:4px;line-height:1.4;">${escape(when)} · all term${(loc && loc.name) ? `<br />${escape(loc.name as string)}` : ''}</div>
        ${venue}
        ${bonus}
      </td></tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:${DEFAULT_PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${DEFAULT_PAGE_BG};padding:32px 16px;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;">
      <tr><td style="padding:28px 32px 8px;">
        <div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(org.name)} · ${escape(termDisplay)}</div>
        <h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;letter-spacing:-0.3px;">${headline}</h1>
      </td></tr>
      <tr><td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">
        Hi ${escape(firstName)},<br /><br />
        ${introMessage
          ? escape(introMessage).replace(/\n/g, '<br />')
          : isOne
            ? `Good news — another after-school class just got added to your ${escape(termDisplay)} schedule. <strong>Please tap Accept or Request change</strong> when you get a moment.`
            : `${classes.length} more after-school classes just got added to your ${escape(termDisplay)} schedule. <strong>Please tap Accept or Request change on each one</strong> when you get a moment.`}
        ${deadline ? `<br /><br /><strong>Please respond by ${fmt(deadline)}.</strong>` : ''}
      </td></tr>
      <tr><td style="padding:8px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table></td></tr>
      <tr><td style="padding:24px 32px 6px;" align="left">
        <a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:16px;font-weight:700;letter-spacing:0.2px;">Review and respond →</a>
      </td></tr>
      <tr><td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">Questions? Just reply to this email.${signatureHtml || `<br /><br />— The ${escape(org.name)} team`}</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function renderPatchText({ termDisplay, org, instructor, classes, portalUrl, deadline, locationById, introMessage }: {
  termDisplay: string; org: { name: string }; instructor: { first_name?: string | null };
  classes: Array<{ a: Record<string, unknown>; p: Record<string, unknown> | undefined }>;
  portalUrl: string; deadline: string; locationById: Map<string, Record<string, unknown>>;
  introMessage: string | null;
}) {
  const firstName = instructor.first_name ?? 'there';
  const isOne = classes.length === 1;
  const lines: string[] = [`Hi ${firstName},`, ''];
  lines.push(introMessage
    ? introMessage
    : isOne
      ? `Good news — another after-school class just got added to your ${termDisplay} schedule. Please tap Accept or Request change when you get a moment.`
      : `${classes.length} more after-school classes just got added to your ${termDisplay} schedule. Please tap Accept or Request change on each one when you get a moment.`);
  if (deadline) { lines.push(''); lines.push(`Please respond by ${fmt(deadline)}.`); }
  lines.push('');
  for (const { a, p } of classes) {
    if (!p) continue;
    const loc = p.program_location_id ? locationById.get(p.program_location_id as string) : undefined;
    const role = a.role === 'developing' ? ' (Developing)' : '';
    const when = [dayName(p.day_of_week as string) ? `${dayName(p.day_of_week as string)}s` : '', [fmtTime(p.start_time as string), fmtTime(p.end_time as string)].filter(Boolean).join('–')].filter(Boolean).join(' · ');
    lines.push(`• ${(p.curriculum as string) || 'Class'}${role}`);
    lines.push(`  ${when} · all term`);
    if (loc && loc.name) lines.push(`  ${loc.name as string}`);
    for (const v of renderVenueDetailsText(loc)) lines.push(v);
    if (a.distance_bonus_cents) lines.push(`  Includes a ${dollars(a.distance_bonus_cents as number)} distance bonus`);
    lines.push('');
  }
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push('');
  lines.push(`Questions? Just reply to this email.`);
  lines.push('');
  lines.push(`— The ${org.name} team`);
  return lines.join('\n');
}
