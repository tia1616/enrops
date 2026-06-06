// send-afterschool-offers: emails offer letters to instructors for an after-school
// TERM and flips their confirmed program_assignments to published. Sibling of the
// camp send-offers, but term/program-shaped (no weeks/session_types — each class
// recurs the same weekday all term).
//
// Input: { organization_id, term, instructor_ids?: string[]|null, mode: 'preview'|'test'|'send', deadline?: 'YYYY-MM-DD' }
//   preview: render HTML/text for everyone in scope, no writes/sends
//   test:    send each to TEST_INBOX, no DB writes
//   send:    send to real instructor.email, flip assignments confirmed -> published
//
// Lifecycle (mirrors camps): proposed -> [Approve] confirmed -> [Send] published
//   -> [instructor Accept] confirmed / [Request change] change_requested.
// Multi-tenant: org-scoped; branding from org_branding.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const TEST_INBOX = 'jessica@journeytosteam.com';
// TODO(B2 multi-tenant): drive the sender domain from org config, not a constant.
// Mirrors the platform-wide hardcode already tracked on the backlog; not a new one.
const FROM_DOMAIN = 'updates.journeytosteam.com';
const DEFAULT_PRIMARY = '#1C004F';
const PAGE_BG = '#FBFBFB';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';
const ARRIVAL_BUFFER_MIN = 15;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

function termDisplayName(code: string | null): string {
  if (!code) return '';
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(code);
  if (!m) return code;
  const t: Record<string, string> = { SU: 'Summer', FA: 'Fall', WI: 'Winter', SP: 'Spring' };
  return `${t[m[1]]} 20${m[2]}`;
}

// "2:05 PM" 12h text -> minutes since midnight (programs store 12h text).
function parse12h(t: string | null): number | null {
  if (!t) return null;
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*$/.exec(t);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (h === 12) h = 0;
  if (m[3].toLowerCase() === 'pm') h += 12;
  return h * 60 + parseInt(m[2], 10);
}
function minutesToLabel(min: number): string {
  let h = Math.floor(min / 60), m = min % 60;
  const ampm = h >= 12 ? 'pm' : 'am';
  h = ((h + 11) % 12) + 1;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}
