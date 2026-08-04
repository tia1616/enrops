-- 20260804a_document_recipient_delivery.sql
--
-- Documentation only. No data change, no backfill.
--
-- roster_email_sends.recipients now carries a per-recipient `delivery` key,
-- stamped by email-program-roster and email-camp-roster as each address is
-- attempted. It exists because the row-level `status` column answers "did
-- ANYONE receive this", not "did THIS contact receive it": both senders set
-- status='sent' whenever at least one address succeeded, so on a partial send
-- a contact whose own address bounced was indistinguishable from one who got
-- the roster. The Comms per-contact timeline read that row status and told
-- the bounced contact they had been sent a roster they never received.
--
-- Rows written before this key existed have no `delivery` on their recipients.
-- That is deliberate and is NOT backfilled -- the per-address outcome was never
-- recorded, so it cannot be reconstructed. Readers must treat a missing
-- `delivery` as unknown and fall back to the row-level status, which is still
-- sound in the one direction that matters: status='failed' means nobody got it.

comment on column public.roster_email_sends.recipients is
  'Snapshot of recipients at send time. Each item: { name, email, role, source, partner_contact_id?, delivery? }. `delivery` is ''sent'' or ''failed'' for THIS address and is absent on rows written before 2026-08-04; absent means unknown, fall back to the row status.';
