-- Take EXECUTE on the new 7-arg replace_student_pickup_dnr_guardian away from anon.
--
-- Caught on staging by reading proacl back rather than assuming the revoke in
-- 20260807b had done the job: the NEW signature came out carrying
-- `anon=X/postgres`, while the 6-arg function it replaces has no anon grant at all.
--
-- Two things combine to cause it, and either alone would be easy to miss:
--   1. Supabase's default privileges grant EXECUTE to anon on newly created public
--      functions. Creating a function is therefore a grant decision whether you
--      intended one or not.
--   2. `revoke ... from public` does NOT remove an explicit role grant. Revoking
--      PUBLIC looks like it covers everything and does not.
--
-- Why it matters rather than being tidy-up: this is SECURITY DEFINER taking an
-- organization id. Its authorization checks do reject an anonymous caller, so no
-- data can be written - but the two rejections raise DIFFERENT messages
-- ('student % not in organization %' versus 'not authorized to edit contacts for
-- student %'), so an anonymous caller could distinguish whether a given student
-- belongs to a given org. That is the probe-oracle shape, and it is a widening
-- against the function being replaced.
--
-- Kept as its own migration because that is the order staging actually ran them
-- in. See the note in 20260807b.
revoke all on function public.replace_student_pickup_dnr_guardian(
  uuid, uuid, jsonb, jsonb, jsonb, text, text
) from anon;
