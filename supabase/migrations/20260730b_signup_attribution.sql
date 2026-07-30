-- Signup attribution: which advertisement brought an operator to enrops.
--
-- Darren's app-events spec asks for utm_content from the signup URL to be
-- captured "into the signup record". It lives in `intelligence` rather than on
-- public.organizations because it is PLATFORM marketing data, not tenant
-- configuration: organizations is readable by every member of an org
-- (members_read_own_org), is read by dozens of surfaces, and does not need to
-- grow a marketing column. intelligence is already the sealed home for
-- platform-usage facts like signup_started.
--
-- Sealed exactly like intelligence.platform_events: RLS on, NO policies, NO
-- grants. Nothing but a SECURITY DEFINER function can reach it. Verified on
-- staging by impersonating a real operator: reading the table returns
-- "42501: permission denied for schema intelligence".
--
-- Applied to STAGING and PROD 2026-07-30, same pass, additive and inert.
-- NOTE: prod's copy of this migration already carried the corrected RETURN
-- from 20260730c; see that file.

CREATE TABLE IF NOT EXISTS intelligence.signup_attribution (
  organization_id uuid PRIMARY KEY
    REFERENCES public.organizations(id) ON DELETE CASCADE,
  utm_content     text NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intelligence.signup_attribution IS
  'Write-once ad attribution for a self-serve operator signup. One row per org, keyed by organization_id so a later call cannot overwrite the first touch.';

ALTER TABLE intelligence.signup_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON intelligence.signup_attribution FROM anon, authenticated;

-- The only writer. SECURITY DEFINER, and it takes ONLY the utm string: the org
-- is resolved from auth.uid(), never from anything the caller sends, so a
-- signed-in operator cannot write attribution against somebody else's org.
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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF v_utm IS NULL THEN
    RETURN false;
  END IF;

  v_utm := left(v_utm, 200);

  SELECT m.organization_id INTO v_org
  FROM public.org_members m
  WHERE m.auth_user_id = v_uid AND m.role = 'owner'
  ORDER BY m.created_at
  LIMIT 1;

  IF v_org IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO intelligence.signup_attribution (organization_id, utm_content)
  VALUES (v_org, v_utm)
  ON CONFLICT (organization_id) DO NOTHING;

  RETURN true;
END;
$fn$;

REVOKE ALL   ON FUNCTION public.record_signup_attribution(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_signup_attribution(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_signup_attribution(text) TO service_role;
