-- A camp day has to say WHICH KIND of day it is, because that is what it pays.
--
-- THE BUG THIS EXISTS TO CLOSE. Instructor pay is resolved from
-- tenant_pay_rates keyed on (organization_id, role, session_type). Camps used
-- to live in camp_sessions, which carries a session_type, so the rate always
-- had a key. Since 2026-09-25 a camp is a row in `programs` instead - and every
-- writer of session_delivery_confirmations hard-coded session_type =
-- 'after_school' for a program, with the comment "programs carry no
-- session_type". That was true when programs only held weekly classes.
--
-- J2S's configured rates make the cost concrete: lead after_school $60,
-- lead full_day $160. A four-day full-day winter camp paid a lead $240 instead
-- of $640. Nothing errors and nothing is flagged - the number looks plausible
-- on the Payroll screen and the instructor is simply short $400.
--
-- THE VOCABULARY ALREADY EXISTS, and this column deliberately reuses it rather
-- than inventing a camp-only spelling: tenant_pay_rates.session_type and
-- session_delivery_confirmations.session_type are both CHECKed against exactly
-- morning | afternoon | full_day | after_school, and camp_sessions.session_type
-- (the old camp shape, still live for the SU26 board) uses the first three.
-- The camp availability survey asks instructors in those same words.
--
-- NULLABLE, and null on every weekly class. The column is meaningful only for a
-- camp; the code answers 'after_school' for a weekly class without reading it,
-- which is what keeps a class's pay byte-for-byte what it was. A camp that
-- somehow carries no session_type is NOT defaulted to after-school - the
-- writers refuse to price the day and say so, because a blank that asks is safe
-- and a wrong number that pays is not.
--
-- ADDITIVE AND INERT ON ITS OWN. Adding the column changes no behaviour until
-- the builder writes it and the confirmation writers read it, so this lands on
-- staging and prod in the same pass ahead of both. It has to: a widened
-- .select() is a deploy-order contract, and PostgREST fails the whole statement
-- on an unknown column - these are the pay-writing send paths.
--
-- Prod carries ZERO camp programs as of 2026-09-30 (verified by query, not by
-- assumption), so there is nothing here to backfill there.

alter table public.programs
  add column if not exists session_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.programs'::regclass
      and conname = 'programs_session_type_check'
  ) then
    alter table public.programs
      add constraint programs_session_type_check
      check (
        session_type is null
        or session_type = any (array['morning', 'afternoon', 'full_day', 'after_school'])
      );
  end if;
end $$;

comment on column public.programs.session_type is
  'Which kind of day a CAMP runs (morning | afternoon | full_day), and therefore which tenant_pay_rates cell its days pay at. NULL on a weekly class, which always pays at after_school. Never defaulted: a camp with no session_type is refused a pay amount rather than priced as after-school.';
