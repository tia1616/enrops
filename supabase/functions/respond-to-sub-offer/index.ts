// respond-to-sub-offer — the only write path for a sub to accept or decline
// the day they were offered via create-assignment-substitution.
//
// Input: { substitution_id: string, action: 'accept' | 'decline', decline_reason?: string }
//
// Behavior:
//   - Verifies caller is the sub_instructor on the row (anti-enumeration:
//     same 403 for missing row + belongs-to-someone-else).
//   - Verifies status === 'pending' (already_responded otherwise).
//   - 'accept'  -> status='confirmed'.
//   - 'decline' -> status='declined', declined_at=now(), decline_reason (optional).
//                  Sends an Ennie-voiced email to the org's alert_email so an
//                  admin can find another sub. No auto-cascade per project rule.
//
// The column-restriction trigger from PR 3.5 lets the sub UPDATE status,
// decline_reason, declined_at, email_viewed_at — we never touch anything
// else on the row, so we stay within that whitelist.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, resolveInstructor, adminClient } from '../_shared/instructor.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so links in the decline-notification email point at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

interface Body {
  substitution_id?: string;
  action?: 'accept' | 'decline';
  decline_reason?: string;
}

function fmtDate(d: string) {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function escapeHtml(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const { instructor, error } = await resolveInstructor(req);
    if (error) return error;
    const me = instructor!;

    let body: Body;
    try { body = (await req.json()) as Body; } catch { return json({ error: 'invalid_body' }, 400); }

    const substitutionId = (body.substitution_id || '').trim();
    const action = body.action;
    const declineReason = (body.decline_reason || '').toString().trim().slice(0, 1000);

    if (!substitutionId) return json({ error: 'missing_substitution_id' }, 400);
    if (action !== 'accept' && action !== 'decline') return json({ error: 'invalid_action' }, 400);

    const supabase = adminClient();

    const { data: subRow, error: rowErr } = await supabase
      .from('assignment_substitutions')
      .select('id, sub_instructor_id, status, parent_assignment_id, parent_assignment_type, date, sub_tier, organization_id')
      .eq('id', substitutionId)
      .maybeSingle();
    if (rowErr) {
      console.error('[respond-to-sub-offer] lookup failed:', rowErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    // Anti-enumeration: 403 for both missing row and not-yours.
    if (!subRow || subRow.sub_instructor_id !== me.id) {
      return json({ error: 'forbidden' }, 403);
    }
    if (subRow.status !== 'pending') {
      return json({ error: 'already_responded', current_status: subRow.status }, 400);
    }

    const nowIso = new Date().toISOString();

    if (action === 'accept') {
      const { error: updErr } = await supabase
        .from('assignment_substitutions')
        .update({ status: 'confirmed', updated_at: nowIso })
        .eq('id', substitutionId);
      if (updErr) {
        console.error('[respond-to-sub-offer] accept update failed:', updErr);
        return json({ error: 'update_failed', detail: updErr.message }, 500);
      }

      // ── 3-way coordination email ──
      // TO: regular instructor + sub.
      // CC: org's alert_email (admin) so reply-all loops them in too.
      // Middle paragraph (materials handoff / lesson sync) is tenant-
      // configurable via organizations.sub_coordination_notes — empty =
      // skip that paragraph entirely.
      try {
        await sendCoordinationEmail(supabase, subRow, me);
      } catch (e) {
        // Email failure shouldn't fail the accept — the sub IS accepted,
        // log loudly so admin can manually loop the regular if needed.
        console.error('[respond-to-sub-offer] coordination email failed:', e);
      }

      return json({ ok: true, status: 'confirmed' });
    }

    // ── decline path ──
    const { error: updErr } = await supabase
      .from('assignment_substitutions')
      .update({
        status: 'declined',
        declined_at: nowIso,
        decline_reason: declineReason || null,
        updated_at: nowIso,
      })
      .eq('id', substitutionId);
    if (updErr) {
      console.error('[respond-to-sub-offer] decline update failed:', updErr);
      return json({ error: 'update_failed', detail: updErr.message }, 500);
    }

    // ── notify admin ──
    // Gather context for the email: org, sub name, parent assignment's
    // camp_session or program (curriculum + location).
    const [{ data: org }, { data: branding }] = await Promise.all([
      supabase.from('organizations').select('name, slug, alert_email').eq('id', subRow.organization_id).maybeSingle(),
      supabase.from('org_branding').select('email_from_name, email_reply_to').eq('organization_id', subRow.organization_id).maybeSingle(),
    ]);

    let curriculumName = '';
    let locationName: string | null = null;
    if (subRow.parent_assignment_type === 'camp') {
      const { data: parent } = await supabase
        .from('camp_assignments')
        .select('camp_session_id')
        .eq('id', subRow.parent_assignment_id)
        .maybeSingle();
      if (parent?.camp_session_id) {
        const { data: sess } = await supabase
          .from('camp_sessions')
          .select('curriculum_name, location_name')
          .eq('id', parent.camp_session_id)
          .maybeSingle();
        if (sess) {
          curriculumName = sess.curriculum_name ?? '';
          locationName = sess.location_name;
        }
      }
    } else {
      const { data: parent } = await supabase
        .from('program_assignments')
        .select('program_id')
        .eq('id', subRow.parent_assignment_id)
        .maybeSingle();
      if (parent?.program_id) {
        const { data: prog } = await supabase
          .from('programs')
          .select('curriculum, program_location_id')
          .eq('id', parent.program_id)
          .maybeSingle();
        if (prog) {
          curriculumName = prog.curriculum ?? '';
          if (prog.program_location_id) {
            const { data: loc } = await supabase
              .from('program_locations')
              .select('name')
              .eq('id', prog.program_location_id)
              .maybeSingle();
            if (loc) locationName = loc.name;
          }
        }
      }
    }

    const subFullName = [me.first_name, me.last_name].filter(Boolean).join(' ') || 'A sub';
    const friendlyDate = fmtDate(subRow.date);
    const senderFirstName = (branding?.email_from_name ?? org?.name ?? '').split(' ')[0] || 'the team';
    const adminUrl = org?.slug ? `${PUBLIC_SITE_URL}/${org.slug}/admin/schedule` : PUBLIC_SITE_URL;
    const recipient = org?.alert_email;

    if (recipient) {
      const reasonBlock = declineReason
        ? `<p style="font-size:14px;line-height:1.5;color:#1a1a1a;margin:8px 0 14px;padding:10px;background:#FBFBFB;border-left:3px solid #8C88FF;">Reason given: ${escapeHtml(declineReason)}</p>`
        : '';
      const subject = `Sub declined: ${friendlyDate.replace(/^[A-Za-z]+, /, '')} — ${curriculumName || 'a class'}`;
      const html = `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Quick heads-up — <strong>${escapeHtml(subFullName)}</strong> declined the sub offer for <strong>${escapeHtml(curriculumName || 'a class')}</strong>${locationName ? ` at <strong>${escapeHtml(locationName)}</strong>` : ''} on <strong>${escapeHtml(friendlyDate)}</strong>.</p>
    ${reasonBlock}
    <p style="font-size:14px;line-height:1.55;margin:0 0 18px;color:#6b6b6b;">No auto-reassign — open the schedule to pick another sub when you're ready.</p>
    <p style="margin:18px 0 22px;"><a href="${adminUrl}" style="background:#1C004F;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block;">Open the schedule</a></p>
    <p style="font-size:14px;line-height:1.55;margin:0;">— ${escapeHtml(senderFirstName)}</p>
  </div>
</body></html>`;
      const text = [
        `${subFullName} declined the sub offer for ${curriculumName || 'a class'}${locationName ? ` at ${locationName}` : ''} on ${friendlyDate}.`,
        declineReason ? `Reason given: ${declineReason}` : '',
        '',
        `No auto-reassign — open the schedule to pick another sub when you're ready: ${adminUrl}`,
        '',
        `— ${senderFirstName}`,
      ].filter(Boolean).join('\n');

      try {
        const fromName = branding?.email_from_name ?? org?.name ?? 'Enrops';
        const fromEmail = `${fromName} <hello@updates.journeytosteam.com>`;
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: fromEmail,
            to: recipient,
            reply_to: branding?.email_reply_to ?? undefined,
            subject,
            html,
            text,
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          // Don't fail the decline — the row is already updated. Log loudly so
          // admin notices via dashboard if email pipeline is broken.
          console.error('[respond-to-sub-offer] admin notify failed:', r.status, errText.slice(0, 300));
        }
      } catch (e) {
        console.error('[respond-to-sub-offer] admin notify threw:', e);
      }
    } else {
      console.warn('[respond-to-sub-offer] no alert_email on org; admin not notified', { org_id: subRow.organization_id });
    }

    return json({ ok: true, status: 'declined' });
  } catch (err) {
    console.error('[respond-to-sub-offer] fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

// 3-way coordination email fired when a sub ACCEPTS an offer. TO: regular
// + sub. CC: org alert_email (admin). The middle paragraph comes from
// organizations.sub_coordination_notes — tenant-configurable, empty
// string skips it entirely.
async function sendCoordinationEmail(
  supabase: ReturnType<typeof adminClient>,
  subRow: {
    parent_assignment_id: string;
    parent_assignment_type: string;
    date: string;
    organization_id: string;
  },
  me: { id: string; first_name: string | null; last_name: string | null; email: string },
) {
  // Regular instructor (parent's instructor_id) + curriculum/venue context.
  let regularId: string | null = null;
  let curriculumName = '';
  let locationName: string | null = null;
  let campSessionId: string | null = null;
  let programId: string | null = null;
  if (subRow.parent_assignment_type === 'camp') {
    const { data: parent } = await supabase
      .from('camp_assignments').select('instructor_id, camp_session_id')
      .eq('id', subRow.parent_assignment_id).maybeSingle();
    if (!parent) return;
    regularId = parent.instructor_id;
    campSessionId = parent.camp_session_id;
    if (parent.camp_session_id) {
      const { data: sess } = await supabase
        .from('camp_sessions').select('curriculum_name, location_name')
        .eq('id', parent.camp_session_id).maybeSingle();
      if (sess) { curriculumName = sess.curriculum_name ?? ''; locationName = sess.location_name; }
    }
  } else if (subRow.parent_assignment_type === 'program') {
    const { data: parent } = await supabase
      .from('program_assignments').select('instructor_id, program_id')
      .eq('id', subRow.parent_assignment_id).maybeSingle();
    if (!parent) return;
    regularId = parent.instructor_id;
    programId = parent.program_id;
    if (parent.program_id) {
      const { data: prog } = await supabase
        .from('programs').select('curriculum, program_location_id')
        .eq('id', parent.program_id).maybeSingle();
      if (prog) {
        curriculumName = prog.curriculum ?? '';
        if (prog.program_location_id) {
          const { data: loc } = await supabase
            .from('program_locations').select('name')
            .eq('id', prog.program_location_id).maybeSingle();
          if (loc) locationName = loc.name;
        }
      }
    }
  }
  if (!regularId) return;

  const [{ data: regular }, { data: org }, { data: branding }] = await Promise.all([
    supabase.from('instructors').select('first_name, last_name, preferred_name, email').eq('id', regularId).maybeSingle(),
    supabase.from('organizations').select('name, slug, alert_email, sub_coordination_notes').eq('id', subRow.organization_id).maybeSingle(),
    supabase.from('org_branding').select('email_from_name, email_reply_to, primary_color').eq('organization_id', subRow.organization_id).maybeSingle(),
  ]);
  if (!regular?.email) {
    console.warn('[sendCoordinationEmail] regular instructor has no email; skipping');
    return;
  }

  const subFirst = me.first_name || 'the sub';
  const regularFirst = regular.preferred_name || regular.first_name || 'the regular instructor';
  const friendlyDate = fmtDate(subRow.date);
  const senderFirstName = (branding?.email_from_name ?? org?.name ?? '').split(' ')[0] || 'the team';
  const portalUrl = org?.slug ? `${PUBLIC_SITE_URL}/${org.slug}/instructor` : PUBLIC_SITE_URL;
  const coordinationNotes = (org?.sub_coordination_notes || '').trim();

  const subject = `Coordinating ${friendlyDate.replace(/^[A-Za-z]+, /, '')} — ${curriculumName || 'sub day'}${locationName ? ` at ${locationName}` : ''}`;

  const middleParagraphHtml = coordinationNotes
    ? `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;">${escapeHtml(coordinationNotes)}</p>`
    : '';
  const middleParagraphText = coordinationNotes ? `${coordinationNotes}\n\n` : '';

  const html = `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Hi ${escapeHtml(regularFirst)} and ${escapeHtml(subFirst)},</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;"><strong>${escapeHtml(subFirst)}</strong> is covering <strong>${escapeHtml(regularFirst)}</strong>'s class for <strong>${escapeHtml(curriculumName || 'this class')}</strong>${locationName ? ` at <strong>${escapeHtml(locationName)}</strong>` : ''} on <strong>${escapeHtml(friendlyDate)}</strong>.</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">You are both copied on this email so you can communicate. You can exchange phone numbers if you'd like.</p>
    ${middleParagraphHtml}
    <p style="font-size:14px;line-height:1.55;margin:0 0 18px;color:#6b6b6b;">${escapeHtml(subFirst)} — the roster and lesson plan are in your portal: <a href="${portalUrl}" style="color:#1C004F;">${portalUrl}</a></p>
    <p style="font-size:14px;line-height:1.55;margin:18px 0 0;">Please let me know if you have any questions.</p>
    <p style="font-size:14px;line-height:1.55;margin:14px 0 0;">— ${escapeHtml(senderFirstName)} @ ${escapeHtml(org?.name ?? '')}</p>
  </div>
</body></html>`;

  const text = [
    `Hi ${regularFirst} and ${subFirst},`,
    ``,
    `${subFirst} is covering ${regularFirst}'s class for ${curriculumName || 'this class'}${locationName ? ` at ${locationName}` : ''} on ${friendlyDate}.`,
    ``,
    `You are both copied on this email so you can communicate. You can exchange phone numbers if you'd like.`,
    ``,
    middleParagraphText.trim(),
    ``,
    `${subFirst} — the roster and lesson plan are in your portal: ${portalUrl}`,
    ``,
    `Please let me know if you have any questions.`,
    ``,
    `— ${senderFirstName} @ ${org?.name ?? ''}`,
  ].filter((line) => line !== undefined).join('\n');

  // Loop in the OTHER confirmed instructors on this session/program (esp. the
  // LEAD) so whoever is actually on-site with the sub that day knows who's
  // covering — the covered regular (in `to`) is typically the one who's OUT.
  const coEmails: string[] = [];
  if (campSessionId) {
    const { data: coRows } = await supabase
      .from('camp_assignments')
      .select('instructor:instructors(email)')
      .eq('camp_session_id', campSessionId)
      .eq('status', 'confirmed')
      .neq('instructor_id', regularId);
    for (const row of coRows ?? []) {
      const e = (row as { instructor?: { email?: string } }).instructor?.email;
      if (e) coEmails.push(e);
    }
  } else if (programId) {
    const { data: coRows } = await supabase
      .from('program_assignments')
      .select('instructor:instructors(email)')
      .eq('program_id', programId)
      .eq('status', 'confirmed')
      .neq('instructor_id', regularId);
    for (const row of coRows ?? []) {
      const e = (row as { instructor?: { email?: string } }).instructor?.email;
      if (e) coEmails.push(e);
    }
  }

  const fromName = branding?.email_from_name ?? org?.name ?? 'Enrops';
  const fromEmail = `${fromName} <hello@updates.journeytosteam.com>`;
  const replyTo = branding?.email_reply_to ?? org?.alert_email ?? undefined;
  // Normalize for both sending and dedup — emails are effectively
  // case-insensitive and stored with inconsistent case across import paths, so
  // compare lowercased to avoid the same person landing on both To and Cc.
  const norm = (s: string) => s.trim().toLowerCase();
  const to = [norm(regular.email), norm(me.email)];
  const toSet = new Set(to);
  // CC the other co-instructors + the org alert inbox, minus anyone already on `to`.
  const ccSet = new Set<string>();
  for (const e of coEmails) { const n = norm(e); if (!toSet.has(n)) ccSet.add(n); }
  if (org?.alert_email) { const n = norm(org.alert_email); if (!toSet.has(n)) ccSet.add(n); }
  const cc = ccSet.size ? Array.from(ccSet) : undefined;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: fromEmail,
      to,
      cc,
      reply_to: replyTo,
      subject,
      html,
      text,
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`resend ${r.status}: ${errText.slice(0, 300)}`);
  }
}
