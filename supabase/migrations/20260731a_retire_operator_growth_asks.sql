-- Retire v4 section 8 items 3-4: the operator review ask and referral ask.
--
-- Arielle reviewed the shipped build on 2026-07-29 and cut both: a refund is
-- the wrong moment to ask an operator for a review or a referral, and the pitch
-- leaned on "we returned our own fee too", which only means something to an
-- operator who was burned by that exact thing on another platform.
--
-- The send path (_shared/operatorGrowthAsks.ts and its two call sites in
-- refund-registration and stripe-webhook) is deleted in the same commit, so
-- nothing reads this settings row any more. Removing it rather than leaving it
-- at enabled=false so a future reader cannot mistake a dead flag for a feature
-- that is merely switched off.
--
-- The operator_growth_asks TABLE is deliberately kept. It is empty on prod and
-- holds 2 rows on staging from the real sends done during the build, which are
-- the evidence those asks worked. An empty table costs nothing; a DROP on two
-- databases to tidy up a feature nobody is using is the riskier trade.

DELETE FROM public.platform_settings WHERE key = 'operator_growth_asks';

COMMENT ON TABLE public.operator_growth_asks IS
  'RETIRED 2026-07-31 (Arielle: wrong moment to ask). No writer remains. Kept for the staging rows that recorded the original sends. v4 section 8 items 3-4.';
