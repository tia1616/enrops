-- The term-wide early bird stops landing on programs that can't have one.
--
-- Before this, "Apply to 34" meant exactly that: every program in the term got
-- the discount, including a $0 library class, a partner-run class we don't take
-- payment for, and a class that had already been cancelled. Nothing downstream
-- charged a family wrongly -- checkout only honours an early bird that is LOWER
-- than the standard price -- but the Discounts card reported an early bird on
-- programs that could never have one, and a cancelled class kept its discount
-- for the rest of the term.
--
-- Three functions, and the eligibility rule is written ONCE:
--
--   early_bird_skip_reason   -- the rule. Pure, no table access.
--   apply_term_early_bird    -- the write, and (dry run) the preview. Same rule.
--   term_early_bird_offer    -- what a term is currently offering, read back off
--                               the programs that carry it, for the program form.
--
-- The count an operator sees and the write they then authorise come from the SAME
-- call with p_dry_run flipped, so the preview cannot disagree with the result.

-- ---------------------------------------------------------------------------
-- 1. The rule.
-- ---------------------------------------------------------------------------
-- Returns NULL when the program may carry its term's early bird, otherwise a
-- stable reason code the UI turns into a sentence.
--
-- ORDER IS DELIBERATE. The inherent reasons come first and the operator's own
-- choice comes last, so 'opted_out' is only ever reported for a program that
-- COULD have an early bird -- which is exactly when the toggle is live and
-- flipping it back does something. A $0 class that is also opted out reports
-- 'free', because that is the fact the operator cannot change from the toggle.
--
-- 'discount_exceeds_price' is not in the brief and is not an opinion about
-- pricing: a $25 discount on a $20 class computes to $0, and checkout treats
-- $0 < $20 as a valid early bird, so the class would go free. A rule that can
-- zero a price is not a rule. Decided per program, not per term, because it
-- depends on the program's own standard price. Callers asking the standing
-- question "may this program carry one at all?" pass NULL and skip this test.
create or replace function early_bird_skip_reason(
  p_status                  text,
  p_runs_own_registration   boolean,
  p_price_tier              text,
  p_price_cents             integer,
  p_opt_out                 boolean,
  p_new_early_bird_cents    integer default null
) returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(p_status, 'open') in ('cancelled', 'closed') then coalesce(p_status, 'open')
    when coalesce(p_runs_own_registration, false)              then 'partner_run'
    when coalesce(p_price_tier, 'standard') = 'preschool'      then 'preschool'
    when coalesce(p_price_cents, 0) <= 0                       then 'free'
    when p_new_early_bird_cents is not null
         and p_new_early_bird_cents <= 0                       then 'discount_exceeds_price'
    when coalesce(p_opt_out, false)                            then 'opted_out'
    else null
  end;
$$;

