-- legal_documents: let a provider author their OWN documents.
--
-- WHY THIS IS NEEDED AT ALL. Today the table is effectively read-only for every
-- operator: `org_members_read_legal_docs` is SELECT-only, and the only write
-- policy is `platform_admin_legal_docs` (is_platform_admin()). J2S's seven
-- documents were seeded by migration, which is why nobody noticed. A provider
-- onboarding their first instructor has ZERO documents and no way to write any,
-- so every document step of the wizard renders empty. This unblocks that.
--
-- APPEND-ONLY, ON PURPOSE. This grants INSERT and deliberately grants NO UPDATE
-- and NO DELETE. Reasons, in order of importance:
--
--   1. A published version must never change under people who already read it.
--      `submit-agreement` snapshots the text into contractor_agreements at
--      signing time, so a past signature is already safe -- but without this
--      restriction two people could both "sign v1.0" having read different text,
--      and the only proof of the difference would be buried in snapshots.
--      Append-only makes that impossible in the DATABASE rather than relying on
--      the UI to behave. A screen is not a gate.
--
--   2. The table is already designed for it: UNIQUE(organization_id,
--      document_key, document_version) plus `replaced_by` and `effective_from`
--      describe a versioned, superseding document set, not a mutable record.
--      get-legal-document resolves the ACTIVE document as the most recently
--      created row for (org, key), so publishing a new version is exactly an
--      INSERT and needs no update to the old row.
--
--   3. Nothing is lost. Correcting a typo publishes a new version, which is the
--      correct behaviour for a legal document anyway.
--
-- If in-place editing of an unsigned draft is ever wanted, add a separate
-- `status`/draft column and a policy scoped to it -- do NOT loosen this one.
--
-- HOW THE BLOCK BEHAVES, MEASURED not assumed (staging, 2026-08-11, as a real
-- org admin over PostgREST): a cross-org INSERT is refused loudly, 403 with
-- SQLSTATE 42501. An UPDATE or DELETE is refused SILENTLY -- 200 with an empty
-- result set, because with no permissive policy for those commands the row is
-- simply invisible to them, so zero rows match and nothing errors. Re-reading
-- the row confirmed it was untouched, and no attack row was created.
--
-- The data guarantee therefore holds, but the failure is quiet. Nothing in the
-- product issues an UPDATE or DELETE here (the authoring screen only inserts),
-- so no operator can hit it today. Anyone who later adds an "edit" control MUST
-- know this: it would appear to succeed and change nothing -- the silent-failure
-- bug class. Give it a draft policy, or check the affected-row count.
--
-- ADDITIVE AND INERT. No operator could write to this table before, so adding
-- an INSERT policy cannot change any existing behaviour, on either environment,
-- until an authoring surface exists. Safe to apply to prod in the same pass.
--
-- Authorization: can_admin_org(uuid) is the same SECURITY DEFINER helper the
-- other owner/admin write policies use (e.g. members_update_own_org), so this
-- inherits one definition of "may administer this org" instead of inventing a
-- second one. organization_id is checked against the ROW being written, so an
-- admin of org A cannot write a row belonging to org B.

drop policy if exists org_admins_write_legal_docs on public.legal_documents;

create policy org_admins_write_legal_docs
  on public.legal_documents
  for insert
  to authenticated
  with check ( can_admin_org(organization_id) );

comment on table public.legal_documents is
  'Versioned per-org documents instructors read and sign. APPEND-ONLY for org '
  'admins: publish a new version rather than editing a published one, so text '
  'cannot change under someone who already read it. get-legal-document treats '
  'the most recently created row for (organization_id, document_key) as active.';
