// admin-move-registration - move a child from one class to another, as one action.
//
// Until 2026-11-25 every move was a hand-written `UPDATE registrations SET program_id`
// on prod (four of them, 9/10 to 10/19). Jessica's rules, set that day after reading
// how Activity Messenger, Sawyer, Jackrabbit and Amilia do it:
//   * NO MONEY MOVES. Price, discounts, payment status, installments and credits stay
//     exactly as they are; the screen shows any price difference so the operator can
//     settle it separately. (All four platforms do the same.)
//   * The family is emailed by default, with a box to untick.
//   * A full class can be filled past capacity, after an explicit warning.
//
// TWO MODES.
//   options  { registration_id }  -> the child, their current class, and every open
//            class of the same kind they could move to, with seats and price. Read
//            only. program_seat_counts is service_role only, which is why this lives
//            here rather than in the browser.
//   move     { registration_id, target_program_id, notify_family, confirm_over_capacity }
//            -> move_registration() (one transaction, row-locked), then the event log,
//            then the optional email. The email goes AFTER the move commits and a
//            failure to send it never reports the move as failed - the child IS moved,
//            and saying otherwise invites a second move.
//
// AUTH: owner/admin of the registration's org, the same gate as refund-registration
// and admin-remove-registration (the two buttons this one sits beside). Checked here
// because everything below runs on the service key.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { loadOrgBrand, formatFromAddress } from '../_shared/orgBrand.ts';
import { describeProgram } from '../_shared/classSummary.ts';
import { venueLabel } from '../_shared/roomLabel.ts';
import { isCampProgram, programScheduleLabel } from '../_shared/campProgram.ts';
import { esc } from '../_shared/escapeHtml.ts';
import {
  groupRecipientsByAddress,
  sendFamilyEmails,
  tallyFamilySends,
  type MessageRecipientRow,
} from '../_shared/familyNotify.ts';
import { logTransactionalSend } from '../_shared/sendLog.ts';
import { todayInTimezone } from '../_shared/refundFeeProration.ts';
import { logEnrollmentEvent, ENROLLMENT_ACTIONS } from '../_shared/logEnrollmentEvent.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// Every column a summary, a label or the guards below read. One list, so options
// and move describe a class from the same fields.
const PROGRAM_COLUMNS =
  'id, organization_id, curriculum, status, term, day_of_week, class_days, start_time, end_time, end_date, ' +
  'first_session_date, max_capacity, price_cents, room, program_locations ( name, room_number )';

// The machine keys move_registration raises, and what an operator is told for each.
// The database is the rule; these are only its words.
const MOVE_ERRORS: Record<string, { status: number; message: string }> = {
  registration_not_found: { status: 404, message: "We couldn't find that registration. Refresh the roster." },
  not_a_class_registration: { status: 400, message: 'Camp sign-ups can not be moved here yet.' },
  not_enrolled: { status: 409, message: 'Only a child who has a place in the class can be moved.' },
  same_class: { status: 400, message: 'They are already in that class.' },
  target_not_found: { status: 404, message: "We couldn't find that class." },
  target_not_open: { status: 409, message: 'That class is not open, so nobody can be moved into it.' },
  different_kind: { status: 400, message: 'A class can only move to another class, and a camp to another camp.' },
  already_in_target: { status: 409, message: 'This child already has a place in that class, or a sign-up for it in progress.' },
  target_finished: { status: 409, message: 'That class has had its last session, so nobody can be moved into it.' },
  // target_full is answered separately (with the live count) below.
};

// deno-lint-ignore no-explicit-any
type Program = Record<string, any>;

function className(p: Program): string {
  return (p?.curriculum ?? '').trim() || 'their class';
}

function siteName(p: Program): string {
  return (p?.program_locations?.name ?? '').trim();
}

// "Tuesday Minecraft Makers at Jackson Elementary" - the sentence an operator reads
// on the confirm button and in the note. Day first because that is what usually
// differs between two classes at one school.
// Twin of rosterClassLabel in src/lib/rosterActions.js - keep the two in step.
function classLabel(p: Program): string {
  const name = className(p);
  const dayWord = !isCampProgram(p) && p?.day_of_week
    ? String(p.day_of_week).charAt(0).toUpperCase() + String(p.day_of_week).slice(1).toLowerCase()
    : '';
  // Not when the name already says it: "Saturday Ballet Intensive" must not read
  // "Saturday Saturday Ballet Intensive" (seen on staging 2026-11-25).
  const day = dayWord && !new RegExp(`\\b${dayWord}`, 'i').test(name) ? `${dayWord} ` : '';
  const site = siteName(p);
  return `${day}${name}${site ? ` at ${site}` : ''}`;
}

