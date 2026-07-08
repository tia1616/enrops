-- Structured date-specific unavailability for after-school (weekly) availability.
-- Individual dates the instructor already knows they can't make; the matcher/picker
-- surface a non-blocking "needs a sub that day" warning when a class session falls
-- on one of these. Additive + nullable; RLS already covered by the table's
-- instructor_term_availability_self policy (row-level).
--
-- Applied to staging (mumfymlapolsfdnpewci) 2026-07-08 via MCP; apply to prod
-- (iuasfpztkmrtagivlhtj) in the same pass on ship.
ALTER TABLE public.instructor_term_availability
  ADD COLUMN IF NOT EXISTS unavailable_dates date[] NULL;

COMMENT ON COLUMN public.instructor_term_availability.unavailable_dates IS
  'Individual dates the instructor cannot teach this term (weekly-class conflicts). Surfaced as a sub-needed warning, not a hard block.';
