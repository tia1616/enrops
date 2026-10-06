-- Early-bird eligibility: a preschool tier, and a per-program opt-out.
--
-- Two additions, both additive and inert until the RPC in 20261006b reads them:
--
-- 1. price_tier gains 'preschool'. The after-school pricing sheet has no early
--    bird for preschool, so the tier has to be nameable before the rule can
--    exclude it. price_tier has existed since the first pricing migration but
--    nothing has ever read or written it from the app -- this build gives it its
--    first UI (the program form's price row) and its first reader (the apply RPC).
--    Deliberately NOT mirrored onto program_type: that column IS read, by
--    pricing.js's per-session rate fallback, and a third value there would send a
--    preschool class down an unpriced branch. One concept, one column.
--
-- 2. early_bird_opt_out records "this program was deliberately taken out of its
--    term's early bird", so a later Apply from Money > Discounts skips it instead
--    of silently putting the discount back. Default false = every existing
--    program keeps exactly the behaviour it has today.
--
-- Multi-tenant: both are plain columns on an org-scoped table; no org is named
-- here and no org's behaviour changes until it uses the new UI.

-- 1. Preschool joins the price tiers.
alter table programs drop constraint if exists programs_price_tier_check;
alter table programs add constraint programs_price_tier_check
  check (price_tier = any (array['standard'::text, 'coding_robotics'::text, 'preschool'::text]));

-- 2. The opt-out flag.
alter table programs
  add column if not exists early_bird_opt_out boolean not null default false;

comment on column programs.early_bird_opt_out is
  'True when an operator turned this program''s early bird off by hand. apply_term_early_bird then CLEARS the row''s early-bird columns instead of re-applying the term discount to it. Turning the whole term off ignores this flag: it removes every program''s early bird, opted-out ones included.';
