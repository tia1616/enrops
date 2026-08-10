-- get_campaign_recipients: optionally skip families who have already enrolled.
--
-- approved_recipient_ids is a SNAPSHOT taken when the operator approves the
-- audience. A multi-touchpoint campaign then sends off that frozen list for
-- weeks. Nothing between the snapshot and the send re-checks whether a family
-- registered in the meantime, so a parent who signs up off touchpoint 1 still
-- receives "last week to register" from touchpoint 3. That is the bug this
-- closes: the list was correct once, and now stays correct.
--
-- OPT-IN, per campaign, via draft_inputs.skip_enrolled = true.
--
-- Deliberately not platform-wide default. A campaign aimed AT enrolled families
-- ("you're in, here is what to bring") is a legitimate and existing shape, and
-- switching this on globally would silently resolve those to an empty audience
-- and mark the touchpoint 'skipped' with nobody noticing. Opt-in means the
-- blast radius is exactly the campaigns that ask for it.
--
-- Matching:
--   * email, lower + trimmed, against parents.email. Verified on prod against
--     the FA26 week-of-Aug-31 audience: all 29 families enrolled in those
--     classes were present in marketing_recipients under the SAME address, and
--     zero had registered under an address the contact list did not hold. So
--     email is a sufficient key for this tenant's data today. It is not a
--     guarantee for every tenant; a family registering under a second address
--     is invisible to this and will still be mailed.
--   * scoped to the campaign's own picked programs AND camps, so enrolling in
--     an unrelated class does not remove someone from a campaign about a
--     different one.
--   * organization_id scoped on every leg. Multi-tenant.
--   * a withdrawn registration puts the family back into the audience, which is
--     the behaviour we want. Written as coalesce(status,'') <> 'cancelled' and
--     NOT as a bare status <> 'cancelled': registrations.status is NULLABLE, and
--     a bare inequality against NULL yields NULL rather than TRUE, so a
--     NULL-status registration would silently fail to exclude that family and
--     they would be mailed "register now" for a class they hold. There are zero
--     NULL-status rows today, so this is latent, not live - but the column
--     permits it and the default only applies on INSERT. Coalescing to '' makes
--     an unknown status count as ENROLLED, which is the safe direction: the
--     failure we care about is emailing someone who already paid.
--
-- Flag read as jsonb equality rather than a ::boolean cast: draft_inputs is
-- operator-adjacent jsonb, and a cast would throw on any non-boolean value and
-- take the whole send down with it. Anything that is not exactly true reads as
-- false.
--
-- ACL: this function is SECURITY DEFINER with no internal auth check, and
-- 20260604_lock_anon_executable_definer_fns.sql revoked EXECUTE from public,
-- anon and authenticated for that reason. CREATE OR REPLACE preserves the
-- existing ACL, but the grants are restated below so a rebuild from migrations
-- cannot land a PUBLIC-executable version of it.

CREATE OR REPLACE FUNCTION public.get_campaign_recipients(p_campaign_id uuid)
 RETURNS TABLE(id uuid, email text, parent_name text, child_first_name text, child_last_name text, school_name text, city text, zip text, geo_segment text, segments text[])
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    mr.id,
    mr.email,
    mr.parent_name,
    mr.child_first_name,
    mr.child_last_name,
    mr.school_name,
    mr.city,
    mr.zip,
    mr.geo_segment,
    mr.segments
  FROM marketing_campaigns mc
  JOIN marketing_recipients mr
    ON mr.organization_id = mc.organization_id
   AND mr.id = ANY(mc.approved_recipient_ids)
  WHERE mc.id = p_campaign_id
    AND (
      COALESCE(mc.draft_inputs -> 'skip_enrolled', 'false'::jsonb) <> 'true'::jsonb
      OR NOT EXISTS (
        SELECT 1
        FROM registrations rg
        JOIN parents pa ON pa.id = rg.parent_id
        WHERE rg.organization_id = mc.organization_id
          AND COALESCE(rg.status, '') <> 'cancelled'
          AND lower(btrim(pa.email)) = lower(btrim(mr.email))
          AND (
            rg.program_id::text IN (
              SELECT jsonb_array_elements_text(
                COALESCE(mc.draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb))
            )
            OR rg.camp_session_id::text IN (
              SELECT jsonb_array_elements_text(
                COALESCE(mc.draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb))
            )
          )
      )
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.get_campaign_recipients(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_campaign_recipients(uuid) TO service_role;
