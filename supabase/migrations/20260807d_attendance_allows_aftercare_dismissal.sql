-- attendance_records.dismissal_kind gains 'aftercare'.
--
-- WHY A NEW KIND RATHER THAN REUSING ONE. Once a family can answer "goes to
-- aftercare", an instructor has to be able to record what they did at the end of
-- class. The existing kinds are released_to_adult, walked_or_biked, not_dismissed
-- and released_to_guardian, and none of them describes it:
--
--   - released_to_adult is the obvious-looking reuse and is actively WRONG. Class
--     Reports flags `dismissal_kind === 'released_to_adult' && !released_to_contact_id`
--     as "Released to someone not on the authorized list", in RED, in the grid and
--     in the detail panel (ClassReports.jsx:598 and :668). An aftercare program is
--     not a contact row, so every single aftercare dismissal would raise a
--     safety violation against an instructor who did exactly the right thing.
--     A compliance report that cries wolf on the normal case stops being read.
--   - walked_or_biked means the child left alone, which is the opposite.
--   - not_dismissed means it did not happen.
--
-- Jessica, 2026-08-07, on how this actually works: "instructors usually walk kids
-- to aftercare then take the rest outside to their parents or bikes." It is a
-- staff-performed handoff to a program, not a release to a person - its own thing,
-- so it gets its own value.
--
-- ADDITIVE AND INERT. Widening a CHECK cannot invalidate an existing row, and
-- nothing writes 'aftercare' until the frontend that offers the option ships. Zero
-- rows carry it today on either environment. Safe to apply to prod ahead of the
-- frontend, which is the right order here - the frontend is the side that breaks
-- alone, since it would write a value the constraint rejects.

alter table public.attendance_records
  drop constraint if exists attendance_records_dismissal_kind_chk;

alter table public.attendance_records
  add constraint attendance_records_dismissal_kind_chk
  check (
    dismissal_kind is null
    or dismissal_kind = any (array[
      'released_to_adult'::text,
      'walked_or_biked'::text,
      'not_dismissed'::text,
      'released_to_guardian'::text,
      'aftercare'::text
    ])
  );
