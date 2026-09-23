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
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so links in the decline-notification email point at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

interface Body {
  substitution_id?: string;
  action?: 'accept' | 'decline';
  decline_reason?: string;
}

// The one spelling of the race sentinel in this function. accept_sub_offer
// writes it onto the people who were closed out when somebody else accepted
// first; every reader that asks "did this person actually refuse?" compares
// against it. It is a machine value living in a human free-text column, so it
// is written in one place here and refused as input below.
const RESERVED_DECLINE_REASON = 'covered_by_other';

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

    // 'covered_by_other' is how the product records that somebody LOST a race,
    // not that they refused, and six readers treat that exact string as "this
    // person did not really say no". decline_reason is otherwise free text the
    // instructor writes, so the sentinel has to be refused on the way in: a
    // decline carrying it would delete a genuine refusal from the coverage
    // alarm and from the contact timeline.
    //
    // The database trigger refuses it too, but it cannot be the only guard.
    // That trigger waves SERVICE ROLE writes through on purpose (every edge
    // function here is service role, and auth.uid() is null for all of them),
    // so the trigger closes the direct-PATCH route and this closes ours.
    if (declineReason.toLowerCase() === RESERVED_DECLINE_REASON) {
      return json({
        error: 'reserved_decline_reason',
        detail: 'Please word your reason differently - that exact phrase is reserved.',
      }, 400);
    }

    const supabase = adminClient();

    const { data: subRow, error: rowErr } = await supabase
      .from('assignment_substitutions')
      .select('id, sub_instructor_id, status, decline_reason, parent_assignment_id, parent_assignment_type, date, sub_tier, organization_id')
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
      // Somebody else accepted first and this offer was closed out for them.
      // That is NOT "you already responded" — they did not respond at all, and
      // telling them so about a class they were still deciding on is both
      // confusing and slightly insulting. The class simply went to whoever was
      // quicker, which is the whole point of asking several people.
      const coveredByOther = subRow.status === 'declined'
        && subRow.decline_reason === RESERVED_DECLINE_REASON;
      if (coveredByOther) {
        return json({ ok: true, status: 'covered_by_other', already_covered: true });
      }
      return json({ error: 'already_responded', current_status: subRow.status }, 400);
    }

    const nowIso = new Date().toISOString();

    if (action === 'accept') {
      // FIRST YES WINS, decided by the database in one step.
      //
      // A class-day can be offered to several people at once, so two of them can
      // press Accept in the same second. A plain status update would let both
      // through and leave two people believing they have the class — or, once
      // the single-settled index rejects the second, surface a raw constraint
      // error to somebody who did nothing wrong.
      //
      // accept_sub_offer (20260723c, on prod since July and until now called by
      // nothing) confirms this offer, closes the sibling offers in the same
      // transaction, and tells us which way it went. 'lost' is a normal, polite
      // outcome, not an error: somebody was simply faster.
      const { data: outcome, error: acceptErr } = await supabase
        .rpc('accept_sub_offer', { p_substitution_id: substitutionId, p_sub_instructor_id: me.id });
      if (acceptErr) {
        console.error('[respond-to-sub-offer] accept rpc failed:', acceptErr);
        return json({ error: 'update_failed', detail: acceptErr.message }, 500);
      }
      // `losers` is typed in, not cast away. accept_sub_offer builds it on every
      // winning accept for exactly one reason -- its own header says the list is
      // returned "so the edge fn can email them 'already covered'" -- and the
      // narrower cast that used to be here silently dropped it, so the people
      // closed out of a class-day were never told by any channel. They kept a
      // live "Can you sub on Tuesday?" email with a working-looking Accept
      // button for a day that was gone.
      const result = (outcome ?? {}) as {
        outcome?: string;
        status?: string;
        losers?: Array<{
          sub_instructor_id: string;
          email: string | null;
          first_name: string | null;
          preferred_name: string | null;
        }>;
      };
      if (result.outcome === 'time_conflict') {
        // They are already covering another class that overlaps this one. The
        // pickers could not see it: sub_availability_on_date counts only
        // confirmed and taught as busy, so two live offers left this person
        // looking free in both. Refusing here is what stops one of the two
        // rooms being empty.
        return json({
          error: 'time_conflict',
          detail: 'You are already covering another class that overlaps this one. Contact the office if that is wrong.',
        }, 409);
      }
      if (result.outcome === 'lost') {
        // Their own offer has already been closed as covered by the RPC. Tell
        // them plainly rather than failing: they said yes, and the honest answer
        // is that the day was taken, not that something went wrong.
        return json({ ok: true, status: 'covered_by_other', already_covered: true });
      }
      if (result.outcome === 'already_responded') {
        return json({ error: 'already_responded', current_status: result.status }, 400);
      }
      if (result.outcome === 'forbidden') return json({ error: 'forbidden' }, 403);
      if (result.outcome === 'not_found') return json({ error: 'forbidden' }, 403);
      if (result.outcome !== 'won') {
        // An outcome nobody has taught this function about. Refuse rather than
        // report success off a value we do not understand.
        console.error('[respond-to-sub-offer] unrecognised accept outcome:', result);
        return json({ error: 'update_failed', detail: 'unrecognised accept outcome' }, 500);
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

      // ── tell the people who did not get it ──
      // Their offer rows were closed inside accept_sub_offer's transaction, so
      // the card simply disappears from their portal at the next load. Without
      // this they are never told anything at all: the only message they hold is
      // the original ask, and somebody who replied "yes, I'll take it" by email
      // rather than clicking Accept has blocked the afternoon out and may turn
      // up. Same reasoning as the accept path's own consolation notice, for the
      // people who never click.
      try {
        await notifyLosers(supabase, subRow, result.losers ?? []);
      } catch (e) {
        console.error('[respond-to-sub-offer] loser notification failed:', e);
      }

      return json({ ok: true, status: 'confirmed' });
    }

    // ── decline path ──
    // Guarded on status, not on id alone. The pending check at the top of this
    // function ran two round trips ago, and a class-day can now be held by
    // several people at once, so in that gap this very row can move: the sub
    // pressing Accept in another tab confirms it, or somebody else's accept
    // closes it as covered_by_other. An id-only write would then stamp
    // 'declined' over a CONFIRMED row -- silently uncovering a class that three
    // inboxes have already been told is covered -- or wipe the covered_by_other
    // stamp, which is what makes a race loss read as a refusal on the timeline
    // and fires a "they declined" alert for a day somebody is already teaching.
    const { data: declinedRows, error: updErr } = await supabase
      .from('assignment_substitutions')
      .update({
        status: 'declined',
        declined_at: nowIso,
        decline_reason: declineReason || null,
        updated_at: nowIso,
      })
      .eq('id', substitutionId)
      .eq('status', 'pending')
      .select('id');
    if (updErr) {
      console.error('[respond-to-sub-offer] decline update failed:', updErr);
      return json({ error: 'update_failed', detail: updErr.message }, 500);
    }
    if (!declinedRows || declinedRows.length === 0) {
      // Nothing was written, so the row moved underneath us. Re-read and answer
      // for the state it is ACTUALLY in rather than reporting a decline that
      // did not happen and emailing an admin about it.
      const { data: fresh } = await supabase
        .from('assignment_substitutions')
        .select('status, decline_reason')
        .eq('id', substitutionId)
        .maybeSingle();
      if (fresh?.status === 'declined' && fresh.decline_reason === RESERVED_DECLINE_REASON) {
        return json({ ok: true, status: 'covered_by_other', already_covered: true });
      }
      return json({ error: 'already_responded', current_status: fresh?.status ?? null }, 400);
    }

    // ── notify admin ──
    // Gather context for the email: org, sub name, parent assignment's
    // camp_session or program (curriculum + location).
    const [{ data: org }, { data: branding }] = await Promise.all([
      supabase.from('organizations').select('name, slug, alert_email').eq('id', subRow.organization_id).maybeSingle(),
      supabase.from('org_branding').select('email_from_name, email_reply_to').eq('organization_id', subRow.organization_id).maybeSingle(),
    ]);

    const declineCtx = await loadClassContext(
      supabase, subRow.parent_assignment_type, subRow.parent_assignment_id);
    const curriculumName = declineCtx.curriculumName;
    const locationName = declineCtx.locationName;

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
        const brand = await loadOrgBrand(supabase, subRow.organization_id);
        const fromEmail = formatFromAddress(brand);
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            from: fromEmail,
            to: recipient,
            reply_to: brand.reply_to,
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

// What class is this row about? ONE spelling, because this file used to answer
// the question twice with two near-identical blocks (once for the decline
// notice, once inside sendCoordinationEmail) and the loser notice below would
// have made three. Returns empty-ish values rather than throwing: every caller
// is building an email, and a missing curriculum name should degrade the
// wording, never lose the message.
async function loadClassContext(
  supabase: ReturnType<typeof adminClient>,
  parentType: string,
  parentId: string,
): Promise<{
  curriculumName: string;
  locationName: string | null;
  regularId: string | null;
  campSessionId: string | null;
  programId: string | null;
}> {
  const out = {
    curriculumName: '',
    locationName: null as string | null,
    regularId: null as string | null,
    campSessionId: null as string | null,
    programId: null as string | null,
  };

  if (parentType === 'camp') {
    const { data: parent } = await supabase
      .from('camp_assignments').select('instructor_id, camp_session_id')
      .eq('id', parentId).maybeSingle();
    if (!parent) return out;
    out.regularId = parent.instructor_id;
    out.campSessionId = parent.camp_session_id;
    if (parent.camp_session_id) {
      const { data: sess } = await supabase
        .from('camp_sessions').select('curriculum_name, location_name')
        .eq('id', parent.camp_session_id).maybeSingle();
      if (sess) {
        out.curriculumName = sess.curriculum_name ?? '';
        out.locationName = sess.location_name;
      }
    }
    return out;
  }

  if (parentType === 'program') {
    const { data: parent } = await supabase
      .from('program_assignments').select('instructor_id, program_id')
      .eq('id', parentId).maybeSingle();
    if (!parent) return out;
    out.regularId = parent.instructor_id;
    out.programId = parent.program_id;
    if (parent.program_id) {
      const { data: prog } = await supabase
        .from('programs').select('curriculum, program_location_id')
        .eq('id', parent.program_id).maybeSingle();
      if (prog) {
        out.curriculumName = prog.curriculum ?? '';
        if (prog.program_location_id) {
          const { data: loc } = await supabase
            .from('program_locations').select('name')
            .eq('id', prog.program_location_id).maybeSingle();
          if (loc) out.locationName = loc.name;
        }
      }
    }
  }
  return out;
}

// Told to everybody whose offer was closed out when somebody else accepted
// first. Short on purpose: there is nothing for them to do, and the one thing
// they need is to stop holding the afternoon.
//
// Each person is mailed SEPARATELY rather than bcc'd as a group, because these
// are colleagues who were quietly competing for the same day and a shared
// recipient list would show each of them who else was asked and who was slower.
async function notifyLosers(
  supabase: ReturnType<typeof adminClient>,
  subRow: { parent_assignment_id: string; parent_assignment_type: string; date: string; organization_id: string },
  losers: Array<{ email: string | null; first_name: string | null; preferred_name: string | null }>,
) {
  const withEmail = losers.filter((l) => l.email);
  if (withEmail.length === 0) {
    if (losers.length > 0) {
      console.warn('[notifyLosers] closed-out subs have no email on file; nobody told', {
        count: losers.length,
      });
    }
    return;
  }

  const ctx = await loadClassContext(supabase, subRow.parent_assignment_type, subRow.parent_assignment_id);
  const [{ data: org }, { data: branding }] = await Promise.all([
    supabase.from('organizations').select('name').eq('id', subRow.organization_id).maybeSingle(),
    supabase.from('org_branding').select('email_from_name').eq('organization_id', subRow.organization_id).maybeSingle(),
  ]);
  const senderFirstName = (branding?.email_from_name ?? org?.name ?? '').split(' ')[0] || 'the team';
  const friendlyDate = fmtDate(subRow.date);
  const className = ctx.curriculumName || 'that class';
  const brand = await loadOrgBrand(supabase, subRow.organization_id);
  const fromEmail = formatFromAddress(brand);

  const subject = `${friendlyDate.replace(/^[A-Za-z]+, /, '')} is covered - thanks for considering it`;

  for (const loser of withEmail) {
    const first = loser.preferred_name || loser.first_name || 'there';
    const html = `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Quick update: <strong>${escapeHtml(className)}</strong>${ctx.locationName ? ` at <strong>${escapeHtml(ctx.locationName)}</strong>` : ''} on <strong>${escapeHtml(friendlyDate)}</strong> has been covered by someone else, so please don't hold the time.</p>
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Nothing for you to do. Thanks for being willing, and sorry for the back and forth.</p>
    <p style="font-size:14px;line-height:1.55;margin:18px 0 0;">- ${escapeHtml(senderFirstName)}${org?.name ? ` @ ${escapeHtml(org.name)}` : ''}</p>
  </div>
</body></html>`;
    const text = [
      `Hi ${first},`,
      ``,
      `Quick update: ${className}${ctx.locationName ? ` at ${ctx.locationName}` : ''} on ${friendlyDate} has been covered by someone else, so please don't hold the time.`,
      ``,
      `Nothing for you to do. Thanks for being willing, and sorry for the back and forth.`,
      ``,
      `- ${senderFirstName}${org?.name ? ` @ ${org.name}` : ''}`,
    ].join('\n');

    // One person's bounce must not stop the rest being told.
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        // tenant_reply_to, not reply_to: the latter falls back to the PLATFORM
        // address when a tenant has none of its own, so an instructor hitting
        // Reply on "your day was covered" would be writing to Enrops about
        // another company's class instead of to the office that asked them.
        // Undefined is the honest answer when the tenant has no mailbox.
        body: JSON.stringify({
          from: fromEmail, to: loser.email,
          reply_to: brand.tenant_reply_to ?? undefined,
          subject, html, text,
        }),
      });
      if (!r.ok) {
        console.error('[notifyLosers] resend failed:', r.status, (await r.text()).slice(0, 300));
      }
    } catch (e) {
      console.error('[notifyLosers] resend threw:', e);
    }
  }
}

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
  const ctx = await loadClassContext(
    supabase, subRow.parent_assignment_type, subRow.parent_assignment_id);
  const { curriculumName, locationName, campSessionId, programId } = ctx;
  const regularId = ctx.regularId;
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

  const brand = await loadOrgBrand(supabase, subRow.organization_id);
  const fromEmail = formatFromAddress(brand);
  const replyTo = brand.reply_to;
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
