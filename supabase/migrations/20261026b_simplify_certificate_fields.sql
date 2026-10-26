-- A document is the file, who it's for, and when it expires. Nothing typed off it.
--
-- Jessica, 2026-10-26: "why would i edit the coverage amounts? ... don't i just
-- upload the form, and then the partner can see it? i've never had to tell a
-- partner manually what amounts are on a coi - they just ask for one, i get it
-- and send them the coi. check yourself for overengineering." She chose: the
-- form asks for the file, the partner, and the expiry date only.
--
-- So the fields copied by hand off a certificate go: insurer, policy number,
-- abuse coverage, coverage notes, additional insured, and the four coverage
-- amounts (which existed on staging only, from a migration deleted the same
-- day). The partner reads all of it on the certificate itself, which is the
-- document of record; a hand-typed copy beside it can only drift from it.
-- Expiry stays: it drives Current / Expiring in 30 days and the reminders.
--
-- None of this reached prod, so nothing is lost there. `if exists` lets the
-- same file run on staging (which has every column) and prod (which has none
-- of the table yet when this runs after 20261012b and 20261020a).
--
-- The view lists its columns, and CREATE OR REPLACE cannot remove one, so it is
-- dropped and recreated: security_invoker set in the CREATE, grants re-issued
-- explicitly (Supabase stops auto-granting new objects in public on 2026-10-30).

drop view if exists public.provider_documents_with_status;

alter table public.provider_documents drop constraint if exists provider_documents_limits_check;
alter table public.provider_documents
  drop column if exists insurer,
  drop column if exists policy_number,
  drop column if exists abuse_coverage,
  drop column if exists coverage_notes,
  drop column if exists additional_insured,
  drop column if exists gl_occurrence_limit,
  drop column if exists gl_aggregate_limit,
  drop column if exists abuse_occurrence_limit,
  drop column if exists abuse_aggregate_limit;

create view public.provider_documents_with_status
with (security_invoker = on) as
  select d.id, d.organization_id, d.partner_id, d.doc_type, d.title, d.received_on,
         d.effective_on, d.expires_on, d.storage_path, d.original_filename,
         d.created_by, d.created_at, d.updated_at,
         private.document_expiry_status(d.expires_on, d.organization_id) as expiry_status
  from public.provider_documents d;

revoke all on public.provider_documents_with_status from public, anon;
grant select on public.provider_documents_with_status to authenticated, service_role;
