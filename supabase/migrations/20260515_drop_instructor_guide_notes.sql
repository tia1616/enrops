-- Drop curricula.instructor_guide_notes
-- Run date: 2026-05-15
--
-- The original Chunk 1 spec included an AI-extracted "instructor guide notes"
-- field as a catch-all for prep notes / classroom mgmt tips from the doc.
-- Per Jessica's review: instructors already have the original uploaded
-- document in Storage and don't need a separate AI synthesis of it. The
-- column was added empty in 20260515_reconcile_curricula_to_chunk2_spec.sql
-- and is being removed before any data is ever written to it.
--
-- Verified empty before this migration: curricula has 0 rows.

ALTER TABLE curricula DROP COLUMN IF EXISTS instructor_guide_notes;
