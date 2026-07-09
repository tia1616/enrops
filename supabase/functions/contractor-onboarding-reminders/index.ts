// contractor-onboarding-reminders — one-time cron at June 5 + June 10.
//
// Two scheduled runs:
//   June 5  (type=admin_summary):       admin summary email only
//   June 10 (type=admin_and_contractor): admin summary AND a "pick up where
//                                        you left off" email to each
//                                        in-progress contractor
//
// Auth: verify_jwt: false. pg_cron sends X-Cron-Secret header signed against
// CRON_SECRET env var (vault entry: enrops_cron_secret).
//
// Step 1: guard — if no contractors are in a reminderable state, skip emails
//         entirely and jump straight to self-unschedule.
// Step 2: admin summary (always).
// Step 3: contractor reminders (admin_and_contractor only).
//         Filters overall_status IN ('invited', 'in_progress'). Intentionally
//         excludes pending_background_check + pending_stripe (they're waiting
//         on an external system, not on themselves), and complete/declined/
//         abandoned (terminal).
// Step 4: cron.unschedule(cron_job_name) — only on full success. If anything
//         threw, leave the job in place so an admin can re-trigger.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders, json, adminClient } from '../_shared/instructor.ts';

// Per-environment site origin. Staging Supabase sets PUBLIC_SITE_URL to the staging
// site so the onboarding link points at staging, not prod. Defaults to prod.
const PUBLIC_SITE_URL = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://enrops.com').replace(/\/+$/, '');

interface RemindersBody {
  type?: 'admin_summary' | 'admin_and_contractor';
  cron_job_name?: string;
}

const REMINDERABLE_STATUSES = ['not_invited', 'invited', 'in_progress', 'pending_background_check', 'pending_stripe'];
const CONTRACTOR_PROMPT_STATUSES = ['invited', 'in_progress'];

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const cronSecret = Deno.env.get('CRON_SECRET');
  const headerSecret = req.headers.get('X-Cron-Secret');
  if (!cronSecret) {
    console.error('CRON_SECRET not set on contractor-onboarding-reminders');
    return json({ error: 'cron_not_configured' }, 500);
  }
  if (!headerSecret || headerSecret !== cronSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: RemindersBody;
  try {
    body = (await req.json()) as RemindersBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const type = body.type;
  const cronJobName = body.cron_job_name?.trim();
  if (type !== 'admin_summary' && type !== 'admin_and_contractor') {
    return json({ error: 'invalid_type' }, 400);
  }
  if (!cronJobName) {
    return json({ error: 'cron_job_name_required' }, 400);
  }

  const supabase = adminClient();
  const summary = {
    orgs_processed: 0,
    admin_emails_sent: 0,
    contractor_emails_sent: 0,
    contractor_emails_failed: 0,
    unscheduled: false,
    skipped_reason: '' as string,
  };

  try {
    // Step 1: find all orgs that have at least one reminderable contractor.
    const { data: orgIds, error: orgIdErr } = await supabase
      .from('contractor_onboarding_status')
      .select('organization_id')
      .in('overall_status', REMINDERABLE_STATUSES);

    if (orgIdErr) {
      console.error('reminderable org lookup failed:', orgIdErr);
      return json({ error: 'lookup_failed', detail: orgIdErr.message }, 500);
    }

    const distinctOrgIds = Array.from(new Set((orgIds ?? []).map((r) => r.organization_id)));

    if (distinctOrgIds.length === 0) {
      // Guard hit — nothing to remind. Still self-unschedule.
      summary.skipped_reason = 'no_reminderable_contractors';
      const unschedRes = await unscheduleCron(supabase, cronJobName);
      summary.unscheduled = unschedRes.ok;
      return json({ ok: true, summary });
    }

    // Step 2 + 3: iterate orgs. Send admin summary always; contractor emails on June 10.
    for (const orgId of distinctOrgIds) {
      summary.orgs_processed++;

      const { data: org } = await supabase
        .from('organizations')
        .select('id, slug, name, alert_email, default_sender_name, default_sender_email')
        .eq('id', orgId)
        .maybeSingle();

      if (!org?.slug || !org.default_sender_email || !org.alert_email) {
        console.error('org missing required config for reminders', { orgId });
        continue;
      }

      // Pull all in-progress-ish contractors for this org.
      const { data: rows } = await supabase
        .from('contractor_onboarding_status')
        .select(
          'instructor_id, overall_status, current_step, instructors!inner(first_name, last_name, email)',
        )
        .eq('organization_id', orgId)
        .in('overall_status', REMINDERABLE_STATUSES);

      const all = (rows ?? []) as unknown as Array<{
        instructor_id: string;
        overall_status: string;
        current_step: number;
        instructors: { first_name: string | null; last_name: string | null; email: string | null };
      }>;

      // Admin summary (always)
      const adminBody = buildAdminSummaryText(all, org.name ?? 'enrops');
      const adminOk = await sendEmail({
        fromName: org.default_sender_name ?? org.name ?? 'enrops',
        fromEmail: org.default_sender_email,
        to: org.alert_email,
        subject: `Contractor onboarding status — ${new Date().toISOString().slice(0, 10)}`,
        text: adminBody,
        tag: 'reminder_admin_summary',
      });
      if (adminOk) summary.admin_emails_sent++;

      // Step 3: contractor reminders (only on the june10 run).
      if (type === 'admin_and_contractor') {
        const inProgress = all.filter((r) => CONTRACTOR_PROMPT_STATUSES.includes(r.overall_status));
        for (const row of inProgress) {
          if (!row.instructors.email) continue;
          const fresh = await supabase.auth.admin.generateLink({
            type: 'magiclink',
            email: row.instructors.email,
            options: { redirectTo: `${PUBLIC_SITE_URL}/${org.slug}/onboarding` },
          });
          const link = fresh.data?.properties?.action_link;
          if (!link) {
            console.error('magic link generation failed for reminder', {
              instructor_id: row.instructor_id,
            });
            summary.contractor_emails_failed++;
            continue;
          }
          const text = buildContractorReminderText({
            firstName: row.instructors.first_name ?? 'there',
            currentStep: row.current_step,
            link,
          });
          const ok = await sendEmail({
            fromName: org.default_sender_name ?? org.name ?? 'enrops',
            fromEmail: org.default_sender_email,
            to: row.instructors.email,
            subject: `Reminder: complete your contractor onboarding by June 12`,
            text,
            tag: 'reminder_contractor',
          });
          if (ok) summary.contractor_emails_sent++;
          else summary.contractor_emails_failed++;
        }
      }
    }

    // Step 4: self-unschedule — only if no contractor emails failed. If some
    // failed, leave the cron in place so we can investigate + re-trigger.
    if (summary.contractor_emails_failed === 0) {
      const unschedRes = await unscheduleCron(supabase, cronJobName);
      summary.unscheduled = unschedRes.ok;
    }

    return json({ ok: true, summary });
  } catch (err) {
    console.error('contractor-onboarding-reminders fatal:', err);
    return json({ error: 'internal_error', detail: (err as Error).message }, 500);
  }
});

