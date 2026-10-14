-- A substitute's "Mark taught" (confirm-sub-delivery) has always written
-- confirmed_by='sub' - deliberately, so a sub-taught day never reads as the
-- regular instructor's own confirmation. This CHECK never allowed 'sub', so
-- every sub's mark-taught failed with a 23514 and a 500, on staging and prod,
-- since the function shipped: zero 'sub' rows existed on either database on
-- 2026-10-14, when Kyle Hering could not mark his 10/12 and 10/14 covers.
--
-- Every reader treats confirmed_by as pending vs not-pending (Payroll,
-- instructor portal, pay-instructor, admin-confirm-session,
-- skip_program_session, guard_pay_line_against_skipped_day), so 'sub' needs no
-- other change. Additive: every existing row still passes.
alter table public.session_delivery_confirmations
  drop constraint if exists session_delivery_confirmations_confirmed_by_check;
alter table public.session_delivery_confirmations
  add constraint session_delivery_confirmations_confirmed_by_check
  check (confirmed_by = any (array['pending'::text, 'self'::text, 'auto'::text, 'admin'::text, 'sub'::text]));
