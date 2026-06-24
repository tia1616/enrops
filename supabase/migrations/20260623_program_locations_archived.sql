-- 20260623_program_locations_archived.sql
--
-- Part of the Schools & Partners redesign. Lets an operator ARCHIVE an orphan
-- venue (one with no partner_id) so it stops nagging at the top of the unified
-- Partners list in the self-emptying "Needs linking" section. Reversible — the
-- venue is hidden, not deleted, and can be restored.
--
-- Additive and safe: nullable-default-false boolean; nothing else reads it yet
-- except NeedsLinkingSection's orphan query (filters archived = false).

alter table program_locations
  add column if not exists archived boolean not null default false;

comment on column program_locations.archived is
  'Operator-archived venue: hidden from the Needs-linking surface so a venue they have decided to leave unlinked does not nag at the top of the Partners list. Reversible.';
