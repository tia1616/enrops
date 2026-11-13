-- Subs get the same travel-time rule as the matcher (2026-11-13, Jessica: "sub
-- should have same limits").
--
-- Same day, DIFFERENT sites: the sub day must start at least
-- organizations.min_minutes_between_sites after anything else they have that
-- day ends (and vice versa). Same-site back-to-back stays fine. The rule is the
-- one match-afterschool applies (supabase/functions/_shared/siteGap.ts) and the
-- board applies (src/lib/scheduleConflicts.js tooCloseBetweenSites).
--
--   accept_sub_offer          HARD: refuses with outcome 'too_close' (the
--                             instructor's own accept is where a sub day is
--                             actually taken, so this is what makes it
--                             impossible rather than merely discouraged).
--   sub_availability_on_date  the picker: someone too close is is_working with
--                             working_reason 'too_close', so the modal moves
--                             them to "already working" and says why, and the
--                             picker and accept cannot disagree.
--
-- Both read the SAME two helpers below; instructor_commitments_on_date and
-- sub_slot_window are unchanged. ACLs: CREATE OR REPLACE keeps the existing
-- grants on the two replaced functions; the two new helpers are granted to
-- exactly the roles that call them (authenticated via the picker, service_role
-- via accept) and revoked from public AND anon (revoke from public alone does
-- not remove anon's EXECUTE on Supabase).

-- Which site an assignment (class OR camp) is at. Both point at
-- program_locations. A sub row's parent_assignment_id is either kind, and the
-- ids come from different tables, so trying both is unambiguous.
create or replace function public.site_of_assignment(p_assignment_id uuid)
returns uuid
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(
    (select pr.program_location_id
       from program_assignments pa
       join programs pr on pr.id = pa.program_id
      where pa.id = p_assignment_id),
    (select cs.location_id
       from camp_assignments ca
       join camp_sessions cs on cs.id = ca.camp_session_id
      where ca.id = p_assignment_id)
  );
$$;

-- The time test, with the gap applied only between DIFFERENT sites (a side with
-- no site counts as different: we cannot prove one building). Minutes, not
-- time + interval, so nothing wraps past midnight. Callers keep their own
-- NULL-time handling; this returns false when any time is unknown.
create or replace function public.slots_clash_with_site_gap(
  a_ts time, a_te time, a_site uuid,
  b_ts time, b_te time, b_site uuid,
  p_gap_min integer)
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case
    when a_ts is null or a_te is null or b_ts is null or b_te is null then false
    else (extract(epoch from a_ts) / 60) < (extract(epoch from b_te) / 60) + x.g
     and (extract(epoch from b_ts) / 60) < (extract(epoch from a_te) / 60) + x.g
  end
  from (select case when a_site is not null and a_site = b_site then 0
                    else greatest(coalesce(p_gap_min, 0), 0) end as g) x;
$$;

revoke all on function public.site_of_assignment(uuid) from public, anon;
revoke all on function public.slots_clash_with_site_gap(time, time, uuid, time, time, uuid, integer) from public, anon;
grant execute on function public.site_of_assignment(uuid) to authenticated, service_role;
grant execute on function public.slots_clash_with_site_gap(time, time, uuid, time, time, uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- accept_sub_offer: unchanged except the second check after the overlap one.
CREATE OR REPLACE FUNCTION public.accept_sub_offer(p_substitution_id uuid, p_sub_instructor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row     assignment_substitutions%ROWTYPE;
  v_losers  jsonb;
  v_ts      time;
  v_te      time;
  v_gap     integer;
  v_site    uuid;
BEGIN
  SELECT * INTO v_row FROM assignment_substitutions
   WHERE id = p_substitution_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_row.sub_instructor_id IS DISTINCT FROM p_sub_instructor_id THEN
    RETURN jsonb_build_object('outcome', 'forbidden');
  END IF;

  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'already_responded', 'status', v_row.status);
  END IF;

  -- The slot ON THIS DATE: an early-release day is a different window.
  SELECT w.ts, w.te INTO v_ts, v_te
    FROM sub_slot_window(v_row.parent_assignment_type, v_row.parent_assignment_id, v_row.date) w;

  IF v_ts IS NOT NULL AND v_te IS NOT NULL AND EXISTS (
    SELECT 1
      FROM instructor_commitments_on_date(p_sub_instructor_id, v_row.date) c
     WHERE c.ts IS NOT NULL AND c.te IS NOT NULL
       AND NOT (c.source = 'subbing' AND c.ref_id = v_row.parent_assignment_id)
       AND v_ts < c.te AND c.ts < v_te
  ) THEN
    RETURN jsonb_build_object('outcome', 'time_conflict');
  END IF;

  -- TRAVEL TIME BETWEEN SITES (20261113b). No overlap, but another school that
  -- day closer than the provider's minimum. FAILS CLOSED: the setting is NOT
  -- NULL on organizations, so a missing value means the org row itself was not
  -- found, and accepting without the rule would be the silent fallback this
  -- build exists to remove.
  SELECT o.min_minutes_between_sites INTO v_gap
    FROM organizations o WHERE o.id = v_row.organization_id;
  IF v_gap IS NULL THEN
    RAISE EXCEPTION 'accept_sub_offer: no min_minutes_between_sites for organization %', v_row.organization_id;
  END IF;
  v_site := site_of_assignment(v_row.parent_assignment_id);

  IF v_gap > 0 AND v_ts IS NOT NULL AND v_te IS NOT NULL AND EXISTS (
    SELECT 1
      FROM instructor_commitments_on_date(p_sub_instructor_id, v_row.date) c
     WHERE c.ts IS NOT NULL AND c.te IS NOT NULL
       AND NOT (c.source = 'subbing' AND c.ref_id = v_row.parent_assignment_id)
       AND slots_clash_with_site_gap(v_ts, v_te, v_site, c.ts, c.te, site_of_assignment(c.ref_id), v_gap)
  ) THEN
    RETURN jsonb_build_object('outcome', 'too_close', 'min_minutes', v_gap);
  END IF;

  BEGIN
    UPDATE assignment_substitutions
       SET status = 'confirmed', updated_at = now()
     WHERE id = p_substitution_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE assignment_substitutions
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
     WHERE id = p_substitution_id AND status = 'pending';
    RETURN jsonb_build_object('outcome', 'lost');
  END;

  WITH sib AS (
    SELECT s.id
      FROM assignment_substitutions s
     WHERE s.parent_assignment_id   = v_row.parent_assignment_id
       AND s.parent_assignment_type = v_row.parent_assignment_type
       AND s.date                   = v_row.date
       AND s.status = 'pending'
       AND s.id <> p_substitution_id
     FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE assignment_substitutions s
       SET status = 'declined', declined_at = now(),
           decline_reason = 'covered_by_other', updated_at = now()
      FROM sib
     WHERE s.id = sib.id
     RETURNING s.sub_instructor_id, s.email_sent_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sub_instructor_id', i.id,
           'email',             i.email,
           'first_name',        i.first_name,
           'preferred_name',    i.preferred_name
         )), '[]'::jsonb)
    INTO v_losers
    FROM upd JOIN instructors i ON i.id = upd.sub_instructor_id
   WHERE upd.email_sent_at IS NOT NULL;

  RETURN jsonb_build_object('outcome', 'won', 'losers', v_losers);
END;
$function$;

-- ---------------------------------------------------------------------------
-- sub_availability_on_date: adds gapcfg / target_site, a site on each booking,
-- and a too_close verdict that joins `working` behind the real overlaps.
CREATE OR REPLACE FUNCTION public.sub_availability_on_date(p_org uuid, p_date date, p_parent_type text, p_parent_assignment_id uuid)
 RETURNS TABLE(instructor_id uuid, is_working boolean, working_reason text, is_date_off boolean, day_time_match text, out_of_area boolean, tight_gap boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH d AS (
    SELECT p_date AS dt, EXTRACT(DOW FROM p_date)::int AS dow
  ),
  wk AS (
    SELECT
      (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(SELECT dow FROM d) + 1] AS key3
  ),
  tgt AS (
    SELECT
      (SELECT lower(trim(pl.district))
         FROM program_assignments pa
         JOIN programs pr ON pr.id = pa.program_id
         JOIN program_locations pl ON pl.id = pr.program_location_id
        WHERE pa.id = p_parent_assignment_id AND pl.district IS NOT NULL)           AS target_district,
      (SELECT cs.session_type
         FROM camp_assignments ca JOIN camp_sessions cs ON cs.id = ca.camp_session_id
        WHERE ca.id = p_parent_assignment_id)                                       AS target_session_type
  ),
  -- The slot ON THIS DATE (early release included) - the same window
  -- accept_sub_offer checks.
  target_win AS (
    SELECT w.ts, w.te
      FROM sub_slot_window(p_parent_type, p_parent_assignment_id, p_date) w
     LIMIT 1
  ),
  -- Travel time between sites (20261113b): the provider's minimum and the site
  -- of the day being covered. An unreadable minimum FAILS CLOSED as a full day
  -- (1440): everyone booked at another school that day reads as too close,
  -- rather than the picker quietly calling them free.
  gapcfg AS (
    SELECT coalesce((SELECT o.min_minutes_between_sites FROM organizations o WHERE o.id = p_org), 1440) AS g
  ),
  target_site AS (
    SELECT site_of_assignment(p_parent_assignment_id) AS s
  ),
  -- Everything that makes each person busy that date - the same function
  -- accept_sub_offer refuses on, so a name the picker shows as free cannot be
  -- refused at accept for a reason the picker did not see, and vice versa.
  booked AS (
    SELECT i.id AS instructor_id, c.source AS reason,
           CASE c.source WHEN 'teaching' THEN 1 WHEN 'camp' THEN 2 ELSE 3 END AS pri,
           c.ts AS s, c.te AS e, site_of_assignment(c.ref_id) AS site
      FROM instructors i
      CROSS JOIN LATERAL instructor_commitments_on_date(i.id, p_date) c
     WHERE i.organization_id = p_org
  ),
  cmp AS (
    SELECT b.instructor_id, b.reason, b.pri,
      (
        (SELECT ts FROM target_win) IS NULL
        OR (SELECT te FROM target_win) IS NULL
        OR b.s IS NULL OR b.e IS NULL
        OR ((SELECT ts FROM target_win) < b.e AND b.s < (SELECT te FROM target_win))
      ) AS is_conflict,
      slots_clash_with_site_gap(
        (SELECT ts FROM target_win), (SELECT te FROM target_win), (SELECT s FROM target_site),
        b.s, b.e, b.site,
        (SELECT g FROM gapcfg)
      ) AS within_gap,
      CASE
        WHEN b.s IS NOT NULL AND b.e IS NOT NULL
         AND (SELECT ts FROM target_win) IS NOT NULL
         AND (SELECT te FROM target_win) IS NOT NULL
        THEN CASE
               WHEN b.s >= (SELECT te FROM target_win)
                 THEN EXTRACT(EPOCH FROM (b.s - (SELECT te FROM target_win))) / 60
               ELSE EXTRACT(EPOCH FROM ((SELECT ts FROM target_win) - b.e)) / 60
             END
      END AS gap_min
    FROM booked b
    WHERE b.instructor_id IS NOT NULL
  ),
  -- A real overlap first (its own reason, by priority); then, for anyone with
  -- no overlap, 'too_close' when another school that day is inside the gap.
  working AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, reason
    FROM (
      SELECT instructor_id, reason, pri FROM cmp WHERE is_conflict
      UNION ALL
      SELECT instructor_id, 'too_close' AS reason, 10 AS pri FROM cmp WHERE NOT is_conflict AND within_gap
    ) x
    ORDER BY instructor_id, pri
  ),
  tight AS (
    SELECT DISTINCT instructor_id
    FROM cmp
    WHERE NOT is_conflict AND NOT within_gap AND gap_min IS NOT NULL AND gap_min < 60
  ),
  off_dates AS (
    SELECT instructor_id FROM instructor_term_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
    UNION
    SELECT instructor_id FROM instructor_availability
      WHERE organization_id = p_org AND (SELECT dt FROM d) = ANY(unavailable_dates)
  ),
  ita_latest AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, weekday_availability
    FROM instructor_term_availability
    WHERE organization_id = p_org
      AND weekday_availability IS NOT NULL AND weekday_availability <> '{}'::jsonb
    ORDER BY instructor_id, COALESCE(updated_at, submitted_at, created_at) DESC NULLS LAST
  ),
  ia_latest AS (
    SELECT DISTINCT ON (instructor_id) instructor_id, session_types
    FROM instructor_availability
    WHERE organization_id = p_org
      AND session_types IS NOT NULL AND array_length(session_types, 1) > 0
    ORDER BY instructor_id, COALESCE(updated_at, submitted_at, created_at) DESC NULLS LAST
  )
  SELECT
    i.id AS instructor_id,
    (w.instructor_id IS NOT NULL) AS is_working,
    w.reason AS working_reason,
    (o.instructor_id IS NOT NULL) AS is_date_off,
    CASE
      WHEN p_parent_type = 'program' THEN (
        CASE
          WHEN il.weekday_availability IS NULL THEN 'none'
          WHEN NOT jsonb_exists(il.weekday_availability, (SELECT key3 FROM wk)) THEN 'day'
          WHEN (SELECT ts FROM target_win) IS NOT NULL AND (
                 ((il.weekday_availability -> (SELECT key3 FROM wk) ->> 'from') IS NOT NULL
                    AND (SELECT ts FROM target_win) < (il.weekday_availability -> (SELECT key3 FROM wk) ->> 'from')::time)
              OR ((il.weekday_availability -> (SELECT key3 FROM wk) ->> 'until') IS NOT NULL
                    AND COALESCE((SELECT te FROM target_win), (SELECT ts FROM target_win)) > (il.weekday_availability -> (SELECT key3 FROM wk) ->> 'until')::time)
               ) THEN 'time'
          ELSE 'match'
        END
      )
      WHEN p_parent_type = 'camp' THEN (
        CASE
          WHEN ic.session_types IS NULL THEN 'none'
          WHEN (SELECT target_session_type FROM tgt) IS NULL THEN 'match'
          WHEN (SELECT target_session_type FROM tgt) = ANY(ic.session_types)
            OR ('full_day' = ANY(ic.session_types)
                 AND (SELECT target_session_type FROM tgt) IN ('morning', 'afternoon')) THEN 'match'
          ELSE 'time'
        END
      )
      ELSE 'none'
    END AS day_time_match,
    (
      p_parent_type = 'program'
      AND (SELECT target_district FROM tgt) IS NOT NULL
      AND jsonb_array_length(COALESCE(i.site_preferences -> 'districts', '[]'::jsonb)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(i.site_preferences -> 'districts') dd
        WHERE lower(trim(dd)) = (SELECT target_district FROM tgt)
      )
    ) AS out_of_area,
    (t.instructor_id IS NOT NULL AND w.instructor_id IS NULL) AS tight_gap
  FROM instructors i
  LEFT JOIN working w      ON w.instructor_id = i.id
  LEFT JOIN tight t        ON t.instructor_id = i.id
  LEFT JOIN off_dates o    ON o.instructor_id = i.id
  LEFT JOIN ita_latest il  ON il.instructor_id = i.id
  LEFT JOIN ia_latest ic   ON ic.instructor_id = i.id
  WHERE i.organization_id = p_org
    AND i.is_active IS DISTINCT FROM false;
$function$;
