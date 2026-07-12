-- Atomic increment of a promo code's display counter (promo_codes.used_count).
-- Called by the stripe-webhook (service role) exactly once per settled payment,
-- gated by the promo_redemptions unique key so a webhook retry can't double it.
-- Enforcement of limits reads the promo_redemptions ledger, not this counter —
-- this is display only ("3 / 10 used").
create or replace function increment_promo_used_count(p_code_id uuid)
returns void
language sql
as $$
  update promo_codes set used_count = coalesce(used_count, 0) + 1 where id = p_code_id;
$$;

revoke all on function increment_promo_used_count(uuid) from public;
grant execute on function increment_promo_used_count(uuid) to service_role;
