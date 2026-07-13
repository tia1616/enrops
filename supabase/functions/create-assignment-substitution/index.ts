// create-assignment-substitution: admin assigns a single-day sub to cover a
// camp or afterschool session, and we send the sub an Ennie-voiced offer
// email with the day's venue + program details.
//
// Input: {
//   parent_assignment_id: string,
//   parent_assignment_type: 'camp' | 'program',
//   date: 'YYYY-MM-DD',
//   sub_instructor_id: string,
//   sub_tier: 'lead' | 'developing',
//   notes?: string,
//   mode?: 'send' | 'test'    // default 'send'; 'test' routes to TEST_INBOX
// }
//
// Behavior:
//   - UPSERTs assignment_substitutions on the unique (parent_assignment_id,
//     parent_assignment_type, date). Reassigning a different sub on the same
//     date replaces the row and resets status to 'pending'. Resending the
//     same sub refreshes email_sent_at.
//   - Sends one email via Resend, then writes email_sent_at = now().
//   - Multi-tenant: parent's org is the source of truth; sub_instructor's
//     org must match (validate trigger enforces this server-side, we also
//     check up front to give a friendly error).
//
// Auth: caller must be owner/admin of the parent assignment's org.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from '../_shared/logPlatformEvent.ts';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';

// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so portal links in offer emails point at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function fmtDate(d: string) {
  const date = new Date(`${d}T00:00:00`);
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtTime(t: string | null) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? 'pm' : 'am';
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, '0')}${ampm}`;
}

function escapeHtml(s: string | null | undefined) {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Body {
  parent_assignment_id?: string;
  parent_assignment_type?: 'camp' | 'program';
  date?: string;
  sub_instructor_id?: string;
  sub_tier?: 'lead' | 'developing';
  notes?: string;
  mode?: 'send' | 'test';
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'auth_required' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'auth_required' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'invalid_auth' }, 401);
    const callerAuthId = userData.user.id;

    let body: Body = {};
    try { body = (await req.json()) as Body; } catch { return json({ error: 'invalid_body' }, 400); }

    const parentId = (body.parent_assignment_id || '').trim();
    const parentType = body.parent_assignment_type;
    const date = (body.date || '').trim();
    const subInstructorId = (body.sub_instructor_id || '').trim();
    const subTier = body.sub_tier;
    const notes = (body.notes || '').toString().trim().slice(0, 1000);
    const mode = body.mode === 'test' ? 'test' : 'send';

    if (!parentId) return json({ error: 'missing_parent_assignment_id' }, 400);
    if (parentType !== 'camp' && parentType !== 'program') return json({ error: 'invalid_parent_assignment_type' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'invalid_date' }, 400);
    if (!subInstructorId) return json({ error: 'missing_sub_instructor_id' }, 400);
    if (subTier !== 'lead' && subTier !== 'developing') return json({ error: 'invalid_sub_tier' }, 400);

    // ── Resolve parent + the org we operate in ────────────────────────────
    let orgId: string;
    let curriculumName = '';
    let startTime: string | null = null;
    let endTime: string | null = null;
    let locationId: string | null = null;
    let locationName: string | null = null;

    if (parentType === 'camp') {
      const { data: parent } = await supabase
        .from('camp_assignments')
        .select('id, organization_id, camp_session_id')
        .eq('id', parentId)
        .maybeSingle();
      if (!parent) return json({ error: 'parent_not_found' }, 404);
      orgId = parent.organization_id;

      const { data: sess } = await supabase
        .from('camp_sessions')
        .select('curriculum_name, start_time, end_time, location_id, location_name')
        .eq('id', parent.camp_session_id)
        .maybeSingle();
      if (sess) {
        curriculumName = sess.curriculum_name ?? '';
        startTime = sess.start_time;
        endTime = sess.end_time;
        locationId = sess.location_id;
        locationName = sess.location_name;
      }
    } else {
      const { data: parent } = await supabase
        .from('program_assignments')
        .select('id, organization_id, program_id')
        .eq('id', parentId)
        .maybeSingle();
      if (!parent) return json({ error: 'parent_not_found' }, 404);
      orgId = parent.organization_id;

      const { data: prog } = await supabase
        .from('programs')
        .select('curriculum, start_time, end_time, program_location_id')
        .eq('id', parent.program_id)
        .maybeSingle();
      if (prog) {
        curriculumName = prog.curriculum ?? '';
        startTime = prog.start_time;
        endTime = prog.end_time;
        locationId = prog.program_location_id;
      }
    }

    // ── Caller is owner/admin on this org ─────────────────────────────────
    const { data: cm } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', orgId)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cm) return json({ error: 'forbidden' }, 403);

    // ── Sub instructor belongs to same org (server-side trigger also enforces) ──
    const { data: sub } = await supabase
      .from('instructors')
      .select('id, organization_id, first_name, last_name, preferred_name, email')
      .eq('id', subInstructorId)
      .maybeSingle();
    if (!sub) return json({ error: 'sub_not_found' }, 404);
    if (sub.organization_id !== orgId) return json({ error: 'sub_wrong_org' }, 400);
    if (!sub.email) return json({ error: 'sub_missing_email', detail: 'Sub has no email on file.' }, 400);

    // ── Venue context (school name, address, arrival/dismissal) ───────────
    let locationAddress: string | null = null;
    let arrivalInstr: string | null = null;
    let dismissalInstr: string | null = null;
    let roomNumber: string | null = null;
    if (locationId) {
      const { data: loc } = await supabase
        .from('program_locations')
        .select('name, address, arrival_instructions, dismissal_instructions, room_number')
        .eq('id', locationId)
        .maybeSingle();
      if (loc) {
        locationAddress = loc.address;
        arrivalInstr = loc.arrival_instructions;
        dismissalInstr = loc.dismissal_instructions;
        roomNumber = loc.room_number;
        locationName = locationName ?? loc.name;
      }
    }

    // ── Org + branding for sender + sign-off ──────────────────────────────
    const { data: org } = await supabase
      .from('organizations')
      .select('id, name, slug')
      .eq('id', orgId)
      .maybeSingle();
    const { data: branding } = await supabase
      .from('org_branding')
      .select('email_from_name, email_reply_to, primary_color')
      .eq('organization_id', orgId)
      .maybeSingle();

    const primary = branding?.primary_color ?? DEFAULT_PRIMARY;
    const senderFirstName = (branding?.email_from_name ?? org?.name ?? '').split(' ')[0] || 'the team';

    // Tenant brand for the sender line: FROM the tenant's verified/shared-platform
    // address, never the hardcoded J2S domain. Loaded once (single-email fn).
    const brand = await loadOrgBrand(supabase, orgId);

    // ── UPSERT assignment_substitutions row ───────────────────────────────
    const { data: subRow, error: upsertErr } = await supabase
      .from('assignment_substitutions')
      .upsert({
        parent_assignment_id: parentId,
        parent_assignment_type: parentType,
        sub_instructor_id: subInstructorId,
        date,
        status: 'pending',
        sub_tier: subTier,
        notes: notes || null,
        assigned_by: callerAuthId,
        assigned_at: new Date().toISOString(),
        organization_id: orgId,
      }, { onConflict: 'parent_assignment_id,parent_assignment_type,date' })
      .select('id')
      .single();
    if (upsertErr || !subRow) {
      console.error('[create-assignment-substitution] upsert failed:', upsertErr);
      return json({ error: 'upsert_failed', detail: upsertErr?.message }, 500);
    }
    const substitutionId = (subRow as { id: string }).id;

    // ── Compose email ────────────────────────────────────────────────────
    const subFirst = sub.preferred_name || sub.first_name || 'there';
    const friendlyDate = fmtDate(date);
    const timeRange = startTime && endTime ? `${fmtTime(startTime)}–${fmtTime(endTime)}` : (startTime ? fmtTime(startTime) : '');
    const venueDisplay = [locationName, roomNumber ? `Room ${roomNumber}` : null].filter(Boolean).join(' · ');
    // Tenant slug must come from org_branding/organizations. No hardcoded
    // fallback — a misconfigured org should surface as a missing link, not
    // a quiet route to the wrong tenant.
    const portalUrl = org?.slug ? `${PUBLIC_SITE_URL}/${org.slug}/instructor` : PUBLIC_SITE_URL;

    const detailRow = (label: string, value: string | null | undefined) => {
      if (!value) return '';
      return `<tr><td style="padding:6px 0;color:${MUTED};font-size:13px;width:120px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;color:${TEXT};font-size:14px;">${escapeHtml(value)}</td></tr>`;
    };

    const subject = `Can you sub on ${friendlyDate.replace(/^[A-Za-z]+, /, '')}?`;

    const html = `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${TEXT};">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Hi ${escapeHtml(subFirst)},</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Looking for a sub for <strong>${escapeHtml(curriculumName || 'a class')}</strong> on <strong>${escapeHtml(friendlyDate)}</strong> — would you be able to take it?</p>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid ${BORDER};border-radius:8px;padding:14px 18px;margin:14px 0 18px;">
      ${detailRow('Program', curriculumName)}
      ${detailRow('Date', friendlyDate)}
      ${detailRow('Time', timeRange)}
      ${detailRow('Where', venueDisplay)}
      ${detailRow('Address', locationAddress)}
      ${detailRow('Arrival', arrivalInstr)}
      ${detailRow('Dismissal', dismissalInstr)}
      ${detailRow('Notes', notes)}
      ${detailRow('Role', subTier === 'lead' ? 'Lead' : 'Developing')}
    </table>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Open your portal to accept or decline — once you accept, you'll see the lesson plan and the day's roster.</p>
    <p style="margin:18px 0 22px;"><a href="${portalUrl}" style="background:${primary};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block;">Open your portal</a></p>
    <p style="font-size:14px;line-height:1.55;color:${MUTED};margin:0 0 6px;">If this day doesn't work, just decline in the portal and I'll find someone else — no harm done.</p>
    <p style="font-size:14px;line-height:1.55;margin:18px 0 0;">— ${escapeHtml(senderFirstName)} @ ${escapeHtml(org?.name ?? '')}</p>
  </div>
