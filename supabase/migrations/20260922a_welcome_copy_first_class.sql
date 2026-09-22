-- 20260922a_welcome_copy_first_class.sql
--
-- The welcome emails said a class "starts" on a date that is not always a start.
--
-- {{program_start_date}} does not mean "the program's first day". It means "the
-- day THIS family should be told about": the program's start for someone who
-- signed up before term, and their own first session for someone who joins in
-- week six (see welcomeWindow.ts, welcomeVerdict -> firstDay). The surrounding
-- prose said "starts", which is only true for the first of those two.
--
-- Found on 2026-09-22 when a parent replied: "I don't understand this weird
-- message. He's been in the class for almost a month." His son had been
-- attending since 31 August; the email announced a start on 28 September, which
-- was simply his next session. A second family's email did the same thing and
-- they did not mention it.
--
-- "first class" / "first day of camp" is true in BOTH cases, so this is a
-- wording change only - no token changes, no code changes, no behaviour change.
--
-- Applied by hand to staging and prod on 2026-09-22 and recorded here so the
-- repo matches the databases. Written with replace() rather than a literal SET
-- so it is idempotent and cannot clobber an operator's own edits to the rest of
-- the body: a row that has already been changed, or that was customised, simply
-- finds no match and is left alone.

-- Template defaults (every tenant, including ones onboarded later).
update automation_templates set
  default_subject = replace(default_subject, '''s after-school program starts ', '''s first class is '),
  default_body    = replace(default_body,
    '''s {{program_name}} after-school program starts {{program_start_date}}',
    '''s first {{program_name}} class is {{program_start_date}}')
where key = 'welcome_afterschool';

update automation_templates set
  default_subject = replace(default_subject, '''s camp starts ', '''s first day of camp is '),
  default_body    = replace(default_body,
    '{{child_first_name}}''s {{program_name}} camp at {{location_name}} starts {{program_start_date}}',
    '{{child_first_name}}''s first day of {{program_name}} camp at {{location_name}} is {{program_start_date}}')
where key = 'welcome_camp';

-- Per-org body overrides. An operator who has customised the body keeps their
-- copy; only this one sentence moves. Subject overrides are untouched because
-- no org has one today - if one appears later it is that operator's own words.
update automations a set
  body_override = replace(a.body_override,
    '''s {{program_name}} after-school program starts {{program_start_date}}',
    '''s first {{program_name}} class is {{program_start_date}}')
from automation_templates t
where t.id = a.template_id and t.key = 'welcome_afterschool' and a.body_override is not null;

update automations a set
  body_override = replace(a.body_override,
    '{{child_first_name}}''s {{program_name}} camp at {{location_name}} starts {{program_start_date}}',
    '{{child_first_name}}''s first day of {{program_name}} camp at {{location_name}} is {{program_start_date}}')
from automation_templates t
where t.id = a.template_id and t.key = 'welcome_camp' and a.body_override is not null;
