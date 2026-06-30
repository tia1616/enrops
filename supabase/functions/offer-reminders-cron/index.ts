// offer-reminders-cron: runs daily. Four passes per invocation — the camp pair
// (camp_assignments / camp_sessions) and the mirrored after-school pair
// (program_assignments / programs):
//
// 1) REMINDER pass — for any assignment where status='published',
//    reminder_sent_at IS NULL, and deadline is 2-3 calendar days away,
//    send the instructor a single reminder email listing every pending row
//    for them, then stamp reminder_sent_at on those rows.
//
// 2) EXPIRE pass — for any assignment where status='published' and
//    deadline < today, set flagged_reason='deadline_passed'. Status stays
//    'published' so the row remains visible as "awaiting response," and the
//    UI's deriveStatus maps flagged_reason → flagged-state. We do NOT
//    auto-cancel; admin decides next steps.
//
// Gating: camps gate by scheduling_cycles.auto_reminders_enabled via the
// camp_session.cycle_id. After-school programs have no cycle_id (they link by
// `term` string), so the program passes gate on the (organization_id, term)
// PAIR of any afterschool scheduling_cycle with the toggle on — never by term
// name alone, since two orgs can each have an "FA26" afterschool cycle. Program
// results are returned under separate program_* keys (camp fields untouched).
//
// Inputs:
//   { dry_run?: boolean }   — when true, returns the lists without mutating
// Trigger: pg_cron daily, or admin-invoke from Calendar UI's manual button.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEFAULT_PRIMARY = '#1C004F';
const DEFAULT_PAGE_BG = '#FBFBFB';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';

const REMINDER_WINDOW_DAYS_MIN = 2;
const REMINDER_WINDOW_DAYS_MAX = 3;