function buildAdminSummaryText(
  rows: Array<{
    instructor_id: string;
    overall_status: string;
    current_step: number;
    instructors: { first_name: string | null; last_name: string | null; email: string | null };
  }>,
  orgName: string,
): string {
  const groups: Record<string, string[]> = {
    not_invited: [],
    invited: [],
    in_progress: [],
    pending_background_check: [],
    pending_stripe: [],
  };
  for (const r of rows) {
    const name = `${r.instructors.first_name ?? ''} ${r.instructors.last_name ?? ''}`.trim() ||
      r.instructors.email ||
      r.instructor_id;
    const label = r.overall_status === 'in_progress' ? `${name} (step ${r.current_step} of 8)` : name;
    if (groups[r.overall_status]) groups[r.overall_status].push(label);
  }
  const lines = [`Contractor onboarding status for ${orgName}:`, ''];
  for (const [status, names] of Object.entries(groups)) {
    if (names.length === 0) continue;
    lines.push(`${status} (${names.length}):`);
    for (const n of names) lines.push(`  - ${n}`);
    lines.push('');
  }
  if (rows.length === 0) lines.push('All contractors are complete or declined. Nothing pending.');
  return lines.join('\n');
}

function buildContractorReminderText(args: {
  firstName: string;
  currentStep: number;
  link: string;
}): string {
  return [
    `Hi ${args.firstName},`,
    ``,
    `Your onboarding deadline is June 12. You're on step ${args.currentStep} of 8.`,
    `Pick up where you left off:`,
    ``,
    args.link,
    ``,
    `If you have questions, reply to this email.`,
  ].join('\n');
}

async function sendEmail(args: {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  tag: string;
}): Promise<boolean> {
  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    console.error('RESEND_API_KEY not set');
    return false;
  }
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: `${args.fromName} <${args.fromEmail}>`,
        to: args.to,
        subject: args.subject,
        text: args.text,
        tags: [{ name: 'type', value: args.tag }],
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Resend ${args.tag} send failed:`, resp.status, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Email send exception for ${args.tag}:`, err);
    return false;
  }
}

async function unscheduleCron(
  supabase: ReturnType<typeof adminClient>,
  jobName: string,
): Promise<{ ok: boolean }> {
  // pg_cron.unschedule(text) — invoked via rpc since it's a function in cron schema.
  // No native PostgREST table for cron, so use a SECURITY DEFINER wrapper if needed.
  // For now: use the SQL endpoint via the admin client.
  const { error } = await supabase.rpc('cron_unschedule_by_name', { job_name: jobName });
  if (error) {
    console.error('cron unschedule failed:', error);
    return { ok: false };
  }
  return { ok: true };
}
