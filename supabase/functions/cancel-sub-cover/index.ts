// cancel-sub-cover: an admin takes a class-day back from a sub, or withdraws an
// offer nobody has answered yet.
//
// Input: { substitution_id: string, reason?: string }
//
// WHY THIS EXISTS. Until now there was no way to undo a sub assignment at all.
// The old create-assignment-substitution upserted onto a unique key of
// (parent_assignment_id, parent_assignment_type, date), so a class-day held
// exactly one row and re-assigning it OVERWROTE whoever was there - the modal's
// button literally read "Swap to Dana". Multi-offer removed that upsert, for
// good reasons, and nothing replaced the one thing it could do. The result was
// a class-day that froze the moment somebody accepted it: the picker greyed out
// its own submit button and told the operator to "cancel their cover first",
// which no surface in the product could do. A confirmed sub who then fell ill
// left a room with no adult and every screen reporting it covered.
//
// Behavior:
//   - confirmed -> cancelled. The cover is released, the day is open again, and
//     the regular instructor and the sub are both told, because both of them
//     were told it was ON by the 3-way coordination email.
//   - pending   -> cancelled. The offer is withdrawn. Only the sub is told, and
//     only if the offer email actually reached them.
//   - taught is REFUSED. The class happened; the pay line is real. Unwinding
//     that is a payroll correction, not a scheduling action.
//   - declined / cancelled are refused as nothing to do.
//
// Auth: caller must be owner/admin of the row's org.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';

