-- 20260824a_instructor_photo_release_consent.sql
--
-- Record whether an instructor agreed to be photographed and filmed.
--
-- WHY. Screen 6's photo/video release had THREE tick boxes and all three were
-- required to finish onboarding - including "I consent to use of my likeness in
-- marketing materials". So agreeing to appear in a provider's marketing was a
-- condition of being allowed to work. Jessica, 2026-08-24: "they have to be able
-- to not accept it and deny that and still be able to continue. shouldn't be
-- mandatory to work for a provider." She is right, and it is the same defect
-- class as the required registration checkbox found on prod the same day: a box
-- that can only ever record YES is not a question, it is a gate.
--
-- AND IT WAS RECORDED NOWHERE. Worth stating plainly because it changes what this
-- migration is for. The wizard posts only
-- `{step, documents:[{document_id, document_version}]}` - the individual tick
-- states are not sent, not stored, and never were. So the old flow coerced a
-- consent AND kept no evidence of it. Making the box optional without adding
-- somewhere to put the answer would have been strictly worse: the instructor
-- declines, nothing is written, the provider never finds out, and their photo is
-- used anyway. The column is the half that makes the optional box safe.
--
-- SHAPE COPIED FROM THE SIBLING THAT ALREADY EXISTS. Families answer this same
-- question at registration and it is stored as
-- `registrations.photo_release_consent` + `photo_release_consent_at`. Same
-- question, same two column names, so nobody has to learn a second spelling and
-- the roster badges already read "Photo OK" / "No photo" off that shape.
--
-- NULLABLE, AND THAT IS THE POINT - three states, not two:
--   NULL  = never asked. Every instructor who onboarded before this shipped.
--   true  = agreed.
--   false = declined, deliberately.
-- A NOT NULL DEFAULT false would silently relabel every existing instructor as
-- having REFUSED consent they were never asked for, which is a worse lie than
-- having no answer. The screen shows "-" for NULL and "Declined" for false.
--
-- SILENCE IS RECORDED AS DECLINED, deliberately (Jessica chose a single optional
-- tick over a two-option choice). An instructor who does not notice the box is
-- stored as false, not NULL - NULL means "the question was never put to them",
-- and once the screen has shown it, it was put to them. False is also the
-- fail-safe direction: the failure mode is not using a photo we could have used,
-- rather than using one we should not have.
--
-- NOTHING READS THESE COLUMNS YET, so this is additive and inert on both
-- databases. Verified before writing: no column named photo_release_consent
-- exists on `instructors` on prod or staging, and every other occurrence of that
-- name in the repo is on `registrations` (the family side) - checked with a
-- repo-wide grep, not assumed.

alter table public.instructors
  add column if not exists photo_release_consent boolean,
  add column if not exists photo_release_consent_at timestamptz;

comment on column public.instructors.photo_release_consent is
  'Did this instructor agree to be photographed/filmed and to their likeness being used in the provider''s marketing? NULL = never asked (onboarded before 2026-08-24). false = declined. Answered on onboarding Screen 6; declining does not block onboarding.';

comment on column public.instructors.photo_release_consent_at is
  'When photo_release_consent was last answered. NULL whenever photo_release_consent is NULL.';
