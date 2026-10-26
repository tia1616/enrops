-- Insurance limits on a certificate (Jessica, 2026-10-26: "add GL and
-- abuse/molestation coverage amounts (per occurrence and aggregate) to the
-- certificate form and show them to partners, before Oct 30"). Spec v3 H2
-- lists them on the provider record a host sees.
--
-- Whole dollars, as printed on a certificate. NULL = not entered. Insurance
-- only: rowFromDraft (src/lib/providerDocumentLogic.js) clears them for any
-- other document type, and the CHECK below refuses them there too.
--
-- No grant change: provider_documents is granted table-wide to authenticated
-- (20261012b) and RLS does the rest, so new columns inherit the same access.

alter table public.provider_documents
  add column if not exists gl_occurrence_limit integer,
  add column if not exists gl_aggregate_limit integer,
  add column if not exists abuse_occurrence_limit integer,
  add column if not exists abuse_aggregate_limit integer;

alter table public.provider_documents drop constraint if exists provider_documents_limits_check;
alter table public.provider_documents add constraint provider_documents_limits_check check (
  coalesce(gl_occurrence_limit, 0) >= 0 and coalesce(gl_aggregate_limit, 0) >= 0
  and coalesce(abuse_occurrence_limit, 0) >= 0 and coalesce(abuse_aggregate_limit, 0) >= 0
  and (doc_type = 'insurance' or (gl_occurrence_limit is null and gl_aggregate_limit is null
                                  and abuse_occurrence_limit is null and abuse_aggregate_limit is null))
);

comment on column public.provider_documents.gl_occurrence_limit is 'Insurance only: general liability, each occurrence, whole dollars. NULL = not entered.';
comment on column public.provider_documents.gl_aggregate_limit is 'Insurance only: general liability, aggregate, whole dollars. NULL = not entered.';
comment on column public.provider_documents.abuse_occurrence_limit is 'Insurance only: sexual abuse and molestation, each occurrence, whole dollars. NULL = not entered.';
comment on column public.provider_documents.abuse_aggregate_limit is 'Insurance only: sexual abuse and molestation, aggregate, whole dollars. NULL = not entered.';

-- The view lists its columns, so the new ones are appended (CREATE OR REPLACE
-- allows trailing columns only). OR REPLACE resets view options, so
-- security_invoker is set again explicitly: without it the view would read the
-- table as its owner and skip RLS for every caller.
create or replace view public.provider_documents_with_status as
  select d.id, d.organization_id, d.partner_id, d.doc_type, d.title, d.received_on,
         d.effective_on, d.expires_on, d.storage_path, d.original_filename, d.insurer,
         d.policy_number, d.abuse_coverage, d.coverage_notes, d.created_by, d.created_at,
         d.updated_at,
         private.document_expiry_status(d.expires_on, d.organization_id) as expiry_status,
         d.additional_insured,
         d.gl_occurrence_limit, d.gl_aggregate_limit, d.abuse_occurrence_limit, d.abuse_aggregate_limit
  from public.provider_documents d;
alter view public.provider_documents_with_status set (security_invoker = on);