revoke all on function early_bird_skip_reason(text, boolean, text, integer, boolean, integer) from public;
revoke all on function early_bird_skip_reason(text, boolean, text, integer, boolean, integer) from anon;
grant execute on function early_bird_skip_reason(text, boolean, text, integer, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The apply, and its own preview.
-- ---------------------------------------------------------------------------
-- The old 5-argument version returned a plain row count and wrote to every
-- program in the term. Dropped rather than replaced: the return type changes, and
-- leaving the old signature callable would leave a second, blanket write path to
-- the same columns.
drop function if exists apply_term_early_bird(uuid, text, text, numeric, date);

create or replace function apply_term_early_bird(
  p_org            uuid,
  p_term           text,
  p_discount_type  text,    -- 'percent' | 'fixed'
  p_discount_value numeric, -- percent (whole) or dollars; NULL turns the term off
  p_deadline       date,
  p_dry_run        boolean default false
) returns table (
  program_id          uuid,
  curriculum          text,
  price_cents         integer,
  early_bird_cents    integer,  -- what the program ends up with; NULL = none
  skip_reason         text,     -- NULL = the discount was applied
  cleared             boolean   -- it HAD an early bird and this run removed it
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Authorisation before anything is read. A dry run returns program names and
  -- prices, so it is an access surface in its own right and gets the same gate
  -- as the write.
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

  -- One pass: work out every program's outcome, then write. The same CTE feeds
  -- the dry run and the real run, so "Apply to 31" and what Apply does cannot
  -- drift apart. A data-modifying CTE always runs to completion whether or not
  -- the outer query reads it, so the UPDATE below needs no forcing reference.
  return query
  with target as (
    select
      p.id,
      p.curriculum            as name,
      p.price_cents           as price,
      p.early_bird_price_cents as had_price,
      p.early_bird_deadline    as had_deadline,
      -- What the term discount would come to for THIS program, off its own
      -- standard price. NULL when the term is being turned off entirely.
      case
        when p_discount_value is null then null
        when p_discount_type = 'percent'
          then round(p.price_cents * (1 - p_discount_value / 100.0))::int
        else p.price_cents - round(p_discount_value * 100)::int
      end                     as proposed,
      p.status,
      p.runs_own_registration,
      p.price_tier,
      p.early_bird_opt_out
    from programs p
    where p.organization_id = p_org
      and p.term = p_term
  ),
  decided as (
    select
      t.*,
      -- Turning the term OFF is not a skip: every program loses its early bird,
      -- including the ones that were opted out, so the operator's "Turn off"
      -- means what it says.
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
      d.id,
      d.name,
      d.price,
      -- An ineligible program does not merely get skipped, it gets CLEARED.
      -- Skipping would leave a cancelled class carrying a discount for the rest
      -- of the term, which is the state this migration exists to end.
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
       -- Touch only rows whose stored values actually change, so a re-Apply is a
       -- no-op rather than a mass UPDATE that wakes every row-level trigger.
       and (p.early_bird_price_cents is distinct from o.new_price
            or p.early_bird_deadline is distinct from o.new_deadline)
    returning p.id
  )
  select o.id, o.name, o.price, o.new_price, o.reason, o.will_clear
    from outcome o
   order by o.reason nulls first, o.name;
end;
$$;

revoke all on function apply_term_early_bird(uuid, text, text, numeric, date, boolean) from public;
revoke all on function apply_term_early_bird(uuid, text, text, numeric, date, boolean) from anon;
grant execute on function apply_term_early_bird(uuid, text, text, numeric, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. What is this term offering?
-- ---------------------------------------------------------------------------
-- Read back off the programs that carry the discount, because that is where it
-- lives -- there is no separate record of a term's offer, and inventing one would
-- mean two places that can disagree about the same number.
--
-- Returns the offer only when the eligible programs AGREE, so the caller gets one
-- of three honest answers and can say a different sentence for each:
--   program_count = 0                  -- this term has no early bird
--   program_count > 0, type IS NULL    -- it varies by program; no single answer
--   type and value set                 -- "$25 off through Nov 2"
create or replace function term_early_bird_offer(p_org uuid, p_term text)
returns table (
  deadline        date,
  discount_type   text,
  discount_value  numeric,
  program_count   integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (can_edit_org(p_org) or is_platform_admin()) then
    raise exception 'not authorized for org %', p_org using errcode = '42501';
  end if;

  return query
  with eb_rows as (
    select
      p.early_bird_deadline as dl,
      p.price_cents - p.early_bird_price_cents as off_cents,
      round((p.price_cents - p.early_bird_price_cents)::numeric * 100 / p.price_cents, 2) as off_pct
    from programs p
    where p.organization_id = p_org
      and p.term = p_term
      and p.early_bird_price_cents is not null
      and p.early_bird_deadline is not null
      and p.price_cents > 0
      -- Only programs ALLOWED to carry it get a vote. A leftover discount on a
      -- cancelled class must not define what the term is offering.
      and early_bird_skip_reason(p.status, p.runs_own_registration, p.price_tier,
                                 p.price_cents, p.early_bird_opt_out, null) is null
  ),
  agg as (
    select
      count(*)::int            as n,
      count(distinct dl)       as n_dl,
      count(distinct off_cents) as n_fixed,
      count(distinct off_pct)  as n_pct,
      max(dl)                  as dl,
      max(off_cents)           as off_cents,
      max(off_pct)             as off_pct
    from eb_rows
  )
  select
    case when a.n > 0 and a.n_dl = 1 then a.dl end,
    -- A single dollar amount is the plainer description, so it wins when both fit
    -- (they only both fit when every program in the term costs the same).
    case when a.n > 0 and a.n_dl = 1 and a.n_fixed = 1 then 'fixed'
         when a.n > 0 and a.n_dl = 1 and a.n_pct   = 1 then 'percent' end,
    case when a.n > 0 and a.n_dl = 1 and a.n_fixed = 1 then (a.off_cents / 100.0)::numeric
         when a.n > 0 and a.n_dl = 1 and a.n_pct   = 1 then a.off_pct end,
    a.n
  from agg a;
end;
$$;

revoke all on function term_early_bird_offer(uuid, text) from public;
revoke all on function term_early_bird_offer(uuid, text) from anon;
grant execute on function term_early_bird_offer(uuid, text) to authenticated;
