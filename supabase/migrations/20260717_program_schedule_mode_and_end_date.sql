-- 20260717_program_schedule_mode_and_end_date.sql
-- Chunk 1 of range-scheduling: additive + inert schema for the alternate
-- "range" scheduling mode (start + end date -> derived session count/dates),
-- alongside the existing "count" mode (fixed session_count + weekly walk).
--
-- ADDITIVE AND EMPTY: every existing row becomes schedule_mode='count', which
-- is EXACTLY today's behavior, and end_date NULL. NOTHING reads these columns
-- yet (the range derivation fn, the wizard toggle, and the edit surfaces come
-- in later chunks), so this changes no runtime behavior. Backward-compat is
-- proven, not argued: after this runs, all N rows must be schedule_mode='count'
-- and end_date NULL, and the row count is unchanged.
--
-- schedule_mode enum follows the house CHECK style (cf. programs_status_check,
-- programs_program_type_check). The "range mode REQUIRES end_date" cross-field
-- invariant is intentionally NOT added here -- it lands WITH the wizard write
-- path (enforced in the DB write AND mirrored in the UI in the same chunk, per
-- the invariant-in-both-places rule), when a range row can first exist. Adding
-- it now would be enforcing a guard no write path can yet satisfy or violate.
--
-- STAGING FIRST: applied to staging (mumfymlapolsfdnpewci) only. Prod parity is
-- the same additive+inert change, applied on Jessica's go AFTER she tests range
-- mode on staging -- never prod before the staging test, even additive.

ALTER TABLE public.programs
  ADD COLUMN IF NOT EXISTS schedule_mode text NOT NULL DEFAULT 'count',
  ADD COLUMN IF NOT EXISTS end_date date;

-- Guarded so the migration is safely re-runnable (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.programs'::regclass
      AND conname  = 'programs_schedule_mode_check'
  ) THEN
    ALTER TABLE public.programs
      ADD CONSTRAINT programs_schedule_mode_check
      CHECK (schedule_mode = ANY (ARRAY['count'::text, 'range'::text]));
  END IF;
END $$;

COMMENT ON COLUMN public.programs.schedule_mode IS
  'count = fixed session_count + weekly walk from first_session_date (default; = legacy behavior). range = derive sessions between first_session_date and end_date on day_of_week, minus closures. Added 2026-07-17, inert until the range derivation + wizard ship.';
COMMENT ON COLUMN public.programs.end_date IS
  'Range mode only: inclusive last meeting-eligible day of the window. NULL in count mode. Added 2026-07-17.';