function arriveBy(start: string | null): string {
  const s = parse12h(start);
  if (s == null) return '';
  return minutesToLabel(s - ARRIVAL_BUFFER_MIN);
}
function dayLabel(dow: string | null): string {
  if (!dow) return '';
  const d = dow.trim().toLowerCase();
  return d.charAt(0).toUpperCase() + d.slice(1) + 's'; // "Mondays"
}
function dollars(cents: number | null | undefined) {
  if (!cents) return '';
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
function escape(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json();
    const organizationId: string | undefined = body.organization_id;
    const term: string | undefined = body.term;
    const instructorIdsInput: string[] | null | undefined = body.instructor_ids;
    const mode: 'preview' | 'test' | 'send' = body.mode ?? 'preview';
    const deadline: string | null = body.deadline ?? null;

    if (!organizationId) return json({ error: 'organization_id is required' }, 400);
    if (!term) return json({ error: 'term is required' }, 400);
    if (!['preview', 'test', 'send'].includes(mode)) return json({ error: `unknown mode "${mode}"` }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Auth: caller must be owner/admin of the org.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth required' }, 401);
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid auth' }, 401);
    const { data: memberRow } = await supabase
      .from('org_members').select('role').eq('auth_user_id', userData.user.id).eq('organization_id', organizationId).maybeSingle();
    if (!memberRow || !['owner', 'admin'].includes(memberRow.role)) return json({ error: 'forbidden' }, 403);

    const { data: org } = await supabase.from('organizations').select('id, name, slug').eq('id', organizationId).maybeSingle();
    if (!org) return json({ error: 'org not found' }, 404);
    if (!org.slug) throw new Error(`send-afterschool-offers: org ${org.id} has no slug; cannot build portal URL`);

    const { data: brandingRow } = await supabase
      .from('org_branding').select('primary_color, email_from_name, email_reply_to').eq('organization_id', organizationId).maybeSingle();
    const primary = brandingRow?.primary_color ?? DEFAULT_PRIMARY;
    const fromName = brandingRow?.email_from_name ?? org.name;
    const replyTo = brandingRow?.email_reply_to ?? null;

    // Programs for this term (open only).
    const { data: progs } = await supabase
      .from('programs')
      .select('id, curriculum, day_of_week, start_time, end_time, program_location_id')
      .eq('organization_id', organizationId).eq('term', term).eq('status', 'open');
    const programIds = (progs ?? []).map((p: any) => p.id);
    if (programIds.length === 0) return json({ sent: 0, failed: [], preview: [], note: 'No open classes for this term.' });
    const progById = new Map<string, any>((progs ?? []).map((p: any) => [p.id, p]));

    // Send acts on 'confirmed' (post-approve); preview/test also show 'published'.
    const statusFilter = mode === 'send' ? ['confirmed'] : ['confirmed', 'published'];
    let q = supabase
      .from('program_assignments')
      .select('id, program_id, instructor_id, role, status, distance_bonus_cents, flags, deadline')
      .eq('organization_id', organizationId).in('status', statusFilter).in('program_id', programIds);
    if (instructorIdsInput && instructorIdsInput.length > 0) q = q.in('instructor_id', instructorIdsInput);
    const { data: assignsRaw, error: aErr } = await q;
    if (aErr) return json({ error: `assignments query: ${aErr.message}` }, 500);
    const assigns = assignsRaw ?? [];
    if (assigns.length === 0) {
      return json({ sent: 0, failed: [], preview: [], note: mode === 'preview'
        ? 'Nothing to preview — approve some proposed matches first.'
        : 'No approved (confirmed) assignments to send. Approve some first.' });
    }

    // Locations.
    const locIds = Array.from(new Set((progs ?? []).map((p: any) => p.program_location_id).filter(Boolean)));
    const { data: locs } = locIds.length
      ? await supabase.from('program_locations')
          .select('id, name, area, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes')
          .in('id', locIds)
      : { data: [] } as any;
    const locById = new Map<string, any>((locs ?? []).map((l: any) => [l.id, l]));

    const instructorIds = Array.from(new Set(assigns.map((a: any) => a.instructor_id)));
    const { data: instructors } = await supabase
      .from('instructors').select('id, first_name, last_name, preferred_name, email').in('id', instructorIds);
    const instById = new Map<string, any>((instructors ?? []).map((i: any) => [i.id, i]));

    const byInstructor = new Map<string, any[]>();
    for (const a of assigns) {
      if (!byInstructor.has(a.instructor_id)) byInstructor.set(a.instructor_id, []);
      byInstructor.get(a.instructor_id)!.push(a);
    }

    const termDisplay = termDisplayName(term);
    const portalUrl = `https://enrops.com/${org.slug}/instructor`;
    const previews: any[] = [];
    const sent: string[] = [];
    const failed: Array<{ instructor_id: string; reason: string }> = [];

    for (const [instructorId, theirs] of byInstructor) {
      const inst = instById.get(instructorId);
      if (!inst || !inst.email) { failed.push({ instructor_id: instructorId, reason: 'instructor missing email' }); continue; }
      const classes = theirs
        .map((a: any) => ({ a, p: progById.get(a.program_id) }))
        .filter((r: any) => !!r.p)
        .sort((x: any, y: any) => (parse12h(x.p.start_time) ?? 0) - (parse12h(y.p.start_time) ?? 0));

      const subject = `Your ${termDisplay} after-school schedule is ready — please review`;
      const html = renderHtml({ org, primary, firstName: inst.preferred_name ?? inst.first_name ?? 'there', termDisplay, classes, portalUrl, deadline, locById });
      const text = renderText({ org, firstName: inst.preferred_name ?? inst.first_name ?? 'there', termDisplay, classes, portalUrl, deadline, locById });
      const recipient = mode === 'send' ? inst.email : TEST_INBOX;
      previews.push({ instructor_id: instructorId, to: recipient, subject, html, text });
      if (mode === 'preview') continue;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: `${fromName} <hello@${FROM_DOMAIN}>`,
            to: recipient,
            reply_to: replyTo ?? undefined,
            subject: mode === 'test' ? `[TEST] ${subject}` : subject,
            html, text,
          }),
        });
        if (!r.ok) { failed.push({ instructor_id: instructorId, reason: `resend ${r.status}: ${(await r.text()).slice(0, 200)}` }); continue; }

        if (mode === 'send') {
          const ids = theirs.map((a: any) => a.id);
          const nowIso = new Date().toISOString();
          const payload: Record<string, any> = { status: 'published', published_at: nowIso, email_sent_at: nowIso };
          if (deadline) payload.deadline = deadline;
          const { error: upErr } = await supabase.from('program_assignments').update(payload).in('id', ids);
          if (upErr) { failed.push({ instructor_id: instructorId, reason: `db update: ${upErr.message}` }); continue; }
          await supabase.from('instructor_offer_messages').insert(
            ids.map((aid: string) => ({
              organization_id: organizationId,
              program_assignment_id: aid,
              sender_role: 'system',
              message: deadline ? `Offer email sent — deadline ${deadline}` : 'Offer email sent',
            })),
          );
        }
        sent.push(instructorId);
      } catch (err: any) {
        failed.push({ instructor_id: instructorId, reason: `unexpected: ${err.message ?? String(err)}` });
      }
    }

    return json({ mode, sent: sent.length, failed, preview: mode === 'preview' ? previews : undefined, recipient_count: byInstructor.size });
  } catch (err: any) {
    console.error('send-afterschool-offers fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});

function venueHtml(loc: any): string {
  if (!loc) return '';
  const lines: string[] = [];
  if (loc.address) lines.push(`<div>${escape(loc.address)}${loc.room_number ? ` · Room ${escape(loc.room_number)}` : ''}</div>`);
  else if (loc.room_number) lines.push(`<div>Room ${escape(loc.room_number)}</div>`);
  if (loc.arrival_instructions) lines.push(`<div><strong>Arrival:</strong> ${escape(loc.arrival_instructions)}</div>`);
  if (loc.dismissal_instructions) lines.push(`<div><strong>Dismissal:</strong> ${escape(loc.dismissal_instructions)}</div>`);
  if (loc.food_drink_policy) lines.push(`<div><strong>Food/drink:</strong> ${escape(loc.food_drink_policy)}</div>`);
  const c: string[] = [];
  if (loc.contact_name) c.push(escape(loc.contact_name));
  if (loc.contact_phone) c.push(escape(loc.contact_phone));
  if (loc.contact_email) c.push(escape(loc.contact_email));
  if (c.length) lines.push(`<div><strong>Venue contact:</strong> ${c.join(' · ')}</div>`);
  if (loc.notes) lines.push(`<div><strong>Notes:</strong> ${escape(loc.notes)}</div>`);
  if (!lines.length) return '';
  return `<div style="margin-top:6px;font-size:12px;color:${MUTED};line-height:1.5;">${lines.join('')}</div>`;
}

function renderHtml({ org, primary, firstName, termDisplay, classes, portalUrl, deadline, locById }: any) {
  const rows = classes.map(({ a, p }: any) => {
    const loc = p.program_location_id ? locById.get(p.program_location_id) : undefined;
    const area = loc?.area ? ` · ${escape(loc.area)}` : '';
    const ab = arriveBy(p.start_time);
    const hardship = Array.isArray(a.flags) && (a.flags.includes('location_override') || a.flags.includes('location_low_pref'));
    const bonus = a.distance_bonus_cents
      ? `<div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">Includes a ${dollars(a.distance_bonus_cents)} bonus${hardship ? `<div style="font-size:12px;color:${MUTED};font-weight:400;">Thanks for covering an area outside your preference.</div>` : ''}</div>`
      : '';
    return `<tr><td style="padding:14px 0;border-bottom:1px solid ${BORDER};">
      <div style="font-size:15px;font-weight:700;color:${TEXT};line-height:1.3;">${escape(p.curriculum ?? 'Class')}</div>
      <div style="font-size:13px;color:${MUTED};margin-top:4px;line-height:1.4;">
        ${escape(dayLabel(p.day_of_week))} ${escape(p.start_time ?? '')}–${escape(p.end_time ?? '')} · <strong>all term</strong><br/>
        ${escape(loc?.name ?? '')}${area}${ab ? ` · please arrive by ${ab}` : ''}
      </div>
      ${venueHtml(loc)}
      ${bonus}
    </td></tr>`;
  }).join('');
  const n = classes.length;
  const cls = n === 1 ? 'class' : 'classes';
  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE_BG};padding:32px 16px;"><tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;">
      <tr><td style="padding:28px 32px 8px;">
        <div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(org.name)}</div>
        <h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;letter-spacing:-0.3px;">Your ${escape(termDisplay)} after-school schedule is ready</h1>
      </td></tr>
      <tr><td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">
        Hi ${escape(firstName)},<br/><br/>
        Your proposed after-school schedule for ${escape(termDisplay)} is below. <strong>Please tap Accept or Request change on each of the ${n} ${cls}</strong> — each one runs weekly all term, and your schedule isn't confirmed until we hear back on every one.${deadline ? `<br/><br/><strong>Please respond by ${escape(deadline)}.</strong>` : ''}
      </td></tr>
      <tr><td style="padding:8px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table></td></tr>
      <tr><td style="padding:24px 32px 6px;" align="left">
        <a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:16px;font-weight:700;">Review and respond →</a>
      </td></tr>
      <tr><td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">Once you've responded to every class, you're set. Questions? Just reply to this email.<br/><br/>— ${escape(org.name)}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

function renderText({ org, firstName, termDisplay, classes, portalUrl, deadline, locById }: any) {
  const lines: string[] = [`Hi ${firstName},`, ''];
  lines.push(`Your proposed after-school schedule for ${termDisplay} is below. Please tap Accept or Request change on each class — each runs weekly all term, and nothing's confirmed until we hear back on every one.`);
  if (deadline) { lines.push(''); lines.push(`Please respond by ${deadline}.`); }
  lines.push('');
  for (const { a, p } of classes) {
    const loc = p.program_location_id ? locById.get(p.program_location_id) : undefined;
    const ab = arriveBy(p.start_time);
    lines.push(`• ${p.curriculum ?? 'Class'}`);
    lines.push(`  ${dayLabel(p.day_of_week)} ${p.start_time ?? ''}–${p.end_time ?? ''} · all term`);
    lines.push(`  ${loc?.name ?? ''}${loc?.area ? ` · ${loc.area}` : ''}${ab ? ` · arrive by ${ab}` : ''}`);
    if (a.distance_bonus_cents) lines.push(`  Includes a ${dollars(a.distance_bonus_cents)} bonus`);
    lines.push('');
  }
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push('');
  lines.push(`— ${org.name}`);
  return lines.join('\n');
}
