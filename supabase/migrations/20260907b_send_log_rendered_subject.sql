-- Store the SUBJECT LINE the family actually received, alongside the send record
-- 20260907a created.
--
-- WHY. 20260907a made transactional sends visible, but only as a category:
-- "Refund receipt", "Registration confirmed". An operator scanning a family's
-- record recognises the sentence that landed in the inbox, not our label for it.
--
-- WHY THE SUBJECT AND NOT THE BODY. Looked at what comparable platforms do
-- (2026-09-07). Dynamics 365 archives an exact copy per recipient and caps
-- retention at ONE YEAR -- the cap is the cost. HubSpot expands the full body on
-- the timeline. Activity Messenger, the closest comparable, stores NO
-- per-recipient content at all: you open the template and see which sends came
-- from it. Storing every rendered body here would also turn this table into a
-- store of child names, classes and dismissal arrangements, with a retention
-- question attached. The subject is most of the recognition for almost none of
-- the cost or the exposure.
--
-- THE NAME IS DELIBERATE. marketing_sends already carries `rendered_subject` for
-- exactly this purpose, so this is the existing in-house pattern rather than a
-- second spelling of one idea.
--
-- Additive and nullable: every existing row keeps a null and every reader falls
-- back to the label it uses today. Prod's grant on this table is table-level
-- (22 of 22 columns SELECT-granted to authenticated, checked on staging after
-- 20260907a), so the new column is covered without an explicit grant.
--
-- NOTE FOR WHOEVER ADDS THE AUTOMATION SIDE: lifecycle-automations-cron computes
-- its own subject and does NOT write this column yet, so automation rows still
-- fall back to automation_templates.display_name. That is a deliberate scope
-- line, not an oversight -- see the board item on template versioning, which is
-- the honest way to answer "what did this actually say" for template-driven mail.

alter table public.automation_run_recipients
  add column if not exists rendered_subject text;

comment on column public.automation_run_recipients.rendered_subject is
  'The subject line as the recipient received it, after variable substitution. Null for rows written before 20260907b and for automation sends, which still resolve their display name from automation_templates.';
