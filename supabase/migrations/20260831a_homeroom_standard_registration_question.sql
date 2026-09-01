-- Homeroom teacher becomes a normal configurable registration question.
--
-- WHY. Until now the field was hardcoded into the registration form and wrapped
-- in `{!lean && ...}`, where `lean = instructor_pay_model !== 'legacy_own_platform'`
-- - a BILLING column. Measured on prod 2026-08-28: j2s is the only active org of
-- seven where the question renders, in the form AND in the Registration Questions
-- screen. So a provider on any other pay model could not see that the platform
-- already asks for a homeroom teacher, and one of them built a duplicate custom
-- question instead. A registration question must not hide behind a billing
-- setting. Jessica, 2026-08-28.
--
-- TWO PARTS, and the second is the one that must not be forgotten:
--   1. Allow 'homeroom_teacher' as a standard_key, so the question can be
--      configured per org like the other four.
--   2. Seed it ON and REQUIRED for the orgs whose form asks it TODAY. Without
--      this, shipping the frontend half silently un-requires what 5ed9621e
--      deliberately made mandatory on 2026-08-24 (42 of 118 FA26 registrations
--      had no homeroom teacher, so instructors collecting a class from
--      classrooms had nothing to go on for a third of the roster).
--
-- DEFAULT OFF FOR EVERYONE ELSE. A provider opts in; absence of a row IS off
-- (see get_active_registration_fields). No row is inserted for any other org, so
-- no live checkout form gains a field nobody asked for - the mistake the
-- mandatory photo gate made twice.
--
-- INERT UNTIL THE FRONTEND SHIPS. On an environment still running the old
-- frontend: the registration form reads std.homeroom_teacher from nowhere (it
-- renders the field on `!lean`, exactly as before), and the Registration
-- Questions screen filters its custom list to `standard_key IS NULL` and seeds
-- its standard section from its own STANDARD_FIELDS array, so a row for an
-- unknown standard_key is invisible there rather than mis-rendered. That is why
-- this migration is safe to apply to both environments in the same pass, ahead
-- of the frontend, and why it MUST go first: the reverse order takes the
-- question off j2s's live form.

begin;

-- 1. Widen the standard_key vocabulary.
--
-- Rewritten in full rather than patched, so the allowed set is readable in one
-- place. 'emergency_contact' and 'how_heard' are carried over unchanged: no org
-- has a row for either on either environment, but they are part of the stored
-- contract and dropping them here would be a silent narrowing.
alter table public.custom_reg_fields
  drop constraint if exists custom_reg_fields_standard_key_check;

alter table public.custom_reg_fields
  add constraint custom_reg_fields_standard_key_check
  check (
    standard_key is null
    or standard_key = any (array[
      'guardian_secondary',
      'dismissal_method',
      'authorized_pickup',
      'do_not_release',
      'emergency_contact',
      'how_heard',
      'homeroom_teacher'
    ])
  );

-- 2. Seed the orgs that already ask it, ON and REQUIRED.
--
-- Selected by the SAME config test the old frontend used to decide whether to
-- render the field (Register.jsx: instructor_pay_model === 'legacy_own_platform'),
-- NOT by a hardcoded slug or UUID. So this seeds exactly the set whose families
-- are answering the question today, on whichever environment it runs, and an org
-- that changes pay model later is unaffected - its row already exists and is
-- its own to configure.
--
-- field_key / field_type / applies_to / sort_order match what saveStandard()
-- writes for a standard question, so the operator's next save in Registration
-- Questions is a no-op on this row rather than a rewrite. sort_order 4 is
-- homeroom's index in STANDARD_FIELDS.
--
-- DO NOTHING, not DO UPDATE: re-running this must never re-arm a question an
-- operator has since turned off or made optional. The insert is the seed, not
-- the policy.
insert into public.custom_reg_fields
  (organization_id, standard_key, field_key, label, field_type,
   is_required, is_active, applies_to, sort_order)
select o.id, 'homeroom_teacher', 'std_homeroom_teacher', 'Homeroom teacher', 'standard',
       true, true, 'all', 4
from public.organizations o
where o.instructor_pay_model = 'legacy_own_platform'
on conflict (organization_id, field_key) do nothing;

commit;