</body></html>`;

    const textParts = [
      `Hi ${subFirst},`,
      ``,
      `Looking for a sub for ${curriculumName || 'a class'} on ${friendlyDate} — would you be able to take it?`,
      ``,
      `Program: ${curriculumName}`,
      `Date: ${friendlyDate}`,
      timeRange ? `Time: ${timeRange}` : '',
      venueDisplay ? `Where: ${venueDisplay}` : '',
      locationAddress ? `Address: ${locationAddress}` : '',
      arrivalInstr ? `Arrival: ${arrivalInstr}` : '',
      dismissalInstr ? `Dismissal: ${dismissalInstr}` : '',
      notes ? `Notes: ${notes}` : '',
      `Role: ${subTier === 'lead' ? 'Lead' : 'Developing'}`,
      ``,
      `Open your portal to accept or decline — once you accept, you'll see the lesson plan and the day's roster:`,
      portalUrl,
      ``,
      `If this day doesn't work, just decline in the portal and I'll find someone else — no harm done.`,
      ``,
      `— ${senderFirstName} @ ${org?.name ?? ''}`,
    ].filter(Boolean);
    const text = textParts.join('\n');

    // ── Send via Resend ───────────────────────────────────────────────────
    const fromEmail = formatFromAddress(brand);
    const recipient = mode === 'test' ? TEST_INBOX : sub.email;
    const subjectOut = mode === 'test' ? `[TEST] ${subject}` : subject;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipient,
        reply_to: brand.reply_to,
        subject: subjectOut,
        html,
        text,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[create-assignment-substitution] resend failed:', resp.status, errText);
      // Row already exists; surface the failure but leave the row in place so admin can retry.
      return json({ error: 'email_failed', detail: errText.slice(0, 300) }, 502);
    }

    // ── Mark email_sent_at — the artifact column that gates the "Resent"
    //    button state in the modal. Only this edge fn writes it.
    await supabase
      .from('assignment_substitutions')
      .update({ email_sent_at: new Date().toISOString() })
      .eq('id', substitutionId);

    // Only a real send counts as usage (matches send-offers / invite-parents /
    // matcher guards). Test-fires still upsert the row but aren't production use.
    if (mode === 'send') {
      await logPlatformEvent(supabase, {
        feature: FEATURE.SCHEDULING, action: ACTION.SUB_ASSIGNED, outcome: OUTCOME.SUCCESS,
        organizationId: orgId, actorUserId: callerAuthId,
        metadata: { substitution_id: substitutionId },
      });
    }
    return json({
      ok: true,
      substitution_id: substitutionId,
      recipient,
      mode,
    });
  } catch (err) {
    console.error('[create-assignment-substitution] fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});
