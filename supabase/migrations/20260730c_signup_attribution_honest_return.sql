-- record_signup_attribution returned true whenever it HAD a utm to try, even
-- when ON CONFLICT DO NOTHING discarded it because first touch already won.
-- A caller reading true would reasonably believe the value was stored.
-- Now it reports what actually happened: true only when a row was written.
--
-- Found by testing the SECOND write, not just the first: two calls with
-- different utm values both returned true, while the stored row correctly still
-- held the first. The behaviour was right and the return value was lying.
--
-- Prod's 20260730b already carried this corrected body, so on prod this file is
-- a byte-identical no-op applied only so both environments list the same
-- migrations. Verified afterwards: pg_get_functiondef md5 matches across
-- staging and prod.

CREATE OR REPLACE FUNCTION public.record_signup_attribution(p_utm_content text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'intelligence', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_org uuid;
  v_utm text := nullif(btrim(coalesce(p_utm_content, '')), '');
  v_written uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Nothing to record is not an error. The overwhelming majority of signups
  -- arrive with no utm_content at all (typed the URL, a referral, a magic link
  -- opened on another device) and must not see a failure for it.
  IF v_utm IS NULL THEN
    RETURN false;
  END IF;

  -- utm_content is attacker-controlled: it comes from a query string on a
  -- public page. Bound it so a hostile link cannot write an unbounded blob.
  v_utm := left(v_utm, 200);

  -- Same owner lookup provision_operator_org uses, so the two agree on which
  -- org "the account this person just created" means.
  SELECT m.organization_id INTO v_org
  FROM public.org_members m
  WHERE m.auth_user_id = v_uid AND m.role = 'owner'
  ORDER BY m.created_at
  LIMIT 1;

  IF v_org IS NULL THEN
    RETURN false;
  END IF;

  -- Write-once: the PRIMARY KEY plus DO NOTHING means first touch wins and a
  -- retry, a double-submit, or a later visit carrying a different ad cannot
  -- rewrite history. DO NOTHING (not DO UPDATE) is also why no UPDATE path is
  -- needed anywhere.
  INSERT INTO intelligence.signup_attribution (organization_id, utm_content)
  VALUES (v_org, v_utm)
  ON CONFLICT (organization_id) DO NOTHING
  RETURNING organization_id INTO v_written;

  -- RETURNING yields no row when the conflict clause discarded the insert, so
  -- v_written stays NULL. That is the ONLY honest signal available here, and it
  -- is why this is not just `RETURN true`.
  RETURN v_written IS NOT NULL;
END;
$fn$;

REVOKE ALL   ON FUNCTION public.record_signup_attribution(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_signup_attribution(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_signup_attribution(text) TO service_role;
