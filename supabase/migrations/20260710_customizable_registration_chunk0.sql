-- Customizable Registration — Chunk 0 (schema only, additive + inert).
-- Spec: docs/specs/customizable-registration.md
--
-- This migration lays the dormant scaffolding for customizable registration.
-- It is PURE DDL — it seeds NO data, enables NO field, and changes NO live
-- behavior. J2S's live /j2s/register page renders identically after this runs
-- because: (a) no standard-field rows are created (absent row = field OFF), and
-- (b) student_contacts / dismissal_method start empty. Fields become visible only
-- when a later chunk deliberately inserts an active row (reversible).
--
-- Contents:
--   1. student_contacts        — child-level "people" (guardian / authorized_pickup
--                                / emergency / do_not_release), org-scoped, RLS.
--   2. students.dismissal_method (+ aftercare_provider) — how the child leaves.
--   3. custom_reg_fields.standard_key — lets the ONE reg-question table hold both
--      provider-custom questions AND wired standard questions in one ordered list.
--   4. replace_student_contacts(...) — atomic ordered-replace RPC, mirrors the proven
--      replace_emergency_contacts pattern but WITH an internal ownership check.
--   5. RLS finding fix — remove anon cross-org enumeration of custom_reg_fields;
--      replace with a single-org SECURITY DEFINER reader for the public reg page.
--
-- Applied to staging (mumfymlapolsfdnpewci) first, then prod
-- (iuasfpztkmrtagivlhtj) in the SAME pass (parity). Run the security advisor
-- after applying on each env.

-- ============================================================================
-- 1. student_contacts
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.student_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('guardian','authorized_pickup','emergency','do_not_release')),
  first_name text NOT NULL,
  last_name text NULL,
  phone text NULL,
  email text NULL,
  relationship text NULL,
  sort_order integer NOT NULL DEFAULT 0,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.student_contacts IS
  'Child-level people associated with a student: guardian (additional to the parent account), authorized_pickup (release-to list), emergency, do_not_release. Ordered set per (student, role) via sort_order. Written atomically by replace_student_contacts() or directly by service-role guest checkout. do_not_release is sensitive (custody) — gate visibility per RBAC.';
COMMENT ON COLUMN public.student_contacts.role IS
  'guardian | authorized_pickup | emergency | do_not_release. Primary guardian is the parents account row, NOT stored here.';
COMMENT ON COLUMN public.student_contacts.sort_order IS
  'Priority within (student, role). Assigned from array position by replace_student_contacts().';

CREATE INDEX IF NOT EXISTS student_contacts_student_idx ON public.student_contacts (student_id);
CREATE INDEX IF NOT EXISTS student_contacts_org_idx ON public.student_contacts (organization_id);

-- Grants (explicit — required for Data API access after 2026-10-30). No anon:
-- this table is never read pre-auth. Guest checkout writes via service_role.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.student_contacts TO authenticated;
-- Belt-and-suspenders: Supabase still auto-grants SELECT to anon on new public
-- tables (until the 2026-10-30 cutoff). RLS already blocks anon here, but this
-- table holds custody / do_not_release data — revoke the auto-grant explicitly.
REVOKE SELECT ON public.student_contacts FROM anon;

ALTER TABLE public.student_contacts ENABLE ROW LEVEL SECURITY;

-- Policies are dropped-then-created so this file is replay-safe
-- (Postgres has no CREATE POLICY IF NOT EXISTS).
DROP POLICY IF EXISTS student_contacts_member_read ON public.student_contacts;
DROP POLICY IF EXISTS student_contacts_donotrelease_read ON public.student_contacts;
DROP POLICY IF EXISTS student_contacts_member_write ON public.student_contacts;
DROP POLICY IF EXISTS student_contacts_parent_read ON public.student_contacts;

-- Any org member reads NON-sensitive contacts (rosters, admin).
CREATE POLICY student_contacts_member_read ON public.student_contacts
  FOR SELECT
  USING (role <> 'do_not_release' AND (is_org_member(organization_id) OR is_platform_admin()));

