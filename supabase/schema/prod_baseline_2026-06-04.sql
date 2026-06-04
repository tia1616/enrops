--
-- PostgreSQL database dump
--

\restrict K2YcwPvDih3qPJ9ugCUh6hkQabReyKBaVYXphW0GxwYVV1gFMjpJVyL6dWd7swl

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: intelligence; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA intelligence;


--
-- Name: SCHEMA intelligence; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA intelligence IS 'Append-only platform telemetry for future predictive intelligence. Sealed from the operational public schema; written only via public.log_enrollment_event(). No UPDATE/DELETE granted — history is immutable.';


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: private; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA private;


--
-- Name: current_instructor_id(); Type: FUNCTION; Schema: private; Owner: -
--

CREATE FUNCTION private.current_instructor_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT id FROM public.instructors
  WHERE auth_user_id = auth.uid()
  LIMIT 1;
$$;


--
-- Name: auto_add_registrant_to_marketing_list(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_add_registrant_to_marketing_list() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_auto_enabled  boolean;
  v_parent_email  text;
  v_parent_name   text;
  v_child_first   text;
  v_child_last    text;
  v_school_name   text;
begin
  if (TG_OP = 'UPDATE') then
    if NEW.status is not distinct from OLD.status then return NEW; end if;
  end if;
  if NEW.status is null or NEW.status <> 'confirmed' then return NEW; end if;

  select auto_subscribe_registrants into v_auto_enabled
  from organizations where id = NEW.organization_id;
  if v_auto_enabled is not true then return NEW; end if;

  select p.email, nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    into v_parent_email, v_parent_name
  from parents p where p.id = NEW.parent_id;
  if v_parent_email is null then return NEW; end if;

  select s.first_name, s.last_name, pl.name
    into v_child_first, v_child_last, v_school_name
  from students s
  left join program_locations pl on pl.id = s.program_location_id
  where s.id = NEW.student_id;

  insert into marketing_recipients (
    organization_id, email, parent_name, child_first_name, child_last_name,
    school_name, source, segments
  )
  values (
    NEW.organization_id,
    lower(v_parent_email),
    v_parent_name,
    v_child_first,
    v_child_last,
    v_school_name,
    'enrops_registration',
    array['registrant']::text[]
  )
  on conflict do nothing;

  return NEW;
end;
$$;


--
-- Name: FUNCTION auto_add_registrant_to_marketing_list(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.auto_add_registrant_to_marketing_list() IS 'Upserts the registering parent into marketing_recipients on registration confirmation. Honors organizations.auto_subscribe_registrants. CAN-SPAM compliant via the always-on unsubscribe link in every send.';


--
-- Name: check_camp_assignment_conflict(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_camp_assignment_conflict() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  target_session record;
  conflict_row record;
begin
  if new.status = 'withdrawn' or new.instructor_id is null then
    return new;
  end if;

  select week_num, location_name, session_type, class_days, curriculum_name
    into target_session
    from camp_sessions
    where id = new.camp_session_id;

  if not found then
    return new;
  end if;

  select
    ca.id, cs.week_num, cs.location_name, cs.session_type, cs.curriculum_name
    into conflict_row
    from camp_assignments ca
    join camp_sessions cs on cs.id = ca.camp_session_id
    where ca.id <> new.id
      and ca.instructor_id = new.instructor_id
      and ca.status <> 'withdrawn'
      and cs.week_num = target_session.week_num
      and cs.id <> new.camp_session_id
      -- Overlapping class_days (any shared day-of-week)
      and (
        cs.class_days is null
        or target_session.class_days is null
        or cs.class_days && target_session.class_days
      )
      -- Conflict patterns
      and (
        cs.session_type = target_session.session_type
        or cs.session_type = 'full_day'
        or target_session.session_type = 'full_day'
        or (
          cs.session_type in ('morning', 'afternoon')
          and target_session.session_type in ('morning', 'afternoon')
          and cs.session_type <> target_session.session_type
          and cs.location_name <> target_session.location_name
        )
      )
    limit 1;

  if found then
    raise exception
      'Instructor conflict: same instructor is already on % at % (%, Wk %). Either drop that camp first or pick a different instructor.',
      conflict_row.curriculum_name,
      conflict_row.location_name,
      conflict_row.session_type,
      conflict_row.week_num
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;


--
-- Name: check_org_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_org_access(p_org_id uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE auth_user_id = auth.uid() 
      AND organization_id = p_org_id
      AND accepted_at IS NOT NULL
  );
$$;


--
-- Name: compute_distance_bonus(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_distance_bonus() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_cycle             uuid;
  v_org               uuid;
  v_session_location  text;
  v_curriculum        text;
  v_week              int;
  v_region            text;
  v_pref              text;
  v_flags             text[] := '{}';
  v_min_other_week    int;
  v_is_anchor         boolean;
BEGIN
  SELECT cs.cycle_id, cs.organization_id, cs.location_name, cs.curriculum_name, cs.week_num
    INTO v_cycle, v_org, v_session_location, v_curriculum, v_week
  FROM camp_sessions cs WHERE cs.id = NEW.camp_session_id;

  SELECT vr.region_name INTO v_region
  FROM venue_regions vr
  WHERE vr.organization_id = v_org AND vr.location_name = v_session_location;

  IF v_region IS NULL THEN
    NEW.distance_bonus_cents := NULL;
    NEW.flags := '{}';
    RETURN NEW;
  END IF;

  SELECT preference INTO v_pref
  FROM instructor_location_preferences
  WHERE instructor_id = NEW.instructor_id
    AND cycle_id = v_cycle
    AND location_name = v_region
  LIMIT 1;

  -- Lowest week_num among OTHER assignments in the same series (instructor +
  -- cycle + location + curriculum). NULL if no siblings exist.
  SELECT MIN(cs2.week_num) INTO v_min_other_week
  FROM camp_assignments ca2
  JOIN camp_sessions cs2 ON cs2.id = ca2.camp_session_id
  WHERE ca2.instructor_id = NEW.instructor_id
    AND cs2.cycle_id = v_cycle
    AND cs2.location_name = v_session_location
    AND cs2.curriculum_name = v_curriculum
    AND ca2.id != NEW.id;

  -- NEW row is the anchor iff there are no siblings, or its week_num is at
  -- least as low as the lowest sibling. Ties go to NEW (deterministic).
  v_is_anchor := (v_min_other_week IS NULL) OR (v_week <= v_min_other_week);

  IF v_pref = 'unavailable' THEN
    v_flags := array_append(v_flags, 'location_override');
    IF v_is_anchor THEN
      NEW.distance_bonus_cents := 5000;
    ELSE
      NEW.distance_bonus_cents := NULL;
    END IF;
  ELSIF v_pref = 'not_preferred' THEN
    v_flags := array_append(v_flags, 'location_low_pref');
    NEW.distance_bonus_cents := NULL;
  ELSE
    NEW.distance_bonus_cents := NULL;
  END IF;

  NEW.flags := v_flags;
  RETURN NEW;
END;
$$;


--
-- Name: cron_unschedule_by_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cron_unschedule_by_name(job_name text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT cron.unschedule(job_name);
$$;


--
-- Name: current_parent_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_parent_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT id FROM parents WHERE auth_id = auth.uid() LIMIT 1;
$$;


--
-- Name: derive_program_session_dates(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.derive_program_session_dates(p_program_id uuid) RETURNS date[]
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_first_date    DATE;
  v_count         INTEGER;
  v_location_id   UUID;
  v_location_closures DATE[];
  v_district      TEXT;
  v_org_id        UUID;
  v_term          TEXT;
  v_school_year   TEXT;
  v_district_closures DATE[];
  v_all_closures  DATE[];
  v_result        DATE[] := '{}';
  v_candidate     DATE;
  v_max_lookups   INTEGER;
  v_added         INTEGER := 0;
  i               INTEGER := 0;
BEGIN
  SELECT
    p.first_session_date,
    p.session_count,
    p.program_location_id,
    p.organization_id,
    p.term
  INTO v_first_date, v_count, v_location_id, v_org_id, v_term
  FROM programs p
  WHERE p.id = p_program_id;

  IF v_first_date IS NULL OR v_count IS NULL OR v_count <= 0 THEN
    RETURN '{}';
  END IF;

  SELECT
    COALESCE(pl.closure_dates, '{}'),
    pl.district
  INTO v_location_closures, v_district
  FROM program_locations pl
  WHERE pl.id = v_location_id;

  v_school_year := term_to_school_year(v_term);
  IF v_district IS NOT NULL AND v_school_year IS NOT NULL THEN
    SELECT COALESCE(
      ARRAY(
        SELECT (elem->>'date')::date
        FROM jsonb_array_elements(dc.no_school_dates) AS elem
        WHERE elem->>'date' IS NOT NULL
      ),
      '{}'::date[]
    )
    INTO v_district_closures
    FROM district_calendars dc
    WHERE dc.organization_id = v_org_id
      AND dc.district = v_district
      AND dc.school_year = v_school_year;
  END IF;

  v_district_closures := COALESCE(v_district_closures, '{}'::date[]);
  v_all_closures := v_location_closures || v_district_closures;

  v_max_lookups := v_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < v_count AND i < v_max_lookups LOOP
    v_candidate := v_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$$;


--
-- Name: FUNCTION derive_program_session_dates(p_program_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.derive_program_session_dates(p_program_id uuid) IS 'Returns the chronological list of dates a program meets, skipping both location closure_dates and district_calendars.no_school_dates (for district-following locations). Caller RLS gates access via SECURITY INVOKER. Early-release dates are NOT subtracted - programs still meet on those days.';


--
-- Name: get_campaign_recipients(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_campaign_recipients(p_campaign_id uuid) RETURNS TABLE(id uuid, email text, parent_name text, child_first_name text, child_last_name text, school_name text, city text, zip text, geo_segment text, segments text[])
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
  WHERE mc.id = p_campaign_id;
$$;


--
-- Name: guard_organizations_locked_columns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_organizations_locked_columns() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF auth.role() IS NULL
     OR auth.role() = 'service_role'
     OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.stripe_account_id        IS DISTINCT FROM OLD.stripe_account_id
  OR NEW.platform_fee_card_pct    IS DISTINCT FROM OLD.platform_fee_card_pct
  OR NEW.platform_fee_ach_pct     IS DISTINCT FROM OLD.platform_fee_ach_pct
  OR NEW.platform_fee_cap_cents   IS DISTINCT FROM OLD.platform_fee_cap_cents
  OR NEW.instructor_pay_enabled   IS DISTINCT FROM OLD.instructor_pay_enabled
  OR NEW.instructor_pay_model     IS DISTINCT FROM OLD.instructor_pay_model THEN
    RAISE EXCEPTION 'stripe_account_id, platform fee rate columns, instructor_pay_enabled, and instructor_pay_model can only be changed by Enrops platform admins.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: is_org_member(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_org_member(org_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM org_members
        WHERE auth_user_id = auth.uid() AND organization_id = org_id AND accepted_at IS NOT NULL
    );
$$;


--
-- Name: is_org_owner_or_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_org_owner_or_admin(p_org_id uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_members
    WHERE auth_user_id = auth.uid() 
      AND organization_id = p_org_id
      AND role IN ('owner', 'admin')
      AND accepted_at IS NOT NULL
  );
$$;


--
-- Name: is_platform_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT EXISTS (SELECT 1 FROM platform_admins WHERE auth_user_id = auth.uid());
$$;


--
-- Name: link_parent_to_auth_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.link_parent_to_auth_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Link existing parents row with this email, only if not already linked
  UPDATE public.parents
  SET auth_id = NEW.id
  WHERE LOWER(email) = LOWER(NEW.email)
    AND auth_id IS NULL;
  RETURN NEW;
END;
$$;


--
-- Name: log_enrollment_event(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_enrollment_event(p_action_type text, p_organization_id uuid DEFAULT NULL::uuid, p_parent_id uuid DEFAULT NULL::uuid, p_student_id uuid DEFAULT NULL::uuid, p_program_id uuid DEFAULT NULL::uuid, p_camp_session_id uuid DEFAULT NULL::uuid, p_site_id uuid DEFAULT NULL::uuid, p_registration_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb, p_occurred_at timestamp with time zone DEFAULT now(), p_dedupe_key text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'intelligence'
    AS $$
declare
  v_id uuid;
begin
  insert into intelligence.enrollment_events (
    organization_id, parent_id, student_id, program_id, camp_session_id,
    site_id, registration_id, action_type, metadata, occurred_at, dedupe_key
  ) values (
    p_organization_id, p_parent_id, p_student_id, p_program_id, p_camp_session_id,
    p_site_id, p_registration_id, p_action_type, coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, now()), p_dedupe_key
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;
  return v_id;  -- null when a duplicate was skipped
end;
$$;


--
-- Name: preview_program_session_dates(uuid, uuid, text, date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.preview_program_session_dates(p_organization_id uuid, p_location_id uuid, p_term text, p_first_date date, p_count integer) RETURNS date[]
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_location_closures DATE[] := '{}';
  v_district          TEXT;
  v_school_year       TEXT;
  v_district_closures DATE[] := '{}';
  v_all_closures      DATE[];
  v_result            DATE[] := '{}';
  v_candidate         DATE;
  v_max_lookups       INTEGER;
  v_added             INTEGER := 0;
  i                   INTEGER := 0;
BEGIN
  IF p_first_date IS NULL OR p_count IS NULL OR p_count <= 0 THEN
    RETURN '{}';
  END IF;

  IF p_location_id IS NOT NULL THEN
    SELECT
      COALESCE(pl.closure_dates, '{}'),
      pl.district
    INTO v_location_closures, v_district
    FROM program_locations pl
    WHERE pl.id = p_location_id;
  END IF;

  v_school_year := term_to_school_year(p_term);
  IF v_district IS NOT NULL AND v_school_year IS NOT NULL THEN
    SELECT COALESCE(
      ARRAY(
        SELECT (elem->>'date')::date
        FROM jsonb_array_elements(dc.no_school_dates) AS elem
        WHERE elem->>'date' IS NOT NULL
      ),
      '{}'::date[]
    )
    INTO v_district_closures
    FROM district_calendars dc
    WHERE dc.organization_id = p_organization_id
      AND dc.district = v_district
      AND dc.school_year = v_school_year;
  END IF;

  v_district_closures := COALESCE(v_district_closures, '{}'::date[]);
  v_all_closures := v_location_closures || v_district_closures;

  v_max_lookups := p_count * 2 + COALESCE(array_length(v_all_closures, 1), 0);

  WHILE v_added < p_count AND i < v_max_lookups LOOP
    v_candidate := p_first_date + (i * 7);
    IF NOT (v_candidate = ANY(v_all_closures)) THEN
      v_result := v_result || v_candidate;
      v_added := v_added + 1;
    END IF;
    i := i + 1;
  END LOOP;

  RETURN v_result;
END;
$$;


--
-- Name: program_locations_partner_same_org(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.program_locations_partner_same_org() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  partner_org UUID;
BEGIN
  IF NEW.partner_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT organization_id INTO partner_org FROM partners WHERE id = NEW.partner_id;
  IF partner_org IS NULL THEN
    RAISE EXCEPTION 'partner % not found', NEW.partner_id;
  END IF;
  IF partner_org <> NEW.organization_id THEN
    RAISE EXCEPTION 'partner % belongs to a different organisation', NEW.partner_id;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: programs_with_session_dates(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.programs_with_session_dates(p_organization_id uuid, p_term text) RETURNS TABLE(program_id uuid, session_dates date[])
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p.id, derive_program_session_dates(p.id)
  FROM programs p
  WHERE p.organization_id = p_organization_id
    AND p.term = p_term;
$$;


--
-- Name: FUNCTION programs_with_session_dates(p_organization_id uuid, p_term text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.programs_with_session_dates(p_organization_id uuid, p_term text) IS 'Returns derived session dates for every program in the given (organization_id, term). One round-trip alternative to calling derive_program_session_dates() per program. Caller RLS via SECURITY INVOKER.';


--
-- Name: recompute_camp_session_enrollment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_camp_session_enrollment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  new_id uuid;
  old_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    old_id := OLD.camp_session_id;
    new_id := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    old_id := NULL;
    new_id := NEW.camp_session_id;
  ELSE
    old_id := OLD.camp_session_id;
    new_id := NEW.camp_session_id;
  END IF;

  -- Update count for the new/changed camp_session
  IF new_id IS NOT NULL THEN
    UPDATE camp_sessions
    SET current_enrollment = (
          SELECT COUNT(*) FROM registrations
          WHERE camp_session_id = new_id AND status = 'confirmed'
        ),
        enrollment_synced_at = NOW()
    WHERE id = new_id;
  END IF;

  -- If UPDATE changed which camp_session this reg belongs to (or DELETE
  -- removed it), also recount the old one.
  IF old_id IS NOT NULL AND (new_id IS NULL OR old_id <> new_id) THEN
    UPDATE camp_sessions
    SET current_enrollment = (
          SELECT COUNT(*) FROM registrations
          WHERE camp_session_id = old_id AND status = 'confirmed'
        ),
        enrollment_synced_at = NOW()
    WHERE id = old_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: replace_emergency_contacts(uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_emergency_contacts(p_instructor_id uuid, p_organization_id uuid, p_contacts jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  c    jsonb;
  idx  int := 0;
begin
  -- Whole body is one implicit transaction: any raised error rolls back
  -- the delete. Caller (update-instructor-profile) has already validated
  -- that p_contacts is a non-empty array with all required fields.
  delete from public.contractor_emergency_contacts
   where instructor_id = p_instructor_id;

  for c in select * from jsonb_array_elements(p_contacts)
  loop
    insert into public.contractor_emergency_contacts
      (instructor_id, organization_id, contact_name, relationship, phone, is_primary)
    values (
      p_instructor_id,
      p_organization_id,
      c->>'contact_name',
      c->>'relationship',
      c->>'phone',
      idx = 0
    );
    idx := idx + 1;
  end loop;
end;
$$;


--
-- Name: FUNCTION replace_emergency_contacts(p_instructor_id uuid, p_organization_id uuid, p_contacts jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.replace_emergency_contacts(p_instructor_id uuid, p_organization_id uuid, p_contacts jsonb) IS 'Atomic replace of an instructor''s emergency contacts. SECURITY DEFINER, search_path pinned. EXECUTE restricted to service_role; called only by the update-instructor-profile edge function after it has resolved + authorized the instructor. is_primary derived from array position (index 0 = true).';


--
-- Name: restrict_assignment_substitution_sub_updates(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restrict_assignment_substitution_sub_updates() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_caller_is_sub BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM instructors i
    WHERE i.id = OLD.sub_instructor_id
      AND i.auth_user_id = auth.uid()
  ) INTO v_caller_is_sub;

  IF NOT v_caller_is_sub THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_assignment_id   IS DISTINCT FROM OLD.parent_assignment_id   OR
     NEW.parent_assignment_type IS DISTINCT FROM OLD.parent_assignment_type OR
     NEW.sub_instructor_id      IS DISTINCT FROM OLD.sub_instructor_id      OR
     NEW.date                   IS DISTINCT FROM OLD.date                   OR
     NEW.sub_tier               IS DISTINCT FROM OLD.sub_tier               OR
     NEW.assigned_at            IS DISTINCT FROM OLD.assigned_at            OR
     NEW.assigned_by            IS DISTINCT FROM OLD.assigned_by            OR
     NEW.notes                  IS DISTINCT FROM OLD.notes                  OR
     NEW.organization_id        IS DISTINCT FROM OLD.organization_id        OR
     NEW.email_sent_at          IS DISTINCT FROM OLD.email_sent_at          OR
     NEW.created_at             IS DISTINCT FROM OLD.created_at             THEN
    RAISE EXCEPTION 'sub_instructor may only update status, decline_reason, declined_at, email_viewed_at, updated_at'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_automations_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_automations_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: sync_instructor_onboarding_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_instructor_onboarding_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  UPDATE instructors
  SET onboarding_status = NEW.overall_status,
      updated_at = now()
  WHERE id = NEW.instructor_id;
  RETURN NEW;
END;
$$;


--
-- Name: term_to_school_year(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.term_to_school_year(p_term text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_prefix text;
  v_yy     integer;
BEGIN
  IF p_term IS NULL OR length(p_term) < 4 THEN
    RETURN NULL;
  END IF;

  v_prefix := upper(substring(p_term FROM 1 FOR 2));
  BEGIN
    v_yy := substring(p_term FROM 3)::integer;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  IF v_prefix = 'FA' THEN
    RETURN format('20%s-20%s', lpad(v_yy::text, 2, '0'), lpad((v_yy + 1)::text, 2, '0'));
  ELSIF v_prefix IN ('WI', 'SP') THEN
    RETURN format('20%s-20%s', lpad((v_yy - 1)::text, 2, '0'), lpad(v_yy::text, 2, '0'));
  ELSE
    RETURN NULL;
  END IF;
END;
$$;


--
-- Name: FUNCTION term_to_school_year(p_term text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.term_to_school_year(p_term text) IS 'Maps programs.term (FA26, WI27, SP27) to district_calendars.school_year (2026-2027). Returns NULL for SU terms and unknown formats.';


--
-- Name: user_org_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_org_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
    SELECT organization_id FROM org_members
    WHERE auth_user_id = auth.uid() AND accepted_at IS NOT NULL;
$$;


--
-- Name: validate_assignment_substitution_parent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_assignment_substitution_parent() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_parent_org UUID;
  v_sub_org    UUID;
BEGIN
  IF NEW.parent_assignment_type = 'camp' THEN
    SELECT organization_id INTO v_parent_org
    FROM camp_assignments
    WHERE id = NEW.parent_assignment_id;
    IF v_parent_org IS NULL THEN
      RAISE EXCEPTION 'parent_assignment_id % does not exist in camp_assignments',
        NEW.parent_assignment_id
        USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.parent_assignment_type = 'program' THEN
    SELECT organization_id INTO v_parent_org
    FROM program_assignments
    WHERE id = NEW.parent_assignment_id;
    IF v_parent_org IS NULL THEN
      RAISE EXCEPTION 'parent_assignment_id % does not exist in program_assignments',
        NEW.parent_assignment_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_parent_org THEN
    RAISE EXCEPTION 'assignment_substitutions.organization_id (%) does not match parent assignment org (%)',
      NEW.organization_id, v_parent_org
      USING ERRCODE = '23514';
  END IF;

  SELECT organization_id INTO v_sub_org
  FROM instructors
  WHERE id = NEW.sub_instructor_id;

  IF v_sub_org IS NULL THEN
    RAISE EXCEPTION 'sub_instructor_id % does not exist in instructors',
      NEW.sub_instructor_id
      USING ERRCODE = '23503';
  END IF;

  IF v_sub_org IS DISTINCT FROM v_parent_org THEN
    RAISE EXCEPTION 'sub_instructor_id % belongs to org % but parent assignment is in org %',
      NEW.sub_instructor_id, v_sub_org, v_parent_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: vault_create_secret_text(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vault_create_secret_text(p_secret_text text, p_secret_name text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'vault', 'public'
    AS $$
DECLARE
  v_id uuid;
BEGIN
  v_id := vault.create_secret(p_secret_text, p_secret_name, 'Enrops OAuth token');
  RETURN v_id;
END;
$$;


--
-- Name: vault_delete_secret(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vault_delete_secret(p_secret_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'vault', 'public'
    AS $$
BEGIN
  DELETE FROM vault.secrets WHERE id = p_secret_id;
END;
$$;


--
-- Name: vault_read_secret_text(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vault_read_secret_text(p_secret_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'vault', 'public'
    AS $$
DECLARE
  v_text text;
BEGIN
  SELECT decrypted_secret INTO v_text FROM vault.decrypted_secrets WHERE id = p_secret_id;
  RETURN v_text;
END;
$$;


--
-- Name: vault_update_secret_text(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vault_update_secret_text(p_secret_id uuid, p_secret_text text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'vault', 'public'
    AS $$
BEGIN
  PERFORM vault.update_secret(p_secret_id, p_secret_text);
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: enrollment_events; Type: TABLE; Schema: intelligence; Owner: -
--

CREATE TABLE intelligence.enrollment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    parent_id uuid,
    student_id uuid,
    program_id uuid,
    camp_session_id uuid,
    site_id uuid,
    registration_id uuid,
    action_type text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dedupe_key text
);


--
-- Name: TABLE enrollment_events; Type: COMMENT; Schema: intelligence; Owner: -
--

COMMENT ON TABLE intelligence.enrollment_events IS 'One row per enrollment-funnel event. Open action_type vocabulary + jsonb metadata so new signals need no migration. No FKs by design — this is an immutable log, not relational operational data.';


--
-- Name: parents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    phone text,
    is_vip boolean DEFAULT false,
    stripe_customer_id text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    auth_id uuid,
    vip_status text DEFAULT 'none'::text,
    vip_enrolled_at timestamp with time zone,
    emergency_contact_name text,
    emergency_contact_relationship text,
    emergency_contact_phone text,
    emergency_contact_email text,
    communication_preferences jsonb DEFAULT '{"sms_urgent_only": false, "email_session_recaps": true, "email_reenrollment_prompts": true, "email_registration_updates": true}'::jsonb,
    CONSTRAINT parents_vip_status_check CHECK ((vip_status = ANY (ARRAY['none'::text, 'returning'::text, 'new'::text])))
);


--
-- Name: COLUMN parents.emergency_contact_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.parents.emergency_contact_name IS 'Emergency contact is per-parent-account (shared across all their kids). If a parent needs different emergency contacts for different children, that would be a v2 feature.';


--
-- Name: program_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.program_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    district text,
    slug text NOT NULL,
    contact_name text,
    contact_email text,
    dismissal_time text,
    address text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    arrival_instructions text,
    organization_id uuid,
    food_drink_policy text,
    room_number text,
    contact_phone text,
    name_aliases text[] DEFAULT '{}'::text[],
    dismissal_instructions text,
    closure_dates date[] DEFAULT '{}'::date[] NOT NULL,
    partner_id uuid,
    parent_arrival_instructions text,
    parent_dismissal_instructions text
);


--
-- Name: COLUMN program_locations.food_drink_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_locations.food_drink_policy IS 'Per-venue food/drink rules shown to instructors on class detail page. e.g. "No outside food. Water only in classroom."';


--
-- Name: COLUMN program_locations.dismissal_instructions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_locations.dismissal_instructions IS 'Instructor-facing dismissal procedure: where and how students are released to families. Renders as a labeled section below arrival_instructions in the instructor portal.';


--
-- Name: COLUMN program_locations.closure_dates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_locations.closure_dates IS 'Dates the location is closed (school holidays, teacher planning days, district closures). derive_program_session_dates() subtracts these from generated session dates so afterschool programs skip them. Will be replaced by a districts table join in a future refactor.';


--
-- Name: COLUMN program_locations.partner_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_locations.partner_id IS 'Optional FK to the partner organisation that owns this location (school district, parks_rec, etc.). Used to resolve logistics contacts when emailing rosters.';


--
-- Name: COLUMN program_locations.parent_arrival_instructions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_locations.parent_arrival_instructions IS 'Parent-safe arrival info — surfaces in welcome emails. NULL means the welcome block renders empty (safe default). The original arrival_instructions column stays for instructor-facing data.';


--
-- Name: COLUMN program_locations.parent_dismissal_instructions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_locations.parent_dismissal_instructions IS 'Parent-safe dismissal info. Same audience contract as parent_arrival_instructions.';


--
-- Name: programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.programs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_location_id uuid,
    term text DEFAULT 'FA26'::text NOT NULL,
    curriculum text NOT NULL,
    day_of_week text NOT NULL,
    start_time text,
    end_time text,
    first_session_date date,
    sessions integer DEFAULT 8,
    grade_min integer DEFAULT 0,
    grade_max integer DEFAULT 5,
    max_capacity integer DEFAULT 18,
    price_cents integer NOT NULL,
    early_bird_price_cents integer,
    early_bird_deadline date,
    vip_price_cents integer,
    status text DEFAULT 'open'::text,
    instructor_name text,
    instructor_email text,
    room text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    price_tier text DEFAULT 'standard'::text,
    legacy_price_cents integer,
    legacy_deadline date,
    vip_returning_price_cents integer,
    vip_new_price_cents integer,
    organization_id uuid,
    session_count integer DEFAULT 8 NOT NULL,
    program_type text DEFAULT 'standard'::text NOT NULL,
    age_format text,
    age_min integer,
    age_max integer,
    short_description text,
    instructor_guide_url text,
    curriculum_id uuid,
    active_promo_code_id uuid,
    facility_requested_at date,
    facility_approved_at date,
    facility_notes text,
    CONSTRAINT programs_age_format_check CHECK ((age_format = ANY (ARRAY['grade'::text, 'age'::text]))),
    CONSTRAINT programs_facility_dates_check CHECK (((facility_approved_at IS NULL) OR (facility_requested_at IS NULL) OR (facility_approved_at >= facility_requested_at))),
    CONSTRAINT programs_price_tier_check CHECK ((price_tier = ANY (ARRAY['standard'::text, 'coding_robotics'::text]))),
    CONSTRAINT programs_program_type_check CHECK ((program_type = ANY (ARRAY['standard'::text, 'coding_robotics'::text]))),
    CONSTRAINT programs_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'closed'::text, 'cancelled'::text]))),
    CONSTRAINT programs_term_format_check CHECK (((term IS NULL) OR (term ~ '^(FA|WI|SP|SU)[0-9]{2}$'::text)))
);


--
-- Name: COLUMN programs.instructor_guide_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.programs.instructor_guide_url IS 'URL to instructor guide doc (typically Drive link). Renders as button on class detail page; hidden if null.';


--
-- Name: COLUMN programs.facility_requested_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.programs.facility_requested_at IS 'Date the operator submitted the facility booking request (Facilitron / Mazevo / partner email). Null means not requested yet.';


--
-- Name: COLUMN programs.facility_approved_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.programs.facility_approved_at IS 'Date the facility request was approved. Null means still pending or denied — use facility_notes for context.';


--
-- Name: COLUMN programs.facility_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.programs.facility_notes IS 'Free-text. "Waiting on PTA", "Denied — try Bonny Slope library instead", "Approved via partner email not Facilitron", etc.';


--
-- Name: CONSTRAINT programs_facility_dates_check ON programs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT programs_facility_dates_check ON public.programs IS 'Approval date cannot precede the request date. Either may be null while waiting on the workflow.';


--
-- Name: CONSTRAINT programs_term_format_check ON programs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT programs_term_format_check ON public.programs IS 'Term must match (FA|WI|SP|SU)NN, e.g. FA26 / WI27 / SP27 / SU26. Mirrors term_to_school_year() in 20260601_district_calendars.sql — change both together if the convention is ever extended.';


--
-- Name: registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    program_id uuid,
    student_id uuid,
    parent_id uuid,
    status text DEFAULT 'pending'::text,
    payment_method text,
    payment_status text DEFAULT 'unpaid'::text,
    stripe_payment_intent_id text,
    amount_cents integer,
    registered_at timestamp with time zone DEFAULT now(),
    cancelled_at timestamp with time zone,
    notes text,
    discount_type text,
    discount_cents integer DEFAULT 0,
    waitlist_position integer,
    organization_id uuid,
    custom_field_values jsonb DEFAULT '{}'::jsonb,
    post_program_plan text,
    aftercare_provider text,
    authorized_pickup_contacts text,
    how_heard text,
    referred_by text,
    program_fit_acknowledged boolean DEFAULT false,
    program_fit_acknowledged_at timestamp with time zone,
    photo_release_consent boolean DEFAULT false,
    photo_release_consent_at timestamp with time zone,
    promo_code_used text,
    camp_session_id uuid,
    CONSTRAINT photo_release_required_when_confirmed CHECK (((status <> 'confirmed'::text) OR (photo_release_consent = true))),
    CONSTRAINT registrations_discount_type_check CHECK ((discount_type = ANY (ARRAY['sibling'::text, 'legacy'::text, 'vip_returning'::text, 'vip_new'::text, 'promo'::text, NULL::text]))),
    CONSTRAINT registrations_one_program_or_camp_session CHECK ((((program_id IS NOT NULL) AND (camp_session_id IS NULL)) OR ((program_id IS NULL) AND (camp_session_id IS NOT NULL)))),
    CONSTRAINT registrations_payment_method_check CHECK ((payment_method = ANY (ARRAY['stripe'::text, 'stripe_installments'::text, 'invoice'::text, 'comp'::text, 'vip'::text]))),
    CONSTRAINT registrations_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'paid'::text, 'refunded'::text, 'partial'::text]))),
    CONSTRAINT registrations_post_program_plan_check CHECK (((post_program_plan = ANY (ARRAY['picked_up_by_parent'::text, 'walks_home'::text, 'bus'::text, 'aftercare'::text, 'other'::text])) OR (post_program_plan IS NULL))),
    CONSTRAINT registrations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'cancelled'::text, 'refunded'::text, 'waitlist'::text])))
);


--
-- Name: COLUMN registrations.post_program_plan; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.registrations.post_program_plan IS 'What happens when class ends. Instructor needs to know whether to release to aftercare, wait for parent, send to bus, etc.';


--
-- Name: COLUMN registrations.authorized_pickup_contacts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.registrations.authorized_pickup_contacts IS 'People besides the registering parent who are allowed to pick up this child. Free text so parents can add as many as they need with notes.';


--
-- Name: COLUMN registrations.photo_release_consent; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.registrations.photo_release_consent IS 'REQUIRED consent for J2S to photograph/video the child for marketing, social media, and program documentation. Parent must check this box to complete registration. Enforced at frontend AND at DB level via the check constraint below.';


--
-- Name: COLUMN registrations.camp_session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.registrations.camp_session_id IS 'Set when this registration is for a camp_session (summer camps). NULL for afterschool program registrations. Exactly one of program_id or camp_session_id is non-null.';


--
-- Name: students; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.students (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid,
    first_name text NOT NULL,
    last_name text NOT NULL,
    grade integer,
    homeroom_teacher text,
    program_location_id uuid,
    birthdate date,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    emergency_contact_name text,
    emergency_contact_phone text,
    allergies text,
    medical_notes text,
    organization_id uuid,
    pronouns text,
    medical_conditions text,
    epipen_required boolean DEFAULT false,
    medications_at_program text,
    dietary_restrictions text,
    photo_url text,
    special_needs_accommodations text,
    school_records_name text
);


--
-- Name: COLUMN students.allergies; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.students.allergies IS 'Free-text description of any allergies (food, environmental, etc.). Shown prominently on instructor rosters.';


--
-- Name: COLUMN students.epipen_required; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.students.epipen_required IS 'Flag for anaphylactic allergies. Instructor roster shows a red badge.';


--
-- Name: COLUMN students.medications_at_program; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.students.medications_at_program IS 'Any meds the child brings to program (inhaler, epipen, ADHD meds, etc.).';


--
-- Name: COLUMN students.school_records_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.students.school_records_name IS 'Student name as it appears in school records. Optional — only filled if different from first_name/last_name. Prevents roster mismatches with school admins.';


--
-- Name: admin_registrations; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.admin_registrations WITH (security_invoker='true') AS
 SELECT r.id AS registration_id,
    r.status,
    r.payment_status,
    r.registered_at,
    s.first_name AS student_first,
    s.last_name AS student_last,
    pa.first_name AS parent_first,
    pa.last_name AS parent_last,
    pa.email AS parent_email,
    pa.phone AS parent_phone,
    p.curriculum AS program,
    p.day_of_week,
    p.start_time,
    p.end_time,
    p.term,
    p.first_session_date,
    pl.name AS school,
    r.amount_cents,
    r.promo_code_used,
    r.how_heard
   FROM ((((public.registrations r
     JOIN public.students s ON ((s.id = r.student_id)))
     JOIN public.parents pa ON ((pa.id = r.parent_id)))
     JOIN public.programs p ON ((p.id = r.program_id)))
     JOIN public.program_locations pl ON ((pl.id = p.program_location_id)))
  ORDER BY r.registered_at DESC;


--
-- Name: VIEW admin_registrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.admin_registrations IS 'Admin/internal view with parent PII. SECURITY INVOKER — respects RLS on underlying tables. Only service_role and platform admins should query this.';


--
-- Name: afterschool_survey_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.afterschool_survey_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    term text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    deadline date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assignment_substitutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment_substitutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_assignment_id uuid NOT NULL,
    parent_assignment_type text NOT NULL,
    sub_instructor_id uuid NOT NULL,
    date date NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sub_tier text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid,
    notes text,
    organization_id uuid NOT NULL,
    email_sent_at timestamp with time zone,
    email_viewed_at timestamp with time zone,
    declined_at timestamp with time zone,
    decline_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assignment_substitutions_parent_assignment_type_check CHECK ((parent_assignment_type = ANY (ARRAY['camp'::text, 'program'::text]))),
    CONSTRAINT assignment_substitutions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'declined'::text, 'taught'::text, 'missed'::text]))),
    CONSTRAINT assignment_substitutions_sub_tier_check CHECK ((sub_tier = ANY (ARRAY['lead'::text, 'developing'::text])))
);


--
-- Name: TABLE assignment_substitutions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.assignment_substitutions IS 'Single-day substitute instructor assignments. Polymorphic parent: parent_assignment_type=''camp'' references camp_assignments.id; ''program'' references program_assignments.id. v_effective_pay_lines LEFT JOINs to this to route pay to the sub when one exists for the date.';


--
-- Name: automation_edits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_edits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    template_id uuid NOT NULL,
    field text NOT NULL,
    previous_value text,
    new_value text,
    edited_by uuid,
    edited_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_edits_field_check CHECK ((field = ANY (ARRAY['subject_override'::text, 'body_override'::text, 'timing_override'::text, 'enabled'::text])))
);


--
-- Name: TABLE automation_edits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.automation_edits IS 'Append-only voice-signal history. Every operator save of an automation override appends a row. Future Ennie integration computes deltas to feed her drafting context.';


--
-- Name: automation_run_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_run_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_run_id uuid NOT NULL,
    automation_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    parent_id uuid,
    context_key text NOT NULL,
    email text NOT NULL,
    resend_message_id text,
    status text NOT NULL,
    error_message text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_run_recipients_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text, 'skipped_unsubscribed'::text, 'skipped_throttle'::text])))
);