const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function escapeHtml(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Body {
  substitution_id?: string;
  reason?: string;
  /**
   * Does the class STILL need somebody after this release?
   *
   * TRUE (default): the sub fell through and we are back to looking. The day
   * raises the coverage alarm.
   * FALSE: the class does not need a sub at all any more - the regular
   * instructor is teaching it after all, which is the most ordinary reason to
   * release a cover. The day is settled and stays quiet.
   *
   * Without this the alarm could never be cleared: there is no dismiss and no
   * delete, so a day released BECAUSE the regular came back would have sat on
   * the banner shouting "no one to cover it" until the date passed, and the
   * only advice it offered - let the lead take it back - was the thing that had
   * already happened.
   */
  still_needs_cover?: boolean;
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

    const substitutionId = (body.substitution_id || '').trim();
    const reason = (body.reason || '').toString().trim().slice(0, 1000);
    // Defaults to "yes, still looking", which is the state that ALARMS. An
    // omitted flag must not quietly settle a day nobody is covering.
    const stillNeedsCover = body.still_needs_cover !== false;
    if (!substitutionId) return json({ error: 'missing_substitution_id' }, 400);

    const { data: row, error: rowErr } = await supabase
      .from('assignment_substitutions')
      .select('id, organization_id, status, sub_instructor_id, date, parent_assignment_id, parent_assignment_type, email_sent_at')
      .eq('id', substitutionId)
      .maybeSingle();
    if (rowErr) {
      console.error('[cancel-sub-cover] lookup failed:', rowErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!row) return json({ error: 'not_found' }, 404);

    // ── Caller is owner/admin on THIS row's org ──────────────────────────
    // The org comes off the row, never off the request: a caller who is an
    // admin somewhere must not be able to release a cover in another tenant by
    // passing its substitution id.
    const { data: cm } = await supabase
      .from('org_members')
      .select('role')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', row.organization_id)
      .in('role', ['owner', 'admin'])
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!cm) return json({ error: 'forbidden' }, 403);

    if (row.status === 'taught') {
      return json({
        error: 'already_taught',
        detail: 'That class has already been taught, so the cover cannot be released here. Fix it in payroll instead.',
      }, 409);
    }
    if (row.status !== 'pending' && row.status !== 'confirmed') {
      return json({
        error: 'not_live',
        detail: `That offer is already ${row.status}, so there is nothing to cancel.`,
      }, 409);
    }
    const wasConfirmed = row.status === 'confirmed';

    // ── Has this class-day already been DELIVERED? ───────────────────────
    // The status check above is not the money guard it looks like. 'taught' is
    // written by one thing only - the sub tapping "Mark taught" in their own
    // portal - so a day confirmed by an ADMIN instead stays 'confirmed' for
    // ever, and a class taught last week looks identical to one next Tuesday.
    //
    // What actually decides pay is session_delivery_confirmations:
    // v_effective_pay_lines is built FROM that table and LEFT JOINs the
    // substitution only to work out WHO to pay, filtered to confirmed|taught.
    // Release the cover and that join stops matching, so effective_instructor_id
    // falls back to the REGULAR instructor at the regular's own tier. The sub
    // who stood in the room loses their pay line and the regular gains one for a
    // class they did not teach - silently, with no undo, because a cancelled row
    // cannot be un-cancelled.
    //
    // This is live on production today: the single substitution row there is
    // 2026-09-17, still 'confirmed', never marked taught, and its pay line pays
    // the sub. A status-only guard would have let that one through.
    const { data: parentForPay, error: parentPayErr } = row.parent_assignment_type === 'camp'
      ? await supabase.from('camp_assignments').select('camp_session_id').eq('id', row.parent_assignment_id).maybeSingle()
      : await supabase.from('program_assignments').select('program_id').eq('id', row.parent_assignment_id).maybeSingle();
    if (parentPayErr) {
      console.error('[cancel-sub-cover] parent lookup failed:', parentPayErr);
      return json({ error: 'parent_lookup_failed' }, 500);
    }
    const payKey = row.parent_assignment_type === 'camp'
      ? { column: 'camp_session_id', value: (parentForPay as { camp_session_id?: string } | null)?.camp_session_id }
      : { column: 'program_id', value: (parentForPay as { program_id?: string } | null)?.program_id };
    if (payKey.value) {
      const { data: delivered, error: deliveredErr } = await supabase
        .from('session_delivery_confirmations')
        .select('id')
        .eq(payKey.column, payKey.value)
        .eq('session_date', row.date)
        .limit(1);
      // FAIL CLOSED. Not knowing whether this day has been paid for is not a
      // reason to move somebody's pay line.
      if (deliveredErr) {
        console.error('[cancel-sub-cover] delivery check failed:', deliveredErr);
        return json({ error: 'delivery_check_failed', detail: 'We could not confirm whether that class has already been delivered, so nothing was changed. Try again.' }, 500);
      }
      if (delivered && delivered.length > 0) {
        return json({
          error: 'already_delivered',
          detail: 'That class has already been delivered and is on a pay line. Releasing the cover now would move the pay to the regular instructor. Sort it out in payroll instead.',
        }, 409);
      }
    }

    // ── Release it ───────────────────────────────────────────────────────
    // Guarded on the status we READ. Between that read and this write the sub
    // can accept a pending offer from their phone, and releasing a day the
    // operator believed was merely offered - without telling them it had just
    // been taken - is how somebody ends up told their class is covered when it
    // is not, or the reverse.
    const nowIso = new Date().toISOString();
    const { data: cancelled, error: updErr } = await supabase
      .from('assignment_substitutions')
      .update({
        status: 'cancelled',
        cancelled_at: nowIso,
        cancelled_by: callerAuthId,
        cancel_reason: reason || null,
        cover_still_needed: stillNeedsCover,
        updated_at: nowIso,
      })
      .eq('id', substitutionId)
      .eq('status', row.status)
      .select('id');
    if (updErr) {
      console.error('[cancel-sub-cover] update failed:', updErr);
      return json({ error: 'update_failed', detail: updErr.message }, 500);
    }
    if (!cancelled || cancelled.length === 0) {
      const { data: fresh } = await supabase
        .from('assignment_substitutions')
        .select('status')
        .eq('id', substitutionId)
        .maybeSingle();
      return json({
        error: 'status_changed',
        detail: `That offer moved to "${fresh?.status ?? 'something else'}" while you were looking at it. Open the day again and check who is on it.`,
        current_status: fresh?.status ?? null,
      }, 409);
    }

    // ── Tell the people who were told it was on ──────────────────────────
    // A failure here must not fail the release: the day IS open again, and the
    // board is what an operator acts on. But "must not fail" is not "may be
    // asserted anyway" - the outcome is REPORTED, so the modal can say what
    // actually happened. Telling an operator "Dana has been told" when Resend
    // was rate-limited is how Dana turns up to a class that was given away.
    const notified = await notifyCancelled(supabase, row, wasConfirmed, reason, stillNeedsCover)
      .catch((e) => {
        console.error('[cancel-sub-cover] notification failed:', e);
        return { sub: false, regular: false };
      });

    return json({
      ok: true,
      status: 'cancelled',
      was_confirmed: wasConfirmed,
      still_needs_cover: stillNeedsCover,
      notified_sub: notified.sub,
      notified_regular: notified.regular,
      substitution_id: substitutionId,
    });
  } catch (err) {
    console.error('[cancel-sub-cover] fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

// SupabaseClient, not ReturnType<typeof createClient>: called with no schema
// generic, createClient resolves to a client that knows no tables, and every
// .from() below then fails to type. This is the shape _shared/instructor.ts
// already returns from adminClient().
async function notifyCancelled(
  supabase: SupabaseClient,
  row: {
    organization_id: string;
    sub_instructor_id: string;
    date: string;
    parent_assignment_id: string;
    parent_assignment_type: string;
    email_sent_at: string | null;
  },
  wasConfirmed: boolean,
  reason: string,
  stillNeedsCover: boolean,
): Promise<{ sub: boolean; regular: boolean }> {
  const sent = { sub: false, regular: false };
  // Nobody was ever emailed about a pending offer whose send failed, so there
  // is nothing to take back. Telling somebody a day is off when they were never
  // asked is its own small confusion.
  if (!wasConfirmed && !row.email_sent_at) return sent;

  // Class context.
  let curriculumName = '';
  let locationName: string | null = null;
  let regularId: string | null = null;
  if (row.parent_assignment_type === 'camp') {
    const { data: parent } = await supabase
      .from('camp_assignments').select('instructor_id, camp_session_id')
      .eq('id', row.parent_assignment_id).maybeSingle();
    regularId = parent?.instructor_id ?? null;
    if (parent?.camp_session_id) {
      const { data: sess } = await supabase
        .from('camp_sessions').select('curriculum_name, location_name')
        .eq('id', parent.camp_session_id).maybeSingle();
      if (sess) { curriculumName = sess.curriculum_name ?? ''; locationName = sess.location_name; }
    }
  } else {
    const { data: parent } = await supabase
      .from('program_assignments').select('instructor_id, program_id')
      .eq('id', row.parent_assignment_id).maybeSingle();
    regularId = parent?.instructor_id ?? null;
    if (parent?.program_id) {
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

  const [{ data: sub }, { data: regular }, { data: org }, { data: branding }] = await Promise.all([
    supabase.from('instructors').select('first_name, preferred_name, email')
      .eq('id', row.sub_instructor_id).maybeSingle(),
    regularId
      ? supabase.from('instructors').select('first_name, preferred_name, email').eq('id', regularId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('organizations').select('name, slug').eq('id', row.organization_id).maybeSingle(),
    supabase.from('org_branding').select('email_from_name').eq('organization_id', row.organization_id).maybeSingle(),
  ]);
  if (!sub?.email) {
    console.warn('[cancel-sub-cover] sub has no email; not told', { instructor_id: row.sub_instructor_id });
    return sent;
  }

  const subFirst = sub.preferred_name || sub.first_name || 'there';
  const friendlyDate = fmtDate(row.date);
  const className = curriculumName || 'that class';
  const senderFirstName = (branding?.email_from_name ?? org?.name ?? '').split(' ')[0] || 'the team';
  const portalUrl = org?.slug ? `${PUBLIC_SITE_URL}/${org.slug}/instructor` : PUBLIC_SITE_URL;
  const brand = await loadOrgBrand(supabase, row.organization_id);
  const fromEmail = formatFromAddress(brand);

  // TWO PEOPLE, TWO MESSAGES, TWO SENDS.
  //
  // The first version of this built ONE body - written in the second person,
  // addressed "Hi Dana" - and put both the sub and the regular instructor in
  // `to`. Maria, the regular, who is the person now expected in that room,
  // would have received "Hi Dana, you're no longer needed for Ukulele on
  // Tuesday, please don't hold the time" and reasonably concluded the class was
  // off. That is the empty classroom this whole feature exists to prevent.
  //
  // Sent separately, never as two addresses on one message, for the same reason
  // notifyLosers does it: these are colleagues, and one recipient list would
  // show each of them the other's personal address and who was dropped. It also
  // means one bad address cannot swallow the other person's copy.
  const sendOne = async (to: string, subject: string, html: string, text: string) => {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: fromEmail,
          to,
          // tenant_reply_to, never reply_to: reply_to falls back to the PLATFORM
          // address when a tenant has none, which would send an instructor's
          // reply about another company's class to Enrops.
          reply_to: brand.tenant_reply_to ?? undefined,
          subject, html, text,
        }),
      });
      if (!r.ok) {
        console.error('[cancel-sub-cover] resend failed:', r.status, (await r.text()).slice(0, 300));
        return false;
      }
      return true;
    } catch (e) {
      console.error('[cancel-sub-cover] resend threw:', e);
      return false;
    }
  };

  const shell = (greetingName: string, lines: string[]) => {
    const body = lines.filter(Boolean);
    return {
      html: `<!doctype html>
<html><body style="margin:0;background:#FBFBFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;">
  <div style="max-width:560px;margin:0 auto;padding:24px;">
    <p style="font-size:15px;line-height:1.55;margin:0 0 14px;">Hi ${escapeHtml(greetingName)},</p>
    ${body.map((l) => `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;">${escapeHtml(l)}</p>`).join('\n    ')}
    <p style="font-size:14px;line-height:1.55;margin:0 0 18px;color:#6b6b6b;">Your days are in your portal: <a href="${portalUrl}" style="color:#1C004F;">${portalUrl}</a></p>
    <p style="font-size:14px;line-height:1.55;margin:18px 0 0;">- ${escapeHtml(senderFirstName)}${org?.name ? ` @ ${escapeHtml(org.name)}` : ''}</p>
  </div>
</body></html>`,
      text: [`Hi ${greetingName},`, ``, ...body.flatMap((l) => [l, ``]),
        `Your days are in your portal: ${portalUrl}`, ``,
        `- ${senderFirstName}${org?.name ? ` @ ${org.name}` : ''}`].join('\n'),
    };
  };

  const where = locationName ? ` at ${locationName}` : '';

  // ── 1. the sub ──
  const headline = wasConfirmed
    ? `you're no longer needed for ${className} on ${friendlyDate}`
    : `we've withdrawn the sub request for ${className} on ${friendlyDate}`;
  const bodyLine = wasConfirmed
    ? `Plans changed on our end, so please don't hold the time. Sorry for the disruption.`
    : `No need to reply to that one. Sorry for the noise.`;
  const subSubject = wasConfirmed
    ? `Cancelled: ${className} on ${friendlyDate.replace(/^[A-Za-z]+, /, '')}`
    : `Withdrawn: sub request for ${friendlyDate.replace(/^[A-Za-z]+, /, '')}`;
  const subMail = shell(subFirst, [
    `Quick update: ${headline}${where}.`,
    reason || '',
    bodyLine,
  ]);
  sent.sub = await sendOne(sub.email, subSubject, subMail.html, subMail.text);

  // ── 2. the regular instructor ──
  // They were told this person was covering, by the 3-way coordination email
  // that fires on accept. Without this that stays the last word they have on
  // the day. Only on a release of a CONFIRMED cover: a withdrawn offer never
  // reached them, so there is nothing to un-say.
  if (!wasConfirmed) return sent;
  if (!regular?.email || regular.email.toLowerCase() === sub.email.toLowerCase()) return sent;

  const regularFirst = regular.preferred_name || regular.first_name || 'there';
  // Their two outcomes are opposite and the message must not blur them: either
  // the class is theirs again, or somebody else is still being found for it.
  const regularMail = stillNeedsCover
    ? shell(regularFirst, [
        `${subFirst} is no longer covering ${className}${where} on ${friendlyDate}.`,
        `We're looking for somebody else. We'll let you know as soon as the day is covered.`,
      ])
    : shell(regularFirst, [
        `You're back on for ${className}${where} on ${friendlyDate}.`,
        `${subFirst} has been told they're not needed, so the day is yours again.`,
      ]);
  const regularSubject = stillNeedsCover
    ? `${className} on ${friendlyDate.replace(/^[A-Za-z]+, /, '')} needs a new sub`
    : `You're back on for ${className} on ${friendlyDate.replace(/^[A-Za-z]+, /, '')}`;
  sent.regular = await sendOne(regular.email, regularSubject, regularMail.html, regularMail.text);

  return sent;
}