-- do_not_release is custody-sensitive: only org EDITORS (owner/admin/staff) may
-- read it — Viewers are excluded. (Instructor-facing visibility at dismissal is
-- decided in Chunk 3 via the roster policies.)
CREATE POLICY student_contacts_donotrelease_read ON public.student_contacts
  FOR SELECT
  USING (role = 'do_not_release' AND (can_edit_org(organization_id) OR is_platform_admin()));

-- Org editors (owner/admin/staff) manage directly (admin roster editor).
CREATE POLICY student_contacts_member_write ON public.student_contacts
  FOR ALL
  USING (can_edit_org(organization_id) OR is_platform_admin())
  WITH CHECK (can_edit_org(organization_id) OR is_platform_admin());

-- A parent reads their OWN child's contacts, all roles (parent portal display).
CREATE POLICY student_contacts_parent_read ON public.student_contacts
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.students s
    JOIN public.parents pa ON pa.id = s.parent_id
    WHERE s.id = student_contacts.student_id
      AND pa.auth_id = auth.uid()
  ));

-- (Parent WRITES go through replace_student_contacts(), which enforces ownership.)

-- ============================================================================
-- 2. students.dismissal_method (+ aftercare_provider)
-- ============================================================================
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS dismissal_method text NULL,
  ADD COLUMN IF NOT EXISTS aftercare_provider text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.students'::regclass AND conname = 'students_dismissal_method_check'
  ) THEN
    ALTER TABLE public.students
      ADD CONSTRAINT students_dismissal_method_check
      CHECK (dismissal_method IS NULL OR dismissal_method IN
        ('released_to_authorized_adult','walks_or_bikes_home','bus','aftercare','other'));
  END IF;
END $$;

COMMENT ON COLUMN public.students.dismissal_method IS
  'How the child leaves: released_to_authorized_adult (requires >=1 authorized_pickup contact) | walks_or_bikes_home | bus | aftercare | other. Child-level (reused across the child''s programs). NULL until collected. Superset of the legacy registrations.post_program_plan enum.';

-- ============================================================================
-- 3. custom_reg_fields.standard_key — unify standard + custom questions
-- ============================================================================
ALTER TABLE public.custom_reg_fields
  ADD COLUMN IF NOT EXISTS standard_key text NULL;

-- Allow a 'standard' field_type alongside the existing input types.
DO $$
DECLARE
  conname_var text;
BEGIN
  SELECT conname INTO conname_var FROM pg_constraint
  WHERE conrelid = 'public.custom_reg_fields'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%field_type%';
  IF conname_var IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.custom_reg_fields DROP CONSTRAINT %I', conname_var);
  END IF;
  ALTER TABLE public.custom_reg_fields
    ADD CONSTRAINT custom_reg_fields_field_type_check
    CHECK (field_type IN ('text','textarea','select','multiselect','checkbox','number','date','standard'));
END $$;

-- Constrain the standard_key vocabulary when set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.custom_reg_fields'::regclass AND conname = 'custom_reg_fields_standard_key_check'
  ) THEN
    ALTER TABLE public.custom_reg_fields
      ADD CONSTRAINT custom_reg_fields_standard_key_check
      CHECK (standard_key IS NULL OR standard_key IN
        ('guardian_secondary','dismissal_method','authorized_pickup','do_not_release','emergency_contact','how_heard'));
  END IF;
END $$;

-- At most one row per (org, standard_key).
CREATE UNIQUE INDEX IF NOT EXISTS custom_reg_fields_org_standard_key_uidx
  ON public.custom_reg_fields (organization_id, standard_key)
  WHERE standard_key IS NOT NULL;

COMMENT ON COLUMN public.custom_reg_fields.standard_key IS
  'NULL = a provider-authored custom question. Non-NULL = a platform standard question wired to structured storage/rendering (guardian_secondary | dismissal_method | authorized_pickup | do_not_release | emergency_contact | how_heard). Absence of a row for a standard_key = that standard question is OFF for the org.';