--
-- Name: TABLE automation_run_recipients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.automation_run_recipients IS 'Per-recipient send log for lifecycle automations. UNIQUE(automation_id, context_key) provides idempotency — cron cannot double-fire to the same context.';


--
-- Name: COLUMN automation_run_recipients.context_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.automation_run_recipients.context_key IS 'Idempotency key. Format: "program:UUID:parent:UUID" (welcomes/recaps), "student:UUID:year:YYYY" (birthday), "registration:UUID" (abandoned/thank-you).';


--
-- Name: automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    audience_size integer NOT NULL,
    status text NOT NULL,
    error_message text,
    marketing_send_ids uuid[],
    time_saved_minutes integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_runs_audience_size_nonneg CHECK ((audience_size >= 0)),
    CONSTRAINT automation_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped_no_audience'::text, 'skipped_disabled'::text, 'skipped_locked'::text]))),
    CONSTRAINT automation_runs_time_saved_nonneg CHECK (((time_saved_minutes IS NULL) OR (time_saved_minutes >= 0)))
);


--
-- Name: TABLE automation_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.automation_runs IS 'Audit log per cron fire. Source of truth for "last fired" pill (read via MAX(fired_at) — NOT denormalized to automations per the artifact-column rule).';


--
-- Name: automation_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    display_name text NOT NULL,
    description text NOT NULL,
    trigger_type text NOT NULL,
    applies_to_program_type text NOT NULL,
    mailing_type text NOT NULL,
    default_subject text NOT NULL,
    default_body text NOT NULL,
    default_timing jsonb DEFAULT '{}'::jsonb NOT NULL,
    time_saved_minutes_per_send integer DEFAULT 3 NOT NULL,
    push_to_parent_portal boolean DEFAULT true NOT NULL,
    is_v1_enabled boolean DEFAULT true NOT NULL,
    sort_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_templates_applies_to_check CHECK ((applies_to_program_type = ANY (ARRAY['camps'::text, 'afterschool'::text, 'both'::text]))),
    CONSTRAINT automation_templates_mailing_type_check CHECK ((mailing_type = ANY (ARRAY['informational'::text, 'marketing'::text]))),
    CONSTRAINT automation_templates_time_saved_nonneg CHECK ((time_saved_minutes_per_send >= 0)),
    CONSTRAINT automation_templates_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['event_registration_confirmed'::text, 'days_before_first_session'::text, 'days_after_first_session'::text, 'session_midpoint'::text, 'session_last_day'::text, 'birthday'::text, 'event_registration_abandoned'::text, 'survey_pending'::text])))
);


--
-- Name: TABLE automation_templates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.automation_templates IS 'System templates for lifecycle automations (Welcome, Thank-you, etc.). Seeded by migration; not operator-editable. Per-org overrides live in the automations table.';


--
-- Name: COLUMN automation_templates.mailing_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.automation_templates.mailing_type IS 'informational = bypasses promotional-unsubscribe; marketing = respects it. All v1 templates are informational.';


--
-- Name: COLUMN automation_templates.push_to_parent_portal; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.automation_templates.push_to_parent_portal IS 'Data trail flag — when the parent portal ships, it will read automation_runs with this=true. UI does not surface "parent portal" copy until the portal exists.';


--
-- Name: automations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    template_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    subject_override text,
    body_override text,
    timing_override jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE automations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.automations IS 'Per-org enablement + body/subject/timing overrides for automation_templates. enabled defaults false — operator opts in explicitly.';


--
-- Name: available_fonts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.available_fonts (
    name text NOT NULL,
    category text NOT NULL,
    google_fonts_param text NOT NULL,
    fallback_stack text NOT NULL,
    display_order integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT available_fonts_category_check CHECK ((category = ANY (ARRAY['heading'::text, 'body'::text])))
);


--
-- Name: TABLE available_fonts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.available_fonts IS 'Curated Google Fonts the platform offers tenants during onboarding. Two categories (heading, body). Code joins on name to get the Google Fonts URL fragment and a fallback stack for email/print clients that strip web fonts.';


--
-- Name: COLUMN available_fonts.google_fonts_param; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.available_fonts.google_fonts_param IS 'The family= parameter for Google Fonts CSS API (e.g. ''Nunito+Sans:wght@400;600;700''). Combine multiple with &family=.';


--
-- Name: COLUMN available_fonts.fallback_stack; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.available_fonts.fallback_stack IS 'CSS font stack used after the web font, sized so Gmail/Outlook still get something close. Should not include the web font name itself; the rendering code prepends it.';


--
-- Name: camp_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camp_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    camp_session_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    instructor_response_at timestamp with time zone,
    decline_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    change_request_message text,
    admin_response_message text,
    deadline date,
    email_sent_at timestamp with time zone,
    email_viewed_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    distance_bonus_cents integer,
    flagged_reason text,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    distance_bonus_paid_at timestamp with time zone,
    distance_bonus_payout_id uuid,
    CONSTRAINT camp_assignments_role_check CHECK ((role = ANY (ARRAY['lead'::text, 'developing'::text]))),
    CONSTRAINT camp_assignments_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'confirmed'::text, 'change_requested'::text, 'published'::text, 'withdrawn'::text, 'declined'::text])))
);


--
-- Name: COLUMN camp_assignments.flags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.camp_assignments.flags IS 'Matcher-produced flags persisted at publish time. Values: location_override, location_low_pref, curriculum_mismatch. Empty array means no special-case flags. See match-instructors/lib.ts OutputFlag type for the canonical list.';


--
-- Name: COLUMN camp_assignments.distance_bonus_paid_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.camp_assignments.distance_bonus_paid_at IS 'When non-NULL, distance bonus settled by linked payout.';


--
-- Name: camp_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.camp_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    parent_session_id uuid,
    program_id uuid,
    location_id uuid,
    location_name text NOT NULL,
    week_num integer NOT NULL,
    session_type text NOT NULL,
    curriculum_category text NOT NULL,
    curriculum_name text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    ages_min integer,
    ages_max integer,
    runs_own_registration boolean DEFAULT false NOT NULL,
    current_enrollment integer DEFAULT 0 NOT NULL,
    enrollment_synced_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    class_days text[],
    curriculum_id uuid,
    price_cents integer,
    early_bird_price_cents integer,
    early_bird_deadline date,
    CONSTRAINT camp_sessions_curriculum_category_check CHECK ((curriculum_category = ANY (ARRAY['lego'::text, 'coding'::text, 'robotics'::text]))),
    CONSTRAINT camp_sessions_eb_deadline_requires_eb_price CHECK (((early_bird_deadline IS NULL) OR (early_bird_price_cents IS NOT NULL))),
    CONSTRAINT camp_sessions_eb_lower_than_regular CHECK (((early_bird_price_cents IS NULL) OR (price_cents IS NULL) OR (early_bird_price_cents < price_cents))),
    CONSTRAINT camp_sessions_session_type_check CHECK ((session_type = ANY (ARRAY['morning'::text, 'afternoon'::text, 'full_day'::text]))),
    CONSTRAINT camp_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text]))),
    CONSTRAINT camp_sessions_week_num_check CHECK (((week_num >= 1) AND (week_num <= 20)))
);


--
-- Name: COLUMN camp_sessions.class_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.camp_sessions.class_days IS 'Array of weekday names (lowercase: monday, tuesday, wednesday, thursday, friday, saturday, sunday) on which this session actually meets within its week. NULL = assume all weekdays between starts_on and ends_on inclusive.';


--
-- Name: COLUMN camp_sessions.curriculum_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.camp_sessions.curriculum_id IS 'FK to curricula.id once the curriculum is published + linked. Mirror of programs.curriculum_id for the camp side of scheduling.';


--
-- Name: capability_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    category text NOT NULL,
    short_description text,
    why_it_matters text NOT NULL,
    stat_text text,
    stat_source text,
    stat_source_url text,
    required_states text[] DEFAULT '{}'::text[] NOT NULL,
    required_states_human text,
    icon_name text,
    display_order integer DEFAULT 0 NOT NULL,
    is_available boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_definitions_category_check CHECK ((category = ANY (ARRAY['curriculum'::text, 'program'::text, 'parent'::text, 'instructor'::text, 'marketing'::text, 'operations'::text])))
);


--
-- Name: capability_unlock_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_unlock_states (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    capability_id uuid NOT NULL,
    scoped_entity_type text,
    scoped_entity_id uuid,
    is_unlocked boolean DEFAULT false NOT NULL,
    unlocked_at timestamp with time zone,
    last_action_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT capability_unlock_states_scoped_entity_type_check CHECK ((scoped_entity_type = ANY (ARRAY['curriculum'::text, 'program'::text])))
);


--
-- Name: checkout_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkout_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stripe_session_id text NOT NULL,
    organization_id uuid,
    schedule jsonb NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE checkout_schedules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.checkout_schedules IS 'Staging table for installment schedules between create-checkout and stripe-webhook. Bug A fix 2026-05-01: per-child registration_id mapping for N×3 installment rows.';


--
-- Name: contractor_acknowledgments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractor_acknowledgments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instructor_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    document_id text NOT NULL,
    document_version text NOT NULL,
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contractor_agreements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractor_agreements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instructor_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    agreement_version text NOT NULL,
    agreement_text_snapshot text NOT NULL,
    signed_at timestamp with time zone DEFAULT now() NOT NULL,
    typed_signature text NOT NULL,
    ip_address inet,
    user_agent text,
    confirm_read boolean DEFAULT false NOT NULL,
    confirm_pay_structure boolean DEFAULT false NOT NULL,
    confirm_contractor_status boolean DEFAULT false NOT NULL,
    confirm_confidentiality_ip boolean DEFAULT false NOT NULL,
    confirm_supersedes_prior boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contractor_emergency_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractor_emergency_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instructor_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    contact_name text NOT NULL,
    relationship text NOT NULL,
    phone text NOT NULL,
    is_primary boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contractor_onboarding_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractor_onboarding_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instructor_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    current_step integer DEFAULT 1 NOT NULL,
    steps_completed jsonb DEFAULT '{}'::jsonb NOT NULL,
    stripe_connect_account_id text,
    stripe_connect_status text DEFAULT 'not_started'::text,
    stripe_payouts_enabled boolean DEFAULT false,
    checkr_candidate_id text,
    checkr_invitation_id text,
    checkr_status text DEFAULT 'not_started'::text,
    checkr_completed_at timestamp with time zone,
    checkr_last_webhook_event_id text,
    stripe_last_webhook_event_id text,
    overall_status text DEFAULT 'not_invited'::text NOT NULL,
    invited_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resume_requested_at timestamp with time zone,
    background_check_source text DEFAULT 'checkr'::text NOT NULL,
    background_check_file_url text,
    background_check_uploaded_by uuid,
    background_check_completed_on date,
    CONSTRAINT contractor_onboarding_status_background_check_source_check CHECK ((background_check_source = ANY (ARRAY['checkr'::text, 'admin_uploaded'::text]))),
    CONSTRAINT contractor_onboarding_status_checkr_status_check CHECK ((checkr_status = ANY (ARRAY['not_started'::text, 'pending'::text, 'clear'::text, 'consider'::text, 'suspended'::text]))),
    CONSTRAINT contractor_onboarding_status_overall_status_check CHECK ((overall_status = ANY (ARRAY['not_invited'::text, 'invited'::text, 'in_progress'::text, 'pending_background_check'::text, 'pending_stripe'::text, 'complete'::text, 'declined'::text, 'abandoned'::text]))),
    CONSTRAINT contractor_onboarding_status_stripe_connect_status_check CHECK ((stripe_connect_status = ANY (ARRAY['not_started'::text, 'onboarding_in_progress'::text, 'pending_verification'::text, 'complete'::text, 'payouts_disabled'::text])))
);


--
-- Name: COLUMN contractor_onboarding_status.background_check_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contractor_onboarding_status.background_check_source IS 'How the background check was recorded: ''checkr'' = ran through Checkr API, ''admin_uploaded'' = admin uploaded a prior-year report PDF.';


--
-- Name: COLUMN contractor_onboarding_status.background_check_file_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contractor_onboarding_status.background_check_file_url IS 'Storage path inside contractor-documents bucket. Set when source = admin_uploaded.';


--
-- Name: COLUMN contractor_onboarding_status.background_check_uploaded_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contractor_onboarding_status.background_check_uploaded_by IS 'auth.users.id of the admin who uploaded the prior report. Null when source = checkr.';


--
-- Name: COLUMN contractor_onboarding_status.background_check_completed_on; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.contractor_onboarding_status.background_check_completed_on IS 'Date of the original background check (per the uploaded record). Null when source = checkr (timestamp is in checkr_completed_at instead).';


--
-- Name: contractor_ors_certification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contractor_ors_certification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instructor_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    separate_business_location boolean DEFAULT false NOT NULL,
    bears_risk_of_loss boolean DEFAULT false NOT NULL,
    multiple_clients boolean DEFAULT false NOT NULL,
    significant_investment boolean DEFAULT false NOT NULL,
    authority_to_hire boolean DEFAULT false NOT NULL,
    separate_business_location_text text,
    bears_risk_of_loss_text text,
    multiple_clients_text text,
    significant_investment_text text,
    authority_to_hire_text text,
    criteria_met integer NOT NULL,
    certified_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contractor_ors_certification_criteria_met_check CHECK (((criteria_met >= 0) AND (criteria_met <= 5)))
);


--
-- Name: curricula; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curricula (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    short_description text,
    age_range_min integer,
    age_range_max integer,
    session_count integer,
    format text,
    narrative_arc text,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    session_types_supported text[] DEFAULT '{}'::text[] NOT NULL,
    themes text[] DEFAULT '{}'::text[] NOT NULL,
    skills_overall text[] DEFAULT '{}'::text[] NOT NULL,
    materials text[] DEFAULT '{}'::text[] NOT NULL,
    created_by uuid,
    grade_min integer,
    grade_max integer,
    class_size_min integer,
    class_size_max integer,
    prerequisites text,
    mid_term_skills text[] DEFAULT '{}'::text[] NOT NULL,
    final_showcase text,
    final_recap_skills text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT curricula_age_range_valid CHECK (((age_range_min IS NULL) OR (age_range_max IS NULL) OR (age_range_min <= age_range_max))),
    CONSTRAINT curricula_format_check CHECK ((format = ANY (ARRAY['afterschool'::text, 'summer_camp'::text, 'other'::text]))),
    CONSTRAINT curricula_grade_range_valid CHECK (((grade_min IS NULL) OR (grade_max IS NULL) OR (grade_min <= grade_max))),
    CONSTRAINT curricula_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'extracted'::text, 'published'::text])))
);


--
-- Name: COLUMN curricula.class_size_min; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curricula.class_size_min IS 'Minimum students. Drives waitlist + cancel-by + marketing copy.';


--
-- Name: COLUMN curricula.class_size_max; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curricula.class_size_max IS 'Maximum students. Drives waitlist + cancel-by + marketing copy.';


--
-- Name: COLUMN curricula.prerequisites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curricula.prerequisites IS 'Parent-facing prereq line — appears on registration page.';


