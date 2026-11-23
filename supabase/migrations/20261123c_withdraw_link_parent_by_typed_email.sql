-- Withdraw 20260727a's write-time login linking - again, and this time on prod.
--
-- HISTORY. 20260727a linked parents.auth_id to whichever account owns the
-- address typed onto the row. 20260727b withdrew it the same day: an address
-- typed into guest checkout (or by an operator) has not been proven by anyone,
-- so a typo hands the real owner of the mistyped address a family's portal -
-- children's names, medical notes, pickup people. It replaced it with
-- claim_parent_record(), which links at SIGN-IN, the moment the address is
-- proven. Prod applied 27b on 2026-09-01, then re-applied 27a on 2026-09-03
-- (commit e7ba45ca) to repair one family who had signed in to an empty portal,
-- without noticing 27b had withdrawn it. Both have been live since.
--
-- WHY IT IS SAFE TO REMOVE. Every case 27a covered is covered at sign-in:
--   - account exists, family row made later (the 9/3 case): the portal calls
--     claim_parent_record() when the signed-in user has no family, and links it.
--   - family row exists, account made later: on_auth_user_created_link_parent
--     (account creation via magic link / OAuth, i.e. proven).
--   - stripe-webhook already refuses to link at checkout for exactly this reason
--     and points at claim_parent_record().
-- Nothing in src/ or supabase/functions references these objects.
--
-- Jessica's go, 2026-11-23.

drop trigger if exists link_parent_auth_on_insert on public.parents;
drop trigger if exists link_parent_auth_on_email_change on public.parents;
drop function if exists public.link_parent_auth_on_write();
