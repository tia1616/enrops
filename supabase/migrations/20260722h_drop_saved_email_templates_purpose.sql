-- Drop the vestigial saved_email_templates.purpose column.
--
-- Added by 20260722f for a Chunk 4b design (tag instructor templates by purpose)
-- that was CUT the same day: instructor send copy is controlled in Automations,
-- not tagged in Templates (one-place-to-edit). The column shipped but had no
-- reader (grepped src + edge fns) and every row is NULL, so it's pure dead schema.
-- Dropping it also removes its CHECK constraint. Applied to staging + prod same pass.

alter table public.saved_email_templates drop column if exists purpose;