--
-- Name: COLUMN curricula.mid_term_skills; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curricula.mid_term_skills IS 'Skills surfaced in the mid-term recap email. Defaults to {}; UI suggests sessions 1..midpoint skills if empty.';


--
-- Name: COLUMN curricula.final_showcase; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curricula.final_showcase IS 'Capstone/showcase description. Powers the pre-launch reminder email.';


--
-- Name: COLUMN curricula.final_recap_skills; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curricula.final_recap_skills IS 'Top ~6 skills surfaced in the final recap email. Auto-filled at review time by frequency ranking across all per-session skills_practiced.';


--
-- Name: curriculum_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    curriculum_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    doc_type text NOT NULL,
    source_type text NOT NULL,
    storage_path text,
    drive_url text,
    original_filename text,
    mime_type text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    extraction_status text DEFAULT 'pending'::text NOT NULL,
    extraction_result jsonb,
    extraction_error text,
    extracted_text text,
    status_message text,
    CONSTRAINT curriculum_documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['instructor_guide'::text, 'materials_list'::text, 'student_materials'::text, 'other'::text]))),
    CONSTRAINT curriculum_documents_extraction_status_check CHECK ((extraction_status = ANY (ARRAY['pending'::text, 'processing'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT curriculum_documents_source_check CHECK ((((source_type = 'upload'::text) AND (storage_path IS NOT NULL)) OR ((source_type = 'drive_link'::text) AND (drive_url IS NOT NULL)))),
    CONSTRAINT curriculum_documents_source_type_check CHECK ((source_type = ANY (ARRAY['upload'::text, 'drive_link'::text])))
);


--
-- Name: COLUMN curriculum_documents.status_message; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curriculum_documents.status_message IS 'Human-readable progress message (e.g. "Writing recap templates for each session..."). Updated by extract-curriculum-details edge fn; consumed by the extracting page via Supabase Realtime.';


--
-- Name: curriculum_extracted_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_extracted_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    curriculum_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    field_name text NOT NULL,
    extracted_value jsonb,
    confidence double precision,
    source_document_id uuid,
    human_approved boolean DEFAULT false NOT NULL,
    human_edited_value jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    human_approved_by uuid,
    CONSTRAINT curriculum_extracted_fields_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
);


--
-- Name: COLUMN curriculum_extracted_fields.human_approved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.curriculum_extracted_fields.human_approved_by IS 'Who approved the value on the review screen. Null until human_approved=true.';


--
-- Name: curriculum_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curriculum_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    curriculum_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    session_number integer NOT NULL,
    title text,
    description text,
    skills_practiced text[] DEFAULT '{}'::text[] NOT NULL,
    materials_session text[] DEFAULT '{}'::text[] NOT NULL,
    recap_template text,
    parent_engagement_question text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: custom_reg_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_reg_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    field_key text NOT NULL,
    label text NOT NULL,
    field_type text NOT NULL,
    options jsonb,
    is_required boolean DEFAULT false,
    applies_to text DEFAULT 'all'::text,
    applies_to_value text,
    sort_order integer DEFAULT 0,
    help_text text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT custom_reg_fields_applies_to_check CHECK ((applies_to = ANY (ARRAY['all'::text, 'enrollment_type'::text, 'program'::text]))),
    CONSTRAINT custom_reg_fields_field_type_check CHECK ((field_type = ANY (ARRAY['text'::text, 'textarea'::text, 'select'::text, 'multiselect'::text, 'checkbox'::text, 'number'::text, 'date'::text])))
);


--
-- Name: district_calendars; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.district_calendars (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    district text NOT NULL,
    school_year text NOT NULL,
    first_day_of_school date,
    last_day_of_school date,
    no_school_dates jsonb DEFAULT '[]'::jsonb NOT NULL,
    early_release_dates jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_url text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: TABLE district_calendars; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.district_calendars IS 'Per-district school year calendars. Source of truth for no-school dates across all locations in a district. derive_program_session_dates() reads from this for district-following locations.';


--
-- Name: COLUMN district_calendars.no_school_dates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.district_calendars.no_school_dates IS 'jsonb array of {date, reason}. Reason is short label (e.g. "Thanksgiving", "Winter Break"). derive_program_session_dates() reads only the dates; reasons surface in UI when explaining skipped sessions.';


--
-- Name: COLUMN district_calendars.early_release_dates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.district_calendars.early_release_dates IS 'jsonb array of {date, reason}. Programs still meet but dismissal is earlier. Used to flag instructor heads-ups and parent emails. Not subtracted from session dates.';


--
-- Name: enrollment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enrollment_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    terms_covered integer DEFAULT 1,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: installment_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installment_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    num_installments integer NOT NULL,
    interval_type text DEFAULT 'monthly'::text,
    interval_days integer,
    first_charge_timing text DEFAULT 'now'::text,
    is_default boolean DEFAULT false,
    is_active boolean DEFAULT true,
    min_total_cents integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT installment_plans_first_charge_timing_check CHECK ((first_charge_timing = ANY (ARRAY['now'::text, 'program_start'::text, 'custom_date'::text]))),
    CONSTRAINT installment_plans_interval_type_check CHECK ((interval_type = ANY (ARRAY['weekly'::text, 'biweekly'::text, 'monthly'::text, 'custom'::text]))),
    CONSTRAINT installment_plans_num_installments_check CHECK (((num_installments >= 2) AND (num_installments <= 12)))
);


--
-- Name: installments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.installments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registration_id uuid,
    installment_number integer NOT NULL,
    amount_cents integer NOT NULL,
    due_date date NOT NULL,
    status text DEFAULT 'pending'::text,
    stripe_payment_intent_id text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    organization_id uuid,
    stripe_customer_id text,
    stripe_payment_method_id text,
    last_attempt_at timestamp with time zone,
    failure_reason text,
    installment_plan_id uuid,
    parent_notified_failed_at timestamp with time zone,
    CONSTRAINT installments_installment_number_check CHECK ((installment_number = ANY (ARRAY[1, 2, 3]))),
    CONSTRAINT installments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'paused_card_failed'::text, 'paused_program_cancelled'::text])))
);


--
-- Name: COLUMN installments.parent_notified_failed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.installments.parent_notified_failed_at IS 'Set when parent receives a decline notice email. Prevents re-notifying on subsequent cron runs that re-encounter the same paused_card_failed row. Cleared if installment is manually flipped back to pending.';


--
-- Name: instructor_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructor_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    session_types text[] DEFAULT '{}'::text[] NOT NULL,
    available_weeks integer[] DEFAULT '{}'::integer[] NOT NULL,
    unavailable_dates daterange[],
    unavailable_notes text,
    saturdays_ok boolean DEFAULT false NOT NULL,
    role_preference text DEFAULT 'lead_or_developing'::text NOT NULL,
    developing_min_enrollment integer,
    notes text,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    available_days text[] DEFAULT '{}'::text[],
    available_terms text[] DEFAULT '{}'::text[],
    needs_confirmation boolean DEFAULT false NOT NULL,
    CONSTRAINT instructor_availability_available_days_check CHECK ((available_days <@ ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text])),
    CONSTRAINT instructor_availability_role_preference_check CHECK ((role_preference = ANY (ARRAY['lead_only'::text, 'lead_or_developing'::text, 'developing_only'::text])))
);


--
-- Name: COLUMN instructor_availability.available_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructor_availability.available_days IS 'Used for afterschool cycles. Day codes: mon, tue, wed, thu, fri. Empty for summer_camp cycles (which use session_types + available_weeks instead).';


--
-- Name: COLUMN instructor_availability.available_terms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructor_availability.available_terms IS 'Used for afterschool cycles. Term codes: FA26, WI27, SP27, etc. Empty for summer_camp cycles.';


--
-- Name: COLUMN instructor_availability.needs_confirmation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructor_availability.needs_confirmation IS 'When TRUE, the agent deprioritizes this instructor and matches them only after all other instructors have been considered. Used when an instructor''s survey response is tentative or needs follow-up.';


--
-- Name: instructor_curriculum_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructor_curriculum_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    curriculum_category text NOT NULL,
    preference text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instructor_curriculum_preferences_curriculum_category_check CHECK ((curriculum_category = ANY (ARRAY['lego'::text, 'coding'::text, 'robotics'::text]))),
    CONSTRAINT instructor_curriculum_preferences_preference_check CHECK ((preference = ANY (ARRAY['highly_preferred'::text, 'preferred'::text, 'not_preferred'::text])))
);


--
-- Name: instructor_location_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructor_location_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    location_name text NOT NULL,
    preference text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instructor_location_preferences_preference_check CHECK ((preference = ANY (ARRAY['highly_preferred'::text, 'preferred'::text, 'not_preferred'::text, 'unavailable'::text])))
);


--
-- Name: instructor_offer_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructor_offer_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    camp_assignment_id uuid,
    sender_role text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sender_instructor_id uuid,
    program_assignment_id uuid,
    CONSTRAINT instructor_offer_messages_one_assignment_check CHECK ((num_nonnulls(camp_assignment_id, program_assignment_id) = 1)),
    CONSTRAINT instructor_offer_messages_sender_role_check CHECK ((sender_role = ANY (ARRAY['instructor'::text, 'admin'::text, 'system'::text])))
);


--
-- Name: instructor_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructor_payouts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    camp_session_id uuid,
    stripe_destination_account_id text NOT NULL,
    amount_cents integer NOT NULL,
    session_confirmation_ids uuid[] NOT NULL,
    includes_distance_bonus boolean DEFAULT false NOT NULL,
    stripe_transfer_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_reason text,
    paid_by_user_id uuid,
    via_stripe boolean DEFAULT true NOT NULL,
    manual_payment_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    succeeded_at timestamp with time zone,
    program_id uuid,
    CONSTRAINT instructor_payouts_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT instructor_payouts_camp_xor_program_check CHECK (((camp_session_id IS NOT NULL) <> (program_id IS NOT NULL))),
    CONSTRAINT instructor_payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: TABLE instructor_payouts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.instructor_payouts IS 'One row per instructor pay attempt. Either Stripe Connect transfer (via_stripe=true) or manual record-keeping (via_stripe=false).';


--
-- Name: COLUMN instructor_payouts.instructor_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructor_payouts.instructor_id IS 'The EFFECTIVE instructor (sub or regular per resolver). NOT necessarily camp_assignments.instructor_id.';


--
-- Name: COLUMN instructor_payouts.session_confirmation_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructor_payouts.session_confirmation_ids IS 'IDs of session_delivery_confirmations this payout settled.';


--
-- Name: COLUMN instructor_payouts.via_stripe; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructor_payouts.via_stripe IS 'true = Stripe transfer attempted. false = paid outside Enrops; record-keeping only.';


--
-- Name: instructor_term_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructor_term_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    term text NOT NULL,
    available_days text[] DEFAULT '{}'::text[] NOT NULL,
    earliest_start time without time zone,
    latest_end time without time zone,
    unavailable_dates date[] DEFAULT '{}'::date[],
    max_days integer,
    location_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    needs_confirmation boolean DEFAULT false NOT NULL,
    submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instructor_term_availability_days_check CHECK ((available_days <@ ARRAY['mon'::text, 'tue'::text, 'wed'::text, 'thu'::text, 'fri'::text])),
    CONSTRAINT instructor_term_availability_max_days_check CHECK (((max_days IS NULL) OR ((max_days >= 1) AND (max_days <= 5))))
);


--
-- Name: instructors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instructors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    auth_user_id uuid,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    phone text,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contractor_tier text,
    onboarding_status text DEFAULT 'not_invited'::text,
    site_preferences jsonb DEFAULT '{}'::jsonb,
    availability jsonb DEFAULT '{}'::jsonb,
    first_aid_cpr_url text,
    first_aid_cpr_expires_at date,
    photo_url text,
    last_resend_requested_at timestamp with time zone,
    date_of_birth date,
    preferred_name text,
    shirt_size text,
    CONSTRAINT instructors_contractor_tier_check CHECK ((contractor_tier = ANY (ARRAY['lead'::text, 'developing'::text]))),
    CONSTRAINT instructors_onboarding_status_check CHECK ((onboarding_status = ANY (ARRAY['not_invited'::text, 'invited'::text, 'in_progress'::text, 'pending_background_check'::text, 'pending_stripe'::text, 'complete'::text, 'declined'::text, 'abandoned'::text]))),
    CONSTRAINT instructors_shirt_size_check CHECK (((shirt_size IS NULL) OR (shirt_size = ANY (ARRAY['XS'::text, 'S'::text, 'M'::text, 'L'::text, 'XL'::text, '2XL'::text, '3XL'::text]))))
);


--
-- Name: COLUMN instructors.date_of_birth; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructors.date_of_birth IS 'Optional. Used by the contractor onboarding wizard to detect minor instructors and route them to the schedule view instead of the onboarding flow. NULL = treated as adult (default).';


--
-- Name: COLUMN instructors.preferred_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructors.preferred_name IS 'Optional. What the instructor goes by (e.g., Rebecca → "Bo"). Display layers should render preferred_name ?? first_name. Legal documents and tax forms still use first_name + last_name.';


--
-- Name: COLUMN instructors.shirt_size; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.instructors.shirt_size IS 'Optional. Adult unisex t-shirt size for J2S apparel. One of XS, S, M, L, XL, 2XL, 3XL or NULL.';


--
-- Name: legal_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    document_key text NOT NULL,
    document_version text NOT NULL,
    title text NOT NULL,
    body_text text NOT NULL,
    effective_from date,
    replaced_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: marketing_campaign_touchpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_campaign_touchpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    type text NOT NULL,
    order_index integer DEFAULT 0 NOT NULL,
    scheduled_at timestamp with time zone,
    status text DEFAULT 'queued'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    topics text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sent_at timestamp with time zone,
    error_message text,
    CONSTRAINT marketing_campaign_touchpoints_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'skipped'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT marketing_campaign_touchpoints_type_check CHECK ((type = ANY (ARRAY['email'::text, 'flyer'::text, 'social'::text])))
);


--
-- Name: marketing_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    campaign_type text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    subject_template text,
    body_template text,
    audience_filter jsonb DEFAULT '{}'::jsonb,
    throttle_days integer DEFAULT 10 NOT NULL,
    wave text,
    scheduled_at timestamp with time zone,
    sent_at timestamp with time zone,
    total_recipients integer DEFAULT 0,
    total_sent integer DEFAULT 0,
    total_opened integer DEFAULT 0,
    total_clicked integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    template_data jsonb,
    draft_source text,
    draft_inputs jsonb,
    draft_model text,
    approved_at timestamp with time zone,
    approved_by uuid,
    approved_recipient_ids uuid[],
    CONSTRAINT marketing_campaigns_campaign_type_check CHECK ((campaign_type = ANY (ARRAY['fall_early_bird'::text, 'summer_geo'::text, 'vip_renewal'::text, 're_engagement'::text, 'custom'::text]))),
    CONSTRAINT marketing_campaigns_draft_source_check CHECK ((draft_source = ANY (ARRAY['manual'::text, 'ai_assisted'::text]))),
    CONSTRAINT marketing_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ready'::text, 'sending'::text, 'sent'::text, 'paused'::text])))
);


--
-- Name: TABLE marketing_campaigns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketing_campaigns IS 'Email campaigns with templates, audience filters, and send tracking. Multi-tenant.';


--
-- Name: COLUMN marketing_campaigns.template_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketing_campaigns.template_data IS 'Per-campaign rendering data: year_long_hook, fall_descriptions (by curriculum), school_list, soft_open_schools, school_name_aliases, soft_open_ps. Used by marketing-render-and-send edge function.';


--
-- Name: COLUMN marketing_campaigns.approved_recipient_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketing_campaigns.approved_recipient_ids IS 'List of marketing_recipients.id values captured at operator approve time. The cron passes this list to marketing-touchpoint-send for each scheduled touchpoint. Null until approved. Written exclusively by the approve flow.';


--
-- Name: marketing_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    parent_name text,
    phone text,
    child_first_name text,
    child_last_name text,
    school_name text,
    source text NOT NULL,
    source_term text,
    source_class text,
    city text,
    zip text,
    state text,
    geo_segment text,
    tags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    segments text[] DEFAULT '{}'::text[],
    CONSTRAINT marketing_recipients_source_check CHECK ((source = ANY (ARRAY['am_afterschool'::text, 'squarespace_summer'::text, 'enrops_registration'::text, 'manual'::text])))
);


--
-- Name: TABLE marketing_recipients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketing_recipients IS 'Consolidated parent contact list for marketing campaigns. One row per unique email+school+source. Multi-tenant.';


--
-- Name: marketing_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    campaign_id uuid NOT NULL,
    recipient_id uuid NOT NULL,
    email text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    resend_message_id text,
    rendered_subject text,
    sent_at timestamp with time zone,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    school_name text,
    error_message text,
    suppressed_by_throttle boolean DEFAULT false NOT NULL,
    touchpoint_id uuid,
    CONSTRAINT marketing_sends_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'opened'::text, 'clicked'::text, 'bounced'::text, 'failed'::text, 'throttled'::text])))
);


--
-- Name: TABLE marketing_sends; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketing_sends IS 'Per-email send log. Powers 10-day throttle and attribution. Multi-tenant.';


--
-- Name: COLUMN marketing_sends.touchpoint_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketing_sends.touchpoint_id IS 'Which touchpoint within the campaign this send corresponds to. NULL for legacy J2S FA26-launch sends (predates touchpoints). The dedup query in marketing-touchpoint-send keys on (campaign_id, touchpoint_id, recipient_id) so each touchpoint fires exactly once per recipient.';


--
-- Name: marketing_suppressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketing_suppressions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    suppressed_at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    reason text,
    user_agent text,
    ip_address text,
    CONSTRAINT marketing_suppressions_source_check CHECK ((source = ANY (ARRAY['email_reply'::text, 'one_click'::text, 'link_click'::text, 'manual'::text, 'complaint'::text])))
);


--
-- Name: TABLE marketing_suppressions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.marketing_suppressions IS 'Per-org email suppression list. Excluded from marketing-send. Populated by marketing-unsubscribe (link click + one-click) and manual inserts (email replies).';


--
-- Name: org_branding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_branding (
    organization_id uuid NOT NULL,
    logo_url text,
    favicon_url text,
    primary_color text DEFAULT '#691D39'::text,
    secondary_color text DEFAULT '#CFB12F'::text,
    accent_color text DEFAULT '#EAEADD'::text,
    heading_font text,
    body_font text,
    custom_css text,
    email_from_name text,
    email_reply_to text,
    updated_at timestamp with time zone DEFAULT now(),
    hero_headline text,
    hero_subtext text,
    banner_image_url text,
    extra_color text,
    page_bg_color text
);


--
-- Name: COLUMN org_branding.extra_color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_branding.extra_color IS 'Optional 4th brand color (e.g. a secondary accent). Used on flyers, registration pages, and any marketing surface where a 4th color helps.';


--
-- Name: COLUMN org_branding.page_bg_color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_branding.page_bg_color IS 'Page/email background color. Null = platform neutral default. Set this when the tenant wants their branded surfaces on a tinted background.';


--
-- Name: org_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    auth_user_id uuid NOT NULL,
    email text NOT NULL,
    name text,
    role text DEFAULT 'staff'::text,
    permissions jsonb DEFAULT '{}'::jsonb,
    invited_at timestamp with time zone,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT org_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'instructor'::text, 'viewer'::text])))
);


--
-- Name: org_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    policy_type text NOT NULL,
    content_markdown text NOT NULL,
    effective_date date NOT NULL,
    last_updated timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_policies_policy_type_check CHECK ((policy_type = ANY (ARRAY['privacy'::text, 'terms'::text, 'acceptable-use'::text, 'cookies'::text, 'data-retention'::text, 'subprocessors'::text, 'dpa'::text])))
);


--
-- Name: organization_google_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_google_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    google_email text NOT NULL,
    access_token_secret_id uuid NOT NULL,
    refresh_token_secret_id uuid NOT NULL,
    token_expires_at timestamp with time zone NOT NULL,
    scopes text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    legal_name text,
    email text,
    phone text,
    website text,
    stripe_account_id text,
    stripe_account_status text DEFAULT 'not_connected'::text,
    stripe_charges_enabled boolean DEFAULT false,
    stripe_payouts_enabled boolean DEFAULT false,
    platform_plan text DEFAULT 'pilot'::text,
    platform_fee_cents integer DEFAULT 0,
    platform_monthly_cents integer DEFAULT 0,
    status text DEFAULT 'active'::text,
    onboarded_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    logo_url text,
    location_grouping_label text,
    location_grouping_field text,
    alert_email text,
    logo_email_url text,
    default_sender_name text,
    default_sender_email text,
    sending_domain text,
    brand_voice jsonb DEFAULT '{}'::jsonb,
    email_throttle_days integer DEFAULT 10 NOT NULL,
    timezone text DEFAULT 'America/Los_Angeles'::text NOT NULL,
    pay_hourly_cents integer,
    pay_camp_morning_hours numeric(4,2),
    pay_camp_full_day_hours numeric(4,2),
    pay_camp_weekly_bonus_cents integer,
    apps_script_sync_secret text,
    platform_fee_card_pct numeric(5,4) DEFAULT 0.02 NOT NULL,
    platform_fee_ach_pct numeric(5,4) DEFAULT 0.005 NOT NULL,
    platform_fee_cap_cents integer DEFAULT 500 NOT NULL,
    fee_pass_through boolean DEFAULT true NOT NULL,
    statement_descriptor_suffix character varying(14),
    withdrawal_admin_fee_cents integer DEFAULT 0 NOT NULL,
    stripe_last_account_event_id text,
    stripe_business_type text,
    stripe_country text DEFAULT 'US'::text NOT NULL,
    instructor_pay_enabled boolean DEFAULT false NOT NULL,
    instructor_pay_model text DEFAULT 'enrops_platform'::text NOT NULL,
    sub_coordination_notes text DEFAULT ''::text NOT NULL,
    vip_offering jsonb DEFAULT '{"enabled": false}'::jsonb NOT NULL,
    auto_subscribe_registrants boolean DEFAULT true NOT NULL,
    CONSTRAINT chk_stripe_account_status CHECK ((stripe_account_status = ANY (ARRAY['not_connected'::text, 'onboarding'::text, 'active'::text, 'disconnected'::text, 'restricted'::text]))),
    CONSTRAINT organizations_email_throttle_days_check CHECK ((email_throttle_days >= 0)),
    CONSTRAINT organizations_instructor_pay_model_check CHECK ((instructor_pay_model = ANY (ARRAY['legacy_own_platform'::text, 'enrops_platform'::text]))),
    CONSTRAINT organizations_pay_camp_full_day_hours_check CHECK (((pay_camp_full_day_hours IS NULL) OR (pay_camp_full_day_hours > (0)::numeric))),
    CONSTRAINT organizations_pay_camp_morning_hours_check CHECK (((pay_camp_morning_hours IS NULL) OR (pay_camp_morning_hours > (0)::numeric))),
    CONSTRAINT organizations_pay_camp_weekly_bonus_cents_check CHECK (((pay_camp_weekly_bonus_cents IS NULL) OR (pay_camp_weekly_bonus_cents >= 0))),
    CONSTRAINT organizations_pay_hourly_cents_check CHECK (((pay_hourly_cents IS NULL) OR (pay_hourly_cents >= 0))),
    CONSTRAINT organizations_platform_fee_ach_pct_check CHECK (((platform_fee_ach_pct >= (0)::numeric) AND (platform_fee_ach_pct <= (1)::numeric))),
    CONSTRAINT organizations_platform_fee_cap_cents_check CHECK ((platform_fee_cap_cents >= 0)),
    CONSTRAINT organizations_platform_fee_card_pct_check CHECK (((platform_fee_card_pct >= (0)::numeric) AND (platform_fee_card_pct <= (1)::numeric))),
    CONSTRAINT organizations_platform_plan_check CHECK ((platform_plan = ANY (ARRAY['pilot'::text, 'free'::text, 'flat_monthly'::text, 'per_registration'::text, 'hybrid'::text, 'enterprise'::text]))),
    CONSTRAINT organizations_statement_descriptor_suffix_check CHECK (((statement_descriptor_suffix IS NULL) OR (((char_length((statement_descriptor_suffix)::text) >= 3) AND (char_length((statement_descriptor_suffix)::text) <= 14)) AND ((statement_descriptor_suffix)::text ~ '^[A-Z0-9 .,\-]+$'::text)))),
    CONSTRAINT organizations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'archived'::text]))),
    CONSTRAINT organizations_stripe_business_type_check CHECK (((stripe_business_type IS NULL) OR (stripe_business_type = ANY (ARRAY['company'::text, 'individual'::text, 'non_profit'::text, 'government_entity'::text])))),
    CONSTRAINT organizations_stripe_country_check CHECK (((char_length(stripe_country) = 2) AND (stripe_country = upper(stripe_country)))),
    CONSTRAINT organizations_withdrawal_admin_fee_cents_check CHECK ((withdrawal_admin_fee_cents >= 0))
);


--
-- Name: COLUMN organizations.logo_email_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.logo_email_url IS 'Email-safe rasterized PNG of the logo. Generated by the regenerate-email-logo edge function from logo_url. Email templates should prefer this column.';


--
-- Name: COLUMN organizations.pay_hourly_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.pay_hourly_cents IS 'Base hourly rate for instructor pay, in cents. e.g. 2000 = $20/hr.';


--
-- Name: COLUMN organizations.pay_camp_morning_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.pay_camp_morning_hours IS 'Hours logged per morning/afternoon (half-day) camp session.';


--
-- Name: COLUMN organizations.pay_camp_full_day_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.pay_camp_full_day_hours IS 'Hours logged per full-day camp session.';


--
-- Name: COLUMN organizations.pay_camp_weekly_bonus_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.pay_camp_weekly_bonus_cents IS 'One-time bonus paid when all weekdays of a camp are confirmed taught.';


--
-- Name: COLUMN organizations.apps_script_sync_secret; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.apps_script_sync_secret IS 'Per-tenant opaque secret. Apps Script in tenant Google account presents this to apps-script-roster-sync edge function to authenticate inbound sync calls. NULL = no Apps Script integration configured.';


--
-- Name: COLUMN organizations.platform_fee_card_pct; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.platform_fee_card_pct IS 'Stripe Connect platform fee rate on card charges, fraction (0.02 = 2%). LOCKED to platform admins.';


--
-- Name: COLUMN organizations.platform_fee_ach_pct; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.platform_fee_ach_pct IS 'Stripe Connect platform fee rate on ACH charges, fraction (0.005 = 0.5%). LOCKED to platform admins. ACH not yet accepted; column is forward-looking.';


--
-- Name: COLUMN organizations.platform_fee_cap_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.platform_fee_cap_cents IS 'Max Stripe Connect platform fee per transaction in cents (500 = $5). LOCKED to platform admins.';


