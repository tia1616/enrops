// offer-reminders-cron: runs daily. Two passes per invocation:
//
// 1) REMINDER pass — for any camp_assignment where status='published',
//    reminder_sent_at IS NULL, and deadline is 2-4 calendar days away,
//    send the instructor a single reminder email listing every pending row
//    for them, then stamp reminder_sent_at on those rows.
//
// 2) EXPIRE pass — for any camp_assignment where status='published' and
//    deadline < today, set flagged_reason='deadline_passed'. Status stays
//    'published' so the row remains visible as "awaiting response," and the
//    UI's deriveStatus maps flagged_reason → flagged-state. We do NOT
//    auto-cancel; admin decides next steps.
//
// Inputs:
//   { dry_run?: boolean }   — when true, returns the lists without mutating
// Trigger: pg_cron daily, or admin-invoke from Calendar UI's manual button.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const DEFAULT_PRIMARY = '#691D39';
const DEFAULT_PAGE_BG = '#EAEADD';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e2dfd5';

const REMINDER_WINDOW_DAYS_MIN = 2;
const REMINDER_WINDOW_DAYS_MAX = 3;

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
    const remindersByInstructor = new Map<string, typeof reminders>();
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
        .select('id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, cycle_id')
        .in('id', sessionIds);
      const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));
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
      const portalUrl = `https://enrops.com/${org?.slug ?? 'j2s'}/instructor`;
      const subject = `Reminder: please respond to your ${cycleDisplay} schedule`;
      const html = buildReminderHtml({ branding, instructor, camps, cycle, portalUrl, deadline, orgName: org?.name ?? '' });
      const text = buildReminderText({ instructor, camps, cycle, portalUrl, deadline, orgName: org?.name ?? '' });

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

    return json({
      dry_run,
      reminder_results: reminderResults,
      reminders_window: { from: reminderWindowStart, to: reminderWindowEnd },
      upcoming: upcomingArr,
      expired_count: expired.length,
      expired_ids: dry_run ? expired.map((e) => e.id) : undefined,
      ran_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('offer-reminders-cron fatal:', err);
    return json({ error: err.message ?? String(err) }, 500);
  }
});

function buildReminderHtml({ branding, instructor, camps, cycle, portalUrl, deadline, orgName }: any) {
  const primary = branding.primary_color ?? DEFAULT_PRIMARY;
  const firstName = instructor.first_name ?? 'there';
  const cycleDisplay = cycleDisplayName(cycle?.name ?? '');
  const unit = unitLabel(cycle?.cycle_type, camps.length);

  const campRows = camps.map(({ a, s }: any) => {
    const role = a.role === 'developing' ? ' (Developing)' : '';
    const bonus = a.distance_bonus_cents ? `<div style="margin-top:4px;font-size:13px;color:${primary};font-weight:600;">Includes a $${(a.distance_bonus_cents / 100).toFixed(0)} distance bonus</div>` : '';
    return `<tr><td style="padding:10px 0;border-bottom:1px solid ${BORDER};"><div style="font-size:14px;font-weight:600;color:${TEXT};">${escape(s.curriculum_name)}${role}</div><div style="font-size:12px;color:${MUTED};margin-top:2px;">Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${escape(s.location_name)}</div>${bonus}</td></tr>`;
  }).join('');

  return `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:${DEFAULT_PAGE_BG};font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;color:${TEXT};"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${DEFAULT_PAGE_BG};padding:32px 16px;"><tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid ${BORDER};border-radius:10px;"><tr><td style="padding:28px 32px 8px;"><div style="font-size:13px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;font-weight:600;">${escape(orgName)}</div><h1 style="margin:6px 0 0;font-size:22px;color:${TEXT};font-weight:700;">Quick reminder — please respond</h1></td></tr><tr><td style="padding:14px 32px 6px;font-size:15px;color:${TEXT};line-height:1.55;">Hi ${escape(firstName)},<br /><br />Just a nudge — your ${cycleDisplay} schedule is still waiting for your response. <strong>Please tap Accept or Request change on each ${unit}</strong> by <strong>${fmt(deadline)}</strong>.</td></tr><tr><td style="padding:8px 32px 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${campRows}</table></td></tr><tr><td style="padding:20px 32px 6px;"><a href="${portalUrl}" style="display:inline-block;background:${primary};color:#fff;text-decoration:none;padding:13px 26px;border-radius:6px;font-size:15px;font-weight:700;">Review and respond →</a></td></tr><tr><td style="padding:14px 32px 24px;font-size:13px;color:${MUTED};line-height:1.55;">Already responded? You can ignore this email — sometimes the timing crosses. Questions? Just reply.<br /><br />— Jessica, ${escape(orgName)}</td></tr></table></td></tr></table></body></html>`;
}

function buildReminderText({ instructor, camps, cycle, portalUrl, deadline, orgName }: any) {
  const firstName = instructor.first_name ?? 'there';
  const cycleDisplay = cycleDisplayName(cycle?.name ?? '');
  const unit = unitLabel(cycle?.cycle_type, camps.length);
  const lines: string[] = [];
  lines.push(`Hi ${firstName},`);
  lines.push('');
  lines.push(`Just a nudge — your ${cycleDisplay} schedule is still waiting for your response. Please tap Accept or Request change on each ${unit} by ${fmt(deadline)}.`);
  lines.push('');
  for (const { a, s } of camps) {
    const role = a.role === 'developing' ? ' (Developing)' : '';
    lines.push(`• ${s.curriculum_name}${role}`);
    lines.push(`  Week ${s.week_num} · ${fmt(s.starts_on)} – ${fmt(s.ends_on)} · ${s.location_name}`);
    if (a.distance_bonus_cents) lines.push(`  Includes a $${(a.distance_bonus_cents / 100).toFixed(0)} distance bonus`);
  }
  lines.push('');
  lines.push(`Review and respond: ${portalUrl}`);
  lines.push('');
  lines.push("Already responded? You can ignore this email. Questions? Just reply.");
  lines.push('');
  lines.push(`— Jessica, ${orgName}`);
  return lines.join('\n');
}
