// create-assignment-substitution: admin assigns a single-day sub to cover a
// camp or afterschool session, and we send the sub an Ennie-voiced offer
// email with the day's venue + program details.
//
// Input: {
//   parent_assignment_id: string,
//   parent_assignment_type: 'camp' | 'program',
//   date: 'YYYY-MM-DD',
//   sub_instructor_id?: string,     // one candidate (the shape the picker sent before multi-offer)
//   sub_instructor_ids?: string[],  // several candidates, first to accept wins; wins if both are sent
//   sub_tier: 'lead' | 'developing',
//   notes?: string,
//   mode?: 'send' | 'test'    // default 'send'; 'test' routes to test_recipient (else the tenant's OWN inbox)
//                             // and writes NO offer row: it proves the wording, it does not ask anybody.
//   test_recipient?: string   // test-mode override inbox; defaults to the tenant's OWN inbox.
//                             // Refuses with 400 no_tenant_inbox when the org has neither, rather
//                             // than falling back to the platform address and mailing us the detail.
// }
//
// Behavior:
//   - Writes ONE offer row PER PERSON asked, and emails each of them. Several
//     people can hold a live offer on the same class-day; the first to accept
//     gets it and the rest are closed out by accept_sub_offer.
//   - Re-asking somebody who already has a live offer REFRESHES that offer
//     rather than adding a second. Re-asking somebody who DECLINED creates a
//     new live offer beside the decline: the refusal is history and is never
//     overwritten. (It used to be. The old upsert on (parent, type, date) held
//     one row per class-day, so offering a refused day to the next person
//     destroyed the record that anyone had said no, and the day quietly went
//     back to reading "waiting to hear back".)
//   - Refuses when somebody has already ACCEPTED the day, rather than sending
//     offers that could never be taken up.
//   - Multi-tenant: parent's org is the source of truth; sub_instructor's
//     org must match (validate trigger enforces this server-side, we also
//     check up front to give a friendly error).
//
// Auth: caller must be owner/admin of the parent assignment's org.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { logPlatformEvent, FEATURE, ACTION, OUTCOME } from '../_shared/logPlatformEvent.ts';
import { loadOrgBrand, formatFromAddress, resolveTestRecipient, NO_TENANT_INBOX_MESSAGE } from '../_shared/orgBrand.ts';
import { roomDisplay } from '../_shared/roomLabel.ts';

// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so portal links in offer emails point at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

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
  const raw = t.trim();
  let h: number;
  let m: number;
  // Programs store 12-hour text ("3:30 PM"); camps store 24-hour time
  // ("12:30:00"). Parse both so after-school sub offers don't render "NaN".
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
  if (Number.isNaN(h) || Number.isNaN(m)) return raw; // show raw, never "NaN"
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
  /** One candidate. Still accepted: the picker sent this shape before multi-offer. */
  sub_instructor_id?: string;
  /** Several candidates, first to accept gets the day. Wins if both are sent. */
  sub_instructor_ids?: string[];
  sub_tier?: 'lead' | 'developing';
  notes?: string;
  mode?: 'send' | 'test';
  test_recipient?: string;
}