--
-- Name: COLUMN organizations.fee_pass_through; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.fee_pass_through IS 'true = parent pays base + fee at checkout. false = org absorbs fee. Editable by org owner/admin via Finances tab toggle.';


--
-- Name: COLUMN organizations.statement_descriptor_suffix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.statement_descriptor_suffix IS 'Operator name appended to platform descriptor "ENROPS" on parent bank statements. Up to 14 chars.';


--
-- Name: COLUMN organizations.withdrawal_admin_fee_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.withdrawal_admin_fee_cents IS 'Per-tenant suggested admin fee (cents) for parent withdrawals. Quick-fill button on refund drawer.';


--
-- Name: COLUMN organizations.stripe_last_account_event_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.stripe_last_account_event_id IS 'Webhook idempotency token. Most recent account.* event ID we processed for this org.';


--
-- Name: COLUMN organizations.stripe_business_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.stripe_business_type IS 'Stripe Express account business_type. NULL = let Stripe ask. Captured pre-Connect.';


--
-- Name: COLUMN organizations.stripe_country; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.stripe_country IS 'ISO 3166-1 alpha-2 (uppercase). Required by Stripe at Express account create. Default US.';


--
-- Name: COLUMN organizations.instructor_pay_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.instructor_pay_enabled IS 'Circuit breaker for integrated Stripe Connect instructor pay. Manual mark-paid path is always available regardless of this flag.';


--
-- Name: COLUMN organizations.instructor_pay_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.instructor_pay_model IS 'Routing key for instructor pay architecture. ''enrops_platform'' (default, self-serve): instructors are Express accounts under Enrops''s Stripe Connect platform; pay routes via stripe.transfers.create acting on operator''s connected account. ''legacy_own_platform'' (J2S only): operator owns their own Stripe Connect platform; STRIPE_INSTRUCTOR_PLATFORM_KEY env points to it; pay routes via that platform''s balance. LOCKED to platform admins via guard_organizations_locked_columns trigger — flipping orphans existing instructor accounts.';


--
-- Name: COLUMN organizations.vip_offering; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.vip_offering IS 'Single source of truth for tenant''s VIP/annual-pass offering. Read by Ennie''s draft pass + token resolver. Shape: {enabled, label, price_cents, description, excluded_location_ids[]}';


--
-- Name: COLUMN organizations.auto_subscribe_registrants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.organizations.auto_subscribe_registrants IS 'When true (default), confirmed registrations auto-upsert into marketing_recipients via the auto_add_registrant_to_marketing_list() trigger. Every email has an unsubscribe link, so this is CAN-SPAM compliant. Set false for stricter-consent jurisdictions.';


--
-- Name: parent_org_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parent_org_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    first_registered_at timestamp with time zone DEFAULT now(),
    how_heard text,
    referred_by text,
    vip_status text DEFAULT 'none'::text,
    vip_enrolled_at timestamp with time zone,
    lifetime_value_cents integer DEFAULT 0,
    total_registrations integer DEFAULT 0,
    email_opt_in boolean DEFAULT true,
    sms_opt_in boolean DEFAULT false,
    notes text,
    is_flagged boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT parent_org_relationships_vip_status_check CHECK ((vip_status = ANY (ARRAY['none'::text, 'returning'::text, 'new'::text, 'active'::text])))
);


--
-- Name: partner_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    partner_id uuid NOT NULL,
    contact_name text,
    contact_email public.citext,
    contact_phone text,
    contact_role text,
    send_flyers text DEFAULT 'unknown'::text NOT NULL,
    is_org_inbox boolean DEFAULT false NOT NULL,
    role_description text,
    locations_scope text,
    marketing_notes text,
    source text,
    discrepancy_flag text,
    last_verified date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT partner_contacts_contact_role_check CHECK ((contact_role = ANY (ARRAY['operational'::text, 'marketing'::text, 'invoicing'::text, 'approval_gatekeeper'::text]))),
    CONSTRAINT partner_contacts_send_flyers_check CHECK ((send_flyers = ANY (ARRAY['yes'::text, 'no'::text, 'approval_only'::text, 'unknown'::text])))
);


--
-- Name: partners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    partner_name text NOT NULL,
    partner_type text,
    location_area text,
    flyer_distribution text DEFAULT 'unknown'::text NOT NULL,
    flyer_process_notes text,
    locations_managed text,
    marketing_notes text,
    invoicing_notes text,
    proposal_due_dates text,
    guide_release_dates text,
    planning_notes text,
    implementation_notes text,
    other_notes text,
    inactive boolean DEFAULT false NOT NULL,
    inactive_reason text,
    source text,
    discrepancy_flag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT partners_flyer_distribution_check CHECK ((flyer_distribution = ANY (ARRAY['direct'::text, 'approval_required'::text, 'peachjar'::text, 'declined'::text, 'unknown'::text]))),
    CONSTRAINT partners_partner_type_check CHECK ((partner_type = ANY (ARRAY['school_district'::text, 'public_school'::text, 'private_school'::text, 'charter_school'::text, 'parks_rec'::text, 'community_org'::text, 'church'::text])))
);


--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    auth_user_id uuid NOT NULL,
    email text NOT NULL,
    name text,
    role text DEFAULT 'admin'::text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT platform_admins_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'superadmin'::text])))
);


--
-- Name: pricing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    rule_type text NOT NULL,
    applies_to text DEFAULT 'all'::text,
    applies_to_value text,
    percent_off numeric(5,2),
    cents_off integer,
    fixed_price_cents integer,
    active_from date,
    active_until date,
    min_children integer DEFAULT 1,
    requires_code text,
    is_stackable boolean DEFAULT false,
    priority integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT pricing_rules_applies_to_check CHECK ((applies_to = ANY (ARRAY['all'::text, 'tier'::text, 'program'::text, 'enrollment_type'::text]))),
    CONSTRAINT pricing_rules_rule_type_check CHECK ((rule_type = ANY (ARRAY['base_price'::text, 'early_bird'::text, 'sibling_discount'::text, 'bulk_discount'::text, 'enrollment_type'::text, 'promo_code'::text, 'custom'::text])))
);


--
-- Name: program_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.program_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    program_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    instructor_response_at timestamp with time zone,
    decline_reason text,
    change_request_message text,
    admin_response_message text,
    deadline date,
    email_sent_at timestamp with time zone,
    email_viewed_at timestamp with time zone,
    reminder_sent_at timestamp with time zone,
    distance_bonus_cents integer,
    distance_bonus_paid_at timestamp with time zone,
    distance_bonus_payout_id uuid,
    flagged_reason text,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT program_assignments_role_check CHECK ((role = ANY (ARRAY['lead'::text, 'developing'::text]))),
    CONSTRAINT program_assignments_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'confirmed'::text, 'change_requested'::text, 'published'::text, 'withdrawn'::text, 'declined'::text])))
);


--
-- Name: program_curriculum_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.program_curriculum_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    program_id uuid NOT NULL,
    changed_by_user_id uuid,
    from_curriculum_id uuid,
    from_curriculum_name text,
    to_curriculum_id uuid NOT NULL,
    to_curriculum_name text NOT NULL,
    family_notify_choice text NOT NULL,
    instructor_notify_choice text NOT NULL,
    family_recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    family_sent_count integer DEFAULT 0 NOT NULL,
    family_failed_count integer DEFAULT 0 NOT NULL,
    instructor_recipient jsonb,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT program_curriculum_changes_family_notify_choice_check CHECK ((family_notify_choice = ANY (ARRAY['sent'::text, 'skipped'::text, 'no_recipients'::text]))),
    CONSTRAINT program_curriculum_changes_instructor_notify_choice_check CHECK ((instructor_notify_choice = ANY (ARRAY['sent'::text, 'skipped'::text, 'no_recipient'::text])))
);


--
-- Name: TABLE program_curriculum_changes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.program_curriculum_changes IS 'Audit of curriculum swaps on scheduled programs. One row per EditProgramCurriculumModal save, including notification fan-out results.';


--
-- Name: COLUMN program_curriculum_changes.from_curriculum_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_curriculum_changes.from_curriculum_name IS 'Snapshot of curricula.name at change time. Reads truthfully even if curricula row is later renamed or deleted.';


--
-- Name: COLUMN program_curriculum_changes.family_recipients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_curriculum_changes.family_recipients IS 'Per-parent send results. Each item: { parent_id, name, email, resend_message_id, status, failure_reason }.';


--
-- Name: COLUMN program_curriculum_changes.instructor_recipient; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.program_curriculum_changes.instructor_recipient IS 'Single instructor send result, or NULL when skipped/no eligible instructor.';


--
-- Name: program_enrollment; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.program_enrollment AS
 SELECT p.id AS program_id,
    p.curriculum,
    pl.name AS program_location_name,
    pl.name AS school_name,
    p.day_of_week,
    p.max_capacity,
    count(r.id) FILTER (WHERE (r.status = ANY (ARRAY['confirmed'::text, 'pending'::text]))) AS enrolled,
    (p.max_capacity - count(r.id) FILTER (WHERE (r.status = ANY (ARRAY['confirmed'::text, 'pending'::text])))) AS spots_remaining
   FROM ((public.programs p
     JOIN public.program_locations pl ON ((p.program_location_id = pl.id)))
     LEFT JOIN public.registrations r ON ((r.program_id = p.id)))
  GROUP BY p.id, p.curriculum, pl.name, p.day_of_week, p.max_capacity;


--
-- Name: VIEW program_enrollment; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.program_enrollment IS 'Public aggregate counts (max_capacity, enrolled, spots_remaining) for parent-facing "spots available" UI. SECURITY DEFINER is intentional — bypasses RLS on registrations to compute accurate counts. Returns NO PII. Anon has SELECT only; modify privileges revoked.';


--
-- Name: program_fit_texts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.program_fit_texts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    body_text text NOT NULL,
    is_default boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: promo_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    discount_type text NOT NULL,
    discount_value numeric NOT NULL,
    active boolean DEFAULT true,
    max_uses integer,
    used_count integer DEFAULT 0,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    organization_id uuid,
    scope_program_ids uuid[],
    starts_at timestamp with time zone,
    stripe_coupon_id text,
    created_by uuid,
    CONSTRAINT promo_codes_discount_type_check CHECK ((discount_type = ANY (ARRAY['percent'::text, 'fixed'::text])))
);


--
-- Name: refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registration_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    stripe_payment_intent_id text NOT NULL,
    stripe_refund_id text,
    amount_cents integer NOT NULL,
    reason text,
    refunded_by_user_id uuid,
    cancelled_registration boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    succeeded_at timestamp with time zone,
    CONSTRAINT refunds_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text])))
);


--
-- Name: TABLE refunds; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.refunds IS 'One row per refund event. Multiple partial refunds against one registration stack as multiple rows. Total refunded = SUM(amount_cents) WHERE status=succeeded.';


--
-- Name: COLUMN refunds.stripe_payment_intent_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.refunds.stripe_payment_intent_id IS 'The PI being refunded against. For partial refunds we pick the most recently paid PI first.';


--
-- Name: COLUMN refunds.stripe_refund_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.refunds.stripe_refund_id IS 'Stripe re_... ID. NULL until status flips to succeeded.';


--
-- Name: COLUMN refunds.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.refunds.reason IS 'Operator-supplied internal note. Not sent to parent; Stripe sends its own automatic refund email.';


--
-- Name: COLUMN refunds.cancelled_registration; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.refunds.cancelled_registration IS 'true = this refund also cancelled the registration and stopped future installments.';


--
-- Name: roster_email_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roster_email_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    camp_session_id uuid NOT NULL,
    partner_id uuid,
    sent_by_user_id uuid,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    message text,
    resend_message_id text,
    status text DEFAULT 'sent'::text NOT NULL,
    failure_reason text,
    roster_camper_count integer DEFAULT 0 NOT NULL,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT roster_email_sends_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text])))
);


--
-- Name: TABLE roster_email_sends; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.roster_email_sends IS 'Audit of camp roster emails sent to partner logistics contacts.';


--
-- Name: COLUMN roster_email_sends.recipients; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.roster_email_sends.recipients IS 'Snapshot of recipients at send time. Each item: { name, email, role, source }.';


--
-- Name: COLUMN roster_email_sends.resend_message_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.roster_email_sends.resend_message_id IS 'Resend API message id, for tracing deliveries in Resend dashboard.';


--
-- Name: COLUMN roster_email_sends.roster_camper_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.roster_email_sends.roster_camper_count IS 'Camper count baked into the PDF at send time. Useful to spot stale-roster sends.';


--
-- Name: scheduling_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduling_cycles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name text NOT NULL,
    cycle_type text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    weeks jsonb DEFAULT '[]'::jsonb NOT NULL,
    survey_deadline timestamp with time zone,
    status text DEFAULT 'collecting'::text NOT NULL,
    dev_instructor_threshold integer DEFAULT 12 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_reminders_enabled boolean DEFAULT true NOT NULL,
    availability_survey_opened_at timestamp with time zone,
    CONSTRAINT scheduling_cycles_cycle_type_check CHECK ((cycle_type = ANY (ARRAY['summer_camp'::text, 'afterschool'::text]))),
    CONSTRAINT scheduling_cycles_status_check CHECK ((status = ANY (ARRAY['collecting'::text, 'scheduling'::text, 'published'::text, 'closed'::text])))
);


--
-- Name: COLUMN scheduling_cycles.availability_survey_opened_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.scheduling_cycles.availability_survey_opened_at IS 'When the admin released the availability survey to instructors. NULL = not yet released; banner stays hidden in instructor portal. Set by the Open Survey action in Schedule.';


--
-- Name: session_declined_instructors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_declined_instructors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    cycle_id uuid NOT NULL,
    camp_session_id uuid NOT NULL,
    instructor_id uuid NOT NULL,
    reason text DEFAULT 'change_request'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_delivery_confirmations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_delivery_confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    instructor_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    camp_session_id uuid,
    program_id uuid,
    session_date date NOT NULL,
    session_type text NOT NULL,
    confirmed_by text DEFAULT 'pending'::text NOT NULL,
    confirmed_at timestamp with time zone,
    admin_override boolean DEFAULT false,
    admin_override_by uuid,
    admin_override_reason text,
    admin_override_at timestamp with time zone,
    pay_status text DEFAULT 'pending'::text NOT NULL,
    pay_amount_cents integer,
    pay_adjustment_cents integer DEFAULT 0,
    pay_adjustment_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    instructor_payout_id uuid,
    CONSTRAINT one_session_reference CHECK ((((camp_session_id IS NOT NULL) AND (program_id IS NULL)) OR ((camp_session_id IS NULL) AND (program_id IS NOT NULL)))),
    CONSTRAINT session_delivery_confirmations_confirmed_by_check CHECK ((confirmed_by = ANY (ARRAY['pending'::text, 'self'::text, 'auto'::text, 'admin'::text]))),
    CONSTRAINT session_delivery_confirmations_pay_amount_cents_check CHECK ((pay_amount_cents >= 0)),
    CONSTRAINT session_delivery_confirmations_pay_status_check CHECK ((pay_status = ANY (ARRAY['pending'::text, 'approved'::text, 'adjusted'::text, 'withheld'::text, 'paid'::text]))),
    CONSTRAINT session_delivery_confirmations_session_type_check CHECK ((session_type = ANY (ARRAY['full_day'::text, 'morning'::text, 'afternoon'::text, 'after_school'::text])))
);


--
-- Name: COLUMN session_delivery_confirmations.instructor_payout_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.session_delivery_confirmations.instructor_payout_id IS 'When non-NULL, this confirmation has been settled by the linked payout. Canonical paid artifact.';


--
-- Name: time_saved_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_saved_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    action_type text NOT NULL,
    action_label text NOT NULL,
    hours_saved numeric(6,2) NOT NULL,
    related_entity_type text,
    related_entity_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT time_saved_events_hours_saved_check CHECK ((hours_saved > (0)::numeric))
);


--
-- Name: v_effective_pay_lines; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_effective_pay_lines AS
 SELECT c.id AS confirmation_id,
    c.organization_id,
    c.camp_session_id,
    c.program_id,
    c.session_date,
    c.session_type,
    c.confirmed_by,
    c.confirmed_at,
    c.pay_status,
    c.pay_amount_cents,
    c.pay_adjustment_cents,
    c.pay_adjustment_reason,
    c.instructor_payout_id,
    c.created_at AS confirmation_created_at,
    c.instructor_id AS original_instructor_id,
    COALESCE(sub.sub_instructor_id, c.instructor_id) AS effective_instructor_id,
    COALESCE(sub.sub_tier, i.contractor_tier) AS effective_tier,
        CASE
            WHEN (sub.sub_instructor_id IS NOT NULL) THEN 'sub'::text
            ELSE 'regular'::text
        END AS source,
        CASE
            WHEN (sub.sub_instructor_id IS NULL) THEN ca.distance_bonus_cents
            ELSE NULL::integer
        END AS distance_bonus_cents_if_regular,
    ca.id AS camp_assignment_id,
    ca.status AS camp_assignment_status,
    NULL::uuid AS program_assignment_id,
    NULL::text AS program_assignment_status,
    ca.distance_bonus_paid_at,
    ca.distance_bonus_payout_id
   FROM (((public.session_delivery_confirmations c
     JOIN public.instructors i ON ((i.id = c.instructor_id)))
     LEFT JOIN public.camp_assignments ca ON (((ca.instructor_id = c.instructor_id) AND (ca.camp_session_id = c.camp_session_id))))
     LEFT JOIN public.assignment_substitutions sub ON (((sub.parent_assignment_id = ca.id) AND (sub.parent_assignment_type = 'camp'::text) AND (sub.date = c.session_date))))
  WHERE (c.camp_session_id IS NOT NULL)
UNION ALL
 SELECT c.id AS confirmation_id,
    c.organization_id,
    c.camp_session_id,
    c.program_id,
    c.session_date,
    c.session_type,
    c.confirmed_by,
    c.confirmed_at,
    c.pay_status,
    c.pay_amount_cents,
    c.pay_adjustment_cents,
    c.pay_adjustment_reason,
    c.instructor_payout_id,
    c.created_at AS confirmation_created_at,
    c.instructor_id AS original_instructor_id,
    COALESCE(sub.sub_instructor_id, c.instructor_id) AS effective_instructor_id,
    COALESCE(sub.sub_tier, i.contractor_tier) AS effective_tier,
        CASE
            WHEN (sub.sub_instructor_id IS NOT NULL) THEN 'sub'::text
            ELSE 'regular'::text
        END AS source,
        CASE
            WHEN (sub.sub_instructor_id IS NULL) THEN pa.distance_bonus_cents
            ELSE NULL::integer
        END AS distance_bonus_cents_if_regular,
    NULL::uuid AS camp_assignment_id,
    NULL::text AS camp_assignment_status,
    pa.id AS program_assignment_id,
    pa.status AS program_assignment_status,
    pa.distance_bonus_paid_at,
    pa.distance_bonus_payout_id
   FROM (((public.session_delivery_confirmations c
     JOIN public.instructors i ON ((i.id = c.instructor_id)))
     LEFT JOIN public.program_assignments pa ON (((pa.instructor_id = c.instructor_id) AND (pa.program_id = c.program_id))))
     LEFT JOIN public.assignment_substitutions sub ON (((sub.parent_assignment_id = pa.id) AND (sub.parent_assignment_type = 'program'::text) AND (sub.date = c.session_date))))
  WHERE (c.program_id IS NOT NULL);


--
-- Name: VIEW v_effective_pay_lines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_effective_pay_lines IS 'Canonical pay-line view: one row per session_delivery_confirmation with effective_instructor_id, effective_tier, source (regular | sub), distance_bonus_cents_if_regular. Camp rows expose camp_assignment_id/_status; program rows expose program_assignment_id/_status (the other set is NULL). Read by Payroll page + pay-instructor edge fn. Substitutions table is now real — sub rows route pay to sub_instructor_id automatically.';


--
-- Name: venue_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.venue_regions (
    organization_id uuid NOT NULL,
    location_name text NOT NULL,
    region_name text NOT NULL
);


--
-- Name: waiver_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waiver_signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    registration_id uuid,
    waiver_id uuid,
    parent_id uuid,
    signed_at timestamp with time zone DEFAULT now(),
    ip_address text,
    signature_text text,
    organization_id uuid,
    waiver_text_snapshot text,
    waiver_version integer DEFAULT 1,
    user_agent text
);


--
-- Name: waivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    content text NOT NULL,
    required boolean DEFAULT true,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    organization_id uuid,
    version integer DEFAULT 1,
    requires_signature boolean DEFAULT true,
    requires_initials boolean DEFAULT false,
    effective_from date DEFAULT CURRENT_DATE,
    replaced_by uuid,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: enrollment_events enrollment_events_pkey; Type: CONSTRAINT; Schema: intelligence; Owner: -
--

ALTER TABLE ONLY intelligence.enrollment_events
    ADD CONSTRAINT enrollment_events_pkey PRIMARY KEY (id);


--
-- Name: afterschool_survey_state afterschool_survey_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afterschool_survey_state
    ADD CONSTRAINT afterschool_survey_state_pkey PRIMARY KEY (id);


--
-- Name: afterschool_survey_state afterschool_survey_state_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afterschool_survey_state
    ADD CONSTRAINT afterschool_survey_state_unique UNIQUE (organization_id, term);


--
-- Name: assignment_substitutions assignment_substitutions_parent_assignment_id_parent_assign_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_substitutions
    ADD CONSTRAINT assignment_substitutions_parent_assignment_id_parent_assign_key UNIQUE (parent_assignment_id, parent_assignment_type, date);


--
-- Name: assignment_substitutions assignment_substitutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_substitutions
    ADD CONSTRAINT assignment_substitutions_pkey PRIMARY KEY (id);


--
-- Name: automation_edits automation_edits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_edits
    ADD CONSTRAINT automation_edits_pkey PRIMARY KEY (id);


--
-- Name: automation_run_recipients automation_run_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_run_recipients
    ADD CONSTRAINT automation_run_recipients_pkey PRIMARY KEY (id);


--
-- Name: automation_run_recipients automation_run_recipients_unique_send; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_run_recipients
    ADD CONSTRAINT automation_run_recipients_unique_send UNIQUE (automation_id, context_key);


--
-- Name: automation_runs automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_pkey PRIMARY KEY (id);


--
-- Name: automation_templates automation_templates_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_templates
    ADD CONSTRAINT automation_templates_key_key UNIQUE (key);


--
-- Name: automation_templates automation_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_templates
    ADD CONSTRAINT automation_templates_pkey PRIMARY KEY (id);


--
-- Name: automations automations_one_per_org_per_template; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_one_per_org_per_template UNIQUE (organization_id, template_id);


--
-- Name: automations automations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_pkey PRIMARY KEY (id);


--
-- Name: available_fonts available_fonts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.available_fonts
    ADD CONSTRAINT available_fonts_pkey PRIMARY KEY (name);


--
-- Name: camp_assignments camp_assignments_camp_session_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_camp_session_id_role_key UNIQUE (camp_session_id, role);


--
-- Name: camp_assignments camp_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_pkey PRIMARY KEY (id);


--
-- Name: camp_sessions camp_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_pkey PRIMARY KEY (id);


--
-- Name: capability_definitions capability_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_definitions
    ADD CONSTRAINT capability_definitions_pkey PRIMARY KEY (id);


--
-- Name: capability_definitions capability_definitions_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_definitions
    ADD CONSTRAINT capability_definitions_slug_key UNIQUE (slug);


--
-- Name: capability_unlock_states capability_unlock_states_organization_id_capability_id_scop_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_unlock_states
    ADD CONSTRAINT capability_unlock_states_organization_id_capability_id_scop_key UNIQUE (organization_id, capability_id, scoped_entity_type, scoped_entity_id);


--
-- Name: capability_unlock_states capability_unlock_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_unlock_states
    ADD CONSTRAINT capability_unlock_states_pkey PRIMARY KEY (id);


--
-- Name: checkout_schedules checkout_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkout_schedules
    ADD CONSTRAINT checkout_schedules_pkey PRIMARY KEY (id);


--
-- Name: checkout_schedules checkout_schedules_stripe_session_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkout_schedules
    ADD CONSTRAINT checkout_schedules_stripe_session_id_key UNIQUE (stripe_session_id);


--
-- Name: contractor_acknowledgments contractor_acknowledgments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_acknowledgments
    ADD CONSTRAINT contractor_acknowledgments_pkey PRIMARY KEY (id);


--
-- Name: contractor_agreements contractor_agreements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_agreements
    ADD CONSTRAINT contractor_agreements_pkey PRIMARY KEY (id);


--
-- Name: contractor_emergency_contacts contractor_emergency_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_emergency_contacts
    ADD CONSTRAINT contractor_emergency_contacts_pkey PRIMARY KEY (id);


--
-- Name: contractor_onboarding_status contractor_onboarding_status_instructor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_onboarding_status
    ADD CONSTRAINT contractor_onboarding_status_instructor_id_key UNIQUE (instructor_id);


--
-- Name: contractor_onboarding_status contractor_onboarding_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_onboarding_status
    ADD CONSTRAINT contractor_onboarding_status_pkey PRIMARY KEY (id);


--
-- Name: contractor_onboarding_status contractor_onboarding_status_stripe_connect_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_onboarding_status
    ADD CONSTRAINT contractor_onboarding_status_stripe_connect_account_id_key UNIQUE (stripe_connect_account_id);


--
-- Name: contractor_ors_certification contractor_ors_certification_instructor_id_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_ors_certification
    ADD CONSTRAINT contractor_ors_certification_instructor_id_organization_id_key UNIQUE (instructor_id, organization_id);


--
-- Name: contractor_ors_certification contractor_ors_certification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_ors_certification
    ADD CONSTRAINT contractor_ors_certification_pkey PRIMARY KEY (id);


--
-- Name: curricula curricula_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curricula
    ADD CONSTRAINT curricula_pkey PRIMARY KEY (id);


--
-- Name: curriculum_documents curriculum_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_documents
    ADD CONSTRAINT curriculum_documents_pkey PRIMARY KEY (id);


--
-- Name: curriculum_extracted_fields curriculum_extracted_fields_curriculum_id_field_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_extracted_fields
    ADD CONSTRAINT curriculum_extracted_fields_curriculum_id_field_name_key UNIQUE (curriculum_id, field_name);


--
-- Name: curriculum_extracted_fields curriculum_extracted_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_extracted_fields
    ADD CONSTRAINT curriculum_extracted_fields_pkey PRIMARY KEY (id);


--
-- Name: curriculum_sessions curriculum_sessions_curriculum_id_session_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_sessions
    ADD CONSTRAINT curriculum_sessions_curriculum_id_session_number_key UNIQUE (curriculum_id, session_number);


