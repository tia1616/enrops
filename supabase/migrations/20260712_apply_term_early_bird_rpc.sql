-- Term-wide early-bird apply, for the Money > Discounts tab.
--
-- Sets one deadline + one discount ($ or % off each program's OWN standard price)
-- across every program in a term, in a single atomic org-scoped write. Computing
-- the per-row early price in SQL (from price_cents) avoids 30 client round-trips and
-- keeps it correct per program (standard prices differ).
--
-- p_discount_value NULL => turn early-bird OFF for the term (null price + deadline).
-- SECURITY DEFINER + explicit can_edit_org gate; execute granted to authenticated only.

create or replace function apply_term_early_bird(
  p_org uuid,
  p_term text,
  p_discount_type text,   -- 'percent' | 'fixed'
  p_discount_value numeric,-- percent (whole) or dollars; NULL clears early-bird
  p_deadline date
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  if not (can_edit_org(p_org) or is_platform_admin()) then
    raise exception 'not authorized for org %', p_org using errcode = '42501';
  end if;

  if p_discount_value is null then
    update programs
      set early_bird_price_cents = null, early_bird_deadline = null
      where organization_id = p_org and term = p_term;
  else
    if p_discount_type not in ('percent','fixed') then
      raise exception 'invalid discount type %', p_discount_type;
    end if;
    if p_discount_value < 0 or (p_discount_type = 'percent' and p_discount_value > 100) then
      raise exception 'invalid discount value %', p_discount_value;
    end if;
    update programs
      set early_bird_deadline = p_deadline,
          early_bird_price_cents = greatest(0, case
            when p_discount_type = 'percent'
              then round(price_cents * (1 - p_discount_value / 100.0))::int
            else price_cents - round(p_discount_value * 100)::int
          end)
      where organization_id = p_org and term = p_term;
  end if;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function apply_term_early_bird(uuid, text, text, numeric, date) from public;
grant execute on function apply_term_early_bird(uuid, text, text, numeric, date) to authenticated;
