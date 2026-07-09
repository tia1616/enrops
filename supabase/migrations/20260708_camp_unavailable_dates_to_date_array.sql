-- Camp instructor_availability.unavailable_dates was daterange[] but inert (never
-- written by the form, never read by match-instructors). Normalize to date[] to match
-- the after-school column so the same date-picker + "needs a sub" board logic serves
-- both flows.
--
-- SAFE ONLY WHILE EMPTY: verified 0 rows with unavailable_dates data on staging AND
-- prod (2026-07-08). USING NULL is therefore lossless. RE-VERIFY emptiness before
-- applying to prod, and apply this BEFORE the frontend that reads/writes date[] deploys.
ALTER TABLE public.instructor_availability
  ALTER COLUMN unavailable_dates TYPE date[]
  USING NULL::date[];

COMMENT ON COLUMN public.instructor_availability.unavailable_dates IS
  'Individual dates the instructor cannot work this cycle (within weeks they picked). Surfaced as a sub-needed warning on the board, not a hard block.';