--
-- Name: curriculum_sessions curriculum_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_sessions
    ADD CONSTRAINT curriculum_sessions_pkey PRIMARY KEY (id);


--
-- Name: custom_reg_fields custom_reg_fields_organization_id_field_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_reg_fields
    ADD CONSTRAINT custom_reg_fields_organization_id_field_key_key UNIQUE (organization_id, field_key);


--
-- Name: custom_reg_fields custom_reg_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_reg_fields
    ADD CONSTRAINT custom_reg_fields_pkey PRIMARY KEY (id);


--
-- Name: district_calendars district_calendars_organization_id_district_school_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_calendars
    ADD CONSTRAINT district_calendars_organization_id_district_school_year_key UNIQUE (organization_id, district, school_year);


--
-- Name: district_calendars district_calendars_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_calendars
    ADD CONSTRAINT district_calendars_pkey PRIMARY KEY (id);


--
-- Name: enrollment_types enrollment_types_organization_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_types
    ADD CONSTRAINT enrollment_types_organization_id_code_key UNIQUE (organization_id, code);


--
-- Name: enrollment_types enrollment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_types
    ADD CONSTRAINT enrollment_types_pkey PRIMARY KEY (id);


--
-- Name: installment_plans installment_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installment_plans
    ADD CONSTRAINT installment_plans_pkey PRIMARY KEY (id);


--
-- Name: installments installments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installments
    ADD CONSTRAINT installments_pkey PRIMARY KEY (id);


--
-- Name: instructor_availability instructor_availability_cycle_id_instructor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_availability
    ADD CONSTRAINT instructor_availability_cycle_id_instructor_id_key UNIQUE (cycle_id, instructor_id);


--
-- Name: instructor_availability instructor_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_availability
    ADD CONSTRAINT instructor_availability_pkey PRIMARY KEY (id);


--
-- Name: instructor_curriculum_preferences instructor_curriculum_prefere_cycle_id_instructor_id_curric_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_curriculum_preferences
    ADD CONSTRAINT instructor_curriculum_prefere_cycle_id_instructor_id_curric_key UNIQUE (cycle_id, instructor_id, curriculum_category);


--
-- Name: instructor_curriculum_preferences instructor_curriculum_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_curriculum_preferences
    ADD CONSTRAINT instructor_curriculum_preferences_pkey PRIMARY KEY (id);


--
-- Name: instructor_location_preferences instructor_location_preferenc_cycle_id_instructor_id_locati_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_location_preferences
    ADD CONSTRAINT instructor_location_preferenc_cycle_id_instructor_id_locati_key UNIQUE (cycle_id, instructor_id, location_name);


--
-- Name: instructor_location_preferences instructor_location_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_location_preferences
    ADD CONSTRAINT instructor_location_preferences_pkey PRIMARY KEY (id);


--
-- Name: instructor_offer_messages instructor_offer_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_offer_messages
    ADD CONSTRAINT instructor_offer_messages_pkey PRIMARY KEY (id);


--
-- Name: instructor_payouts instructor_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_pkey PRIMARY KEY (id);


--
-- Name: instructor_payouts instructor_payouts_stripe_transfer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_stripe_transfer_id_key UNIQUE (stripe_transfer_id);


--
-- Name: instructor_term_availability instructor_term_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_term_availability
    ADD CONSTRAINT instructor_term_availability_pkey PRIMARY KEY (id);


--
-- Name: instructor_term_availability instructor_term_availability_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_term_availability
    ADD CONSTRAINT instructor_term_availability_unique UNIQUE (organization_id, instructor_id, term);


--
-- Name: instructors instructors_organization_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_organization_id_email_key UNIQUE (organization_id, email);


--
-- Name: instructors instructors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_pkey PRIMARY KEY (id);


--
-- Name: legal_documents legal_documents_organization_id_document_key_document_versi_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_documents
    ADD CONSTRAINT legal_documents_organization_id_document_key_document_versi_key UNIQUE (organization_id, document_key, document_version);


--
-- Name: legal_documents legal_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_documents
    ADD CONSTRAINT legal_documents_pkey PRIMARY KEY (id);


--
-- Name: marketing_campaign_touchpoints marketing_campaign_touchpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_campaign_touchpoints
    ADD CONSTRAINT marketing_campaign_touchpoints_pkey PRIMARY KEY (id);


--
-- Name: marketing_campaigns marketing_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_campaigns
    ADD CONSTRAINT marketing_campaigns_pkey PRIMARY KEY (id);


--
-- Name: marketing_recipients marketing_recipients_organization_id_email_school_name_sour_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_recipients
    ADD CONSTRAINT marketing_recipients_organization_id_email_school_name_sour_key UNIQUE (organization_id, email, school_name, source);


--
-- Name: marketing_recipients marketing_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_recipients
    ADD CONSTRAINT marketing_recipients_pkey PRIMARY KEY (id);


--
-- Name: marketing_sends marketing_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sends
    ADD CONSTRAINT marketing_sends_pkey PRIMARY KEY (id);


--
-- Name: marketing_suppressions marketing_suppressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_suppressions
    ADD CONSTRAINT marketing_suppressions_pkey PRIMARY KEY (id);


--
-- Name: org_branding org_branding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_branding
    ADD CONSTRAINT org_branding_pkey PRIMARY KEY (organization_id);


--
-- Name: org_members org_members_organization_id_auth_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_organization_id_auth_user_id_key UNIQUE (organization_id, auth_user_id);


--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (id);


--
-- Name: org_policies org_policies_organization_id_policy_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_policies
    ADD CONSTRAINT org_policies_organization_id_policy_type_key UNIQUE (organization_id, policy_type);


--
-- Name: org_policies org_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_policies
    ADD CONSTRAINT org_policies_pkey PRIMARY KEY (id);


--
-- Name: organization_google_tokens organization_google_tokens_organization_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_google_tokens
    ADD CONSTRAINT organization_google_tokens_organization_id_user_id_key UNIQUE (organization_id, user_id);


--
-- Name: organization_google_tokens organization_google_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_google_tokens
    ADD CONSTRAINT organization_google_tokens_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_apps_script_sync_secret_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_apps_script_sync_secret_key UNIQUE (apps_script_sync_secret);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);


--
-- Name: parent_org_relationships parent_org_relationships_parent_id_organization_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_org_relationships
    ADD CONSTRAINT parent_org_relationships_parent_id_organization_id_key UNIQUE (parent_id, organization_id);


--
-- Name: parent_org_relationships parent_org_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_org_relationships
    ADD CONSTRAINT parent_org_relationships_pkey PRIMARY KEY (id);


--
-- Name: parents parents_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_email_key UNIQUE (email);


--
-- Name: parents parents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_pkey PRIMARY KEY (id);


--
-- Name: partner_contacts partner_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_contacts
    ADD CONSTRAINT partner_contacts_pkey PRIMARY KEY (id);


--
-- Name: partners partners_organization_id_partner_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_organization_id_partner_name_key UNIQUE (organization_id, partner_name);


--
-- Name: partners partners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_pkey PRIMARY KEY (id);


--
-- Name: platform_admins platform_admins_auth_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_auth_user_id_key UNIQUE (auth_user_id);


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (id);


--
-- Name: pricing_rules pricing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_pkey PRIMARY KEY (id);


--
-- Name: program_assignments program_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_assignments
    ADD CONSTRAINT program_assignments_pkey PRIMARY KEY (id);


--
-- Name: program_curriculum_changes program_curriculum_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_curriculum_changes
    ADD CONSTRAINT program_curriculum_changes_pkey PRIMARY KEY (id);


--
-- Name: program_fit_texts program_fit_texts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_fit_texts
    ADD CONSTRAINT program_fit_texts_pkey PRIMARY KEY (id);


--
-- Name: program_locations program_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_locations
    ADD CONSTRAINT program_locations_pkey PRIMARY KEY (id);


--
-- Name: program_locations program_locations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_locations
    ADD CONSTRAINT program_locations_slug_key UNIQUE (slug);


--
-- Name: programs programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programs
    ADD CONSTRAINT programs_pkey PRIMARY KEY (id);


--
-- Name: promo_codes promo_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_code_key UNIQUE (code);


--
-- Name: promo_codes promo_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);


--
-- Name: refunds refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);


--
-- Name: refunds refunds_stripe_refund_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_stripe_refund_id_key UNIQUE (stripe_refund_id);


--
-- Name: registrations registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_pkey PRIMARY KEY (id);


--
-- Name: roster_email_sends roster_email_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_email_sends
    ADD CONSTRAINT roster_email_sends_pkey PRIMARY KEY (id);


--
-- Name: scheduling_cycles scheduling_cycles_organization_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_cycles
    ADD CONSTRAINT scheduling_cycles_organization_id_name_key UNIQUE (organization_id, name);


--
-- Name: scheduling_cycles scheduling_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_cycles
    ADD CONSTRAINT scheduling_cycles_pkey PRIMARY KEY (id);


--
-- Name: session_declined_instructors session_declined_instructors_camp_session_id_instructor_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_declined_instructors
    ADD CONSTRAINT session_declined_instructors_camp_session_id_instructor_id_key UNIQUE (camp_session_id, instructor_id);


--
-- Name: session_declined_instructors session_declined_instructors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_declined_instructors
    ADD CONSTRAINT session_declined_instructors_pkey PRIMARY KEY (id);


--
-- Name: session_delivery_confirmations session_delivery_confirmations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_pkey PRIMARY KEY (id);


--
-- Name: students students_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_pkey PRIMARY KEY (id);


--
-- Name: time_saved_events time_saved_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_saved_events
    ADD CONSTRAINT time_saved_events_pkey PRIMARY KEY (id);


--
-- Name: contractor_agreements unique_instructor_agreement_version; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_agreements
    ADD CONSTRAINT unique_instructor_agreement_version UNIQUE (instructor_id, agreement_version);


--
-- Name: contractor_acknowledgments unique_instructor_document; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_acknowledgments
    ADD CONSTRAINT unique_instructor_document UNIQUE (instructor_id, document_id, document_version);


--
-- Name: venue_regions venue_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venue_regions
    ADD CONSTRAINT venue_regions_pkey PRIMARY KEY (organization_id, location_name);


--
-- Name: waiver_signatures waiver_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiver_signatures
    ADD CONSTRAINT waiver_signatures_pkey PRIMARY KEY (id);


--
-- Name: waivers waivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waivers
    ADD CONSTRAINT waivers_pkey PRIMARY KEY (id);


--
-- Name: idx_enroll_events_org_action_time; Type: INDEX; Schema: intelligence; Owner: -
--

CREATE INDEX idx_enroll_events_org_action_time ON intelligence.enrollment_events USING btree (organization_id, action_type, occurred_at DESC);


--
-- Name: idx_enroll_events_parent; Type: INDEX; Schema: intelligence; Owner: -
--

CREATE INDEX idx_enroll_events_parent ON intelligence.enrollment_events USING btree (parent_id);


--
-- Name: idx_enroll_events_registration; Type: INDEX; Schema: intelligence; Owner: -
--

CREATE INDEX idx_enroll_events_registration ON intelligence.enrollment_events USING btree (registration_id);


--
-- Name: uq_enroll_events_dedupe; Type: INDEX; Schema: intelligence; Owner: -
--

CREATE UNIQUE INDEX uq_enroll_events_dedupe ON intelligence.enrollment_events USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: assignment_substitutions_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assignment_substitutions_date_idx ON public.assignment_substitutions USING btree (date);


--
-- Name: assignment_substitutions_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assignment_substitutions_org_id_idx ON public.assignment_substitutions USING btree (organization_id);


--
-- Name: assignment_substitutions_sub_instructor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assignment_substitutions_sub_instructor_id_idx ON public.assignment_substitutions USING btree (sub_instructor_id);


--
-- Name: automation_edits_by_org_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_edits_by_org_template_idx ON public.automation_edits USING btree (organization_id, template_id, edited_at DESC);


--
-- Name: automation_edits_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_edits_recent_idx ON public.automation_edits USING btree (edited_at DESC);


--
-- Name: automation_run_recipients_by_automation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_run_recipients_by_automation_idx ON public.automation_run_recipients USING btree (automation_id, sent_at DESC);


--
-- Name: automation_run_recipients_by_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_run_recipients_by_org_idx ON public.automation_run_recipients USING btree (organization_id, sent_at DESC);


--
-- Name: automation_run_recipients_by_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_run_recipients_by_run_idx ON public.automation_run_recipients USING btree (automation_run_id);


--
-- Name: automation_runs_by_automation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_runs_by_automation_idx ON public.automation_runs USING btree (automation_id, fired_at DESC);


--
-- Name: automation_runs_by_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_runs_by_org_idx ON public.automation_runs USING btree (organization_id, fired_at DESC);


--
-- Name: automation_templates_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_templates_sort_idx ON public.automation_templates USING btree (sort_order, key);


--
-- Name: automations_enabled_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automations_enabled_lookup_idx ON public.automations USING btree (enabled, template_id) WHERE (enabled = true);


--
-- Name: camp_sessions_curriculum_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX camp_sessions_curriculum_id_idx ON public.camp_sessions USING btree (curriculum_id);


--
-- Name: capability_definitions_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capability_definitions_category_idx ON public.capability_definitions USING btree (category);


--
-- Name: capability_definitions_display_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capability_definitions_display_order_idx ON public.capability_definitions USING btree (display_order);


--
-- Name: capability_unlock_states_capability_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capability_unlock_states_capability_id_idx ON public.capability_unlock_states USING btree (capability_id);


--
-- Name: capability_unlock_states_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX capability_unlock_states_organization_id_idx ON public.capability_unlock_states USING btree (organization_id);


--
-- Name: curricula_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curricula_organization_id_idx ON public.curricula USING btree (organization_id);


--
-- Name: curricula_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curricula_status_idx ON public.curricula USING btree (status);


--
-- Name: curriculum_documents_curriculum_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_documents_curriculum_id_idx ON public.curriculum_documents USING btree (curriculum_id);


--
-- Name: curriculum_documents_extraction_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_documents_extraction_status_idx ON public.curriculum_documents USING btree (extraction_status);


--
-- Name: curriculum_documents_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_documents_organization_id_idx ON public.curriculum_documents USING btree (organization_id);


--
-- Name: curriculum_extracted_fields_curriculum_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_extracted_fields_curriculum_idx ON public.curriculum_extracted_fields USING btree (curriculum_id);


--
-- Name: curriculum_extracted_fields_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_extracted_fields_organization_idx ON public.curriculum_extracted_fields USING btree (organization_id);


--
-- Name: curriculum_sessions_curriculum_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_sessions_curriculum_id_idx ON public.curriculum_sessions USING btree (curriculum_id);


--
-- Name: curriculum_sessions_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX curriculum_sessions_organization_id_idx ON public.curriculum_sessions USING btree (organization_id);


--
-- Name: district_calendars_org_district_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX district_calendars_org_district_year_idx ON public.district_calendars USING btree (organization_id, district, school_year);


--
-- Name: idx_assignments_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignments_instructor ON public.camp_assignments USING btree (instructor_id);


--
-- Name: idx_assignments_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignments_session ON public.camp_assignments USING btree (camp_session_id);


--
-- Name: idx_camp_assignments_published_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camp_assignments_published_deadline ON public.camp_assignments USING btree (deadline) WHERE (status = 'published'::text);


--
-- Name: idx_camp_sessions_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camp_sessions_cycle ON public.camp_sessions USING btree (cycle_id);


--
-- Name: idx_camp_sessions_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camp_sessions_org ON public.camp_sessions USING btree (organization_id);


--
-- Name: idx_camp_sessions_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_camp_sessions_parent ON public.camp_sessions USING btree (parent_session_id) WHERE (parent_session_id IS NOT NULL);


--
-- Name: idx_checkout_schedules_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_checkout_schedules_session ON public.checkout_schedules USING btree (stripe_session_id);


--
-- Name: idx_checkout_schedules_unconsumed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_checkout_schedules_unconsumed ON public.checkout_schedules USING btree (created_at) WHERE (consumed_at IS NULL);


--
-- Name: idx_contractor_acks_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contractor_acks_instructor ON public.contractor_acknowledgments USING btree (instructor_id);


--
-- Name: idx_contractor_agreements_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contractor_agreements_instructor ON public.contractor_agreements USING btree (instructor_id);


--
-- Name: idx_contractor_ec_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contractor_ec_instructor ON public.contractor_emergency_contacts USING btree (instructor_id);


--
-- Name: idx_contractor_ors_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contractor_ors_instructor ON public.contractor_ors_certification USING btree (instructor_id);


--
-- Name: idx_curr_prefs_cycle_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_curr_prefs_cycle_inst ON public.instructor_curriculum_preferences USING btree (cycle_id, instructor_id);


--
-- Name: idx_custom_fields_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custom_fields_org ON public.custom_reg_fields USING btree (organization_id);


--
-- Name: idx_delivery_confirmations_instructor_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_confirmations_instructor_date ON public.session_delivery_confirmations USING btree (instructor_id, session_date);


--
-- Name: idx_delivery_confirmations_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_confirmations_pending ON public.session_delivery_confirmations USING btree (organization_id, confirmed_by, session_date) WHERE (confirmed_by = 'pending'::text);


--
-- Name: idx_enrollment_types_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_enrollment_types_org ON public.enrollment_types USING btree (organization_id);


--
-- Name: idx_installment_plans_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installment_plans_org ON public.installment_plans USING btree (organization_id);


--
-- Name: idx_installments_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installments_org ON public.installments USING btree (organization_id);


--
-- Name: idx_installments_registration_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installments_registration_id ON public.installments USING btree (registration_id);


--
-- Name: idx_installments_status_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_installments_status_due_date ON public.installments USING btree (status, due_date) WHERE (status = 'pending'::text);


--
-- Name: idx_instructor_availability_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_availability_cycle ON public.instructor_availability USING btree (cycle_id);


--
-- Name: idx_instructor_payouts_camp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_payouts_camp ON public.instructor_payouts USING btree (camp_session_id);


--
-- Name: idx_instructor_payouts_instructor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_payouts_instructor ON public.instructor_payouts USING btree (instructor_id);


--
-- Name: idx_instructor_payouts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_payouts_org ON public.instructor_payouts USING btree (organization_id);


--
-- Name: idx_instructor_payouts_program; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_payouts_program ON public.instructor_payouts USING btree (program_id) WHERE (program_id IS NOT NULL);


--
-- Name: idx_instructor_payouts_stripe_transfer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_payouts_stripe_transfer ON public.instructor_payouts USING btree (stripe_transfer_id) WHERE (stripe_transfer_id IS NOT NULL);


--
-- Name: idx_instructor_term_availability_org_term; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructor_term_availability_org_term ON public.instructor_term_availability USING btree (organization_id, term);


--
-- Name: idx_instructors_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructors_org ON public.instructors USING btree (organization_id);


--
-- Name: idx_instructors_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_instructors_user ON public.instructors USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: idx_iom_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_iom_assignment ON public.instructor_offer_messages USING btree (camp_assignment_id);


--
-- Name: idx_iom_organization; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_iom_organization ON public.instructor_offer_messages USING btree (organization_id);


--
-- Name: idx_legal_docs_org_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_docs_org_key ON public.legal_documents USING btree (organization_id, document_key);


--
-- Name: idx_loc_prefs_cycle_inst; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loc_prefs_cycle_inst ON public.instructor_location_preferences USING btree (cycle_id, instructor_id);


--
-- Name: idx_marketing_campaigns_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_campaigns_org_status ON public.marketing_campaigns USING btree (organization_id, status);


--
-- Name: idx_marketing_recipients_org_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_recipients_org_email ON public.marketing_recipients USING btree (organization_id, email);


--
-- Name: idx_marketing_recipients_org_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_recipients_org_school ON public.marketing_recipients USING btree (organization_id, school_name);


--
-- Name: idx_marketing_recipients_segments; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_recipients_segments ON public.marketing_recipients USING gin (segments);


--
-- Name: idx_marketing_sends_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_sends_campaign ON public.marketing_sends USING btree (campaign_id);


--
-- Name: idx_marketing_sends_campaign_email_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_sends_campaign_email_status ON public.marketing_sends USING btree (campaign_id, email, status);


--
-- Name: idx_marketing_sends_email_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_sends_email_sent_at ON public.marketing_sends USING btree (email, sent_at);


--
-- Name: idx_marketing_sends_org_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_sends_org_campaign ON public.marketing_sends USING btree (organization_id, campaign_id);


--
-- Name: idx_marketing_sends_org_email_sent_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_sends_org_email_sent_at ON public.marketing_sends USING btree (organization_id, email, sent_at);


--
-- Name: idx_marketing_suppressions_email_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_marketing_suppressions_email_lookup ON public.marketing_suppressions USING btree (organization_id, lower(email));


--
-- Name: idx_offer_messages_program_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_offer_messages_program_assignment ON public.instructor_offer_messages USING btree (program_assignment_id);


--
-- Name: idx_org_members_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_members_org ON public.org_members USING btree (organization_id);


--
-- Name: idx_org_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_members_user ON public.org_members USING btree (auth_user_id);


--
-- Name: idx_org_policies_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_policies_lookup ON public.org_policies USING btree (organization_id, policy_type);


--
-- Name: idx_organizations_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_slug ON public.organizations USING btree (slug);


--
-- Name: idx_organizations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_status ON public.organizations USING btree (status);


--
-- Name: idx_parent_org_rel_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parent_org_rel_org ON public.parent_org_relationships USING btree (organization_id);


--
-- Name: idx_parent_org_rel_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parent_org_rel_parent ON public.parent_org_relationships USING btree (parent_id);


--
-- Name: idx_parents_auth; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_parents_auth ON public.parents USING btree (auth_id);


--
-- Name: idx_parents_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parents_email ON public.parents USING btree (email);


--
-- Name: idx_partner_contacts_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_contacts_email ON public.partner_contacts USING btree (contact_email);


--
-- Name: idx_partner_contacts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_contacts_org ON public.partner_contacts USING btree (organization_id);


--
-- Name: idx_partner_contacts_partner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partner_contacts_partner ON public.partner_contacts USING btree (partner_id);


--
-- Name: idx_partners_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partners_org ON public.partners USING btree (organization_id);


--
-- Name: idx_platform_admins_auth_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_admins_auth_user ON public.platform_admins USING btree (auth_user_id);


--
-- Name: idx_pricing_rules_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_rules_org ON public.pricing_rules USING btree (organization_id);


--
-- Name: idx_program_curriculum_changes_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_program_curriculum_changes_organization_id ON public.program_curriculum_changes USING btree (organization_id);


--
-- Name: idx_program_curriculum_changes_program_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_program_curriculum_changes_program_id ON public.program_curriculum_changes USING btree (program_id);


--
-- Name: idx_program_curriculum_changes_program_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_program_curriculum_changes_program_recent ON public.program_curriculum_changes USING btree (program_id, changed_at DESC);


--
-- Name: idx_program_fit_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_program_fit_org ON public.program_fit_texts USING btree (organization_id);


--
-- Name: idx_program_locations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_program_locations_org ON public.program_locations USING btree (organization_id);


--
-- Name: idx_program_locations_partner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_program_locations_partner_id ON public.program_locations USING btree (partner_id);


--
-- Name: idx_programs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_programs_org ON public.programs USING btree (organization_id);


--
-- Name: idx_programs_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_programs_school ON public.programs USING btree (program_location_id);


--
-- Name: idx_programs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_programs_status ON public.programs USING btree (status);


--
-- Name: idx_programs_term; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_programs_term ON public.programs USING btree (term);


--
-- Name: idx_promo_codes_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_promo_codes_org ON public.promo_codes USING btree (organization_id);


--
-- Name: idx_refunds_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refunds_organization_id ON public.refunds USING btree (organization_id);


--
-- Name: idx_refunds_registration_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refunds_registration_id ON public.refunds USING btree (registration_id);


--
-- Name: idx_refunds_stripe_payment_intent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_refunds_stripe_payment_intent_id ON public.refunds USING btree (stripe_payment_intent_id);


--
-- Name: idx_registrations_camp_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_camp_session ON public.registrations USING btree (camp_session_id) WHERE (camp_session_id IS NOT NULL);


--
-- Name: idx_registrations_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_org ON public.registrations USING btree (organization_id);


--
-- Name: idx_registrations_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_parent ON public.registrations USING btree (parent_id);


--
-- Name: idx_registrations_post_plan; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_post_plan ON public.registrations USING btree (post_program_plan) WHERE (post_program_plan IS NOT NULL);


--
-- Name: idx_registrations_program; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_program ON public.registrations USING btree (program_id);


--
-- Name: idx_roster_email_sends_camp_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_email_sends_camp_session_id ON public.roster_email_sends USING btree (camp_session_id);


--
-- Name: idx_roster_email_sends_organization_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_email_sends_organization_id ON public.roster_email_sends USING btree (organization_id);


--
-- Name: idx_roster_email_sends_sent_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_roster_email_sends_sent_at_desc ON public.roster_email_sends USING btree (camp_session_id, sent_at DESC);


--
-- Name: idx_scheduling_cycles_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduling_cycles_org ON public.scheduling_cycles USING btree (organization_id);


--
-- Name: idx_session_confirmations_payout; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_confirmations_payout ON public.session_delivery_confirmations USING btree (instructor_payout_id) WHERE (instructor_payout_id IS NOT NULL);


--
-- Name: idx_students_epipen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_epipen ON public.students USING btree (epipen_required) WHERE (epipen_required = true);


--
-- Name: idx_students_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_org ON public.students USING btree (organization_id);


--
-- Name: idx_students_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_students_parent ON public.students USING btree (parent_id);


--
-- Name: idx_touchpoints_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_touchpoints_campaign ON public.marketing_campaign_touchpoints USING btree (campaign_id);


--
-- Name: idx_touchpoints_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_touchpoints_due ON public.marketing_campaign_touchpoints USING btree (scheduled_at) WHERE (status = 'queued'::text);


--
-- Name: idx_touchpoints_org_status_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_touchpoints_org_status_scheduled ON public.marketing_campaign_touchpoints USING btree (organization_id, status, scheduled_at);


--
-- Name: idx_waivers_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_waivers_org ON public.waivers USING btree (organization_id);


--
-- Name: instructor_offer_messages_sender_instructor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instructor_offer_messages_sender_instructor_idx ON public.instructor_offer_messages USING btree (sender_instructor_id);


--
-- Name: marketing_sends_dedup_per_touchpoint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketing_sends_dedup_per_touchpoint_idx ON public.marketing_sends USING btree (campaign_id, touchpoint_id, recipient_id);


