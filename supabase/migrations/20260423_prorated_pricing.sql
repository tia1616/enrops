-- Patch 1: Formula-based prorated pricing
-- Run date: 2026-04-23
--
-- Adds session_count and program_type columns to programs table.
-- Pricing becomes: session_count × per-session rate, rounded to nearest dollar.
-- Standard rate: $35.625/session (= $285 / 8)
-- Coding/Robotics rate: $37.375/session (= $299 / 8)
--
-- program_type is auto-detected by the frontend via keyword matching on curriculum
-- (minecraft, coder, coding, robotics, python, mbot, bricks & bots, scratch, etc.)
-- The DB column allows explicit override if the keyword match is wrong for any row.
--
-- IMPORTANT: Run this migration in Supabase SQL Editor BEFORE deploying the new dist.zip.
-- The frontend gracefully falls back (session_count defaults to 8, program_type auto-detects)
-- if the migration hasn't run yet, but you'll get wrong prices for any non-8-session program.

-- Add new columns with sane defaults so existing rows don't break
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS session_count INTEGER NOT NULL DEFAULT 8;

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS program_type TEXT NOT NULL DEFAULT 'standard'
  CHECK (program_type IN ('standard', 'coding_robotics'));

-- Backfill program_type from curriculum name keyword matching.
-- This mirrors the frontend's detectProgramType() logic.
UPDATE programs
SET program_type = 'coding_robotics'
WHERE
  curriculum ILIKE '%minecraft%'
  OR curriculum ILIKE '%coder%'
  OR curriculum ILIKE '%coding%'
  OR curriculum ILIKE '%robotics%'
  OR curriculum ILIKE '%robot%'
  OR curriculum ILIKE '%python%'
  OR curriculum ILIKE '%mbot%'
  OR curriculum ILIKE '%bricks & bots%'
  OR curriculum ILIKE '%bricks and bots%'
  OR curriculum ILIKE '%scratch%'
  OR curriculum ILIKE '%computer%';

-- Backfill session_count for known short-run programs.
-- Cascadia runs 6 sessions in fall only.
-- (Add other non-8-session programs here as you discover them.)
UPDATE programs
SET session_count = 6
WHERE school_id IN (
  SELECT id FROM schools WHERE name ILIKE '%cascadia%'
)
AND term = 'FA26';

-- Optional: make price_cents nullable since formula is now source of truth.
-- Keeping it non-nullable for now so old rows with existing prices don't break anything.
-- The frontend ignores price_cents and uses the formula via calculateProgramPrice().
-- If you want to clean up later: ALTER TABLE programs ALTER COLUMN price_cents DROP NOT NULL;

-- Sanity check: see the new prices that will be displayed.
-- Uncomment and run to verify before deploying:
-- SELECT
--   s.name AS school,
--   p.curriculum,
--   p.term,
--   p.day_of_week,
--   p.session_count,
--   p.program_type,
--   CASE
--     WHEN p.program_type = 'coding_robotics'
--       THEN ROUND((p.session_count * 37.375)::numeric) * 100
--     ELSE ROUND((p.session_count * 35.625)::numeric) * 100
--   END AS calculated_price_cents
-- FROM programs p
-- JOIN schools s ON s.id = p.school_id
-- WHERE p.status = 'open'
-- ORDER BY s.name, p.term;
