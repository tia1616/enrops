-- 20260801a_sender_config_never_blocks_alerts.sql
--
-- THE GAP: a provider's operational alerts silently did not send.
--
-- 20260731f made organizations.alert_email always the tenant's own address, which
-- removed one of TWO blockers. The second is organizations.default_sender_email.
-- Thirteen edge functions read that column RAW instead of going through
-- loadOrgBrand(), and they fail in two different ways:
--
--   1. NULL  -> `if (!org.default_sender_email) return;`  The alert is skipped
--      entirely and nobody is told. On prod this hit chase-youth,
--      the-ukulele-project and yoga-playgrounds.
--   2. SET BUT UNVERIFIED -> the value is interpolated straight into the Resend
--      From header. Resend rejects a From on a domain it has not verified, so the
--      send fails. mrs-richelle carries info@mrsrichelle.com with
--      organizations.sending_domain NULL, i.e. unverified.
--
-- loadOrgBrand() already solves both: it uses a tenant's own address ONLY when the
-- domain matches their VERIFIED sending_domain, and otherwise derives a per-tenant
-- address on the shared, always-verified platform domain. The durable fix is to make
-- those thirteen functions use it. That is a separate, larger change across shared
-- functions.
--
-- THIS MIGRATION closes the outcome gap now, without touching those functions, by
-- writing the exact value loadOrgBrand() would have derived. After it, every raw
-- reader gets a valid, verified, per-tenant From, so no alert is silently dropped.
--
-- SAFE BY CONSTRUCTION, and this is the important part: it does NOT change what any
-- email actually sends FROM. loadOrgBrand ignores default_sender_email unless its
-- domain equals the tenant's verified sending_domain. We only write addresses on the
-- platform domain while leaving sending_domain NULL, so loadOrgBrand still computes
-- the same `{slug}@{platform domain}` it computed before. Only the raw readers change
-- behaviour, and only from "broken" to "working".
--
-- Matches the shape shoreview-chess already carries (shoreview-chess@mail.enrops.com),
-- so this is the established convention here, not a new one.

-- ---------------------------------------------------------------------------
-- 1. Fill the NULLs. Derives the platform domain from the enrops org row rather
--    than hardcoding it, so this cannot drift from what loadOrgBrand computes.
-- ---------------------------------------------------------------------------
with platform as (
  select coalesce(
           nullif(btrim(o.sending_domain), ''),
           substring(o.default_sender_email from position('@' in o.default_sender_email) + 1)
         ) as domain
  from public.organizations o
  where o.slug = 'enrops'
)
update public.organizations t
   set default_sender_email = t.slug || '@' || (select domain from platform),
       default_sender_name  = coalesce(t.default_sender_name, t.name)
 where t.default_sender_email is null
   and t.slug is not null
   and (select domain from platform) is not null;

-- ---------------------------------------------------------------------------
-- 2. Keep it that way for every NEW provider.
--
--    A trigger rather than app code, for the same reason 20260731f used one: signup,
--    hand-provisioning and any future SQL all have to satisfy this, and only the
--    database sees every one of them. Self-serve signup sets neither column today,
--    which is exactly how the three prod providers ended up blocked.
--
--    BEFORE INSERT only. Firing on UPDATE would fight an operator who later sets a
--    real verified domain of their own.
-- ---------------------------------------------------------------------------
create or replace function public.tg_org_default_sender_config()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_domain text;
begin
  if new.default_sender_email is null and new.slug is not null then
    select coalesce(
             nullif(btrim(o.sending_domain), ''),
             substring(o.default_sender_email from position('@' in o.default_sender_email) + 1))
      into v_domain
      from public.organizations o
     where o.slug = 'enrops';

    if v_domain is not null then
      new.default_sender_email := new.slug || '@' || v_domain;
    end if;
  end if;

  if new.default_sender_name is null then
    new.default_sender_name := new.name;
  end if;

  return new;
exception when others then
  -- Never block org creation over a sender default.
  return new;
end;
$$;

drop trigger if exists trg_org_default_sender_config on public.organizations;
create trigger trg_org_default_sender_config
  before insert on public.organizations
  for each row execute function public.tg_org_default_sender_config();

comment on column public.organizations.default_sender_email is
  'The From address for this provider''s email. Auto-filled at creation with a per-tenant address on the platform sending domain, because thirteen edge functions read this column raw and SKIP THE SEND when it is null. A tenant''s own domain is only actually used when it matches their verified sending_domain - see loadOrgBrand().';