--
-- Name: organization_google_tokens_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_google_tokens_org_idx ON public.organization_google_tokens USING btree (organization_id);


--
-- Name: program_assignments_instructor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX program_assignments_instructor_id_idx ON public.program_assignments USING btree (instructor_id);


--
-- Name: program_assignments_one_active_per_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX program_assignments_one_active_per_pair ON public.program_assignments USING btree (program_id, instructor_id) WHERE (status <> ALL (ARRAY['declined'::text, 'withdrawn'::text]));


--
-- Name: program_assignments_org_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX program_assignments_org_id_idx ON public.program_assignments USING btree (organization_id);


--
-- Name: program_assignments_program_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX program_assignments_program_id_idx ON public.program_assignments USING btree (program_id);


--
-- Name: programs_curriculum_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX programs_curriculum_id_idx ON public.programs USING btree (curriculum_id);


--
-- Name: session_declined_instructors_camp_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_declined_instructors_camp_session_id_idx ON public.session_declined_instructors USING btree (camp_session_id);


--
-- Name: session_declined_instructors_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_declined_instructors_cycle_id_idx ON public.session_declined_instructors USING btree (cycle_id);


--
-- Name: session_declined_instructors_instructor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_declined_instructors_instructor_id_idx ON public.session_declined_instructors USING btree (instructor_id);


--
-- Name: time_saved_events_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX time_saved_events_organization_id_created_at_idx ON public.time_saved_events USING btree (organization_id, created_at DESC);


--
-- Name: uniq_registrations_camp_student; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_registrations_camp_student ON public.registrations USING btree (camp_session_id, student_id) WHERE (camp_session_id IS NOT NULL);


--
-- Name: unique_camp_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_camp_delivery ON public.session_delivery_confirmations USING btree (instructor_id, session_date, camp_session_id) WHERE (camp_session_id IS NOT NULL);


--
-- Name: unique_primary_emergency_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_primary_emergency_contact ON public.contractor_emergency_contacts USING btree (instructor_id) WHERE (is_primary = true);


--
-- Name: unique_program_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX unique_program_delivery ON public.session_delivery_confirmations USING btree (instructor_id, session_date, program_id) WHERE (program_id IS NOT NULL);


--
-- Name: uq_instructor_payouts_no_concurrent; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_instructor_payouts_no_concurrent ON public.instructor_payouts USING btree (instructor_id, camp_session_id) WHERE (status = ANY (ARRAY['pending'::text, 'succeeded'::text]));


--
-- Name: uq_instructor_payouts_no_concurrent_program; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_instructor_payouts_no_concurrent_program ON public.instructor_payouts USING btree (instructor_id, program_id) WHERE ((status = ANY (ARRAY['pending'::text, 'succeeded'::text])) AND (program_id IS NOT NULL));


--
-- Name: uq_marketing_suppressions_org_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_marketing_suppressions_org_email ON public.marketing_suppressions USING btree (organization_id, lower(email));


--
-- Name: uq_session_delivery_confirmations_camp; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_session_delivery_confirmations_camp ON public.session_delivery_confirmations USING btree (instructor_id, camp_session_id, session_date) WHERE (camp_session_id IS NOT NULL);


--
-- Name: uq_session_delivery_confirmations_program; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_session_delivery_confirmations_program ON public.session_delivery_confirmations USING btree (instructor_id, program_id, session_date) WHERE (program_id IS NOT NULL);


--
-- Name: automations automations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER automations_set_updated_at BEFORE UPDATE ON public.automations FOR EACH ROW EXECUTE FUNCTION public.set_automations_updated_at();


--
-- Name: camp_assignments camp_assignment_conflict_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER camp_assignment_conflict_check BEFORE INSERT OR UPDATE ON public.camp_assignments FOR EACH ROW EXECUTE FUNCTION public.check_camp_assignment_conflict();


--
-- Name: organizations guard_organizations_locked_columns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_organizations_locked_columns BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.guard_organizations_locked_columns();


--
-- Name: registrations recompute_enrollment_after_reg_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recompute_enrollment_after_reg_change AFTER INSERT OR DELETE OR UPDATE ON public.registrations FOR EACH ROW EXECUTE FUNCTION public.recompute_camp_session_enrollment();


--
-- Name: camp_assignments set_distance_bonus_on_assignment; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_distance_bonus_on_assignment BEFORE INSERT OR UPDATE OF camp_session_id, instructor_id ON public.camp_assignments FOR EACH ROW EXECUTE FUNCTION public.compute_distance_bonus();


--
-- Name: registrations trg_auto_add_registrant_to_marketing_list; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_add_registrant_to_marketing_list AFTER INSERT OR UPDATE OF status ON public.registrations FOR EACH ROW EXECUTE FUNCTION public.auto_add_registrant_to_marketing_list();


--
-- Name: program_locations trg_program_locations_partner_same_org; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_program_locations_partner_same_org BEFORE INSERT OR UPDATE OF partner_id, organization_id ON public.program_locations FOR EACH ROW EXECUTE FUNCTION public.program_locations_partner_same_org();


--
-- Name: assignment_substitutions trg_restrict_assignment_substitution_sub_updates; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_restrict_assignment_substitution_sub_updates BEFORE UPDATE ON public.assignment_substitutions FOR EACH ROW EXECUTE FUNCTION public.restrict_assignment_substitution_sub_updates();


--
-- Name: contractor_onboarding_status trg_sync_onboarding_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_onboarding_status AFTER INSERT OR UPDATE OF overall_status ON public.contractor_onboarding_status FOR EACH ROW EXECUTE FUNCTION public.sync_instructor_onboarding_status();


--
-- Name: assignment_substitutions trg_validate_assignment_substitution_parent; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_assignment_substitution_parent BEFORE INSERT OR UPDATE OF parent_assignment_id, parent_assignment_type, organization_id, sub_instructor_id ON public.assignment_substitutions FOR EACH ROW EXECUTE FUNCTION public.validate_assignment_substitution_parent();


--
-- Name: afterschool_survey_state afterschool_survey_state_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.afterschool_survey_state
    ADD CONSTRAINT afterschool_survey_state_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: assignment_substitutions assignment_substitutions_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_substitutions
    ADD CONSTRAINT assignment_substitutions_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id);


--
-- Name: assignment_substitutions assignment_substitutions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_substitutions
    ADD CONSTRAINT assignment_substitutions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: assignment_substitutions assignment_substitutions_sub_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_substitutions
    ADD CONSTRAINT assignment_substitutions_sub_instructor_id_fkey FOREIGN KEY (sub_instructor_id) REFERENCES public.instructors(id) ON DELETE RESTRICT;


--
-- Name: automation_edits automation_edits_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_edits
    ADD CONSTRAINT automation_edits_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES auth.users(id);


--
-- Name: automation_edits automation_edits_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_edits
    ADD CONSTRAINT automation_edits_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: automation_edits automation_edits_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_edits
    ADD CONSTRAINT automation_edits_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.automation_templates(id) ON DELETE CASCADE;


--
-- Name: automation_run_recipients automation_run_recipients_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_run_recipients
    ADD CONSTRAINT automation_run_recipients_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;


--
-- Name: automation_run_recipients automation_run_recipients_automation_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_run_recipients
    ADD CONSTRAINT automation_run_recipients_automation_run_id_fkey FOREIGN KEY (automation_run_id) REFERENCES public.automation_runs(id) ON DELETE CASCADE;


--
-- Name: automation_runs automation_runs_automation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE;


--
-- Name: automations automations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: automations automations_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automations
    ADD CONSTRAINT automations_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.automation_templates(id) ON DELETE CASCADE;


--
-- Name: camp_assignments camp_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id);


--
-- Name: camp_assignments camp_assignments_camp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_camp_session_id_fkey FOREIGN KEY (camp_session_id) REFERENCES public.camp_sessions(id) ON DELETE CASCADE;


--
-- Name: camp_assignments camp_assignments_distance_bonus_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_distance_bonus_payout_id_fkey FOREIGN KEY (distance_bonus_payout_id) REFERENCES public.instructor_payouts(id) ON DELETE SET NULL;


--
-- Name: camp_assignments camp_assignments_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE CASCADE;


--
-- Name: camp_assignments camp_assignments_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_assignments
    ADD CONSTRAINT camp_assignments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: camp_sessions camp_sessions_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curricula(id) ON DELETE SET NULL;


--
-- Name: camp_sessions camp_sessions_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.scheduling_cycles(id) ON DELETE CASCADE;


--
-- Name: camp_sessions camp_sessions_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.program_locations(id);


--
-- Name: camp_sessions camp_sessions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: camp_sessions camp_sessions_parent_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_parent_session_id_fkey FOREIGN KEY (parent_session_id) REFERENCES public.camp_sessions(id) ON DELETE CASCADE;


--
-- Name: camp_sessions camp_sessions_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.camp_sessions
    ADD CONSTRAINT camp_sessions_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id);


--
-- Name: capability_unlock_states capability_unlock_states_capability_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_unlock_states
    ADD CONSTRAINT capability_unlock_states_capability_id_fkey FOREIGN KEY (capability_id) REFERENCES public.capability_definitions(id);


--
-- Name: capability_unlock_states capability_unlock_states_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_unlock_states
    ADD CONSTRAINT capability_unlock_states_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: checkout_schedules checkout_schedules_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkout_schedules
    ADD CONSTRAINT checkout_schedules_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: contractor_acknowledgments contractor_acknowledgments_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_acknowledgments
    ADD CONSTRAINT contractor_acknowledgments_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: contractor_acknowledgments contractor_acknowledgments_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_acknowledgments
    ADD CONSTRAINT contractor_acknowledgments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: contractor_agreements contractor_agreements_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_agreements
    ADD CONSTRAINT contractor_agreements_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: contractor_agreements contractor_agreements_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_agreements
    ADD CONSTRAINT contractor_agreements_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: contractor_emergency_contacts contractor_emergency_contacts_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_emergency_contacts
    ADD CONSTRAINT contractor_emergency_contacts_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: contractor_emergency_contacts contractor_emergency_contacts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_emergency_contacts
    ADD CONSTRAINT contractor_emergency_contacts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: contractor_onboarding_status contractor_onboarding_status_background_check_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_onboarding_status
    ADD CONSTRAINT contractor_onboarding_status_background_check_uploaded_by_fkey FOREIGN KEY (background_check_uploaded_by) REFERENCES auth.users(id);


--
-- Name: contractor_onboarding_status contractor_onboarding_status_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_onboarding_status
    ADD CONSTRAINT contractor_onboarding_status_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: contractor_onboarding_status contractor_onboarding_status_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_onboarding_status
    ADD CONSTRAINT contractor_onboarding_status_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: contractor_ors_certification contractor_ors_certification_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_ors_certification
    ADD CONSTRAINT contractor_ors_certification_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: contractor_ors_certification contractor_ors_certification_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contractor_ors_certification
    ADD CONSTRAINT contractor_ors_certification_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: curricula curricula_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curricula
    ADD CONSTRAINT curricula_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: curricula curricula_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curricula
    ADD CONSTRAINT curricula_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: curriculum_documents curriculum_documents_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_documents
    ADD CONSTRAINT curriculum_documents_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curricula(id) ON DELETE CASCADE;


--
-- Name: curriculum_documents curriculum_documents_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_documents
    ADD CONSTRAINT curriculum_documents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: curriculum_extracted_fields curriculum_extracted_fields_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_extracted_fields
    ADD CONSTRAINT curriculum_extracted_fields_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curricula(id) ON DELETE CASCADE;


--
-- Name: curriculum_extracted_fields curriculum_extracted_fields_human_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_extracted_fields
    ADD CONSTRAINT curriculum_extracted_fields_human_approved_by_fkey FOREIGN KEY (human_approved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: curriculum_extracted_fields curriculum_extracted_fields_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_extracted_fields
    ADD CONSTRAINT curriculum_extracted_fields_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: curriculum_extracted_fields curriculum_extracted_fields_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_extracted_fields
    ADD CONSTRAINT curriculum_extracted_fields_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES public.curriculum_documents(id) ON DELETE SET NULL;


--
-- Name: curriculum_sessions curriculum_sessions_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_sessions
    ADD CONSTRAINT curriculum_sessions_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curricula(id) ON DELETE CASCADE;


--
-- Name: curriculum_sessions curriculum_sessions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curriculum_sessions
    ADD CONSTRAINT curriculum_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: custom_reg_fields custom_reg_fields_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_reg_fields
    ADD CONSTRAINT custom_reg_fields_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: district_calendars district_calendars_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_calendars
    ADD CONSTRAINT district_calendars_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: district_calendars district_calendars_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.district_calendars
    ADD CONSTRAINT district_calendars_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: enrollment_types enrollment_types_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enrollment_types
    ADD CONSTRAINT enrollment_types_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: installment_plans installment_plans_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installment_plans
    ADD CONSTRAINT installment_plans_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: installments installments_installment_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installments
    ADD CONSTRAINT installments_installment_plan_id_fkey FOREIGN KEY (installment_plan_id) REFERENCES public.installment_plans(id);


--
-- Name: installments installments_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installments
    ADD CONSTRAINT installments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: installments installments_registration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.installments
    ADD CONSTRAINT installments_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES public.registrations(id);


--
-- Name: instructor_availability instructor_availability_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_availability
    ADD CONSTRAINT instructor_availability_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.scheduling_cycles(id) ON DELETE CASCADE;


--
-- Name: instructor_availability instructor_availability_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_availability
    ADD CONSTRAINT instructor_availability_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE CASCADE;


--
-- Name: instructor_availability instructor_availability_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_availability
    ADD CONSTRAINT instructor_availability_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: instructor_curriculum_preferences instructor_curriculum_preferences_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_curriculum_preferences
    ADD CONSTRAINT instructor_curriculum_preferences_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.scheduling_cycles(id) ON DELETE CASCADE;


--
-- Name: instructor_curriculum_preferences instructor_curriculum_preferences_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_curriculum_preferences
    ADD CONSTRAINT instructor_curriculum_preferences_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE CASCADE;


--
-- Name: instructor_curriculum_preferences instructor_curriculum_preferences_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_curriculum_preferences
    ADD CONSTRAINT instructor_curriculum_preferences_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: instructor_location_preferences instructor_location_preferences_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_location_preferences
    ADD CONSTRAINT instructor_location_preferences_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.scheduling_cycles(id) ON DELETE CASCADE;


--
-- Name: instructor_location_preferences instructor_location_preferences_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_location_preferences
    ADD CONSTRAINT instructor_location_preferences_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE CASCADE;


--
-- Name: instructor_location_preferences instructor_location_preferences_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_location_preferences
    ADD CONSTRAINT instructor_location_preferences_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: instructor_offer_messages instructor_offer_messages_camp_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_offer_messages
    ADD CONSTRAINT instructor_offer_messages_camp_assignment_id_fkey FOREIGN KEY (camp_assignment_id) REFERENCES public.camp_assignments(id) ON DELETE CASCADE;


--
-- Name: instructor_offer_messages instructor_offer_messages_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_offer_messages
    ADD CONSTRAINT instructor_offer_messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: instructor_offer_messages instructor_offer_messages_program_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_offer_messages
    ADD CONSTRAINT instructor_offer_messages_program_assignment_id_fkey FOREIGN KEY (program_assignment_id) REFERENCES public.program_assignments(id) ON DELETE CASCADE;


--
-- Name: instructor_offer_messages instructor_offer_messages_sender_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_offer_messages
    ADD CONSTRAINT instructor_offer_messages_sender_instructor_id_fkey FOREIGN KEY (sender_instructor_id) REFERENCES public.instructors(id) ON DELETE SET NULL;


--
-- Name: instructor_payouts instructor_payouts_camp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_camp_session_id_fkey FOREIGN KEY (camp_session_id) REFERENCES public.camp_sessions(id) ON DELETE RESTRICT;


--
-- Name: instructor_payouts instructor_payouts_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE RESTRICT;


--
-- Name: instructor_payouts instructor_payouts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: instructor_payouts instructor_payouts_paid_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_paid_by_user_id_fkey FOREIGN KEY (paid_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: instructor_payouts instructor_payouts_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_payouts
    ADD CONSTRAINT instructor_payouts_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE RESTRICT;


--
-- Name: instructor_term_availability instructor_term_availability_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_term_availability
    ADD CONSTRAINT instructor_term_availability_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE CASCADE;


--
-- Name: instructor_term_availability instructor_term_availability_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructor_term_availability
    ADD CONSTRAINT instructor_term_availability_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: instructors instructors_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: instructors instructors_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instructors
    ADD CONSTRAINT instructors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: legal_documents legal_documents_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_documents
    ADD CONSTRAINT legal_documents_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: legal_documents legal_documents_replaced_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_documents
    ADD CONSTRAINT legal_documents_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES public.legal_documents(id);


--
-- Name: marketing_campaign_touchpoints marketing_campaign_touchpoints_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_campaign_touchpoints
    ADD CONSTRAINT marketing_campaign_touchpoints_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE;


--
-- Name: marketing_campaigns marketing_campaigns_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_campaigns
    ADD CONSTRAINT marketing_campaigns_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES auth.users(id);


--
-- Name: marketing_campaigns marketing_campaigns_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_campaigns
    ADD CONSTRAINT marketing_campaigns_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: marketing_recipients marketing_recipients_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_recipients
    ADD CONSTRAINT marketing_recipients_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: marketing_sends marketing_sends_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sends
    ADD CONSTRAINT marketing_sends_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.marketing_campaigns(id);


--
-- Name: marketing_sends marketing_sends_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sends
    ADD CONSTRAINT marketing_sends_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: marketing_sends marketing_sends_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sends
    ADD CONSTRAINT marketing_sends_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.marketing_recipients(id);


--
-- Name: marketing_sends marketing_sends_touchpoint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_sends
    ADD CONSTRAINT marketing_sends_touchpoint_id_fkey FOREIGN KEY (touchpoint_id) REFERENCES public.marketing_campaign_touchpoints(id) ON DELETE SET NULL;


--
-- Name: marketing_suppressions marketing_suppressions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketing_suppressions
    ADD CONSTRAINT marketing_suppressions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_branding org_branding_body_font_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_branding
    ADD CONSTRAINT org_branding_body_font_fk FOREIGN KEY (body_font) REFERENCES public.available_fonts(name) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: org_branding org_branding_heading_font_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_branding
    ADD CONSTRAINT org_branding_heading_font_fk FOREIGN KEY (heading_font) REFERENCES public.available_fonts(name) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: org_branding org_branding_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_branding
    ADD CONSTRAINT org_branding_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: org_members org_members_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_policies org_policies_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_policies
    ADD CONSTRAINT org_policies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_google_tokens organization_google_tokens_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_google_tokens
    ADD CONSTRAINT organization_google_tokens_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_google_tokens organization_google_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_google_tokens
    ADD CONSTRAINT organization_google_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: parent_org_relationships parent_org_relationships_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_org_relationships
    ADD CONSTRAINT parent_org_relationships_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: parent_org_relationships parent_org_relationships_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parent_org_relationships
    ADD CONSTRAINT parent_org_relationships_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE CASCADE;


--
-- Name: parents parents_auth_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parents
    ADD CONSTRAINT parents_auth_id_fkey FOREIGN KEY (auth_id) REFERENCES auth.users(id);


--
-- Name: partner_contacts partner_contacts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_contacts
    ADD CONSTRAINT partner_contacts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: partner_contacts partner_contacts_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_contacts
    ADD CONSTRAINT partner_contacts_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE CASCADE;


--
-- Name: partners partners_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partners
    ADD CONSTRAINT partners_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: platform_admins platform_admins_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: pricing_rules pricing_rules_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: program_assignments program_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_assignments
    ADD CONSTRAINT program_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id);


--
-- Name: program_assignments program_assignments_distance_bonus_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_assignments
    ADD CONSTRAINT program_assignments_distance_bonus_payout_id_fkey FOREIGN KEY (distance_bonus_payout_id) REFERENCES public.instructor_payouts(id) ON DELETE SET NULL;


--
-- Name: program_assignments program_assignments_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_assignments
    ADD CONSTRAINT program_assignments_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE RESTRICT;


--
-- Name: program_assignments program_assignments_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_assignments
    ADD CONSTRAINT program_assignments_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: program_assignments program_assignments_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_assignments
    ADD CONSTRAINT program_assignments_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE CASCADE;


--
-- Name: program_curriculum_changes program_curriculum_changes_changed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_curriculum_changes
    ADD CONSTRAINT program_curriculum_changes_changed_by_user_id_fkey FOREIGN KEY (changed_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: program_curriculum_changes program_curriculum_changes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_curriculum_changes
    ADD CONSTRAINT program_curriculum_changes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: program_curriculum_changes program_curriculum_changes_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_curriculum_changes
    ADD CONSTRAINT program_curriculum_changes_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id) ON DELETE CASCADE;


--
-- Name: program_fit_texts program_fit_texts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_fit_texts
    ADD CONSTRAINT program_fit_texts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: program_locations program_locations_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_locations
    ADD CONSTRAINT program_locations_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE SET NULL;


--
-- Name: programs programs_active_promo_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programs
    ADD CONSTRAINT programs_active_promo_code_id_fkey FOREIGN KEY (active_promo_code_id) REFERENCES public.promo_codes(id);


--
-- Name: programs programs_curriculum_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programs
    ADD CONSTRAINT programs_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.curricula(id);


--
-- Name: programs programs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programs
    ADD CONSTRAINT programs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: programs programs_program_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.programs
    ADD CONSTRAINT programs_program_location_id_fkey FOREIGN KEY (program_location_id) REFERENCES public.program_locations(id);


--
-- Name: promo_codes promo_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: promo_codes promo_codes_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: refunds refunds_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: refunds refunds_refunded_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_refunded_by_user_id_fkey FOREIGN KEY (refunded_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: refunds refunds_registration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES public.registrations(id) ON DELETE CASCADE;


--
-- Name: registrations registrations_camp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_camp_session_id_fkey FOREIGN KEY (camp_session_id) REFERENCES public.camp_sessions(id) ON DELETE CASCADE;


--
-- Name: registrations registrations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: registrations registrations_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id);


--
-- Name: registrations registrations_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id);


--
-- Name: registrations registrations_student_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.students(id);


--
-- Name: roster_email_sends roster_email_sends_camp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_email_sends
    ADD CONSTRAINT roster_email_sends_camp_session_id_fkey FOREIGN KEY (camp_session_id) REFERENCES public.camp_sessions(id) ON DELETE CASCADE;


--
-- Name: roster_email_sends roster_email_sends_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_email_sends
    ADD CONSTRAINT roster_email_sends_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: roster_email_sends roster_email_sends_partner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_email_sends
    ADD CONSTRAINT roster_email_sends_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES public.partners(id) ON DELETE SET NULL;


--
-- Name: roster_email_sends roster_email_sends_sent_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roster_email_sends
    ADD CONSTRAINT roster_email_sends_sent_by_user_id_fkey FOREIGN KEY (sent_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: scheduling_cycles scheduling_cycles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduling_cycles
    ADD CONSTRAINT scheduling_cycles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: program_locations schools_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.program_locations
    ADD CONSTRAINT schools_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: session_declined_instructors session_declined_instructors_camp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_declined_instructors
    ADD CONSTRAINT session_declined_instructors_camp_session_id_fkey FOREIGN KEY (camp_session_id) REFERENCES public.camp_sessions(id) ON DELETE CASCADE;


--
-- Name: session_declined_instructors session_declined_instructors_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_declined_instructors
    ADD CONSTRAINT session_declined_instructors_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.scheduling_cycles(id) ON DELETE CASCADE;


--
-- Name: session_declined_instructors session_declined_instructors_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_declined_instructors
    ADD CONSTRAINT session_declined_instructors_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id) ON DELETE CASCADE;


--
-- Name: session_declined_instructors session_declined_instructors_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_declined_instructors
    ADD CONSTRAINT session_declined_instructors_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: session_delivery_confirmations session_delivery_confirmations_admin_override_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_admin_override_by_fkey FOREIGN KEY (admin_override_by) REFERENCES auth.users(id);


--
-- Name: session_delivery_confirmations session_delivery_confirmations_camp_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_camp_session_id_fkey FOREIGN KEY (camp_session_id) REFERENCES public.camp_sessions(id);


--
-- Name: session_delivery_confirmations session_delivery_confirmations_instructor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_instructor_id_fkey FOREIGN KEY (instructor_id) REFERENCES public.instructors(id);


--
-- Name: session_delivery_confirmations session_delivery_confirmations_instructor_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_instructor_payout_id_fkey FOREIGN KEY (instructor_payout_id) REFERENCES public.instructor_payouts(id) ON DELETE SET NULL;


--
-- Name: session_delivery_confirmations session_delivery_confirmations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: session_delivery_confirmations session_delivery_confirmations_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_delivery_confirmations
    ADD CONSTRAINT session_delivery_confirmations_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.programs(id);


--
-- Name: students students_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: students students_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id);


--
-- Name: students students_program_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.students
    ADD CONSTRAINT students_program_location_id_fkey FOREIGN KEY (program_location_id) REFERENCES public.program_locations(id);


--
-- Name: time_saved_events time_saved_events_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_saved_events
    ADD CONSTRAINT time_saved_events_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: time_saved_events time_saved_events_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_saved_events
    ADD CONSTRAINT time_saved_events_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: venue_regions venue_regions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.venue_regions
    ADD CONSTRAINT venue_regions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: waiver_signatures waiver_signatures_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiver_signatures
    ADD CONSTRAINT waiver_signatures_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: waiver_signatures waiver_signatures_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiver_signatures
    ADD CONSTRAINT waiver_signatures_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id);


--
-- Name: waiver_signatures waiver_signatures_registration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiver_signatures
    ADD CONSTRAINT waiver_signatures_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES public.registrations(id);


--
-- Name: waiver_signatures waiver_signatures_waiver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiver_signatures
    ADD CONSTRAINT waiver_signatures_waiver_id_fkey FOREIGN KEY (waiver_id) REFERENCES public.waivers(id);


--
-- Name: waivers waivers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waivers
    ADD CONSTRAINT waivers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: waivers waivers_replaced_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waivers
    ADD CONSTRAINT waivers_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES public.waivers(id);


--
-- Name: enrollment_events; Type: ROW SECURITY; Schema: intelligence; Owner: -
--

ALTER TABLE intelligence.enrollment_events ENABLE ROW LEVEL SECURITY;

--
-- Name: org_policies Org members can delete own org policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Org members can delete own org policies" ON public.org_policies FOR DELETE TO authenticated USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: org_policies Org members can insert own org policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Org members can insert own org policies" ON public.org_policies FOR INSERT TO authenticated WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: org_policies Org members can update own org policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Org members can update own org policies" ON public.org_policies FOR UPDATE TO authenticated USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: org_policies Public read access for org_policies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read access for org_policies" ON public.org_policies FOR SELECT USING (true);


