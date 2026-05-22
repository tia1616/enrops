-- The $50 distance/availability bonus should pay once per series (instructor +
-- cycle + location + curriculum), not once per week. Multi-week camps like
-- Lacamas (Wks 4-7 robotics) were paying 4x.
--
-- Logic: find the lowest week_num across all of THIS instructor's assignments
-- to the same (cycle, location, curriculum). The "series anchor" — the row
-- with the lowest week_num — gets the bonus. Other rows still carry the
-- location flag (so the calendar still shows the yellow/orange chip), they
-- just don't earn the bonus a second time.
--
-- Known edge case (deferred — option B per 2026-05-22 discussion): if admin
-- reassigns just the anchor row mid-series to someone else, the remaining
-- siblings don't auto-recompute. To fix, an admin can either (a) re-save
-- the new anchor row (any UPDATE OF instructor_id|camp_session_id re-fires
-- this trigger), or (b) run a manual recompute we can add later.
--
-- Applied 2026-05-22.

CREATE OR REPLACE FUNCTION public.compute_distance_bonus()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
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
$function$;

-- Backfill: touch every assignment with an instructor so the trigger re-fires.
-- The setter-to-itself pattern is safe and idempotent.
UPDATE public.camp_assignments
SET instructor_id = instructor_id
WHERE instructor_id IS NOT NULL;
