-- A test send is not a send to a family, and the reporting has to be able to
-- tell them apart.
--
-- marketing_sends records every email marketing-touchpoint-send ships, test
-- sends included, with no marker. That was survivable while the per-touchpoint
-- dedup capped tests at ONE row per touchpoint forever: at most one stray row
-- could reach the numbers. On 2026-09-07 that dedup was deliberately bypassed
-- for mode='test' (Jeff could not re-preview the email he was editing), so an
-- operator iterating on copy now writes a row per click, bounded only by
-- TEST_SEND_THROTTLE_PER_MINUTE = 30.
--
-- Those rows land in CampaignDetail's engagement summary, which selects every
-- marketing_sends row for the campaign and aggregates client-side, and in the
-- family timeline drawer against the operator's own contact. Eight tests while
-- writing an email would overstate that touchpoint's sent count by eight.
--
-- Shape copied from suppressed_by_throttle on this same table: boolean, NOT
-- NULL, default false. Every existing row is a real send or a pre-bypass test
-- capped at one, so backfilling false is correct and no data migration is
-- needed.
--
-- DEPLOY ORDER: this migration runs on BOTH databases BEFORE the function that
-- writes the column. The insert is a bulk insert of the whole batch - an
-- unknown column fails the entire statement, and the code path only pushes the
-- failure onto results.errors because the emails have already shipped. Column
-- first, then the function, then the frontend that reads it.

alter table public.marketing_sends
  add column if not exists is_test boolean not null default false;

comment on column public.marketing_sends.is_test is
  'True when this row came from mode=''test'' (operator previewing their own copy). Real family sends are false. Reporting surfaces must exclude true.';

-- Partial index: every reader filters is_test = false, and the real-send rows
-- are the overwhelming majority, so index the exception rather than the rule.
create index if not exists marketing_sends_test_rows_idx
  on public.marketing_sends (campaign_id)
  where is_test;