// The provider's own calendar day, not UTC's: a Pacific provider moving a child at
// 6pm must not be told it is tomorrow. Same helper and fallback the refund path uses.
async function orgTimezone(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data, error } = await supabase.from('organizations').select('timezone').eq('id', orgId).maybeSingle();
  if (error) console.error('[admin-move-registration] timezone lookup failed:', error);
  return (data as { timezone?: string | null } | null)?.timezone ?? null;
}

function fmtShortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// describeProgram reads day_of_week, which on a CAMP holds only its first day, so
// a Mon-Thu camp would be described as "Monday". Camps get their real day span.
function summaryFor(p: Program): string {
  if (!isCampProgram(p)) return describeProgram(p);
  const where = venueLabel(p?.program_locations?.name, p?.room, p?.program_locations?.room_number);
  return [where, programScheduleLabel(p)].filter(Boolean).join(' · ');
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

async function authorise(supabase: SupabaseClient, req: Request) {
  const authHeader = req.headers.get('Authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: json({ error: 'auth_required' }, 401) };
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return { error: json({ error: 'invalid_auth' }, 401) };
  return { user: userData.user };
}

async function loadRegistration(supabase: SupabaseClient, registrationId: string) {
  return await supabase
    .from('registrations')
    .select(
      'id, organization_id, program_id, student_id, parent_id, status, cancelled_at, amount_cents, ' +
        'discount_type, payment_status, notes, students ( first_name, last_name )',
    )
    .eq('id', registrationId)
    .maybeSingle();
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const supabase = adminClient();
    const auth = await authorise(supabase, req);
    if (!auth.user) return auth.error ?? json({ error: 'invalid_auth' }, 401);
    const callerAuthId = auth.user.id;

    // deno-lint-ignore no-explicit-any
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const mode = body?.mode === 'move' ? 'move' : body?.mode === 'options' ? 'options' : null;
    if (!mode) return json({ error: 'mode_required' }, 400);
    const registrationId = String(body?.registration_id ?? '').trim();
    if (!registrationId) return json({ error: 'registration_id_required' }, 400);

    // The registration first, so the org check uses ITS org, never one the caller names.
    const { data: regRow, error: rErr } = await loadRegistration(supabase, registrationId);
    const reg = regRow as Program | null;
    if (rErr) {
      console.error('[admin-move-registration] registration lookup failed:', rErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    // 403, not 404: an unknown id and somebody else's id must look the same.
    if (!reg) return json({ error: 'forbidden' }, 403);

    const { data: member, error: memErr } = await supabase
      .from('org_members')
      .select('organization_id, name, email')
      .eq('auth_user_id', callerAuthId)
      .eq('organization_id', reg.organization_id)
      .in('role', ['owner', 'admin'])
      .maybeSingle();
    if (memErr) {
      console.error('[admin-move-registration] org_members lookup failed:', memErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!member) return json({ error: 'forbidden' }, 403);

    if (!reg.program_id) {
      return json({ error: 'not_a_class_registration', message: MOVE_ERRORS.not_a_class_registration.message }, 400);
    }

    const { data: sourceRow, error: sErr } = await supabase
      .from('programs')
      .select(PROGRAM_COLUMNS)
      .eq('id', reg.program_id)
      .maybeSingle();
    const source = sourceRow as Program | null;
    if (sErr || !source) {
      console.error('[admin-move-registration] source program lookup failed:', sErr);
      return json({ error: 'lookup_failed' }, 500);
    }

    const studentFirst = (reg as Program).students?.first_name?.trim() || 'this child';
    const studentFull = [
      (reg as Program).students?.first_name, (reg as Program).students?.last_name,
    ].filter(Boolean).join(' ').trim() || studentFirst;

    // ── OPTIONS ─────────────────────────────────────────────────────────────────
    if (mode === 'options') {
      const { data: progs, error: pErr } = await supabase
        .from('programs')
        .select(PROGRAM_COLUMNS)
        .eq('organization_id', reg.organization_id)
        .eq('status', 'open')
        .neq('id', reg.program_id);
      if (pErr) {
        console.error('[admin-move-registration] programs lookup failed:', pErr);
        return json({ error: 'lookup_failed' }, 500);
      }
      // A class to a class, a camp to a camp - the same rule move_registration enforces.
      const sameKind = ((progs ?? []) as Program[]).filter((p: Program) => isCampProgram(p) === isCampProgram(source));
      const ids = sameKind.map((p: Program) => p.id);

      // A READ THAT FAILS IS NOT "EVERY CLASS HAS ROOM". Each of these lookups
      // refuses the whole list on error rather than answering with an empty map,
      // because an empty seat map renders every class as open.
      const [seatsRes, lastRes, mineRes] = await Promise.all([
        ids.length
          ? supabase.rpc('program_seat_counts', { p_program_ids: ids })
          : Promise.resolve({ data: [], error: null }),
        supabase.rpc('class_last_sessions', { p_organization_id: reg.organization_id }),
        // The classes this child already has a place in, so the list can say so
        // rather than offer a move the database will refuse.
        supabase
          .from('registrations')
          .select('program_id, status, cancelled_at')
          .eq('student_id', reg.student_id)
          .eq('status', 'confirmed')
          .is('cancelled_at', null),
      ]);
      if (seatsRes.error || lastRes.error || mineRes.error) {
        console.error('[admin-move-registration] options lookups failed:', seatsRes.error, lastRes.error, mineRes.error);
        return json({ error: 'lookup_failed' }, 500);
      }
      const seats = new Map((seatsRes.data ?? []).map((s: Program) => [s.program_id, s]));
      const lastByProgram = new Map((lastRes.data ?? []).map((l: Program) => [l.program_id, l]));
      const mine = new Set((mineRes.data ?? []).map((m: Program) => m.program_id));
      const today = todayInTimezone(await orgTimezone(supabase, reg.organization_id));

      const classes = sameKind
        .map((p: Program) => {
          const s = seats.get(p.id) as Program | undefined;
          const last = lastByProgram.get(p.id) as Program | undefined;
          return {
            id: p.id,
            name: className(p),
            label: classLabel(p),
            summary: summaryFor(p),
            site: siteName(p),
            term: p.term ?? null,
            day_of_week: p.day_of_week ?? null,
            first_session_date: p.first_session_date ?? null,
            last_session: last?.last_session ?? null,
            started: !!(p.first_session_date && p.first_session_date <= today),
            price_cents: p.price_cents ?? null,
            max_capacity: s?.max_capacity ?? p.max_capacity ?? null,
            seats_taken: Number(s?.seats_taken ?? 0),
            is_full: !!s?.is_full,
            already_in: mine.has(p.id),
          };
        })
        // A class whose last session has passed is not somewhere a child can go.
        // Unknown last session (class_last_sessions only derives some terms for some
        // orgs) stays in the list: the term is shown, and hiding a real class is worse.
        .filter((c) => !(c.last_session && c.last_session < today))
        .sort((a, b) =>
          (a.site || '').localeCompare(b.site || '') ||
          (a.first_session_date || '').localeCompare(b.first_session_date || '') ||
          a.name.localeCompare(b.name)
        );

      return json({
        mode: 'options',
        registration: {
          id: reg.id,
          student_name: studentFull,
          student_first_name: studentFirst,
          amount_cents: reg.amount_cents ?? null,
          payment_status: reg.payment_status ?? null,
          discount_type: reg.discount_type ?? null,
          movable: reg.status === 'confirmed' && !reg.cancelled_at,
        },
        from: {
          id: source.id,
          name: className(source),
          label: classLabel(source),
          summary: summaryFor(source),
          term: source.term ?? null,
          price_cents: source.price_cents ?? null,
        },
        classes,
      });
    }

    // ── MOVE ────────────────────────────────────────────────────────────────────
    const targetId = String(body?.target_program_id ?? '').trim();
    if (!targetId) return json({ error: 'target_program_id_required' }, 400);
    const notifyFamily = body?.notify_family !== false;
    const confirmOverCapacity = body?.confirm_over_capacity === true;

    const { data: targetRow, error: tErr } = await supabase
      .from('programs')
      .select(PROGRAM_COLUMNS)
      .eq('id', targetId)
      .eq('organization_id', reg.organization_id)
      .maybeSingle();
    const target = targetRow as Program | null;
    if (tErr) {
      console.error('[admin-move-registration] target lookup failed:', tErr);
      return json({ error: 'lookup_failed' }, 500);
    }
    if (!target) return json({ error: 'target_not_found', message: MOVE_ERRORS.target_not_found.message }, 404);

    // CAPACITY is decided INSIDE move_registration, under a lock on the target class,
    // so two moves into the last seat cannot both pass. Allowed past full only with
    // the operator's confirmation, which the panel asks for beside the button.
    const tz = await orgTimezone(supabase, reg.organization_id);

    // THE INSTRUCTOR READS THIS. registrations.notes is shown on the instructor
    // portal's roster ("Note: ..."), so it says only what helps whoever teaches the
    // new class - where the child came from and when. Who moved them and the money
    // are recorded in the enrollment event and the send log, not here.
    const note = `Moved here from ${classLabel(source)} on ${fmtShortDate(todayInTimezone(tz))}.`;

    const { error: moveErr } = await supabase.rpc('move_registration', {
      p_registration_id: reg.id,
      p_target_program_id: targetId,
      p_note: note,
      p_allow_over_capacity: confirmOverCapacity,
    });
    if (moveErr && (moveErr.message ?? '').includes('target_full')) {
      // Nothing moved. Re-read the count for the sentence; a failed read still
      // refuses, it just says less.
      const { data: seatRows } = await supabase.rpc('program_seat_counts', { p_program_ids: [targetId] });
      const seat = (seatRows ?? [])[0] as Program | undefined;
      return json({
        error: 'target_full',
        message: seat
          ? `${className(target)} is full (${seat.seats_taken} of ${seat.max_capacity}). Moving ${studentFirst} puts it over.`
          : `${className(target)} is full. Moving ${studentFirst} puts it over.`,
        seats_taken: seat ? Number(seat.seats_taken ?? 0) : null,
        max_capacity: seat?.max_capacity ?? null,
      }, 409);
    }
    if (moveErr) {
      const key = Object.keys(MOVE_ERRORS).find((k) => (moveErr.message ?? '').includes(k));
      if (key) return json({ error: key, message: MOVE_ERRORS[key].message }, MOVE_ERRORS[key].status);
      console.error('[admin-move-registration] move failed:', moveErr);
      return json({ error: 'move_failed', message: "Couldn't move them. Nothing changed." }, 500);
    }

    // THE CHILD IS MOVED. Nothing below may report otherwise.
    await logEnrollmentEvent(supabase, {
      actionType: ENROLLMENT_ACTIONS.MOVED,
      organizationId: reg.organization_id,
      parentId: reg.parent_id,
      studentId: reg.student_id,
      programId: targetId,
      registrationId: reg.id,
      metadata: { from_program_id: source.id, to_program_id: targetId, over_capacity_confirmed: confirmOverCapacity },
    });

    let email: { requested: boolean; sent: number; failed: number; unreachable: number; error?: string } = {
      requested: notifyFamily, sent: 0, failed: 0, unreachable: 0,
    };
    if (notifyFamily) {
      try {
        email = { requested: true, ...(await emailFamily(supabase, { reg, source, target, studentFirst, today: todayInTimezone(tz) })) };
      } catch (e) {
        console.error('[admin-move-registration] family email threw:', e);
        email = { requested: true, sent: 0, failed: 0, unreachable: 0, error: 'email_failed' };
      }
    }

    // Over capacity is read AFTER the move, from the real count. The confirmation
    // only says the operator allowed it; a seat may have freed since the list loaded,
    // and "this class is now over capacity" must not be said of a class that is not.
    const { data: afterRows } = await supabase.rpc('program_seat_counts', { p_program_ids: [targetId] });
    const after = (afterRows ?? [])[0] as Program | undefined;
    const overCapacity = !!after && Number(after.max_capacity) > 0 &&
      Number(after.seats_taken) > Number(after.max_capacity);

    return json({
      ok: true,
      moved: { registration_id: reg.id, from_program_id: source.id, to_program_id: targetId },
      over_capacity: overCapacity,
      email,
    });
  } catch (err) {
    console.error('[admin-move-registration] fatal:', err);
    return json({ error: 'internal_error' }, 500);
  }
});

// The household's own addresses in the class they are NOW in, through the same
// recipient rule Message families uses (both parents, placeholder addresses marked
// unreachable), narrowed to THIS child so a sibling in the same class is not named.
async function emailFamily(
  supabase: SupabaseClient,
  args: { reg: Program; source: Program; target: Program; studentFirst: string; today: string },
): Promise<{ sent: number; failed: number; unreachable: number; error?: string }> {
  const { reg, source, target, today } = args;
  const { data: rows, error: rErr } = await supabase.rpc('program_message_recipients', {
    p_program_id: target.id,
    p_org_id: reg.organization_id,
    p_include_waitlist: false,
    p_include_cancelled: false,
  });
  if (rErr) {
    console.error('[admin-move-registration] recipients failed:', rErr);
    return { sent: 0, failed: 0, unreachable: 0, error: 'recipients_failed' };
  }
  const mineOnly = ((rows ?? []) as MessageRecipientRow[]).filter(
    (r) => r.parent_id === reg.parent_id && r.student_id === reg.student_id,
  );
  const grouped = groupRecipientsByAddress(mineOnly);
  if (grouped.sendable.length === 0) {
    return { sent: 0, failed: 0, unreachable: grouped.unreachable.length, error: 'no_address' };
  }

  // The next real meeting of the new class, from the same session walk rosters and
  // reminders use. A class that has not started gets its first day.
  let nextDate = '';
  const { data: dates, error: dErr } = await supabase.rpc('derive_program_session_dates', {
    p_program_id: target.id,
  });
  if (dErr) console.error('[admin-move-registration] session dates failed:', dErr);
  const upcoming = ((dates ?? []) as string[]).filter((d) => d >= today).sort();
  const started = !!(target.first_session_date && target.first_session_date <= today);
  if (upcoming.length) nextDate = fmtDate(upcoming[0]);

  const brand = await loadOrgBrand(supabase, reg.organization_id);
  const newWhere = summaryFor(target);
  const oldName = className(source);
  const newName = className(target);
  const subject = `{{student_first_name}}'s class has changed`;
  // Family-facing copy: short, no em dashes (Jessica's rule for email she sends).
  const nextLine = nextDate
    ? `<p><strong>${started ? 'Next class' : 'First class'}:</strong> ${esc(nextDate)}</p>`
    : '';
  const bodyHtml = [
    `<p>Hi {{parent_first_name}},</p>`,
    `<p>{{student_first_name}} has been moved from <strong>${esc(oldName)}</strong> to <strong>${esc(newName)}</strong>.</p>`,
    newWhere ? `<p><strong>New class:</strong> ${esc(newWhere)}</p>` : '',
    nextLine,
    `<p>Nothing changes with your payment. If you have any questions, just reply to this email.</p>`,
  ].filter(Boolean).join('\n');

  const results = await sendFamilyEmails({
    recipients: grouped.sendable.map((g) => ({
      parent_id: g.parent_id,
      name: g.name,
      email: g.email,
      student_first_name: g.student_first_name,
    })),
    subject,
    bodyText: '',
    bodyHtml,
    orgName: brand.org_name,
    programName: newName,
    from: formatFromAddress(brand),
    replyTo: brand.reply_to,
    apiKey: RESEND_API_KEY,
    tags: [
      { name: 'type', value: 'registration_moved' },
      { name: 'program_id', value: String(target.id) },
    ],
  });

  // One send-log row per address, so the move shows on the family's timeline and
  // in delivery tracking like every other transactional email. The key carries the
  // target class so a later move to a different class is a new row, not an overwrite.
  for (const r of results) {
    await logTransactionalSend(supabase, {
      organizationId: reg.organization_id,
      source: 'registration_moved',
      contextKey: `registration:${reg.id}:moved_to:${target.id}:${r.email}`,
      email: r.email,
      parentId: r.parent_id,
      send: r.status === 'sent'
        ? { ok: true, id: r.resend_message_id }
        : { ok: false, error: r.failure_reason ?? 'send failed' },
      subject: `${args.studentFirst}'s class has changed`,
    });
  }

  const tally = tallyFamilySends(results);
  return { sent: tally.sent, failed: tally.failed, unreachable: grouped.unreachable.length };
}
