-- The Discounts preview names a class, but a class name is not an identity.
--
-- Found on staging by eyeball: Winter 2027 listed "LEGO Brickopolis Architects:
-- Engineering & Design" THREE times in the price preview, at $285 -> $260 each,
-- and again TWICE in the skipped list -- once as "Free class" and once as
-- "Preschool". Five real classes, five different sites, one name. The counts were
-- right and the screen was still useless: an operator cannot tell which one is
-- free, which is preschool, or whether three identical rows are a bug.
--
-- Every other operator surface identifies a class by its SITE. This one did not,
-- because the function returned `curriculum` alone. It now returns the site too,
-- and the card renders "Site - Class name".
--
-- DROP then CREATE, not CREATE OR REPLACE: the RETURN TABLE shape changes, and
-- Postgres refuses to replace a function whose return type differs. The argument
-- list is unchanged, so the single caller keeps working.
--
-- Dropping also DROPS THE GRANTS. They are re-issued below and must be read back
-- from pg_proc.proacl: `revoke ... from public` does not remove anon's EXECUTE
-- (anon holds it via the default PUBLIC grant), which is how a definer function
-- leaked parent emails once already.

drop function if exists apply_term_early_bird(uuid, text, text, numeric, date, boolean);

create function apply_term_early_bird(
  p_org            uuid,
  p_term           text,
  p_discount_type  text,    -- 'percent' | 'fixed'
  p_discount_value numeric, -- percent (whole) or dollars; NULL turns the term off
  p_deadline       date,
  p_dry_run        boolean default false
) returns table (
  program_id          uuid,
  curriculum          text,
  site_name           text,    -- the venue, so one name at five sites is five rows
  price_cents         integer,
  early_bird_cents    integer, -- what the program ends up with; NULL = none
  skip_reason         text,    -- NULL = the discount was applied
  cleared             boolean  -- it HAD an early bird and this run removed it
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Authorisation before anything is read. A dry run returns program names,
  -- sites and prices, so it is an access surface in its own right and gets the
  -- same gate as the write.
  if not (can_edit_org(p_org) or is_platform_admin()) then
    raise exception 'not authorized for org %', p_org using errcode = '42501';
  end if;

  if p_discount_value is not null then
    if p_discount_type not in ('percent', 'fixed') then
      raise exception 'invalid discount type %', p_discount_type;
    end if;
    if p_discount_value < 0 or (p_discount_type = 'percent' and p_discount_value > 100) then
      raise exception 'invalid discount value %', p_discount_value;
    end if;
    if p_deadline is null then
      raise exception 'an early bird needs an end date';
    end if;
  end if;

  return query
  with target as (
    select
      p.id,
      p.curriculum             as name,
      -- LEFT join: a class with no site still has to appear in the list. Losing
      -- a row from the count is worse than showing it without a venue.
      pl.name                  as site,
      p.price_cents            as price,
      p.early_bird_price_cents as had_price,
      p.early_bird_deadline    as had_deadline,
      case
        when p_discount_value is null then null
        when p_discount_type = 'percent'
          then round(p.price_cents * (1 - p_discount_value / 100.0))::int
        else p.price_cents - round(p_discount_value * 100)::int
      end                      as proposed,
      p.status,
      p.runs_own_registration,
      p.price_tier,
      p.early_bird_opt_out
    from programs p
    left join program_locations pl on pl.id = p.program_location_id
    where p.organization_id = p_org
      and p.term = p_term
  ),
  decided as (
    select
      t.*,
      case
        when p_discount_value is null then null
        else early_bird_skip_reason(
               t.status, t.runs_own_registration, t.price_tier,
               t.price, t.early_bird_opt_out, t.proposed)
      end as reason
    from target t
  ),
  outcome as (
    select
      d.id, d.name, d.site, d.price,
      case when d.reason is null and p_discount_value is not null
           then d.proposed end as new_price,
      case when d.reason is null and p_discount_value is not null
           then p_deadline end as new_deadline,
      d.reason,
      (d.had_price is not null or d.had_deadline is not null)
        and (d.reason is not null or p_discount_value is null) as will_clear
    from decided d
  ),
  written as (
    update programs p
       set early_bird_price_cents = o.new_price,
           early_bird_deadline    = o.new_deadline
      from outcome o
     where p.id = o.id
       and not p_dry_run
       and (p.early_bird_price_cents is distinct from o.new_price
            or p.early_bird_deadline is distinct from o.new_deadline)
    returning p.id
  )
  select o.id, o.name, o.site, o.price, o.new_price, o.reason, o.will_clear
    from outcome o
   -- Site first within a reason: an operator scanning the skipped list is
   -- looking for a place, and five rows sharing a name sort meaninglessly.
   order by o.reason nulls first, o.site nulls last, o.name;
end;
$$;

revoke all on function apply_term_early_bird(uuid, text, text, numeric, date, boolean) from public;
revoke all on function apply_term_early_bird(uuid, text, text, numeric, date, boolean) from anon;
grant execute on function apply_term_early_bird(uuid, text, text, numeric, date, boolean) to authenticated;