--
-- Name: organizations admins_insert_orgs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admins_insert_orgs ON public.organizations FOR INSERT WITH CHECK (public.is_platform_admin());


--
-- Name: platform_admins admins_manage_admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admins_manage_admins ON public.platform_admins USING (public.is_platform_admin());


--
-- Name: platform_admins admins_view_admins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admins_view_admins ON public.platform_admins FOR SELECT USING (public.is_platform_admin());


--
-- Name: afterschool_survey_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.afterschool_survey_state ENABLE ROW LEVEL SECURITY;

--
-- Name: afterschool_survey_state afterschool_survey_state_instructor_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY afterschool_survey_state_instructor_read ON public.afterschool_survey_state FOR SELECT USING ((organization_id IN ( SELECT instructors.organization_id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid()))));


--
-- Name: afterschool_survey_state afterschool_survey_state_org_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY afterschool_survey_state_org_manage ON public.afterschool_survey_state USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: assignment_substitutions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assignment_substitutions ENABLE ROW LEVEL SECURITY;

--
-- Name: assignment_substitutions assignment_substitutions_org_members_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assignment_substitutions_org_members_manage ON public.assignment_substitutions USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: assignment_substitutions assignment_substitutions_sub_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assignment_substitutions_sub_self_read ON public.assignment_substitutions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.instructors i
  WHERE ((i.id = assignment_substitutions.sub_instructor_id) AND (i.auth_user_id = auth.uid())))));


--
-- Name: assignment_substitutions assignment_substitutions_sub_self_update_status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assignment_substitutions_sub_self_update_status ON public.assignment_substitutions FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.instructors i
  WHERE ((i.id = assignment_substitutions.sub_instructor_id) AND (i.auth_user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.instructors i
  WHERE ((i.id = assignment_substitutions.sub_instructor_id) AND (i.auth_user_id = auth.uid())))));


--
-- Name: automation_edits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_edits ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_run_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_run_recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: automations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

--
-- Name: available_fonts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.available_fonts ENABLE ROW LEVEL SECURITY;

--
-- Name: available_fonts available_fonts_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY available_fonts_public_read ON public.available_fonts FOR SELECT USING (true);


--
-- Name: camp_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camp_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: camp_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.camp_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_definitions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capability_definitions ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_unlock_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capability_unlock_states ENABLE ROW LEVEL SECURITY;

--
-- Name: checkout_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.checkout_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_acknowledgments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contractor_acknowledgments ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_agreements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contractor_agreements ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_emergency_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contractor_emergency_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_onboarding_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contractor_onboarding_status ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_ors_certification; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contractor_ors_certification ENABLE ROW LEVEL SECURITY;

--
-- Name: curricula; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curricula ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curriculum_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_extracted_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curriculum_extracted_fields ENABLE ROW LEVEL SECURITY;

--
-- Name: curriculum_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.curriculum_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: custom_reg_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.custom_reg_fields ENABLE ROW LEVEL SECURITY;

--
-- Name: district_calendars; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.district_calendars ENABLE ROW LEVEL SECURITY;

--
-- Name: enrollment_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.enrollment_types ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_unlock_states insert_own_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_org ON public.capability_unlock_states FOR INSERT WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.accepted_at IS NOT NULL)))));


--
-- Name: time_saved_events insert_own_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY insert_own_org ON public.time_saved_events FOR INSERT WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.accepted_at IS NOT NULL)))));


--
-- Name: installment_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.installment_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: installments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.installments ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_availability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructor_availability ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_curriculum_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructor_curriculum_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_location_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructor_location_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_offer_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructor_offer_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_payouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructor_payouts ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_acknowledgments instructor_read_acks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_read_acks ON public.contractor_acknowledgments FOR SELECT USING ((instructor_id = private.current_instructor_id()));


--
-- Name: contractor_agreements instructor_read_agreements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_read_agreements ON public.contractor_agreements FOR SELECT USING ((instructor_id = private.current_instructor_id()));


--
-- Name: session_delivery_confirmations instructor_read_confirmations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_read_confirmations ON public.session_delivery_confirmations FOR SELECT USING ((instructor_id = private.current_instructor_id()));


--
-- Name: contractor_emergency_contacts instructor_read_ec; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_read_ec ON public.contractor_emergency_contacts FOR SELECT USING ((instructor_id = private.current_instructor_id()));


--
-- Name: contractor_ors_certification instructor_read_ors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_read_ors ON public.contractor_ors_certification FOR SELECT USING ((instructor_id = private.current_instructor_id()));


--
-- Name: contractor_onboarding_status instructor_read_own_onboarding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_read_own_onboarding ON public.contractor_onboarding_status FOR SELECT USING ((instructor_id = private.current_instructor_id()));


--
-- Name: camp_assignments instructor_self_assignments_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_assignments_read ON public.camp_assignments FOR SELECT USING (((instructor_id IN ( SELECT instructors.id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid()))) AND (published_at IS NOT NULL)));


--
-- Name: instructor_availability instructor_self_availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_availability ON public.instructor_availability USING ((instructor_id IN ( SELECT instructors.id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid()))));


--
-- Name: instructor_curriculum_preferences instructor_self_curr_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_curr_prefs ON public.instructor_curriculum_preferences USING ((instructor_id IN ( SELECT instructors.id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid()))));


--
-- Name: scheduling_cycles instructor_self_cycles_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_cycles_read ON public.scheduling_cycles FOR SELECT USING ((id IN ( SELECT DISTINCT cs.cycle_id
   FROM (public.camp_sessions cs
     JOIN public.camp_assignments ca ON ((ca.camp_session_id = cs.id)))
  WHERE (ca.instructor_id = private.current_instructor_id()))));


--
-- Name: instructor_offer_messages instructor_self_iom_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_iom_read ON public.instructor_offer_messages FOR SELECT USING ((camp_assignment_id IN ( SELECT ca.id
   FROM (public.camp_assignments ca
     JOIN public.instructors i ON ((i.id = ca.instructor_id)))
  WHERE (i.auth_user_id = auth.uid()))));


--
-- Name: instructor_offer_messages instructor_self_iom_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_iom_write ON public.instructor_offer_messages FOR INSERT WITH CHECK (((sender_role = 'instructor'::text) AND (camp_assignment_id IN ( SELECT ca.id
   FROM (public.camp_assignments ca
     JOIN public.instructors i ON ((i.id = ca.instructor_id)))
  WHERE (i.auth_user_id = auth.uid())))));


--
-- Name: instructor_location_preferences instructor_self_loc_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_loc_prefs ON public.instructor_location_preferences USING ((instructor_id IN ( SELECT instructors.id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid()))));


--
-- Name: instructors instructor_self_read_instructors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_read_instructors ON public.instructors FOR SELECT USING ((auth_user_id = auth.uid()));


--
-- Name: camp_sessions instructor_self_read_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_self_read_sessions ON public.camp_sessions FOR SELECT USING ((id IN ( SELECT ca.camp_session_id
   FROM public.camp_assignments ca
  WHERE (ca.published_at IS NOT NULL))));


--
-- Name: instructor_term_availability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructor_term_availability ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_term_availability instructor_term_availability_org_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_term_availability_org_manage ON public.instructor_term_availability USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: instructor_term_availability instructor_term_availability_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructor_term_availability_self ON public.instructor_term_availability USING ((instructor_id IN ( SELECT instructors.id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid())))) WITH CHECK ((instructor_id IN ( SELECT instructors.id
   FROM public.instructors
  WHERE (instructors.auth_user_id = auth.uid()))));


--
-- Name: instructors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;

--
-- Name: parents instructors_read_camp_roster_parents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructors_read_camp_roster_parents ON public.parents FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.registrations r
     JOIN public.camp_assignments ca ON ((ca.camp_session_id = r.camp_session_id)))
  WHERE ((r.parent_id = parents.id) AND (ca.instructor_id = private.current_instructor_id()) AND (ca.status = 'confirmed'::text)))));


--
-- Name: students instructors_read_camp_roster_students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructors_read_camp_roster_students ON public.students FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.registrations r
     JOIN public.camp_assignments ca ON ((ca.camp_session_id = r.camp_session_id)))
  WHERE ((r.student_id = students.id) AND (ca.instructor_id = private.current_instructor_id()) AND (ca.status = 'confirmed'::text)))));


--
-- Name: registrations instructors_read_camp_rosters; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructors_read_camp_rosters ON public.registrations FOR SELECT USING (((camp_session_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.camp_assignments ca
  WHERE ((ca.camp_session_id = registrations.camp_session_id) AND (ca.instructor_id = private.current_instructor_id()) AND (ca.status = 'confirmed'::text))))));


--
-- Name: instructor_payouts instructors_see_own_payouts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY instructors_see_own_payouts ON public.instructor_payouts FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.instructors i
  WHERE ((i.id = instructor_payouts.instructor_id) AND (i.auth_user_id = auth.uid())))));


--
-- Name: legal_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.legal_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_campaign_touchpoints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_campaign_touchpoints ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_sends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_sends ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_suppressions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.marketing_suppressions ENABLE ROW LEVEL SECURITY;

--
-- Name: automations members_manage_automations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_automations ON public.automations USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: org_branding members_manage_branding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_branding ON public.org_branding USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: custom_reg_fields members_manage_custom_fields; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_custom_fields ON public.custom_reg_fields USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: district_calendars members_manage_district_calendars; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_district_calendars ON public.district_calendars USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: enrollment_types members_manage_enrollment_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_enrollment_types ON public.enrollment_types USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: program_fit_texts members_manage_fit_texts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_fit_texts ON public.program_fit_texts USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: installment_plans members_manage_installment_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_installment_plans ON public.installment_plans USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: installments members_manage_org_installments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_org_installments ON public.installments USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: refunds members_manage_org_refunds; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_org_refunds ON public.refunds USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: pricing_rules members_manage_pricing_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_pricing_rules ON public.pricing_rules USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: program_locations members_manage_program_locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_program_locations ON public.program_locations USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: programs members_manage_programs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_programs ON public.programs USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: promo_codes members_manage_promo_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_promo_codes ON public.promo_codes USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: waivers members_manage_waivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_manage_waivers ON public.waivers USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: automation_edits members_read_automation_edits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_read_automation_edits ON public.automation_edits FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: automation_run_recipients members_read_automation_run_recipients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_read_automation_run_recipients ON public.automation_run_recipients FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: automation_runs members_read_automation_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_read_automation_runs ON public.automation_runs FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: parents members_see_org_parents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_see_org_parents ON public.parents FOR SELECT USING ((public.is_platform_admin() OR (id IN ( SELECT parent_org_relationships.parent_id
   FROM public.parent_org_relationships
  WHERE (parent_org_relationships.organization_id IN ( SELECT public.user_org_ids() AS user_org_ids))))));


--
-- Name: registrations members_see_org_regs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_see_org_regs ON public.registrations FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: parent_org_relationships members_see_org_rels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_see_org_rels ON public.parent_org_relationships FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: waiver_signatures members_see_org_sigs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_see_org_sigs ON public.waiver_signatures FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: students members_see_org_students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_see_org_students ON public.students FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: registrations members_update_org_regs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_update_org_regs ON public.registrations FOR UPDATE USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: parent_org_relationships members_update_org_rels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_update_org_rels ON public.parent_org_relationships FOR UPDATE USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: students members_update_org_students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_update_org_students ON public.students FOR UPDATE USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: organizations members_update_own_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_update_own_org ON public.organizations FOR UPDATE USING ((public.is_org_member(id) OR public.is_platform_admin()));


--
-- Name: automation_edits members_write_automation_edits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY members_write_automation_edits ON public.automation_edits FOR INSERT WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: session_declined_instructors org admins delete declines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org admins delete declines" ON public.session_declined_instructors FOR DELETE TO authenticated USING ((organization_id IN ( SELECT om.organization_id
   FROM public.org_members om
  WHERE ((om.auth_user_id = auth.uid()) AND (om.accepted_at IS NOT NULL) AND (om.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: session_declined_instructors org admins write declines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org admins write declines" ON public.session_declined_instructors FOR INSERT TO authenticated WITH CHECK ((organization_id IN ( SELECT om.organization_id
   FROM public.org_members om
  WHERE ((om.auth_user_id = auth.uid()) AND (om.accepted_at IS NOT NULL) AND (om.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: session_declined_instructors org members read declines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "org members read declines" ON public.session_declined_instructors FOR SELECT TO authenticated USING ((organization_id IN ( SELECT om.organization_id
   FROM public.org_members om
  WHERE ((om.auth_user_id = auth.uid()) AND (om.accepted_at IS NOT NULL)))));


--
-- Name: partner_contacts org_access_partner_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_access_partner_contacts ON public.partner_contacts USING (public.check_org_access(organization_id));


--
-- Name: partners org_access_partners; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_access_partners ON public.partners USING (public.check_org_access(organization_id));


--
-- Name: contractor_acknowledgments org_admins_insert_acks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_insert_acks ON public.contractor_acknowledgments FOR INSERT WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: contractor_agreements org_admins_insert_agreements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_insert_agreements ON public.contractor_agreements FOR INSERT WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: contractor_ors_certification org_admins_insert_ors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_insert_ors ON public.contractor_ors_certification FOR INSERT WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: camp_assignments org_admins_write_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_assignments ON public.camp_assignments USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: instructor_availability org_admins_write_availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_availability ON public.instructor_availability USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: session_delivery_confirmations org_admins_write_confirmations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_confirmations ON public.session_delivery_confirmations USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))) WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: instructor_curriculum_preferences org_admins_write_curr_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_curr_prefs ON public.instructor_curriculum_preferences USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: curricula org_admins_write_curricula; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_curricula ON public.curricula USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: curriculum_documents org_admins_write_curriculum_documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_curriculum_documents ON public.curriculum_documents USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: curriculum_extracted_fields org_admins_write_curriculum_extracted_fields; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_curriculum_extracted_fields ON public.curriculum_extracted_fields USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: curriculum_sessions org_admins_write_curriculum_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_curriculum_sessions ON public.curriculum_sessions USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: scheduling_cycles org_admins_write_cycles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_cycles ON public.scheduling_cycles USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: contractor_emergency_contacts org_admins_write_ec; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_ec ON public.contractor_emergency_contacts USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))) WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: instructors org_admins_write_instructors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_instructors ON public.instructors USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: instructor_offer_messages org_admins_write_iom; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_iom ON public.instructor_offer_messages USING ((organization_id IN ( SELECT om.organization_id
   FROM public.org_members om
  WHERE ((om.auth_user_id = auth.uid()) AND (om.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: instructor_location_preferences org_admins_write_loc_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_loc_prefs ON public.instructor_location_preferences USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: contractor_onboarding_status org_admins_write_onboarding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_onboarding ON public.contractor_onboarding_status USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])))))) WITH CHECK ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: camp_sessions org_admins_write_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_sessions ON public.camp_sessions USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: venue_regions org_admins_write_venue_regions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_admins_write_venue_regions ON public.venue_regions USING ((organization_id IN ( SELECT om.organization_id
   FROM public.org_members om
  WHERE ((om.auth_user_id = auth.uid()) AND (om.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: org_branding; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_branding ENABLE ROW LEVEL SECURITY;

--
-- Name: org_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;

--
-- Name: instructor_payouts org_members_manage_instructor_payouts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_manage_instructor_payouts ON public.instructor_payouts USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: contractor_acknowledgments org_members_read_acks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_acks ON public.contractor_acknowledgments FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: contractor_agreements org_members_read_agreements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_agreements ON public.contractor_agreements FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: camp_assignments org_members_read_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_assignments ON public.camp_assignments FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: instructor_availability org_members_read_availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_availability ON public.instructor_availability FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: session_delivery_confirmations org_members_read_confirmations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_confirmations ON public.session_delivery_confirmations FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: instructor_curriculum_preferences org_members_read_curr_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_curr_prefs ON public.instructor_curriculum_preferences FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: curricula org_members_read_curricula; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_curricula ON public.curricula FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: curriculum_documents org_members_read_curriculum_documents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_curriculum_documents ON public.curriculum_documents FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: curriculum_extracted_fields org_members_read_curriculum_extracted_fields; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_curriculum_extracted_fields ON public.curriculum_extracted_fields FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: curriculum_sessions org_members_read_curriculum_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_curriculum_sessions ON public.curriculum_sessions FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: scheduling_cycles org_members_read_cycles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_cycles ON public.scheduling_cycles FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: contractor_emergency_contacts org_members_read_ec; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_ec ON public.contractor_emergency_contacts FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: organization_google_tokens org_members_read_google_tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_google_tokens ON public.organization_google_tokens FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: instructors org_members_read_instructors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_instructors ON public.instructors FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: legal_documents org_members_read_legal_docs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_legal_docs ON public.legal_documents FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: instructor_location_preferences org_members_read_loc_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_loc_prefs ON public.instructor_location_preferences FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: contractor_onboarding_status org_members_read_onboarding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_onboarding ON public.contractor_onboarding_status FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: contractor_ors_certification org_members_read_ors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_ors ON public.contractor_ors_certification FOR SELECT USING ((organization_id IN ( SELECT public.user_org_ids() AS user_org_ids)));


--
-- Name: marketing_suppressions org_members_read_own_suppressions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_own_suppressions ON public.marketing_suppressions FOR SELECT TO authenticated USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: camp_sessions org_members_read_sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_sessions ON public.camp_sessions FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))));


--
-- Name: venue_regions org_members_read_venue_regions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_members_read_venue_regions ON public.venue_regions FOR SELECT USING ((organization_id IN ( SELECT om.organization_id
   FROM public.org_members om
  WHERE (om.auth_user_id = auth.uid()))));


--
-- Name: org_policies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_policies ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_campaigns org_read_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_read_campaigns ON public.marketing_campaigns USING (public.check_org_access(organization_id));


--
-- Name: marketing_recipients org_read_recipients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_read_recipients ON public.marketing_recipients USING (public.check_org_access(organization_id));


--
-- Name: marketing_sends org_read_sends; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_read_sends ON public.marketing_sends USING (public.check_org_access(organization_id));


--
-- Name: organization_google_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_google_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: org_members owners_manage_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owners_manage_members ON public.org_members USING (public.is_org_owner_or_admin(organization_id));


--
-- Name: parent_org_relationships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parent_org_relationships ENABLE ROW LEVEL SECURITY;

--
-- Name: parents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parents ENABLE ROW LEVEL SECURITY;

--
-- Name: registrations parents_create_own_regs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_create_own_regs ON public.registrations FOR INSERT WITH CHECK ((parent_id = public.current_parent_id()));


--
-- Name: parent_org_relationships parents_create_own_rels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_create_own_rels ON public.parent_org_relationships FOR INSERT WITH CHECK ((parent_id = public.current_parent_id()));


--
-- Name: waiver_signatures parents_create_own_sigs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_create_own_sigs ON public.waiver_signatures FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.registrations r
  WHERE ((r.id = waiver_signatures.registration_id) AND (r.parent_id = public.current_parent_id())))));


--
-- Name: parents parents_create_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_create_self ON public.parents FOR INSERT WITH CHECK ((auth_id = auth.uid()));


--
-- Name: students parents_manage_own_students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_manage_own_students ON public.students USING ((parent_id = public.current_parent_id()));


--
-- Name: installments parents_see_own_installments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_own_installments ON public.installments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.registrations r
  WHERE ((r.id = installments.registration_id) AND (r.parent_id = public.current_parent_id())))));


--
-- Name: refunds parents_see_own_refunds; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_own_refunds ON public.refunds FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.registrations r
  WHERE ((r.id = refunds.registration_id) AND (r.parent_id = public.current_parent_id())))));


--
-- Name: registrations parents_see_own_regs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_own_regs ON public.registrations FOR SELECT USING ((parent_id = public.current_parent_id()));


--
-- Name: parent_org_relationships parents_see_own_rels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_own_rels ON public.parent_org_relationships FOR SELECT USING ((parent_id = public.current_parent_id()));


--
-- Name: waiver_signatures parents_see_own_sigs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_own_sigs ON public.waiver_signatures FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.registrations r
  WHERE ((r.id = waiver_signatures.registration_id) AND (r.parent_id = public.current_parent_id())))));


--
-- Name: students parents_see_own_students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_own_students ON public.students FOR SELECT USING ((parent_id = public.current_parent_id()));


--
-- Name: parents parents_see_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_see_self ON public.parents FOR SELECT USING ((auth_id = auth.uid()));


--
-- Name: parents parents_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY parents_update_self ON public.parents FOR UPDATE USING ((auth_id = auth.uid()));


--
-- Name: partner_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: partners; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

--
-- Name: contractor_acknowledgments platform_admin_acks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_acks ON public.contractor_acknowledgments USING (public.is_platform_admin());


--
-- Name: contractor_agreements platform_admin_agreements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_agreements ON public.contractor_agreements USING (public.is_platform_admin());


--
-- Name: session_delivery_confirmations platform_admin_confirmations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_confirmations ON public.session_delivery_confirmations USING (public.is_platform_admin());


--
-- Name: contractor_emergency_contacts platform_admin_ec; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_ec ON public.contractor_emergency_contacts USING (public.is_platform_admin());


--
-- Name: legal_documents platform_admin_legal_docs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_legal_docs ON public.legal_documents USING (public.is_platform_admin());


--
-- Name: contractor_onboarding_status platform_admin_onboarding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_onboarding ON public.contractor_onboarding_status USING (public.is_platform_admin());


--
-- Name: contractor_ors_certification platform_admin_ors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY platform_admin_ors ON public.contractor_ors_certification USING (public.is_platform_admin());


--
-- Name: platform_admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: pricing_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pricing_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: program_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.program_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: program_assignments program_assignments_instructor_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY program_assignments_instructor_self_read ON public.program_assignments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.instructors i
  WHERE ((i.id = program_assignments.instructor_id) AND (i.auth_user_id = auth.uid())))));


--
-- Name: program_assignments program_assignments_org_members_manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY program_assignments_org_members_manage ON public.program_assignments USING ((public.is_org_member(organization_id) OR public.is_platform_admin())) WITH CHECK ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: program_curriculum_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.program_curriculum_changes ENABLE ROW LEVEL SECURITY;

--
-- Name: program_curriculum_changes program_curriculum_changes_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY program_curriculum_changes_org_read ON public.program_curriculum_changes FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: program_fit_texts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.program_fit_texts ENABLE ROW LEVEL SECURITY;

--
-- Name: program_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.program_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: programs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.programs ENABLE ROW LEVEL SECURITY;

--
-- Name: promo_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations public_read_active_orgs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_active_orgs ON public.organizations FOR SELECT USING ((status = 'active'::text));


--
-- Name: waivers public_read_active_waivers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_active_waivers ON public.waivers FOR SELECT USING (((active = true) AND (organization_id IN ( SELECT organizations.id
   FROM public.organizations
  WHERE (organizations.status = 'active'::text)))));


--
-- Name: automation_templates public_read_automation_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_automation_templates ON public.automation_templates FOR SELECT USING (true);


--
-- Name: org_branding public_read_branding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_branding ON public.org_branding FOR SELECT USING ((organization_id IN ( SELECT organizations.id
   FROM public.organizations
  WHERE (organizations.status = 'active'::text))));


--
-- Name: capability_definitions public_read_capability_definitions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_capability_definitions ON public.capability_definitions FOR SELECT USING (true);


--
-- Name: custom_reg_fields public_read_custom_fields; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_custom_fields ON public.custom_reg_fields FOR SELECT USING ((is_active = true));


--
-- Name: district_calendars public_read_district_calendars; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_district_calendars ON public.district_calendars FOR SELECT USING ((organization_id IN ( SELECT organizations.id
   FROM public.organizations
  WHERE (organizations.status = 'active'::text))));


--
-- Name: enrollment_types public_read_enrollment_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_enrollment_types ON public.enrollment_types FOR SELECT USING ((is_active = true));


--
-- Name: program_fit_texts public_read_fit_texts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_fit_texts ON public.program_fit_texts FOR SELECT USING ((is_active = true));


--
-- Name: installment_plans public_read_installment_plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_installment_plans ON public.installment_plans FOR SELECT USING ((is_active = true));


--
-- Name: pricing_rules public_read_pricing_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_pricing_rules ON public.pricing_rules FOR SELECT USING ((is_active = true));


--
-- Name: program_locations public_read_program_locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_program_locations ON public.program_locations FOR SELECT USING ((organization_id IN ( SELECT organizations.id
   FROM public.organizations
  WHERE (organizations.status = 'active'::text))));


--
-- Name: programs public_read_programs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_programs ON public.programs FOR SELECT USING ((organization_id IN ( SELECT organizations.id
   FROM public.organizations
  WHERE (organizations.status = 'active'::text))));


--
-- Name: promo_codes public_read_promo_codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY public_read_promo_codes ON public.promo_codes FOR SELECT USING (((active = true) AND (organization_id IN ( SELECT organizations.id
   FROM public.organizations
  WHERE (organizations.status = 'active'::text)))));


--
-- Name: org_members read_own_membership; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_own_membership ON public.org_members FOR SELECT USING ((auth_user_id = auth.uid()));


--
-- Name: refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: roster_email_sends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roster_email_sends ENABLE ROW LEVEL SECURITY;

--
-- Name: roster_email_sends roster_email_sends_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY roster_email_sends_org_read ON public.roster_email_sends FOR SELECT USING ((public.is_org_member(organization_id) OR public.is_platform_admin()));


--
-- Name: scheduling_cycles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduling_cycles ENABLE ROW LEVEL SECURITY;

--
-- Name: capability_unlock_states select_own_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_org ON public.capability_unlock_states FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.accepted_at IS NOT NULL)))));


--
-- Name: time_saved_events select_own_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_own_org ON public.time_saved_events FOR SELECT USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.accepted_at IS NOT NULL)))));


--
-- Name: session_declined_instructors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.session_declined_instructors ENABLE ROW LEVEL SECURITY;

--
-- Name: session_delivery_confirmations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.session_delivery_confirmations ENABLE ROW LEVEL SECURITY;

--
-- Name: students; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;

--
-- Name: parents subs_read_camp_roster_parents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subs_read_camp_roster_parents ON public.parents FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ((public.registrations r
     JOIN public.assignment_substitutions s ON ((s.parent_assignment_type = 'camp'::text)))
     JOIN public.camp_assignments ca ON ((ca.id = s.parent_assignment_id)))
  WHERE ((r.parent_id = parents.id) AND (ca.camp_session_id = r.camp_session_id) AND (s.sub_instructor_id = private.current_instructor_id()) AND (s.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))))));