// An operator picking from a short list of colleagues; the cap exists so a
// malformed client cannot fan a single click into hundreds of emails.
const MAX_CANDIDATES = 12;

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
    // One offer or several. Deduped, because asking the same person twice in one
    // click would be two emails and two rows for one human, and every count this
    // feeds ("3 people asked") is about people.
    const rawCandidates = Array.isArray(body.sub_instructor_ids) && body.sub_instructor_ids.length
      ? body.sub_instructor_ids
      : [body.sub_instructor_id];
    const candidateIds = [...new Set(
      rawCandidates.map((id) => (id || '').toString().trim()).filter(Boolean),
    )];
    const subTier = body.sub_tier;
    const notes = (body.notes || '').toString().trim().slice(0, 1000);
    const mode = body.mode === 'test' ? 'test' : 'send';
    const testRecipient = body.test_recipient; // test-mode override; else the tenant's OWN inbox, or null -> refuse

    if (!parentId) return json({ error: 'missing_parent_assignment_id' }, 400);
    if (parentType !== 'camp' && parentType !== 'program') return json({ error: 'invalid_parent_assignment_type' }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'invalid_date' }, 400);
    if (candidateIds.length === 0) return json({ error: 'missing_sub_instructor_id' }, 400);
    if (candidateIds.length > MAX_CANDIDATES) {
      return json({ error: 'too_many_candidates', detail: `Ask at most ${MAX_CANDIDATES} people at once.` }, 400);
    }
    // A test send names one person and goes to the tenant's own inbox. Asking
    // what a three-person test means invents semantics nobody requested.
    if (mode === 'test' && candidateIds.length > 1) {
      return json({ error: 'test_send_is_single', detail: 'Send a test to one person at a time.' }, 400);
    }
    if (subTier !== 'lead' && subTier !== 'developing') return json({ error: 'invalid_sub_tier' }, 400);

    // ── Resolve parent + the org we operate in ────────────────────────────
    let orgId: string;
    let curriculumName = '';
    let startTime: string | null = null;
    let endTime: string | null = null;
    let locationId: string | null = null;
    let locationName: string | null = null;
    // The class's own room, for a PROGRAM sub. Camps have no room of their own,
    // so it stays null there and the site room is used - unchanged behaviour.
    let classRoom: string | null = null;

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
        // `room` added 2026-08-25: this email told a sub the SITE room, which at
        // Happy Valley Library is the summer camp room, not the after-school one.
        // A sub has most likely never been in the building.
        .select('curriculum, start_time, end_time, program_location_id, room')
        .eq('id', parent.program_id)
        .maybeSingle();
      if (prog) {
        curriculumName = prog.curriculum ?? '';
        startTime = prog.start_time;
        endTime = prog.end_time;
        locationId = prog.program_location_id;
        classRoom = prog.room ?? null;
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

    // ── Every candidate belongs to this org and can be emailed ────────────
    // Validated as a BATCH before anybody is contacted. Asking two of three and
    // reporting a problem with the third would leave the operator unable to tell
    // who is holding an offer, so one bad candidate refuses the whole click.
    const { data: subs, error: subsErr } = await supabase
      .from('instructors')
      .select('id, organization_id, first_name, last_name, preferred_name, email')
      .in('id', candidateIds);
    if (subsErr) {
      console.error('[create-assignment-substitution] candidate lookup failed:', subsErr);
      return json({ error: 'candidate_lookup_failed', detail: subsErr.message }, 500);
    }
    const byId = new Map((subs ?? []).map((s) => [s.id, s]));
    const candidates = candidateIds.map((id) => byId.get(id));
    if (candidates.some((s) => !s)) return json({ error: 'sub_not_found' }, 404);
    if (candidates.some((s) => s!.organization_id !== orgId)) return json({ error: 'sub_wrong_org' }, 400);
    const noEmail = candidates.filter((s) => !s!.email);
    if (noEmail.length > 0) {
      return json({
        error: 'sub_missing_email',
        detail: noEmail.length === 1
          ? `${noEmail[0]!.preferred_name || noEmail[0]!.first_name || 'That instructor'} has no email on file.`
          : `${noEmail.length} of the people you picked have no email on file.`,
      }, 400);
    }

    // ── Is the day already settled? ───────────────────────────────────────
    // Somebody confirmed (or already taught) means the day is covered, and a
    // fresh offer would ask people to cover a class that has a teacher. Refuse
    // rather than create offers that can never be accepted: the single-settled
    // index would reject the winner anyway, but an operator deserves the reason.
    const { data: settled, error: settledErr } = await supabase
      .from('assignment_substitutions')
      .select('id, sub_instructor_id')
      .eq('parent_assignment_id', parentId)
      .eq('parent_assignment_type', parentType)
      .eq('date', date)
      .in('status', ['confirmed', 'taught'])
      .limit(1);
    if (settledErr) {
      console.error('[create-assignment-substitution] settled check failed:', settledErr);
      return json({ error: 'settled_check_failed', detail: settledErr.message }, 500);
    }
    // Refused in TEST mode too. A test writes no row now, but the wording it
    // produces says "can you cover this?" about a class that already has a
    // teacher, and an operator reading that back has been told something false
    // about the day.
    if (settled && settled.length > 0) {
      return json({
        error: 'already_covered',
        detail: 'Somebody has already accepted this day. Release their cover first if you need a different person.',
      }, 409);
    }

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

    // ── One offer row PER PERSON ──────────────────────────────────────────
    // This used to upsert on (parent, type, date), which meant a class-day held
    // exactly one row and re-offering a refused day OVERWROTE the refusal: the
    // decline was destroyed, the day went back to reading "waiting to hear
    // back", and nothing anywhere recorded that anyone had said no. Now each
    // person gets their own row, so a decline survives the next ask.
    //
    // Re-asking the SAME person is a resend, not a second offer: their existing
    // live row is refreshed rather than duplicated (the partial unique index on
    // pending offers enforces that in the database too). A row they previously
    // DECLINED is left untouched and a new live one is created beside it, which
    // is what lets "Ann said no, then said yes when I asked again" be true.
    const nowIso = new Date().toISOString();
    const { data: existingRows, error: existingErr } = await supabase
      .from('assignment_substitutions')
      .select('id, sub_instructor_id, status, email_sent_at')
      .eq('parent_assignment_id', parentId)
      .eq('parent_assignment_type', parentType)
      .eq('date', date)
      .in('sub_instructor_id', candidateIds);
    if (existingErr) {
      console.error('[create-assignment-substitution] existing lookup failed:', existingErr);
      return json({ error: 'existing_lookup_failed', detail: existingErr.message }, 500);
    }
    const livePendingByInstructor = new Map(
      (existingRows ?? [])
        .filter((r) => r.status === 'pending')
        .map((r) => [r.sub_instructor_id, { id: r.id }]),
    );

    // Get the row this offer will live on, WITHOUT yet writing anything a failed
    // send would make untrue.
    //
    // A refresh is deliberately not written here. The offer email states the
    // ROLE, so writing "developing" onto the row before the email goes means a
    // bounced resend leaves the row saying developing while the only message the
    // instructor ever received says lead — and the role on the row is what
    // payroll pays. Clearing the stamp instead was tried and is worse: it erases
    // a real earlier email from their contact history and turns the button back
    // into "Send offer", which is how somebody gets asked twice. So the terms
    // are written only once the email carrying them has actually gone.
    async function rowForCandidate(instructorId: string): Promise<{ id: string; isRefresh: boolean } | { error: string }> {
      const existingId = livePendingByInstructor.get(instructorId)?.id;
      if (existingId) return { id: existingId, isRefresh: true };
      const { data, error } = await supabase
        .from('assignment_substitutions')
        .insert({
          parent_assignment_id: parentId,
          parent_assignment_type: parentType,
          sub_instructor_id: instructorId,
          date,
          status: 'pending',
          sub_tier: subTier,
          notes: notes || null,
          assigned_by: callerAuthId,
          assigned_at: nowIso,
          organization_id: orgId,
        })
        .select('id')
        .single();
      if (error || !data) {
        // 23505 has two possible causes and the message must not assert one:
        // the one-offer-per-day rule still being in place (the function reached
        // an environment ahead of its migration), or two admins asking the same
        // person for the same day at the same moment on a fully-migrated one.
        // Both are "somebody already holds this", and a retry is the right move.
        if ((error as { code?: string } | null)?.code === '23505') {
          return { error: 'Somebody already holds an offer for this class day. Refresh and check who before asking again.' };
        }
        return { error: error?.message ?? 'insert returned no row' };
      }
      return { id: (data as { id: string }).id, isRefresh: false };
    }

    // ── Compose email ────────────────────────────────────────────────────
    // Everything that does not depend on WHO is being asked is built once; the
    // greeting and the recipient are the only per-person parts.
    const friendlyDate = fmtDate(date);
    const timeRange = startTime && endTime ? `${fmtTime(startTime)}–${fmtTime(endTime)}` : (startTime ? fmtTime(startTime) : '');
    // Through the shared rule: the class's room beats the site's, and the label
    // arrives already worded (no "Room Makerspace", no "Room Room 111").
    const venueDisplay = [locationName, roomDisplay(classRoom, roomNumber)].filter(Boolean).join(' · ');
    // Tenant slug must come from org_branding/organizations. No hardcoded
    // fallback — a misconfigured org should surface as a missing link, not
    // a quiet route to the wrong tenant.
    const portalUrl = org?.slug ? `${PUBLIC_SITE_URL}/${org.slug}/instructor` : PUBLIC_SITE_URL;

    const detailRow = (label: string, value: string | null | undefined) => {
      if (!value) return '';
      return `<tr><td style="padding:6px 0;color:${MUTED};font-size:13px;width:120px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:6px 0;color:${TEXT};font-size:14px;">${escapeHtml(value)}</td></tr>`;
    };

    const subject = `Can you sub on ${friendlyDate.replace(/^[A-Za-z]+, /, '')}?`;
    const fromEmail = formatFromAddress(brand);

    // Everyone asked gets the same offer, addressed to them. Declared as a
    // function so the whole compose-and-send path is identical for one person
    // and for five — the multi-offer case is not a second code path.
    // substitutionId is NULL for a test send, which deliberately writes no row
    // at all. A test used to insert a real pending offer against the named
    // instructor while the [TEST] email went to the tenant's own inbox, so the
    // instructor - who never received anything - could open their portal, find
    // a live offer with Accept and Decline on it, and accept. That confirmed
    // them for real and fired the 3-way coordination email for real. A test
    // must not be able to staff a class.
    async function offerTo(cand: { id: string; preferred_name?: string | null; first_name?: string | null; email?: string | null }, substitutionId: string | null, isRefresh: boolean) {
    const subFirst = cand.preferred_name || cand.first_name || 'there';

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
    const recipient = mode === 'test' ? resolveTestRecipient(brand, testRecipient) : cand.email;
    // A test offer names the sub, the class and the date. resolveTestRecipient
    // returns null rather than cascading to the platform, so refuse here: the
    // old fallback mailed one provider's substitution detail to Enrops while
    // the modal reported a successful test. Nothing needs undoing - a test
    // writes no row - so the admin can fix the address and retry.
    if (mode === 'test' && !recipient) {
      console.error('[create-assignment-substitution] test send refused, org has no inbox of its own', {
        organization_id: orgId,
        substitution_id: substitutionId,
      });
      return { error: 'no_tenant_inbox', message: NO_TENANT_INBOX_MESSAGE, status: 400 };
    }
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
      // The email did NOT go, so this person has not been asked. A row left
      // behind here says otherwise everywhere it is read: the modal renders
      // "Offered, waiting" beside their name, the board counts them in "N
      // people asked", and get_sub_coverage files the day as 'awaiting', its
      // calm state, for a class nobody has been contacted about. The operator's
      // one correct move is to ask somebody else, and the screen talks them out
      // of it.
      //
      // Only a row THIS call created is removed. A refresh's row is a real
      // earlier offer with a real email behind it; deleting that would destroy
      // the record of a message the instructor actually received. Guarded on
      // pending + no stamp so a row that somehow got used in the meantime is
      // left alone.
      if (substitutionId && !isRefresh) {
        const { error: cleanupErr } = await supabase
          .from('assignment_substitutions')
          .delete()
          .eq('id', substitutionId)
          .eq('status', 'pending')
          .is('email_sent_at', null);
        if (cleanupErr) {
          console.error('[create-assignment-substitution] could not remove the un-emailed offer row:', cleanupErr, { substitution_id: substitutionId });
        }
      }
      return { error: 'email_failed', detail: errText.slice(0, 300), status: 502 };
    }

    // ── Mark email_sent_at — the artifact column that gates the "Resent"
    //    button state in the modal. Only this edge fn writes it.
    //
    // The error is CHECKED, because by this point the email HAS gone. A silent
    // failure here leaves the row looking un-emailed, so the modal offers to
    // send again and the same person gets a second identical offer — while the
    // first one is missing from their contact history, which filters on this
    // very column. Report it instead: the offer stands, the record does not.
    // The terms ride along with the stamp on a refresh: the email that just went
    // is the one that describes them, so they become true at exactly the moment
    // it does. A new row already carries them from its insert.
    //
    // GUARDED ON pending, not on id alone. The settled check ran three round
    // trips and a Resend call ago, and a class-day can now be held by several
    // people at once. In that gap the offer can be ACCEPTED - the sub taps
    // Accept on their phone while the admin is resending with a different tier
    // - and an id-only write would then stamp the new sub_tier and a fresh
    // assigned_at onto a confirmed row. sub_tier is what v_effective_pay_lines
    // reads as effective_tier, so that silently re-prices a class-day somebody
    // has already agreed to teach, at a rate no email ever quoted them.
    if (!substitutionId) return { ok: true, substitution_id: null, recipient };
    const stampedAt = new Date().toISOString();
    const { data: stampedRows, error: stampErr } = await supabase
      .from('assignment_substitutions')
      .update(isRefresh
        ? {
            sub_tier: subTier, notes: notes || null,
            assigned_by: callerAuthId, assigned_at: nowIso,
            email_sent_at: stampedAt,
          }
        : { email_sent_at: stampedAt })
      .eq('id', substitutionId)
      .eq('status', 'pending')
      .select('id');
    if (stampErr) {
      console.error('[create-assignment-substitution] email_sent_at stamp failed:', stampErr, { substitution_id: substitutionId });
      return {
        error: 'sent_but_unrecorded',
        detail: `The offer email went to ${recipient}, but we could not record that it was sent. Do not send it again — check with them directly.`,
        status: 500,
      };
    }
    if (!stampedRows || stampedRows.length === 0) {
      // The offer settled while this email was in flight. The TERMS must not be
      // written - the row already describes what that person agreed to - but
      // the email is a fact that happened, and the column it lives in is what
      // the modal reads to decide between "Send offer" and "Resend". Leaving it
      // blank is how the same person gets asked twice.
      const { error: factErr } = await supabase
        .from('assignment_substitutions')
        .update({ email_sent_at: stampedAt })
        .eq('id', substitutionId);
      if (factErr) {
        console.error('[create-assignment-substitution] settled-row stamp failed:', factErr, { substitution_id: substitutionId });
      }
      console.warn('[create-assignment-substitution] offer settled mid-send; terms not re-written', {
        substitution_id: substitutionId,
      });
      // Reported, not swallowed. The email that just landed quotes the NEW
      // terms and the row still holds the old ones, and the row is what payroll
      // reads. An operator who changed the tier and saw a clean "sent" would
      // believe they had re-priced the day.
      return {
        ok: true, substitution_id: substitutionId, recipient,
        terms_not_applied: true,
      };
    }

    return { ok: true, substitution_id: substitutionId, recipient };
    }   // end offerTo

    // ── Ask everybody who was picked ──────────────────────────────────────
    // Sequential, not parallel: each send writes a row and the failure of one
    // must not leave the others half-reported. The first hard failure stops the
    // round and says who was already asked, so an operator is never left
    // guessing which of five people is holding an offer.
    const asked: Array<{ instructor_id: string; substitution_id: string | null; recipient: string }> = [];
    // People whose offer settled while their resend was in flight, so the email
    // they just received quotes terms the row does not carry.
    const termsNotApplied: string[] = [];

    // Usage is recorded for what ACTUALLY happened, on every exit, not only on
    // the clean one. This used to sit after the loop, past both of its early
    // returns, so a round that emailed two people and then hit a Resend failure
    // on the third logged nothing at all - two real offer emails with no
    // receipt anywhere that they were sent.
    async function logRound(ok: boolean) {
      if (mode !== 'send' || asked.length === 0) return;
      await logPlatformEvent(supabase, {
        feature: FEATURE.SCHEDULING, action: ACTION.SUB_ASSIGNED,
        outcome: ok ? OUTCOME.SUCCESS : OUTCOME.FAIL,
        organizationId: orgId, actorUserId: callerAuthId,
        metadata: {
          substitution_ids: asked.map((a) => a.substitution_id),
          asked_count: asked.length,
          candidate_count: candidates.length,
        },
      });
    }

    for (const cand of candidates as Array<NonNullable<typeof candidates[number]>>) {
      // A test writes no row: it only proves what the email looks like. See the
      // note on offerTo - a test used to leave a live, acceptable offer sitting
      // in a real instructor's portal.
      let rowId: string | null = null;
      let rowIsRefresh = false;
      if (mode === 'send') {
        const row = await rowForCandidate(cand.id);
        if ('error' in row) {
          console.error('[create-assignment-substitution] row write failed:', row.error);
          await logRound(false);
          return json({
            error: 'offer_write_failed', detail: row.error,
            asked, asked_count: asked.length,
          }, 500);
        }
        rowId = row.id;
        rowIsRefresh = row.isRefresh;
      }
      // The Resend call inside offerTo is a bare fetch: a DNS failure or a
      // timeout THROWS rather than returning !resp.ok, and the outer catch
      // cannot see `asked`. Without this, the exact case logRound was written
      // for - two people emailed, the third failing - would leave no usage row
      // and tell the operator nothing about who already holds an offer.
      let sent: Awaited<ReturnType<typeof offerTo>>;
      try {
        sent = await offerTo(cand, rowId, rowIsRefresh);
      } catch (e) {
        console.error('[create-assignment-substitution] send threw:', e);
        await logRound(false);
        return json({
          error: 'email_failed',
          detail: (e as Error).message || 'The offer email could not be sent.',
          asked, asked_count: asked.length,
        }, 502);
      }
      if ('error' in sent) {
        // 'sent_but_unrecorded' means the email DID go — count that person as
        // asked, or the operator is told fewer were contacted than really were
        // and may re-send to somebody who already has it. Every other failure
        // means no email went, and a refresh's row is untouched: its old terms
        // and old stamp still describe the last message that really was sent.
        if (sent.error === 'sent_but_unrecorded') {
          asked.push({ instructor_id: cand.id, substitution_id: rowId, recipient: cand.email! });
        }
        await logRound(false);
        return json({ ...sent, asked, asked_count: asked.length }, sent.status ?? 502);
      }
      asked.push({ instructor_id: cand.id, substitution_id: sent.substitution_id, recipient: sent.recipient! });
      if ((sent as { terms_not_applied?: boolean }).terms_not_applied) {
        termsNotApplied.push(cand.preferred_name || cand.first_name || 'Somebody');
      }
    }

    // Only a real send counts as usage (matches send-offers / invite-parents /
    // matcher guards). A test writes no row and is not production use.
    await logRound(true);
    return json({
      ok: true,
      // Single-candidate shape kept so the existing picker keeps working
      // unchanged: it reads substitution_id and recipient off the response.
      substitution_id: asked[0]?.substitution_id ?? null,
      recipient: asked[0]?.recipient ?? null,
      asked,
      asked_count: asked.length,
      // Named, not a bare flag: the operator has to know WHOSE terms did not
      // take, because that person is the one holding a message that disagrees
      // with what payroll will pay.
      terms_not_applied: termsNotApplied,
      mode,
    });
  } catch (err) {
    console.error('[create-assignment-substitution] fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});
