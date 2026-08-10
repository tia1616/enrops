-- Welcome sweep: run the Welcome trigger every 15 minutes, not once a day.
--
-- Why: lifecycle-automations-daily fires at 15:00 UTC (8am PT) and is the ONLY
-- thing that has ever delivered a Welcome on prod. A parent signing up at 10am
-- for a class that afternoon got nothing at all: by the next morning's run the
-- program had started, and the audience excluded anything already begun. The
-- event-mode hook in stripe-webhook was supposed to cover this and has never
-- produced a single send in prod; it also cannot help registrations that never
-- touch Stripe (admin-added, $0, imported).
--
-- The sweep asks one question — "is anyone newly eligible for a Welcome?" — and
-- is a no-op the rest of the time:
--   * only the days_before_first_session trigger runs (everything else is
--     date-anchored and stays on the daily job)
--   * the UNIQUE constraint on automation_run_recipients.context_key means a
--     family already emailed is skipped, so re-running is free
--   * it holds off outside 7am-9pm in the ORG's own timezone, so nobody is
--     emailed at 3am; anyone found then goes out on the 7am sweep
--   * it does not write an automation_runs row when it finds nobody, which
--     would otherwise add ~100k empty rows a year
--
-- PROD ONLY, deliberately. Staging has no lifecycle cron job at all, so adding
-- a 15-minute sender there would start firing staging email nobody asked for.
-- Staging was verified by invoking the function directly instead.
--
-- REQUIRES the lifecycle-automations-cron edge function to be deployed FIRST.
-- Against an older deploy the sweep_welcome flag is an unknown key, the body
-- reads as plain cron mode, and every trigger would re-run every 15 minutes.

-- Mirrors lifecycle-automations-daily exactly (same URL, same anon bearer, same
-- timeout) so the two jobs cannot drift; only the schedule and the body differ.
-- The anon key is the publishable one already shipped in the frontend bundle.
select cron.schedule(
  'lifecycle-welcome-sweep',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://iuasfpztkmrtagivlhtj.supabase.co/functions/v1/lifecycle-automations-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1YXNmcHp0a21ydGFnaXZsaHRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTg3MDYsImV4cCI6MjA5MTgzNDcwNn0.sY1xg9EmgPC1jiumFwYMxXkLkemEhtLGbFg4uzQ4qUQ'
    ),
    body := '{"sweep_welcome": true}'::jsonb,
    timeout_milliseconds := 140000
  );
  $$
);