--
-- Name: students subs_read_camp_roster_students; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subs_read_camp_roster_students ON public.students FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ((public.registrations r
     JOIN public.assignment_substitutions s ON ((s.parent_assignment_type = 'camp'::text)))
     JOIN public.camp_assignments ca ON ((ca.id = s.parent_assignment_id)))
  WHERE ((r.student_id = students.id) AND (ca.camp_session_id = r.camp_session_id) AND (s.sub_instructor_id = private.current_instructor_id()) AND (s.status = ANY (ARRAY['confirmed'::text, 'taught'::text]))))));


--
-- Name: registrations subs_read_camp_rosters; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY subs_read_camp_rosters ON public.registrations FOR SELECT USING (((camp_session_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.assignment_substitutions s
     JOIN public.camp_assignments ca ON ((ca.id = s.parent_assignment_id)))
  WHERE ((s.parent_assignment_type = 'camp'::text) AND (s.sub_instructor_id = private.current_instructor_id()) AND (s.status = ANY (ARRAY['confirmed'::text, 'taught'::text])) AND (ca.camp_session_id = registrations.camp_session_id))))));


--
-- Name: time_saved_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.time_saved_events ENABLE ROW LEVEL SECURITY;

--
-- Name: marketing_campaign_touchpoints tp_org_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tp_org_admin_write ON public.marketing_campaign_touchpoints TO authenticated USING (((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.role = ANY (ARRAY['owner'::text, 'admin'::text])) AND (org_members.accepted_at IS NOT NULL)))) OR (EXISTS ( SELECT 1
   FROM public.platform_admins
  WHERE (platform_admins.auth_user_id = auth.uid())))));


--
-- Name: marketing_campaign_touchpoints tp_org_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tp_org_member_read ON public.marketing_campaign_touchpoints FOR SELECT TO authenticated USING (((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.accepted_at IS NOT NULL)))) OR (EXISTS ( SELECT 1
   FROM public.platform_admins
  WHERE (platform_admins.auth_user_id = auth.uid())))));


--
-- Name: capability_unlock_states update_own_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_own_org ON public.capability_unlock_states FOR UPDATE USING ((organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE ((org_members.auth_user_id = auth.uid()) AND (org_members.accepted_at IS NOT NULL)))));


--
-- Name: organization_google_tokens user_manages_own_google_token; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_manages_own_google_token ON public.organization_google_tokens USING (((user_id = auth.uid()) AND (organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid()))))) WITH CHECK (((user_id = auth.uid()) AND (organization_id IN ( SELECT org_members.organization_id
   FROM public.org_members
  WHERE (org_members.auth_user_id = auth.uid())))));


--
-- Name: venue_regions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.venue_regions ENABLE ROW LEVEL SECURITY;

--
-- Name: waiver_signatures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.waiver_signatures ENABLE ROW LEVEL SECURITY;

--
-- Name: waivers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.waivers ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: SCHEMA private; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA private TO authenticated;


--
-- Name: FUNCTION current_instructor_id(); Type: ACL; Schema: private; Owner: -
--

GRANT ALL ON FUNCTION private.current_instructor_id() TO authenticated;


--
-- Name: FUNCTION auto_add_registrant_to_marketing_list(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auto_add_registrant_to_marketing_list() TO anon;
GRANT ALL ON FUNCTION public.auto_add_registrant_to_marketing_list() TO authenticated;
GRANT ALL ON FUNCTION public.auto_add_registrant_to_marketing_list() TO service_role;


--
-- Name: FUNCTION check_camp_assignment_conflict(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_camp_assignment_conflict() TO anon;
GRANT ALL ON FUNCTION public.check_camp_assignment_conflict() TO authenticated;
GRANT ALL ON FUNCTION public.check_camp_assignment_conflict() TO service_role;


--
-- Name: FUNCTION check_org_access(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_org_access(p_org_id uuid) TO anon;
GRANT ALL ON FUNCTION public.check_org_access(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.check_org_access(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION compute_distance_bonus(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.compute_distance_bonus() TO anon;
GRANT ALL ON FUNCTION public.compute_distance_bonus() TO authenticated;
GRANT ALL ON FUNCTION public.compute_distance_bonus() TO service_role;


--
-- Name: FUNCTION cron_unschedule_by_name(job_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cron_unschedule_by_name(job_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cron_unschedule_by_name(job_name text) TO anon;
GRANT ALL ON FUNCTION public.cron_unschedule_by_name(job_name text) TO authenticated;
GRANT ALL ON FUNCTION public.cron_unschedule_by_name(job_name text) TO service_role;


--
-- Name: FUNCTION current_parent_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.current_parent_id() TO anon;
GRANT ALL ON FUNCTION public.current_parent_id() TO authenticated;
GRANT ALL ON FUNCTION public.current_parent_id() TO service_role;


--
-- Name: FUNCTION derive_program_session_dates(p_program_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.derive_program_session_dates(p_program_id uuid) TO anon;
GRANT ALL ON FUNCTION public.derive_program_session_dates(p_program_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.derive_program_session_dates(p_program_id uuid) TO service_role;


--
-- Name: FUNCTION get_campaign_recipients(p_campaign_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_campaign_recipients(p_campaign_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_campaign_recipients(p_campaign_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_campaign_recipients(p_campaign_id uuid) TO service_role;


--
-- Name: FUNCTION guard_organizations_locked_columns(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_organizations_locked_columns() TO anon;
GRANT ALL ON FUNCTION public.guard_organizations_locked_columns() TO authenticated;
GRANT ALL ON FUNCTION public.guard_organizations_locked_columns() TO service_role;


--
-- Name: FUNCTION is_org_member(org_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_org_member(org_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_org_member(org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_org_member(org_id uuid) TO service_role;


--
-- Name: FUNCTION is_org_owner_or_admin(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_org_owner_or_admin(p_org_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_org_owner_or_admin(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_org_owner_or_admin(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION is_platform_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_platform_admin() TO anon;
GRANT ALL ON FUNCTION public.is_platform_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_platform_admin() TO service_role;


--
-- Name: FUNCTION link_parent_to_auth_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.link_parent_to_auth_user() TO anon;
GRANT ALL ON FUNCTION public.link_parent_to_auth_user() TO authenticated;
GRANT ALL ON FUNCTION public.link_parent_to_auth_user() TO service_role;


--
-- Name: FUNCTION log_enrollment_event(p_action_type text, p_organization_id uuid, p_parent_id uuid, p_student_id uuid, p_program_id uuid, p_camp_session_id uuid, p_site_id uuid, p_registration_id uuid, p_metadata jsonb, p_occurred_at timestamp with time zone, p_dedupe_key text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.log_enrollment_event(p_action_type text, p_organization_id uuid, p_parent_id uuid, p_student_id uuid, p_program_id uuid, p_camp_session_id uuid, p_site_id uuid, p_registration_id uuid, p_metadata jsonb, p_occurred_at timestamp with time zone, p_dedupe_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_enrollment_event(p_action_type text, p_organization_id uuid, p_parent_id uuid, p_student_id uuid, p_program_id uuid, p_camp_session_id uuid, p_site_id uuid, p_registration_id uuid, p_metadata jsonb, p_occurred_at timestamp with time zone, p_dedupe_key text) TO service_role;


--
-- Name: FUNCTION preview_program_session_dates(p_organization_id uuid, p_location_id uuid, p_term text, p_first_date date, p_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.preview_program_session_dates(p_organization_id uuid, p_location_id uuid, p_term text, p_first_date date, p_count integer) TO anon;
GRANT ALL ON FUNCTION public.preview_program_session_dates(p_organization_id uuid, p_location_id uuid, p_term text, p_first_date date, p_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.preview_program_session_dates(p_organization_id uuid, p_location_id uuid, p_term text, p_first_date date, p_count integer) TO service_role;


--
-- Name: FUNCTION program_locations_partner_same_org(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.program_locations_partner_same_org() TO anon;
GRANT ALL ON FUNCTION public.program_locations_partner_same_org() TO authenticated;
GRANT ALL ON FUNCTION public.program_locations_partner_same_org() TO service_role;


--
-- Name: FUNCTION programs_with_session_dates(p_organization_id uuid, p_term text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.programs_with_session_dates(p_organization_id uuid, p_term text) TO anon;
GRANT ALL ON FUNCTION public.programs_with_session_dates(p_organization_id uuid, p_term text) TO authenticated;
GRANT ALL ON FUNCTION public.programs_with_session_dates(p_organization_id uuid, p_term text) TO service_role;


--
-- Name: FUNCTION recompute_camp_session_enrollment(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recompute_camp_session_enrollment() TO anon;
GRANT ALL ON FUNCTION public.recompute_camp_session_enrollment() TO authenticated;
GRANT ALL ON FUNCTION public.recompute_camp_session_enrollment() TO service_role;


--
-- Name: FUNCTION replace_emergency_contacts(p_instructor_id uuid, p_organization_id uuid, p_contacts jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.replace_emergency_contacts(p_instructor_id uuid, p_organization_id uuid, p_contacts jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.replace_emergency_contacts(p_instructor_id uuid, p_organization_id uuid, p_contacts jsonb) TO service_role;


--
-- Name: FUNCTION restrict_assignment_substitution_sub_updates(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.restrict_assignment_substitution_sub_updates() TO anon;
GRANT ALL ON FUNCTION public.restrict_assignment_substitution_sub_updates() TO authenticated;
GRANT ALL ON FUNCTION public.restrict_assignment_substitution_sub_updates() TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION set_automations_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_automations_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_automations_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_automations_updated_at() TO service_role;


--
-- Name: FUNCTION sync_instructor_onboarding_status(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_instructor_onboarding_status() TO anon;
GRANT ALL ON FUNCTION public.sync_instructor_onboarding_status() TO authenticated;
GRANT ALL ON FUNCTION public.sync_instructor_onboarding_status() TO service_role;


--
-- Name: FUNCTION term_to_school_year(p_term text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.term_to_school_year(p_term text) TO anon;
GRANT ALL ON FUNCTION public.term_to_school_year(p_term text) TO authenticated;
GRANT ALL ON FUNCTION public.term_to_school_year(p_term text) TO service_role;


--
-- Name: FUNCTION user_org_ids(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.user_org_ids() TO anon;
GRANT ALL ON FUNCTION public.user_org_ids() TO authenticated;
GRANT ALL ON FUNCTION public.user_org_ids() TO service_role;


--
-- Name: FUNCTION validate_assignment_substitution_parent(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_assignment_substitution_parent() TO anon;
GRANT ALL ON FUNCTION public.validate_assignment_substitution_parent() TO authenticated;
GRANT ALL ON FUNCTION public.validate_assignment_substitution_parent() TO service_role;


--
-- Name: FUNCTION vault_create_secret_text(p_secret_text text, p_secret_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vault_create_secret_text(p_secret_text text, p_secret_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vault_create_secret_text(p_secret_text text, p_secret_name text) TO service_role;


--
-- Name: FUNCTION vault_delete_secret(p_secret_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vault_delete_secret(p_secret_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vault_delete_secret(p_secret_id uuid) TO service_role;


--
-- Name: FUNCTION vault_read_secret_text(p_secret_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vault_read_secret_text(p_secret_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vault_read_secret_text(p_secret_id uuid) TO service_role;


--
-- Name: FUNCTION vault_update_secret_text(p_secret_id uuid, p_secret_text text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.vault_update_secret_text(p_secret_id uuid, p_secret_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.vault_update_secret_text(p_secret_id uuid, p_secret_text text) TO service_role;


--
-- Name: TABLE parents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.parents TO anon;
GRANT ALL ON TABLE public.parents TO authenticated;
GRANT ALL ON TABLE public.parents TO service_role;


--
-- Name: TABLE program_locations; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE public.program_locations TO anon;
GRANT ALL ON TABLE public.program_locations TO authenticated;
GRANT ALL ON TABLE public.program_locations TO service_role;


--
-- Name: COLUMN program_locations.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(name) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.district; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(district) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.slug; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(slug) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.address; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(address) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.organization_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(organization_id) ON TABLE public.program_locations TO anon;


--
-- Name: COLUMN program_locations.name_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(name_aliases) ON TABLE public.program_locations TO anon;


--
-- Name: TABLE programs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.programs TO anon;
GRANT ALL ON TABLE public.programs TO authenticated;
GRANT ALL ON TABLE public.programs TO service_role;


--
-- Name: TABLE registrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.registrations TO anon;
GRANT ALL ON TABLE public.registrations TO authenticated;
GRANT ALL ON TABLE public.registrations TO service_role;


--
-- Name: TABLE students; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.students TO anon;
GRANT ALL ON TABLE public.students TO authenticated;
GRANT ALL ON TABLE public.students TO service_role;


--
-- Name: TABLE admin_registrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_registrations TO service_role;


--
-- Name: TABLE afterschool_survey_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.afterschool_survey_state TO anon;
GRANT ALL ON TABLE public.afterschool_survey_state TO authenticated;
GRANT ALL ON TABLE public.afterschool_survey_state TO service_role;


--
-- Name: TABLE assignment_substitutions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.assignment_substitutions TO anon;
GRANT ALL ON TABLE public.assignment_substitutions TO authenticated;
GRANT ALL ON TABLE public.assignment_substitutions TO service_role;


--
-- Name: TABLE automation_edits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_edits TO anon;
GRANT ALL ON TABLE public.automation_edits TO authenticated;
GRANT ALL ON TABLE public.automation_edits TO service_role;


--
-- Name: TABLE automation_run_recipients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_run_recipients TO anon;
GRANT ALL ON TABLE public.automation_run_recipients TO authenticated;
GRANT ALL ON TABLE public.automation_run_recipients TO service_role;


--
-- Name: TABLE automation_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_runs TO anon;
GRANT ALL ON TABLE public.automation_runs TO authenticated;
GRANT ALL ON TABLE public.automation_runs TO service_role;


--
-- Name: TABLE automation_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_templates TO anon;
GRANT ALL ON TABLE public.automation_templates TO authenticated;
GRANT ALL ON TABLE public.automation_templates TO service_role;


--
-- Name: TABLE automations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automations TO anon;
GRANT ALL ON TABLE public.automations TO authenticated;
GRANT ALL ON TABLE public.automations TO service_role;


--
-- Name: TABLE available_fonts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.available_fonts TO anon;
GRANT ALL ON TABLE public.available_fonts TO authenticated;
GRANT ALL ON TABLE public.available_fonts TO service_role;


--
-- Name: TABLE camp_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.camp_assignments TO anon;
GRANT ALL ON TABLE public.camp_assignments TO authenticated;
GRANT ALL ON TABLE public.camp_assignments TO service_role;


--
-- Name: TABLE camp_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.camp_sessions TO anon;
GRANT ALL ON TABLE public.camp_sessions TO authenticated;
GRANT ALL ON TABLE public.camp_sessions TO service_role;


--
-- Name: TABLE capability_definitions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.capability_definitions TO anon;
GRANT ALL ON TABLE public.capability_definitions TO authenticated;
GRANT ALL ON TABLE public.capability_definitions TO service_role;


--
-- Name: TABLE capability_unlock_states; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.capability_unlock_states TO anon;
GRANT ALL ON TABLE public.capability_unlock_states TO authenticated;
GRANT ALL ON TABLE public.capability_unlock_states TO service_role;


--
-- Name: TABLE checkout_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.checkout_schedules TO anon;
GRANT ALL ON TABLE public.checkout_schedules TO authenticated;
GRANT ALL ON TABLE public.checkout_schedules TO service_role;


--
-- Name: TABLE contractor_acknowledgments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contractor_acknowledgments TO anon;
GRANT ALL ON TABLE public.contractor_acknowledgments TO authenticated;
GRANT ALL ON TABLE public.contractor_acknowledgments TO service_role;


--
-- Name: TABLE contractor_agreements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contractor_agreements TO anon;
GRANT ALL ON TABLE public.contractor_agreements TO authenticated;
GRANT ALL ON TABLE public.contractor_agreements TO service_role;


--
-- Name: TABLE contractor_emergency_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contractor_emergency_contacts TO anon;
GRANT ALL ON TABLE public.contractor_emergency_contacts TO authenticated;
GRANT ALL ON TABLE public.contractor_emergency_contacts TO service_role;


--
-- Name: TABLE contractor_onboarding_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contractor_onboarding_status TO anon;
GRANT ALL ON TABLE public.contractor_onboarding_status TO authenticated;
GRANT ALL ON TABLE public.contractor_onboarding_status TO service_role;


--
-- Name: TABLE contractor_ors_certification; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.contractor_ors_certification TO anon;
GRANT ALL ON TABLE public.contractor_ors_certification TO authenticated;
GRANT ALL ON TABLE public.contractor_ors_certification TO service_role;


--
-- Name: TABLE curricula; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.curricula TO anon;
GRANT ALL ON TABLE public.curricula TO authenticated;
GRANT ALL ON TABLE public.curricula TO service_role;


--
-- Name: TABLE curriculum_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.curriculum_documents TO anon;
GRANT ALL ON TABLE public.curriculum_documents TO authenticated;
GRANT ALL ON TABLE public.curriculum_documents TO service_role;


--
-- Name: TABLE curriculum_extracted_fields; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.curriculum_extracted_fields TO anon;
GRANT ALL ON TABLE public.curriculum_extracted_fields TO authenticated;
GRANT ALL ON TABLE public.curriculum_extracted_fields TO service_role;


--
-- Name: TABLE curriculum_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.curriculum_sessions TO anon;
GRANT ALL ON TABLE public.curriculum_sessions TO authenticated;
GRANT ALL ON TABLE public.curriculum_sessions TO service_role;


--
-- Name: TABLE custom_reg_fields; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.custom_reg_fields TO anon;
GRANT ALL ON TABLE public.custom_reg_fields TO authenticated;
GRANT ALL ON TABLE public.custom_reg_fields TO service_role;


--
-- Name: TABLE district_calendars; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.district_calendars TO anon;
GRANT ALL ON TABLE public.district_calendars TO authenticated;
GRANT ALL ON TABLE public.district_calendars TO service_role;


--
-- Name: TABLE enrollment_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.enrollment_types TO anon;
GRANT ALL ON TABLE public.enrollment_types TO authenticated;
GRANT ALL ON TABLE public.enrollment_types TO service_role;


--
-- Name: TABLE installment_plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.installment_plans TO anon;
GRANT ALL ON TABLE public.installment_plans TO authenticated;
GRANT ALL ON TABLE public.installment_plans TO service_role;


--
-- Name: TABLE installments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.installments TO anon;
GRANT ALL ON TABLE public.installments TO authenticated;
GRANT ALL ON TABLE public.installments TO service_role;


--
-- Name: TABLE instructor_availability; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructor_availability TO anon;
GRANT ALL ON TABLE public.instructor_availability TO authenticated;
GRANT ALL ON TABLE public.instructor_availability TO service_role;


--
-- Name: TABLE instructor_curriculum_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructor_curriculum_preferences TO anon;
GRANT ALL ON TABLE public.instructor_curriculum_preferences TO authenticated;
GRANT ALL ON TABLE public.instructor_curriculum_preferences TO service_role;


--
-- Name: TABLE instructor_location_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructor_location_preferences TO anon;
GRANT ALL ON TABLE public.instructor_location_preferences TO authenticated;
GRANT ALL ON TABLE public.instructor_location_preferences TO service_role;


--
-- Name: TABLE instructor_offer_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructor_offer_messages TO anon;
GRANT ALL ON TABLE public.instructor_offer_messages TO authenticated;
GRANT ALL ON TABLE public.instructor_offer_messages TO service_role;


--
-- Name: TABLE instructor_payouts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructor_payouts TO anon;
GRANT ALL ON TABLE public.instructor_payouts TO authenticated;
GRANT ALL ON TABLE public.instructor_payouts TO service_role;


--
-- Name: TABLE instructor_term_availability; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructor_term_availability TO anon;
GRANT ALL ON TABLE public.instructor_term_availability TO authenticated;
GRANT ALL ON TABLE public.instructor_term_availability TO service_role;


--
-- Name: TABLE instructors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.instructors TO anon;
GRANT ALL ON TABLE public.instructors TO authenticated;
GRANT ALL ON TABLE public.instructors TO service_role;


--
-- Name: TABLE legal_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.legal_documents TO anon;
GRANT ALL ON TABLE public.legal_documents TO authenticated;
GRANT ALL ON TABLE public.legal_documents TO service_role;


--
-- Name: TABLE marketing_campaign_touchpoints; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketing_campaign_touchpoints TO anon;
GRANT ALL ON TABLE public.marketing_campaign_touchpoints TO authenticated;
GRANT ALL ON TABLE public.marketing_campaign_touchpoints TO service_role;


--
-- Name: TABLE marketing_campaigns; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketing_campaigns TO service_role;
GRANT SELECT,UPDATE ON TABLE public.marketing_campaigns TO authenticated;


--
-- Name: TABLE marketing_recipients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketing_recipients TO service_role;
GRANT SELECT ON TABLE public.marketing_recipients TO authenticated;


--
-- Name: TABLE marketing_sends; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketing_sends TO service_role;
GRANT SELECT ON TABLE public.marketing_sends TO authenticated;


--
-- Name: TABLE marketing_suppressions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.marketing_suppressions TO anon;
GRANT ALL ON TABLE public.marketing_suppressions TO authenticated;
GRANT ALL ON TABLE public.marketing_suppressions TO service_role;


--
-- Name: TABLE org_branding; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.org_branding TO anon;
GRANT ALL ON TABLE public.org_branding TO authenticated;
GRANT ALL ON TABLE public.org_branding TO service_role;


--
-- Name: TABLE org_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.org_members TO anon;
GRANT ALL ON TABLE public.org_members TO authenticated;
GRANT ALL ON TABLE public.org_members TO service_role;


--
-- Name: TABLE org_policies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.org_policies TO anon;
GRANT ALL ON TABLE public.org_policies TO authenticated;
GRANT ALL ON TABLE public.org_policies TO service_role;


--
-- Name: TABLE organization_google_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.organization_google_tokens TO anon;
GRANT ALL ON TABLE public.organization_google_tokens TO authenticated;
GRANT ALL ON TABLE public.organization_google_tokens TO service_role;


--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.organizations TO anon;
GRANT ALL ON TABLE public.organizations TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;


--
-- Name: TABLE parent_org_relationships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.parent_org_relationships TO anon;
GRANT ALL ON TABLE public.parent_org_relationships TO authenticated;
GRANT ALL ON TABLE public.parent_org_relationships TO service_role;


--
-- Name: TABLE partner_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partner_contacts TO anon;
GRANT ALL ON TABLE public.partner_contacts TO authenticated;
GRANT ALL ON TABLE public.partner_contacts TO service_role;


--
-- Name: TABLE partners; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partners TO anon;
GRANT ALL ON TABLE public.partners TO authenticated;
GRANT ALL ON TABLE public.partners TO service_role;


--
-- Name: TABLE platform_admins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_admins TO anon;
GRANT ALL ON TABLE public.platform_admins TO authenticated;
GRANT ALL ON TABLE public.platform_admins TO service_role;


--
-- Name: TABLE pricing_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pricing_rules TO anon;
GRANT ALL ON TABLE public.pricing_rules TO authenticated;
GRANT ALL ON TABLE public.pricing_rules TO service_role;


--
-- Name: TABLE program_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.program_assignments TO anon;
GRANT ALL ON TABLE public.program_assignments TO authenticated;
GRANT ALL ON TABLE public.program_assignments TO service_role;


--
-- Name: TABLE program_curriculum_changes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.program_curriculum_changes TO anon;
GRANT ALL ON TABLE public.program_curriculum_changes TO authenticated;
GRANT ALL ON TABLE public.program_curriculum_changes TO service_role;


--
-- Name: TABLE program_enrollment; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.program_enrollment TO service_role;
GRANT SELECT ON TABLE public.program_enrollment TO anon;
GRANT SELECT ON TABLE public.program_enrollment TO authenticated;


--
-- Name: TABLE program_fit_texts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.program_fit_texts TO anon;
GRANT ALL ON TABLE public.program_fit_texts TO authenticated;
GRANT ALL ON TABLE public.program_fit_texts TO service_role;


--
-- Name: TABLE promo_codes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.promo_codes TO anon;
GRANT ALL ON TABLE public.promo_codes TO authenticated;
GRANT ALL ON TABLE public.promo_codes TO service_role;


--
-- Name: TABLE refunds; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.refunds TO anon;
GRANT ALL ON TABLE public.refunds TO authenticated;
GRANT ALL ON TABLE public.refunds TO service_role;


--
-- Name: TABLE roster_email_sends; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.roster_email_sends TO anon;
GRANT ALL ON TABLE public.roster_email_sends TO authenticated;
GRANT ALL ON TABLE public.roster_email_sends TO service_role;


--
-- Name: TABLE scheduling_cycles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scheduling_cycles TO anon;
GRANT ALL ON TABLE public.scheduling_cycles TO authenticated;
GRANT ALL ON TABLE public.scheduling_cycles TO service_role;


--
-- Name: TABLE session_declined_instructors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.session_declined_instructors TO anon;
GRANT ALL ON TABLE public.session_declined_instructors TO authenticated;
GRANT ALL ON TABLE public.session_declined_instructors TO service_role;


--
-- Name: TABLE session_delivery_confirmations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.session_delivery_confirmations TO anon;
GRANT ALL ON TABLE public.session_delivery_confirmations TO authenticated;
GRANT ALL ON TABLE public.session_delivery_confirmations TO service_role;


--
-- Name: TABLE time_saved_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.time_saved_events TO anon;
GRANT ALL ON TABLE public.time_saved_events TO authenticated;
GRANT ALL ON TABLE public.time_saved_events TO service_role;


--
-- Name: TABLE v_effective_pay_lines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.v_effective_pay_lines TO anon;
GRANT ALL ON TABLE public.v_effective_pay_lines TO authenticated;
GRANT ALL ON TABLE public.v_effective_pay_lines TO service_role;


--
-- Name: TABLE venue_regions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.venue_regions TO anon;
GRANT ALL ON TABLE public.venue_regions TO authenticated;
GRANT ALL ON TABLE public.venue_regions TO service_role;


--
-- Name: TABLE waiver_signatures; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.waiver_signatures TO anon;
GRANT ALL ON TABLE public.waiver_signatures TO authenticated;
GRANT ALL ON TABLE public.waiver_signatures TO service_role;


--
-- Name: TABLE waivers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.waivers TO anon;
GRANT ALL ON TABLE public.waivers TO authenticated;
GRANT ALL ON TABLE public.waivers TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict K2YcwPvDih3qPJ9ugCUh6hkQabReyKBaVYXphW0GxwYVV1gFMjpJVyL6dWd7swl

