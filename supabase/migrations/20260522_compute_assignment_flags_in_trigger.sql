-- Extend the existing compute_distance_bonus() trigger to also write
-- camp_assignments.flags alongside distance_bonus_cents. One lookup, two
-- columns set, no new trigger.
--
-- location_override  -> instructor's region preference is 'unavailable' (+$50 bonus)
-- location_low_pref  -> instructor's region preference is 'not_preferred' (no bonus, flagged)
--
-- curriculum_mismatch is intentionally NOT handled here — out of option A scope.
--
-- Backfill at the bottom: touch each row to re-fire the trigger.
-- Applied 2026-05-22.

CREATE OR REPLACE FUNCTION public.compute_distance_bonus()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_cycle             uuid;
  v_org               uuid;
  v_session_location  text;
  v_region            text;
  v_pref              text;
  v_flags             text[] := '{}';
BEGIN
  SELECT cs.cycle_id, cs.organization_id, cs.location_name
    INTO v_cycle, v_org, v_session_location
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

  IF v_pref = 'unavailable' THEN
    NEW.distance_bonus_cents := 5000;
    v_flags := array_append(v_flags, 'location_override');
  ELSIF v_pref = 'not_preferred' THEN
    NEW.distance_bonus_cents := NULL;
    v_flags := array_append(v_flags, 'location_low_pref');
  ELSE
    NEW.distance_bonus_cents := NULL;
  END IF;

  NEW.flags := v_flags;
  RETURN NEW;
END;
$function$;

-- Backfill existing SU26 published assignments.
UPDATE public.camp_assignments
SET instructor_id = instructor_id
WHERE published_at IS NOT NULL;
