// supabase/functions/marketing-automations-cron/index.ts
// Cron job that fires triggered automation emails hourly.
// Checks each enabled automation and sends to eligible recipients.
//
// Designed to be called by pg_cron or Supabase Cron:
//   SELECT net.http_post(url, '{}', headers)
//
// Trigger types handled:
//   - registration_complete: fires immediately on new registration (handled by webhook, not cron)
//   - days_before_start: fires N days before first_session_date
//   - days_after_start: fires N days after first_session_date
//   - session_halfway: fires at session_count/2
//   - session_complete: fires after last session
//   - student_birthday: fires on student's birthdate

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();
  const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

  let totalSent = 0;
  let totalErrors = 0;

  try {
    // Load all enabled automations with their templates
    const { data: automations } = await supabase
      .from('marketing_automations')
      .select(`
        *,
        template:marketing_automation_templates(*)
      `)
      .eq('enabled', true);

    if (!automations || automations.length === 0) {
      return json({ message: 'No enabled automations', sent: 0 });
    }

    for (const auto of automations) {
      const tpl = auto.template;
      if (!tpl) continue;

      const subject = auto.subject_override ?? tpl.default_subject;
      const body = auto.body_override ?? tpl.default_body;
      const timing = auto.timing_config ?? tpl.default_timing ?? {};

      try {
        switch (tpl.trigger_type) {
          case 'days_before_start': {
            const daysBefore = timing.days_before ?? 7;
            // Find registrations where first_session_date is daysBefore days from today
            const targetDate = addDays(now, daysBefore);
            const targetDateStr = targetDate.toISOString().split('T')[0];

            const { data: eligible } = await supabase.rpc('get_automation_eligible_days_before', {
              p_org_id: auto.organization_id,
              p_target_date: targetDateStr,
              p_automation_id: auto.id,
            });

            // For now, log what would fire — actual send requires the RPC function
            console.log(`[${tpl.slug}] Would fire for ${(eligible ?? []).length} recipients on ${targetDateStr}`);
            break;
          }

          case 'days_after_start': {
            const daysAfter = timing.days_after ?? 14;
            const targetDate = addDays(now, -daysAfter);
            const targetDateStr = targetDate.toISOString().split('T')[0];

            console.log(`[${tpl.slug}] Checking for sessions that started on ${targetDateStr}`);
            break;
          }

          case 'student_birthday': {
            // Find students whose birthdate month+day matches today
            const monthDay = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
            console.log(`[${tpl.slug}] Checking for birthdays on ${monthDay}`);
            break;
          }

          case 'session_halfway':
          case 'session_complete': {
            // These require curriculum skills from DB (blocked until migration)
            console.log(`[${tpl.slug}] Skipped — requires curriculum skills DB migration`);
            break;
          }

          case 'registration_complete': {
            // Handled by stripe-webhook, not by cron
            break;
          }
        }
      } catch (e) {
        console.error(`Automation ${tpl.slug} error:`, e);
        totalErrors++;
      }
    }

    return json({ sent: totalSent, errors: totalErrors, checked: automations.length });
  } catch (e) {
    console.error('marketing-automations-cron error:', e);
    return json({ error: e.message }, 500);
  }
});

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
