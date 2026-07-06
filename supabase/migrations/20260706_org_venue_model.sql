-- organizations.venue_model — how a tenant relates to the places it runs classes.
--
--   'partner_venues' (DEFAULT) — the tenant runs programs INSIDE other people's
--       places: schools, Parks & Rec, churches. The /admin/schools surface is
--       partner-first (partner + its venues + district calendars). This is the
--       J2S model and stays the behavior for every existing tenant.
--
--   'own_venue' — the tenant runs classes at its OWN location(s) (a center, a
--       studio, online). There is no external "partner"; a venue with no
--       partner_id is NORMAL, not an orphan to be linked. The surface reframes
--       to a plain "Locations" list.
--
-- Additive + safe by construction: NOT NULL DEFAULT 'partner_venues' means every
-- existing row keeps today's exact behavior (J2S untouched). Opting specific
-- tenants (Shoreview Chess, Mrs. Richelle) into 'own_venue' is a separate,
-- verified data step — NOT baked into this schema migration.
--
-- Parity: this migration is applied to BOTH staging and prod in the same pass.

alter table public.organizations
  add column if not exists venue_model text not null default 'partner_venues';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_venue_model_check'
  ) then
    alter table public.organizations
      add constraint organizations_venue_model_check
      check (venue_model in ('partner_venues', 'own_venue'));
  end if;
end $$;

comment on column public.organizations.venue_model is
  'How the tenant relates to its venues: partner_venues (runs inside others'' places — schools/Parks & Rec; the default, J2S model) or own_venue (runs at its own center/studio/online — no external partner).';
