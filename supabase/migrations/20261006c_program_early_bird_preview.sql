-- "What would THIS program get?" -- the one question the program form asks.
--
-- The form needs three things before it can draw its Early bird row: what the
-- term is offering, what that comes to for this program's own price, and whether
-- this program is allowed to have it. All three are already decided by
-- 20261006b; this composes them into a single answer so the form never has to
-- compute a price or re-state the rule in JavaScript.
--
-- That matters more here than it looks. The form shows a price and then saves a
-- price. If the preview were calculated in JS and the save in SQL, they would be
-- two implementations of one number -- the bug class that once put a refund rate
-- of 22.2% in an email and 100% on the screen that email linked to. They round
-- differently on the halves, so the form would show $1.67 and store $1.68.
--
-- Takes the DRAFT values rather than reading the row, because the operator is
-- usually mid-edit: they have just typed a new price, or just ticked
-- "the partner runs registration", and the row on disk does not say so yet. On a
-- brand-new program there is no row at all.
create or replace function program_early_bird_preview(
  p_org                    uuid,
  p_term                   text,
  p_status                 text,
  p_runs_own_registration  boolean,
  p_price_tier             text,
  p_price_cents            integer,
  p_opt_out                boolean
) returns table (
  deadline            date,
  discount_type       text,
  discount_value      numeric,
  term_program_count  integer,
  early_bird_cents    integer,
  skip_reason         text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_offer   record;
  v_price   integer;
begin
  if not (can_edit_org(p_org) or is_platform_admin()) then
    raise exception 'not authorized for org %', p_org using errcode = '42501';
  end if;

  select o.deadline, o.discount_type, o.discount_value, o.program_count
    into v_offer
    from term_early_bird_offer(p_org, p_term) o;

  -- What the term's discount comes to for this program's own standard price.
  -- Spelled exactly as apply_term_early_bird spells it, including the rounding:
  -- percent rounds the RESULT, not the discount.
  v_price := case
    when v_offer.discount_value is null then null
    when v_offer.discount_type = 'percent'
      then round(p_price_cents * (1 - v_offer.discount_value / 100.0))::int
    else p_price_cents - round(v_offer.discount_value * 100)::int
  end;

  return query
  select
    v_offer.deadline,
    v_offer.discount_type,
    v_offer.discount_value,
    coalesce(v_offer.program_count, 0),
    v_price,
    early_bird_skip_reason(p_status, p_runs_own_registration, p_price_tier,
                           p_price_cents, p_opt_out, v_price);
end;
$$;

revoke all on function program_early_bird_preview(uuid, text, text, boolean, text, integer, boolean) from public;
revoke all on function program_early_bird_preview(uuid, text, text, boolean, text, integer, boolean) from anon;
grant execute on function program_early_bird_preview(uuid, text, text, boolean, text, integer, boolean) to authenticated;
