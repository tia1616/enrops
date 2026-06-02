-- Schedule marketing-touchpoint-cron to run every 5 minutes.
--
-- The cron polls marketing_campaign_touchpoints for due-and-queued rows
-- whose parent campaign is approved (status='sending', approved_at NOT NULL).
-- For each, it CAS-claims the touchpoint then invokes
-- marketing-touchpoint-send via HTTP.
--
-- Safety: the safety gate against the ~71 stuck queued touchpoints (from test
-- campaigns where approved_at IS NULL) is in the cron function itself —
-- it only processes touchpoints whose campaign is approved. Verified before
-- this migration goes live.
--
-- Pattern-matches the existing offer-reminders-daily / process-installments-daily
-- crons (anon key in bearer; functions handle their own service-role internal auth).

SELECT cron.schedule(
  'marketing-touchpoint-cron-every-5min',
  '*/5 * * * *',
  $$
    SELECT net.http_post(
      url := 'https://iuasfpztkmrtagivlhtj.supabase.co/functions/v1/marketing-touchpoint-cron',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1YXNmcHp0a21ydGFnaXZsaHRqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTg3MDYsImV4cCI6MjA5MTgzNDcwNn0.sY1xg9EmgPC1jiumFwYMxXkLkemEhtLGbFg4uzQ4qUQ'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 140000
    );
  $$
);
