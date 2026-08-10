-- Corrects the backfill rule in 20260810f, found by the post-ship gauntlet.
--
-- That migration backfilled an ALLOW-list of two statuses ('pending',
-- 'paused_card_failed'). installments_status_check permits SIX:
--   pending | paid | failed | refunded | paused_card_failed | paused_program_cancelled
--
-- 'failed' and 'paused_program_cancelled' were missed, and they are not
-- terminal - process-installments' own alert emails tell operators to "flip the
-- rows back to status=pending to retry". A row resurrected that way would carry
-- no snapshot, fall back to live org config, and reopen the exact consent hole
-- the snapshot exists to close, for that family.
--
-- The right shape for a money guard is a DENY-list of provably-terminal states,
-- not an allow-list of the ones we happened to think of. Only 'paid' and
-- 'refunded' are done: a paid row is never re-charged and a refunded one is
-- closed. Everything else can still become a charge.
--
-- NO-OP TODAY on both environments, verified before applying: prod holds only
-- pending (all stamped) and paid; staging the same. This closes the rule, not a
-- live exposure. Already applied to staging and prod on 2026-08-10; this file is
-- the record.
update public.installments i
   set fee_pass_through = o.fee_pass_through
  from public.organizations o
 where o.id = i.organization_id
   and i.fee_pass_through is null
   and i.status not in ('paid', 'refunded');
