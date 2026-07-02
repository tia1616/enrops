-- Tenant type flag: does this org take registration/money THROUGH Enrops (term
-- programs + checkout), or does registration happen elsewhere (Wufoo/own site)
-- and Enrops just holds the class schedule? Drives which surface the operator
-- sees for Programs + Instructor scheduling — one surface each, unambiguous.
--
-- Default true: every existing tenant is registration-through-Enrops today, so
-- they keep the current surfaces unchanged (additive + backward-compatible).
-- Outside-registration orgs are set false explicitly, per environment (each
-- UPDATE is a no-op where that slug doesn't exist).
alter table public.organizations
  add column if not exists uses_enrops_registration boolean not null default true;

-- staging synthetic outside-reg org
update public.organizations set uses_enrops_registration = false where slug = 'tenant-two-test';
-- prod: Shoreview Chess keeps Wufoo + its own Stripe; Enrops holds the schedule only
update public.organizations set uses_enrops_registration = false where slug = 'shoreview-chess';