-- ============================================================================
-- 4. replace_student_contacts() — atomic ordered replace WITH ownership check
-- ============================================================================
-- Mirrors replace_emergency_contacts, but SECURITY DEFINER means it bypasses RLS,
-- so the body is the only gate: it MUST authorize the caller. Allowed callers:
--   - an org editor (owner/admin/staff) of p_organization_id, OR
--   - the parent who owns the student (parents.auth_id = auth.uid()).
-- Guest checkout (create-registration) uses the service-role client and writes
-- student_contacts DIRECTLY (bypasses RLS) rather than this RPC, so service_role
-- is intentionally NOT granted execute here.
CREATE OR REPLACE FUNCTION public.replace_student_contacts(
  p_student_id uuid,
  p_organization_id uuid,
  p_role text,
  p_contacts jsonb
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  c   jsonb;
  idx int := 0;
BEGIN
  IF p_role NOT IN ('guardian','authorized_pickup','emergency','do_not_release') THEN
    RAISE EXCEPTION 'invalid role %', p_role;
  END IF;

  -- The student must belong to the stated org (prevents org spoofing).
  IF NOT EXISTS (
    SELECT 1 FROM public.students s
    WHERE s.id = p_student_id AND s.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'student % not in organization %', p_student_id, p_organization_id;
  END IF;

  -- Authorization gate.
  IF NOT (
    can_edit_org(p_organization_id)
    OR EXISTS (
      SELECT 1 FROM public.students s
      JOIN public.parents pa ON pa.id = s.parent_id
      WHERE s.id = p_student_id AND pa.auth_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'not authorized to edit contacts for student %', p_student_id;
  END IF;

  -- Whole body is one implicit transaction: a raised error rolls back the delete.
  DELETE FROM public.student_contacts
   WHERE student_id = p_student_id AND role = p_role;

  FOR c IN SELECT * FROM jsonb_array_elements(COALESCE(p_contacts, '[]'::jsonb))
  LOOP
    INSERT INTO public.student_contacts
      (student_id, organization_id, role, first_name, last_name, phone, email, relationship, notes, sort_order)
    VALUES (
      p_student_id,
      p_organization_id,
      p_role,
      c->>'first_name',
      c->>'last_name',
      c->>'phone',
      c->>'email',
      c->>'relationship',
      c->>'notes',
      idx
    );
    idx := idx + 1;
  END LOOP;
END;
$function$;

-- Lock down the DEFINER doorway: Supabase auto-grants EXECUTE to anon+authenticated,
-- so revoke explicitly, then grant only to the roles that should call it.
REVOKE EXECUTE ON FUNCTION public.replace_student_contacts(uuid,uuid,text,jsonb) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.replace_student_contacts(uuid,uuid,text,jsonb) TO authenticated;

-- ============================================================================
-- 5. RLS finding fix — stop anon cross-org enumeration of custom_reg_fields
-- ============================================================================
-- Before: policy public_read_custom_fields USING (is_active = true) for role
-- public — no org filter, so an anon reader could enumerate EVERY org's active
-- registration questions (labels). No app code reads custom_reg_fields today, so
-- removing the blanket public policy breaks nothing. The public reg page will read
-- ONE org's active fields via the SECURITY DEFINER reader below (must specify an
-- org id → cannot enumerate across orgs). Returns only field DEFINITIONS for that
-- org (no PII, no answers), so exposing to anon is safe.
DROP POLICY IF EXISTS public_read_custom_fields ON public.custom_reg_fields;

CREATE OR REPLACE FUNCTION public.get_active_registration_fields(p_org_id uuid)
  RETURNS SETOF public.custom_reg_fields
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public','pg_temp'
AS $function$
  SELECT * FROM public.custom_reg_fields
  WHERE organization_id = p_org_id AND is_active = true
  ORDER BY sort_order, created_at;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_active_registration_fields(uuid) FROM public;
GRANT  EXECUTE ON FUNCTION public.get_active_registration_fields(uuid) TO anon, authenticated, service_role;
