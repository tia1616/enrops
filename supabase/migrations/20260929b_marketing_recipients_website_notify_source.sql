-- A contact can come from the tenant's own website.
--
-- website-lead-intake writes marketing_recipients.source = 'website_notify' for
-- people who filled in the "Get Notified" form on the tenant's site. The CHECK
-- constraint listed four sources and rejected it, so the first real lead would
-- have 500'd the intake.
--
-- THIS ALSO CLOSES A DRIFT. The constraint was NOT the same on both databases:
--   prod    : am_afterschool, squarespace_summer, enrops_registration, manual
--   staging : ... the same four, PLUS 'wufoo'
-- 'wufoo' reached staging by hand and never became a migration. Writing the
-- four-value list plus the new one would have silently NARROWED staging and
-- broken any row already carrying it, so the list below is the UNION of both
-- databases plus 'website_notify', and the same statement now runs on each.
--
-- BEFORE / AFTER / LOST
--   before (prod)    : 4 values        after: 6 values   lost: none
--   before (staging) : 5 values        after: 6 values   lost: none
-- Nothing that is storable today stops being storable.
--
-- 'wufoo' is inert on both: wufoo-sync posts source "wufoo" to import-contacts,
-- which coerces any source outside its own allow-list to 'manual'. It is carried
-- here to preserve staging, not to enable a writer.

alter table public.marketing_recipients
  drop constraint if exists marketing_recipients_source_check;

alter table public.marketing_recipients
  add constraint marketing_recipients_source_check
  check (source = any (array[
    'am_afterschool',
    'squarespace_summer',
    'enrops_registration',
    'manual',
    'wufoo',
    'website_notify'
  ]::text[]));

comment on column public.marketing_recipients.source is
  'How this contact first reached the list. website_notify = the tenant''s own website "Get Notified" form, via the website-lead-intake edge function. A contact who arrives again through a different door keeps the source it was created with; the durable marker for "this person asked us through the website" is the website-notify TAG, which every intake row carries.';
