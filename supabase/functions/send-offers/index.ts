// send-offers: emails offer letters to instructors and flips their confirmed
// assignments to published. Test mode routes every send to a single inbox.
//
// Input: { cycle_id: string, instructor_ids: string[] | null, mode: 'preview' | 'test' | 'send' }
// - mode 'preview': returns rendered HTML + meta for every instructor in scope, no DB writes, no email sends
// - mode 'test':    sends each rendered email to the tenant's test inbox (body.test_recipient,
//                   else the tenant's alert_email), overriding instructor.email, still flips DB
// - mode 'send':    sends to real instructor.email, flips DB
//
// Multi-tenant: queries scoped by organization (inferred from cycle.organization_id).
// Branded copy/colors pulled from org_branding; sender domain from org config.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from '../_shared/logPlatformEvent.ts';
import { loadOrgBrand, renderSignatureBlock, formatFromAddress, resolveTestRecipient } from '../_shared/orgBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so portal links in test emails point at staging, not prod. Defaults to prod.
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

type AssignmentRow = {
  id: string;
  camp_session_id: string;
  instructor_id: string;
  role: string;
  status: string;
  distance_bonus_cents: number | null;
  flags: string[] | null;
  deadline: string | null;
};

type SessionRow = {
  id: string;
  location_id: string | null;
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

type LocationDetails = {
  id: string;
  name: string | null;
  address: string | null;
  room_number: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  arrival_instructions: string | null;
  dismissal_instructions: string | null;
  food_drink_policy: string | null;
  notes: string | null;
};

type InstructorRow = { id: string; first_name: string | null; last_name: string | null; preferred_name: string | null; email: string | null };

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
    const testRecipient: string | undefined = body.test_recipient; // test-mode override; else tenant alert_email

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

    // Tenant email signature — loaded once per org (outside the instructor loop).
    const brand = await loadOrgBrand(supabase, cycle.organization_id);
    // Where test-mode sends land: caller-supplied recipient, else the tenant's inbox.
    const testInbox = resolveTestRecipient(brand, testRecipient);

    // Preview and Test include confirmed AND published — both are non-mutating, so
    // they let admins inspect and re-test without changing the send-state.
    // Real Send fires only on 'confirmed' so it never re-mails already-published rows.
    const statusFilter = mode === 'send' ? ['confirmed'] : ['confirmed', 'published'];
    let assignmentsQuery = supabase
      .from('camp_assignments')
      .select('id, camp_session_id, instructor_id, role, status, distance_bonus_cents, flags, deadline')
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
      .select('id, location_id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, start_time, end_time, class_days')
      .in('id', sessionIds);
    const sessionById = new Map<string, SessionRow>((sessions ?? []).map((s) => [s.id, s as SessionRow]));

    // Pull venue details (address, room, contact, arrival, food/drink, notes) for
    // any locations referenced by these sessions. Each gets rendered under its camp
    // row in the email so instructors have everything they need in one place. Fields
    // are optional — only set fields render.
    const locationIds = Array.from(new Set((sessions ?? []).map((s) => s.location_id).filter(Boolean)));
    const { data: locations } = locationIds.length
      ? await supabase
          .from('program_locations')
          .select('id, name, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes')
          .in('id', locationIds)
      : { data: [] } as any;
    const locationById = new Map<string, any>((locations ?? []).map((l: any) => [l.id, l]));

    const { data: instructors } = await supabase
      .from('instructors')
      .select('id, first_name, last_name, preferred_name, email')
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
      if (!org.slug) throw new Error(`send-offers: org ${org.id} has no slug; cannot build portal URL`);
      const portalUrl = `${PUBLIC_SITE_URL}/${org.slug}/instructor`;
      const html = renderHtml({ cycle, org, branding, instructor, camps, portalUrl, deadline, locationById, signatureHtml: renderSignatureBlock(brand) });
      const text = renderText({ cycle, org, instructor, camps, portalUrl, deadline, locationById });
      const recipient = mode === 'send' ? instructor.email! : testInbox;

      previews.push({ instructor_id: instructorId, to: recipient, subject, html, text });

      if (mode === 'preview') continue;

      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            // Send AS the tenant: FROM their verified/shared-platform sender, not
            // the hardcoded J2S domain. Mirrors send-afterschool-offers (the twin).
            from: formatFromAddress(brand),
            to: recipient,
            reply_to: brand.reply_to,
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

        // Real Send: flip to published. Test mode skips this so it can be re-run
        // without polluting send-state.
        if (mode === 'send') {
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

          // Audit row per assignment so the cycle-wide email activity log can show
          // exactly who got the bulk offer and when.
          await supabase.from('instructor_offer_messages').insert(
            ids.map((assignmentId) => ({
              organization_id: cycle.organization_id,
              camp_assignment_id: assignmentId,
              sender_role: 'system',
              message: deadline ? `Offer email sent — deadline ${deadline}` : 'Offer email sent',
            }))
          );
        }

        sent.push(instructorId);
      } catch (err: any) {
        failed.push({ instructor_id: instructorId, reason: `unexpected: ${err.message ?? String(err)}` });
      }
    }

    // intelligence: record the real send as platform usage (one event per send
    // action, not per instructor). Preview/test aren't real usage. Fail-safe.
    if (mode === 'send') {
      await logPlatformEvent(supabase, {
        feature: FEATURE.SCHEDULING,
        action: ACTION.OFFER_SENT,
        outcome: sent.length > 0 ? OUTCOME.SUCCESS : OUTCOME.FAIL,
        organizationId: cycle.organization_id,
        actorUserId: userData.user.id,
        metadata: { sent_count: sent.length, failed_count: failed.length },
      });
    }

    return json({
      mode,
      sent: sent.length,
      failed,
      preview: mode === 'preview' ? previews : undefined,
      // Where test/preview sends were routed, so the UI can tell the operator
      // truthfully (never a hardcoded inbox). Omitted for real sends.
      test_recipient: mode === 'send' ? undefined : testInbox,
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

// Renders the optional venue-detail block under each camp row. Only set fields
// appear, so empty venues degrade gracefully (no missing-data placeholders).
function renderVenueDetailsHtml(loc: LocationDetails | undefined): string {
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

function renderVenueDetailsText(loc: LocationDetails | undefined): string[] {
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

function renderHtml({ cycle, org, branding, instructor, camps, portalUrl, deadline, locationById, signatureHtml }: {
  cycle: Cycle;
  org: Org;
  branding: Branding;
  instructor: InstructorRow;
  camps: Array<{ a: AssignmentRow; s: SessionRow | undefined }>;
  portalUrl: string;
  deadline: string | null;
  locationById: Map<string, LocationDetails>;
  signatureHtml: string;
}) {
  const primary = branding.primary_color ?? DEFAULT_PRIMARY;
  const firstName = instructor.preferred_name ?? instructor.first_name ?? 'there';
  const campCount = camps.length;
  const cycleRange = (cycle.starts_on && cycle.ends_on) ? `${fmt(cycle.starts_on)} – ${fmt(cycle.ends_on)}` : '';

  const campRows = camps.map(({ a, s }) => {
    if (!s) return '';
    const loc = s.location_id ? locationById.get(s.location_id) : undefined;
    const venue = renderVenueDetailsHtml(loc);
    // location_override (instructor marked this region 'unavailable') is the
    // only flag that carries a bonus today. Surface the WHY in the email so
    // the instructor sees the bonus isn't arbitrary.
    const hasOverride = Array.isArray(a.flags) && a.flags.includes('location_override');
    const bonusReason = hasOverride
      ? `<div style="margin-top:2px;font-size:12px;color:${MUTED};font-weight:400;">A hardship bonus because this is a location you marked unavailable. Thanks for covering it.</div>`
      : '';
    const bonus = a.distance_bonus_cents ? `
      <div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">
        Includes a ${dollars(a.distance_bonus_cents)} distance bonus
        ${bonusReason}
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
            <td style="padding:14px 32px 8px;font-size:13px;color:${MUTED};line-height:1.55;">
              Once you've responded to every ${unitLabel(cycle.cycle_type, 1)}, you're set. Questions? Just reply to this email.
              ${signatureHtml || `<br /><br />
              — The ${escape(org.name)} team`}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 24px;font-size:11px;color:${MUTED};line-height:1.5;font-style:italic;border-top:1px solid ${BORDER};">
              * Assignments are subject to change according to enrollment. Changes can be made up to one week before the start date. More programs may open and be offered to you before the start of ${unitLabel(cycle.cycle_type, 2)} as well.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderText({ cycle, org, instructor, camps, portalUrl, deadline, locationById }: {
  cycle: Cycle;
  org: Org;
  instructor: InstructorRow;
  camps: Array<{ a: AssignmentRow; s: SessionRow | undefined }>;
  portalUrl: string;
  deadline: string | null;
  locationById: Map<string, LocationDetails>;
}) {
  const firstName = instructor.preferred_name ?? instructor.first_name ?? 'there';
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
    const loc = s.location_id ? locationById.get(s.location_id) : undefined;
    const role = a.role === 'developing' ? ' (Developing)' : '';
    lines.push(`• ${s.curriculum_name ?? titleCase(unitLabel(cycle.cycle_type, 1))}${role}`);
    lines.push(`  Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${classDaysSummary(s.class_days)}`);
    lines.push(`  ${s.location_name ?? ''} · ${titleCase(s.session_type)} ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}`);
    for (const v of renderVenueDetailsText(loc)) lines.push(v);
    if (a.distance_bonus_cents) {
      const hasOverride = Array.isArray(a.flags) && a.flags.includes('location_override');
      lines.push(`  Includes a ${dollars(a.distance_bonus_cents)} distance bonus`);
      if (hasOverride) lines.push(`  (A hardship bonus because this is a location you marked unavailable.)`);
    }
    lines.push('');
  }
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push(`(You'll see each ${unitLabel(cycle.cycle_type, 1)} with an Accept and Request change button.)`);
  lines.push('');
  lines.push(`Once you've responded to every ${unitLabel(cycle.cycle_type, 1)}, you're set. Questions? Just reply to this email.`);
  lines.push('');
  lines.push(`— The ${org.name} team`);
  lines.push('');
  lines.push(`* Assignments are subject to change according to enrollment. Changes can be made up to one week before the start date. More programs may open and be offered to you before the start of ${unitLabel(cycle.cycle_type, 2)} as well.`);
  return lines.join('\n');
}

function escape(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