// After-school classes recur the same weekday all term, so the program email
// frames each class by day/time (not "Week N · dates"). Mirror the buffer that
// send-afterschool-offers uses for "please arrive by ...".
const ARRIVAL_BUFFER_MIN = 15;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function fmt(date: string | null) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(date: string, days: number) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function escape(s: string | null | undefined) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ---- After-school (program) time/format helpers — mirror send-afterschool-offers ----
// Programs store times as 12h text ("2:05 PM"). Older/synthetic rows may carry
// 24h ("15:45"); parse12h returns null for those and callers degrade gracefully.
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

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    let dry_run = false;
    if (req.method === 'POST') {
      try { const b = await req.json(); dry_run = !!b.dry_run; } catch {}
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const today = todayISO();
    const reminderWindowStart = addDaysISO(today, REMINDER_WINDOW_DAYS_MIN);
    const reminderWindowEnd = addDaysISO(today, REMINDER_WINDOW_DAYS_MAX);

    // -------------------- REMINDER PASS --------------------
    // Skip cycles where the admin disabled auto-reminders for this batch.
    const { data: enabledCycles } = await supabase
      .from('scheduling_cycles')
      .select('id')
      .eq('auto_reminders_enabled', true);
    const enabledCycleIds = (enabledCycles ?? []).map((c) => c.id);
    const { data: enabledSessions } = enabledCycleIds.length
      ? await supabase.from('camp_sessions').select('id').in('cycle_id', enabledCycleIds)
      : { data: [] };
    const enabledSessionIds = (enabledSessions ?? []).map((s) => s.id);

    const { data: reminderRows, error: remErr } = enabledSessionIds.length
      ? await supabase
          .from('camp_assignments')
          .select('id, organization_id, instructor_id, camp_session_id, role, deadline, distance_bonus_cents')
          .eq('status', 'published')
          .is('reminder_sent_at', null)
          .not('email_sent_at', 'is', null)
          .not('deadline', 'is', null)
          .gte('deadline', reminderWindowStart)
          .lte('deadline', reminderWindowEnd)
          .in('camp_session_id', enabledSessionIds)
      : { data: [], error: null };
    if (remErr) return json({ error: `reminder query: ${remErr.message}` }, 500);

    const reminders = reminderRows ?? [];
    const remindersByInstructor = new Map<string, any[]>();
    for (const r of reminders) {
      if (!remindersByInstructor.has(r.instructor_id)) remindersByInstructor.set(r.instructor_id, []);
      remindersByInstructor.get(r.instructor_id)!.push(r);
    }

    const reminderResults: Array<{ instructor_id: string; sent: boolean; reason?: string }> = [];
    for (const [instructorId, theirRows] of remindersByInstructor) {
      const orgId = theirRows[0].organization_id;

      const { data: instructor } = await supabase
        .from('instructors').select('id, first_name, email').eq('id', instructorId).maybeSingle();
      if (!instructor?.email) {
        reminderResults.push({ instructor_id: instructorId, sent: false, reason: 'no email' });
        continue;
      }

      const sessionIds = theirRows.map((r) => r.camp_session_id);
      const { data: sessions } = await supabase
        .from('camp_sessions')
        .select('id, location_id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, cycle_id')
        .in('id', sessionIds);
      const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));

      // Venue details — same pattern as send-offers / send-patch-offer.
      const locationIds = Array.from(new Set((sessions ?? []).map((s: any) => s.location_id).filter(Boolean)));
      const { data: locations } = locationIds.length
        ? await supabase
            .from('program_locations')
            .select('id, name, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes')
            .in('id', locationIds)
        : { data: [] } as any;
      const locationById = new Map<string, any>((locations ?? []).map((l: any) => [l.id, l]));
      const cycleId = sessions?.[0]?.cycle_id;
      const { data: cycle } = cycleId
        ? await supabase.from('scheduling_cycles').select('id, name, cycle_type').eq('id', cycleId).maybeSingle()
        : { data: null } as any;

      const { data: org } = await supabase.from('organizations').select('name, slug').eq('id', orgId).maybeSingle();
      const { data: brandingRow } = await supabase
        .from('org_branding')
        .select('primary_color, email_from_name, email_reply_to')
        .eq('organization_id', orgId)
        .maybeSingle();
      const branding = {
        primary_color: brandingRow?.primary_color ?? DEFAULT_PRIMARY,
        email_from_name: brandingRow?.email_from_name ?? org?.name ?? 'Enrops',
        email_reply_to: brandingRow?.email_reply_to ?? null,
      };

      const camps = theirRows
        .map((r) => ({ a: r, s: sessionById.get(r.camp_session_id) }))
        .filter((row) => !!row.s)
        .sort((x, y) => (x.s!.starts_on ?? '').localeCompare(y.s!.starts_on ?? ''));

      const deadline = theirRows[0].deadline;
      const cycleDisplay = cycleDisplayName(cycle?.name ?? '');
      if (!org?.slug) throw new Error(`offer-reminders-cron: org ${org?.id ?? 'null'} has no slug; cannot build portal URL`);
      const portalUrl = `https://enrops.com/${org.slug}/instructor`;
      const subject = `Reminder: please respond to your ${cycleDisplay} schedule`;
      const html = buildReminderHtml({ branding, instructor, camps, cycle, portalUrl, deadline, orgName: org?.name ?? '', locationById });
      const text = buildReminderText({ instructor, camps, cycle, portalUrl, deadline, orgName: org?.name ?? '', locationById });

      if (dry_run) {
        reminderResults.push({ instructor_id: instructorId, sent: false, reason: 'dry_run' });
        continue;
      }

      const fromName = branding.email_from_name;
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
        reminderResults.push({ instructor_id: instructorId, sent: false, reason: `resend ${r.status}: ${errText.slice(0, 200)}` });
        continue;
      }

      const ids = theirRows.map((r) => r.id);
      const { error: upErr } = await supabase
        .from('camp_assignments')
        .update({ reminder_sent_at: new Date().toISOString() })
        .in('id', ids);
      if (upErr) {
        reminderResults.push({ instructor_id: instructorId, sent: false, reason: `db update: ${upErr.message}` });
        continue;
      }

      // Audit row in the thread.
      await supabase.from('instructor_offer_messages').insert(
        ids.map((assignmentId) => ({
          organization_id: orgId,
          camp_assignment_id: assignmentId,
          sender_role: 'system',
          message: `Reminder email sent — deadline ${deadline}`,
        }))
      );

      reminderResults.push({ instructor_id: instructorId, sent: true });
    }

    // -------------------- EXPIRE PASS --------------------
    let expired: any[] = [];
    if (!dry_run) {
      const { data, error: expErr } = await supabase
        .from('camp_assignments')
        .update({ flagged_reason: 'deadline_passed' })
        .eq('status', 'published')
        .is('flagged_reason', null)
        .not('deadline', 'is', null)
        .lt('deadline', today)
        .select('id, organization_id');
      if (expErr) return json({ error: `expire update: ${expErr.message}`, reminder_results: reminderResults }, 500);
      expired = data ?? [];

      if (expired.length > 0) {
        await supabase.from('instructor_offer_messages').insert(
          expired.map((r) => ({
            organization_id: r.organization_id,
            camp_assignment_id: r.id,
            sender_role: 'system',
            message: 'Deadline passed without instructor response — flagged for admin review.',
          }))
        );
      }
    } else {
      // In dry_run, just count what would expire.
      const { data, error: expErr } = await supabase
        .from('camp_assignments')
        .select('id')
        .eq('status', 'published')
        .is('flagged_reason', null)
        .not('deadline', 'is', null)
        .lt('deadline', today);
      if (expErr) return json({ error: `expire dry_run query: ${expErr.message}`, reminder_results: reminderResults }, 500);
      expired = data ?? [];
    }

    // ==================== AFTER-SCHOOL (PROGRAM) PASSES ====================
    // Same two passes as camps, but program/term-shaped. Programs recur weekly
    // all term and link by `term` string (no cycle_id), and the auto-reminder
    // toggle lives on the org's afterschool scheduling_cycle. Two different orgs
    // can each have an "FA26" afterschool cycle with opposite toggle states, so
    // we gate on the (organization_id, term) PAIR — never by term name alone.
    const { data: asCycles } = await supabase
      .from('scheduling_cycles')
      .select('organization_id, name')
      .eq('cycle_type', 'afterschool')
      .eq('auto_reminders_enabled', true);
    const enabledProgramKeys = new Set((asCycles ?? []).map((c) => `${c.organization_id}:${c.name}`));
    const asOrgIds = Array.from(new Set((asCycles ?? []).map((c) => c.organization_id)));
    const asTermNames = Array.from(new Set((asCycles ?? []).map((c) => c.name)));

    let eligibleProgramIds: string[] = [];
    if (asOrgIds.length && asTermNames.length) {
      // .in × .in is a cross-product; filter back down to exact enabled pairs.
      const { data: progRows } = await supabase
        .from('programs')
        .select('id, organization_id, term')
        .in('organization_id', asOrgIds)
        .in('term', asTermNames);
      eligibleProgramIds = (progRows ?? [])
        .filter((p: any) => enabledProgramKeys.has(`${p.organization_id}:${p.term}`))
        .map((p: any) => p.id);
    }

    // -------------------- PROGRAM REMINDER PASS --------------------
    const { data: progReminderRows, error: progRemErr } = eligibleProgramIds.length
      ? await supabase
          .from('program_assignments')
          .select('id, organization_id, instructor_id, program_id, role, deadline, distance_bonus_cents, flags')
          .eq('status', 'published')
          .is('reminder_sent_at', null)
          .not('email_sent_at', 'is', null)
          .not('deadline', 'is', null)
          .gte('deadline', reminderWindowStart)
          .lte('deadline', reminderWindowEnd)
          .in('program_id', eligibleProgramIds)
      : { data: [], error: null };
    if (progRemErr) return json({ error: `program reminder query: ${progRemErr.message}`, reminder_results: reminderResults }, 500);

    const progReminders = progReminderRows ?? [];
    const progRemindersByInstructor = new Map<string, any[]>();
    for (const r of progReminders) {
      if (!progRemindersByInstructor.has(r.instructor_id)) progRemindersByInstructor.set(r.instructor_id, []);
      progRemindersByInstructor.get(r.instructor_id)!.push(r);
    }

    const programReminderResults: Array<{ instructor_id: string; sent: boolean; reason?: string }> = [];
    for (const [instructorId, theirRows] of progRemindersByInstructor) {
      const orgId = theirRows[0].organization_id;

      const { data: instructor } = await supabase
        .from('instructors').select('id, first_name, preferred_name, email').eq('id', instructorId).maybeSingle();
      if (!instructor?.email) {
        programReminderResults.push({ instructor_id: instructorId, sent: false, reason: 'no email' });
        continue;
      }

      const programIds = theirRows.map((r) => r.program_id);
      const { data: programs } = await supabase
        .from('programs')
        .select('id, curriculum, day_of_week, start_time, end_time, program_location_id, term')
        .in('id', programIds);
      const programById = new Map((programs ?? []).map((p: any) => [p.id, p]));

      const locationIds = Array.from(new Set((programs ?? []).map((p: any) => p.program_location_id).filter(Boolean)));
      const { data: locations } = locationIds.length
        ? await supabase
            .from('program_locations')
            .select('id, name, area, address, room_number, contact_name, contact_phone, contact_email, arrival_instructions, dismissal_instructions, food_drink_policy, notes')
            .in('id', locationIds)
        : { data: [] } as any;
      const locationById = new Map<string, any>((locations ?? []).map((l: any) => [l.id, l]));

      const { data: org } = await supabase.from('organizations').select('id, name, slug').eq('id', orgId).maybeSingle();
      const { data: brandingRow } = await supabase
        .from('org_branding')
        .select('primary_color, email_from_name, email_reply_to')
        .eq('organization_id', orgId)
        .maybeSingle();
      const branding = {
        primary_color: brandingRow?.primary_color ?? DEFAULT_PRIMARY,
        email_from_name: brandingRow?.email_from_name ?? org?.name ?? 'Enrops',
        email_reply_to: brandingRow?.email_reply_to ?? null,
      };

      const classes = theirRows
        .map((r) => ({ a: r, p: programById.get(r.program_id) }))
        .filter((row) => !!row.p)
        .sort((x, y) => (parse12h(x.p!.start_time) ?? 0) - (parse12h(y.p!.start_time) ?? 0));

      // Derive the email's headline deadline + term from the same (first-by-
      // start-time) class so they can't come from different assignments. In the
      // real flow an instructor's term offers all share one deadline/term (sent
      // in one send-afterschool-offers batch); the fallback covers odd data.
      const deadline = classes[0]?.a?.deadline ?? theirRows[0].deadline;
      const termDisplay = cycleDisplayName(classes[0]?.p?.term ?? '');
      if (!org?.slug) throw new Error(`offer-reminders-cron: org ${org?.id ?? 'null'} has no slug; cannot build portal URL`);
      const portalUrl = `https://enrops.com/${org.slug}/instructor`;
      const firstName = instructor.preferred_name ?? instructor.first_name ?? 'there';
      const subject = `Reminder: please respond to your ${termDisplay} after-school schedule`;
      const html = buildProgramReminderHtml({ branding, firstName, classes, termDisplay, portalUrl, deadline, orgName: org?.name ?? '', locationById });
      const text = buildProgramReminderText({ firstName, classes, termDisplay, portalUrl, deadline, orgName: org?.name ?? '', locationById });

      if (dry_run) {
        programReminderResults.push({ instructor_id: instructorId, sent: false, reason: 'dry_run' });
        continue;
      }

      const fromName = branding.email_from_name;
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
        programReminderResults.push({ instructor_id: instructorId, sent: false, reason: `resend ${r.status}: ${errText.slice(0, 200)}` });
        continue;
      }

      const ids = theirRows.map((r) => r.id);
      const { error: upErr } = await supabase
        .from('program_assignments')
        .update({ reminder_sent_at: new Date().toISOString() })
        .in('id', ids);
      if (upErr) {
        programReminderResults.push({ instructor_id: instructorId, sent: false, reason: `db update: ${upErr.message}` });
        continue;
      }

      await supabase.from('instructor_offer_messages').insert(
        ids.map((assignmentId) => ({
          organization_id: orgId,
          program_assignment_id: assignmentId,
          sender_role: 'system',
          message: `Reminder email sent — deadline ${deadline}`,
        }))
      );

      programReminderResults.push({ instructor_id: instructorId, sent: true });
    }

    // -------------------- PROGRAM EXPIRE PASS --------------------
    // Gated to the same enabled (org, term) pairs: an org that turned the
    // toggle OFF is opting out of automated flagging too. (Camp's expire pass
    // is global; here we honor the per-org afterschool switch.)
    let programExpired: any[] = [];
    if (eligibleProgramIds.length) {
      if (!dry_run) {
        const { data, error: expErr } = await supabase
          .from('program_assignments')
          .update({ flagged_reason: 'deadline_passed' })
          .eq('status', 'published')
          .is('flagged_reason', null)
          .not('deadline', 'is', null)
          .lt('deadline', today)
          .in('program_id', eligibleProgramIds)
          .select('id, organization_id');
        if (expErr) return json({ error: `program expire update: ${expErr.message}`, reminder_results: reminderResults, program_reminder_results: programReminderResults }, 500);
        programExpired = data ?? [];

        if (programExpired.length > 0) {
          await supabase.from('instructor_offer_messages').insert(
            programExpired.map((r) => ({
              organization_id: r.organization_id,
              program_assignment_id: r.id,
              sender_role: 'system',
              message: 'Deadline passed without instructor response — flagged for admin review.',
            }))
          );
        }
      } else {
        const { data, error: expErr } = await supabase
          .from('program_assignments')
          .select('id')
          .eq('status', 'published')
          .is('flagged_reason', null)
          .not('deadline', 'is', null)
          .lt('deadline', today)
          .in('program_id', eligibleProgramIds);
        if (expErr) return json({ error: `program expire dry_run query: ${expErr.message}`, reminder_results: reminderResults, program_reminder_results: programReminderResults }, 500);
        programExpired = data ?? [];
      }
    }

    // Upcoming schedule: every still-pending row's deadline minus 3 days,
    // grouped by fire-date. Lets the admin see "reminders will fire on May 17"
    // even when today isn't in the window yet.
    const { data: pendingAll } = enabledSessionIds.length
      ? await supabase
          .from('camp_assignments')
          .select('instructor_id, deadline')
          .eq('status', 'published')
          .is('reminder_sent_at', null)
          .not('email_sent_at', 'is', null)
          .not('deadline', 'is', null)
          .in('camp_session_id', enabledSessionIds)
      : { data: [] };
    const upcoming = new Map();
    for (const r of pendingAll ?? []) {
      const fireDate = addDaysISO(r.deadline, -3);
      if (!upcoming.has(fireDate)) upcoming.set(fireDate, { camps: 0, instructors: new Set() });
      const bucket = upcoming.get(fireDate);
      bucket.camps += 1;
      bucket.instructors.add(r.instructor_id);
    }
    const upcomingArr = Array.from(upcoming.entries())
      .map(([fire_date, b]) => ({ fire_date, instructor_count: b.instructors.size, assignment_count: b.camps }))
      .sort((a, b) => a.fire_date.localeCompare(b.fire_date));

    // Program upcoming forecast — separate from camps so the camp UI's counts
    // stay untouched (additive-and-empty).
    const { data: progPendingAll } = eligibleProgramIds.length
      ? await supabase
          .from('program_assignments')
          .select('instructor_id, deadline')
          .eq('status', 'published')
          .is('reminder_sent_at', null)
          .not('email_sent_at', 'is', null)
          .not('deadline', 'is', null)
          .in('program_id', eligibleProgramIds)
      : { data: [] };
    const progUpcoming = new Map();
    for (const r of progPendingAll ?? []) {
      const fireDate = addDaysISO(r.deadline, -3);
      if (!progUpcoming.has(fireDate)) progUpcoming.set(fireDate, { classes: 0, instructors: new Set() });
      const bucket = progUpcoming.get(fireDate);
      bucket.classes += 1;
      bucket.instructors.add(r.instructor_id);
    }
    const progUpcomingArr = Array.from(progUpcoming.entries())
      .map(([fire_date, b]) => ({ fire_date, instructor_count: b.instructors.size, assignment_count: b.classes }))
      .sort((a, b) => a.fire_date.localeCompare(b.fire_date));

    return json({
      dry_run,
      reminder_results: reminderResults,
      reminders_window: { from: reminderWindowStart, to: reminderWindowEnd },
      upcoming: upcomingArr,
      expired_count: expired.length,
      expired_ids: dry_run ? expired.map((e) => e.id) : undefined,
      // After-school (program) results — mirror of the camp fields above.
      program_reminder_results: programReminderResults,
      program_upcoming: progUpcomingArr,
      program_expired_count: programExpired.length,
      program_expired_ids: dry_run ? programExpired.map((e) => e.id) : undefined,
      ran_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('offer-reminders-cron fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});

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
  return `<div style="margin-top:4px;font-size:11px;color:${MUTED};line-height:1.5;">${lines.join('')}</div>`;
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

function buildReminderHtml({ branding, instructor, camps, cycle, portalUrl, deadline, orgName, locationById }: any) {
  const primary = branding.primary_color ?? DEFAULT_PRIMARY;
  const firstName = instructor.first_name ?? 'there';
  const cycleDisplay = cycleDisplayName(cycle?.name ?? '');
  const unit = unitLabel(cycle?.cycle_type, camps.length);

  const campRows = camps.map(({ a, s }: any) => {
    const loc = s.location_id ? locationById?.get(s.location_id) : undefined;
    const venue = renderVenueDetailsHtml(loc);
    const role = a.role === 'developing' ? ' (Developing)' : '';
    const bonus = a.distance_bonus_cents ? `<div style="margin-top:4px;font-size:13px;color:${primary};font-weight:600;">Includes a $${(a.distance_bonus_cents / 100).toFixed(0)} distance bonus</div>` : '';
    return `<tr><td style="padding:10px 0;border-bottom:1px solid ${BORDER};"><div style="font-size:14px;font-weight:600;color:${TEXT};">${escape(s.curriculum_name)}${role}</div><div style="font-size:12px;color:${MUTED};margin-top:2px;">Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${escape(s.location_name)}</div>${venue}${bonus}</td></tr>`;
  }).join('');

  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${DEFAULT_PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${DEFAULT_PAGE_BG};padding:32px 16px;"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;"><tr><td style="padding:28px 32px 8px;"><div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(orgName)}</div><h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;">Quick reminder — please respond</h1></td></tr><tr><td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">Hi ${escape(firstName)},<br /><br />Just a nudge — your ${cycleDisplay} schedule is still waiting for your response. <strong>Please tap Accept or Request change on each ${unit}</strong> by <strong>${fmt(deadline)}</strong>.</td></tr><tr><td style="padding:8px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${campRows}</table></td></tr><tr><td style="padding:20px 32px 6px;"><a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:13px 26px;border-radius:6px;font-size:15px;font-weight:700;">Review and respond →</a></td></tr><tr><td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">Already responded? You can ignore this email — sometimes the timing crosses. Questions? Just reply.<br /><br />— The ${escape(orgName)} team</td></tr></table></td></tr></table></body></html>`;
}

function buildReminderText({ instructor, camps, cycle, portalUrl, deadline, orgName, locationById }: any) {
  const firstName = instructor.first_name ?? 'there';
  const cycleDisplay = cycleDisplayName(cycle?.name ?? '');
  const unit = unitLabel(cycle?.cycle_type, camps.length);
  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');
  lines.push(`Just a nudge — your ${cycleDisplay} schedule is still waiting for your response. Please tap Accept or Request change on each ${unit} by ${fmt(deadline)}.`);
  lines.push('');
  for (const { a, s } of camps) {
    const loc = s.location_id ? locationById?.get(s.location_id) : undefined;
    const role = a.role === 'developing' ? ' (Developing)' : '';
    lines.push(`• ${s.curriculum_name}${role}`);
    lines.push(`  Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${s.location_name}`);
    for (const v of renderVenueDetailsText(loc)) lines.push(v);
    if (a.distance_bonus_cents) lines.push(`  Includes a $${(a.distance_bonus_cents / 100).toFixed(0)} distance bonus`);
  }
  lines.push('');
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push('');
  lines.push("Already responded? You can ignore this email. Questions? Just reply.");
  lines.push('');
  lines.push(`— The ${orgName} team`);
  return lines.join('\n');
}

// ---- After-school (program) reminder renderers ----
// Weekly framing: curriculum · day/time · all term · school · area. No week
// numbers or date ranges — each class recurs the same weekday all term.
function buildProgramReminderHtml({ branding, firstName, classes, termDisplay, portalUrl, deadline, orgName, locationById }: any) {
  const primary = branding.primary_color ?? DEFAULT_PRIMARY;
  const n = classes.length;
  const unit = n === 1 ? 'class' : 'classes';

  const rows = classes.map(({ a, p }: any) => {
    const loc = p.program_location_id ? locationById?.get(p.program_location_id) : undefined;
    const area = loc?.area ? ` · ${escape(loc.area)}` : '';
    const ab = arriveBy(p.start_time);
    const venue = renderVenueDetailsHtml(loc);
    const hardship = Array.isArray(a.flags) && (a.flags.includes('location_override') || a.flags.includes('location_low_pref'));
    const bonus = a.distance_bonus_cents
      ? `<div style="margin-top:6px;font-size:13px;color:${primary};font-weight:600;">Includes a ${dollars(a.distance_bonus_cents)} bonus${hardship ? `<div style="font-size:12px;color:${MUTED};font-weight:400;">Thanks for covering an area outside your preference.</div>` : ''}</div>`
      : '';
    return `<tr><td style="padding:12px 0;border-bottom:1px solid ${BORDER};">
      <div style="font-size:14px;font-weight:600;color:${TEXT};line-height:1.3;">${escape(p.curriculum ?? 'Class')}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:2px;line-height:1.4;">${escape(dayLabel(p.day_of_week))} ${escape(p.start_time ?? '')}–${escape(p.end_time ?? '')} · <strong>all term</strong><br/>${escape(loc?.name ?? '')}${area}${ab ? ` · please arrive by ${ab}` : ''}</div>
      ${venue}
      ${bonus}
    </td></tr>`;
  }).join('');

  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${DEFAULT_PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${DEFAULT_PAGE_BG};padding:32px 16px;"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;"><tr><td style="padding:28px 32px 8px;"><div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(orgName)}</div><h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;">Quick reminder — please respond</h1></td></tr><tr><td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">Hi ${escape(firstName)},<br /><br />Just a nudge — your ${escape(termDisplay)} after-school schedule is still waiting for your response. <strong>Please tap Accept or Request change on each ${unit}</strong> by <strong>${fmt(deadline)}</strong>. Each one runs weekly all term, and your schedule isn't confirmed until we hear back on every one.</td></tr><tr><td style="padding:8px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}</table></td></tr><tr><td style="padding:20px 32px 6px;"><a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:13px 26px;border-radius:6px;font-size:15px;font-weight:700;">Review and respond →</a></td></tr><tr><td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">Already responded? You can ignore this email — sometimes the timing crosses. Questions? Just reply.<br /><br />— The ${escape(orgName)} team</td></tr></table></td></tr></table></body></html>`;
}

function buildProgramReminderText({ firstName, classes, termDisplay, portalUrl, deadline, orgName, locationById }: any) {
  const n = classes.length;
  const unit = n === 1 ? 'class' : 'classes';
  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');
  lines.push(`Just a nudge — your ${termDisplay} after-school schedule is still waiting for your response. Please tap Accept or Request change on each ${unit} by ${fmt(deadline)}. Each one runs weekly all term, and nothing's confirmed until we hear back on every one.`);
  lines.push('');
  for (const { a, p } of classes) {
    const loc = p.program_location_id ? locationById?.get(p.program_location_id) : undefined;
    const ab = arriveBy(p.start_time);
    lines.push(`• ${p.curriculum ?? 'Class'}`);
    lines.push(`  ${dayLabel(p.day_of_week)} ${p.start_time ?? ''}–${p.end_time ?? ''} · all term`);
    lines.push(`  ${loc?.name ?? ''}${loc?.area ? ` · ${loc.area}` : ''}${ab ? ` · arrive by ${ab}` : ''}`);
    for (const v of renderVenueDetailsText(loc)) lines.push(v);
    if (a.distance_bonus_cents) lines.push(`  Includes a ${dollars(a.distance_bonus_cents)} bonus`);
  }
  lines.push('');
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push('');
  lines.push('Already responded? You can ignore this email. Questions? Just reply.');
  lines.push('');
  lines.push(`— The ${orgName} team`);
  return lines.join('\n');
}
