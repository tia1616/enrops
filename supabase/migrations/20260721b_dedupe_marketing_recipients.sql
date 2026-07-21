-- One row per person: merge duplicate marketing_recipients and change the
-- unique key from (organization_id, email, school_name, source) to
-- (organization_id, email).
--
-- Root cause of duplicate sends: the old 4-column key lets the same email
-- appear under multiple source/school combos. The send dedup checks by
-- recipient_id (row UUID), so each row got its own email — 3,722 excess
-- emails across 3 campaigns as of 2026-07-21.
--
-- Steps: pick survivor → enrich → remap FKs → delete dupes → swap constraint
-- → rewrite trigger.

BEGIN;

-- ── 0. Drop old constraint first so enrichment UPDATEs don't collide ────────
-- (Setting a survivor's school_name to a sibling's value would violate the
-- old 4-column key while the sibling row still exists.)
ALTER TABLE marketing_recipients
  DROP CONSTRAINT marketing_recipients_organization_id_email_school_name_sour_key;

-- ── 1. Build dedupe map ─────────────────────────────────────────────────────
-- Survivor = registration-source preferred, then most recently updated.
CREATE TEMP TABLE _dedupe_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id, organization_id, lower(email) AS email_lc,
    row_number() OVER (
      PARTITION BY organization_id, lower(email)
      ORDER BY
        CASE source
          WHEN 'enrops_registration' THEN 1
          WHEN 'squarespace_summer'  THEN 2
          WHEN 'am_afterschool'      THEN 3
          WHEN 'import'              THEN 4
          ELSE 5
        END,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST
    ) AS rn
  FROM marketing_recipients
)
SELECT r.id AS survivor_id, d.id AS doomed_id
FROM ranked r
JOIN ranked d
  ON  d.organization_id = r.organization_id
  AND d.email_lc        = r.email_lc
  AND d.rn > 1
WHERE r.rn = 1;

-- All member IDs per group (survivor + its doomed siblings)
CREATE TEMP TABLE _groups ON COMMIT DROP AS
SELECT DISTINCT survivor_id, survivor_id AS member_id FROM _dedupe_map
UNION ALL
SELECT survivor_id, doomed_id FROM _dedupe_map;

-- ── 2a. Enrich survivors: scalar fields ─────────────────────────────────────
-- COALESCE(survivor.X, best_from_siblings.X) — never overwrites existing data.
UPDATE marketing_recipients surv
SET
  parent_name      = COALESCE(surv.parent_name,      e.parent_name),
  phone            = COALESCE(surv.phone,             e.phone),
  child_first_name = COALESCE(surv.child_first_name,  e.child_first_name),
  child_last_name  = COALESCE(surv.child_last_name,   e.child_last_name),
  school_name      = COALESCE(surv.school_name,       e.school_name),
  geo_segment      = COALESCE(surv.geo_segment,       e.geo_segment),
  city             = COALESCE(surv.city,              e.city),
  zip              = COALESCE(surv.zip,               e.zip)
FROM (
  SELECT
    g.survivor_id,
    (array_agg(mr.parent_name ORDER BY
       CASE mr.source WHEN 'enrops_registration' THEN 1 ELSE 2 END,
       mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.parent_name IS NOT NULL AND mr.parent_name <> ''))[1] AS parent_name,
    (array_agg(mr.phone ORDER BY
       CASE mr.source WHEN 'enrops_registration' THEN 1 ELSE 2 END,
       mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.phone IS NOT NULL AND mr.phone <> ''))[1] AS phone,
    (array_agg(mr.child_first_name ORDER BY
       CASE mr.source WHEN 'enrops_registration' THEN 1 ELSE 2 END,
       mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.child_first_name IS NOT NULL AND mr.child_first_name <> ''))[1] AS child_first_name,
    (array_agg(mr.child_last_name ORDER BY
       CASE mr.source WHEN 'enrops_registration' THEN 1 ELSE 2 END,
       mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.child_last_name IS NOT NULL AND mr.child_last_name <> ''))[1] AS child_last_name,
    (array_agg(mr.school_name ORDER BY
       CASE mr.source WHEN 'enrops_registration' THEN 1 ELSE 2 END,
       mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.school_name IS NOT NULL AND mr.school_name <> ''))[1] AS school_name,
    (array_agg(mr.geo_segment ORDER BY
       CASE mr.source WHEN 'enrops_registration' THEN 1 ELSE 2 END,
       mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.geo_segment IS NOT NULL AND mr.geo_segment <> ''))[1] AS geo_segment,
    (array_agg(mr.city ORDER BY mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.city IS NOT NULL AND mr.city <> ''))[1] AS city,
    (array_agg(mr.zip ORDER BY mr.updated_at DESC NULLS LAST)
     FILTER (WHERE mr.zip IS NOT NULL AND mr.zip <> ''))[1] AS zip
  FROM _groups g
  JOIN marketing_recipients mr ON mr.id = g.member_id
  GROUP BY g.survivor_id
) e
WHERE surv.id = e.survivor_id;

-- ── 2b. Enrich survivors: merge tags ────────────────────────────────────────
WITH all_tags AS (
  SELECT g.survivor_id, t
  FROM _groups g
  JOIN marketing_recipients mr ON mr.id = g.member_id
  CROSS JOIN LATERAL unnest(COALESCE(mr.tags, '{}')) AS t
  WHERE t IS NOT NULL AND t <> ''
),
merged AS (
  SELECT survivor_id, array_agg(DISTINCT t ORDER BY t) AS tags
  FROM all_tags
  GROUP BY survivor_id
)
UPDATE marketing_recipients surv
SET tags = COALESCE(m.tags, '{}')
FROM merged m
WHERE surv.id = m.survivor_id;

-- ── 2c. Enrich survivors: merge segments ────────────────────────────────────
WITH all_segs AS (
  SELECT g.survivor_id, s
  FROM _groups g
  JOIN marketing_recipients mr ON mr.id = g.member_id
  CROSS JOIN LATERAL unnest(COALESCE(mr.segments, '{}')) AS s
  WHERE s IS NOT NULL AND s <> ''
),
merged AS (
  SELECT survivor_id, array_agg(DISTINCT s ORDER BY s) AS segments
  FROM all_segs
  GROUP BY survivor_id
)
UPDATE marketing_recipients surv
SET segments = COALESCE(m.segments, '{}')
FROM merged m
WHERE surv.id = m.survivor_id;

-- ── 3. Remap marketing_sends FK ─────────────────────────────────────────────
UPDATE marketing_sends ms
SET recipient_id = dm.survivor_id
FROM _dedupe_map dm
WHERE ms.recipient_id = dm.doomed_id;

-- ── 4. Fix approved_recipient_ids arrays ────────────────────────────────────
-- Replace doomed IDs with their survivor, deduplicate.
UPDATE marketing_campaigns mc
SET approved_recipient_ids = (
  SELECT array_agg(DISTINCT mapped_id)
  FROM (
    SELECT COALESCE(dm.survivor_id, aid) AS mapped_id
    FROM unnest(mc.approved_recipient_ids) AS aid
    LEFT JOIN _dedupe_map dm ON dm.doomed_id = aid
  ) sub
  WHERE mapped_id IS NOT NULL
)
WHERE mc.approved_recipient_ids && (SELECT array_agg(doomed_id) FROM _dedupe_map);

-- ── 5. Delete non-survivor rows ─────────────────────────────────────────────
DELETE FROM marketing_recipients
WHERE id IN (SELECT doomed_id FROM _dedupe_map);

-- ── 6. Add new unique constraint (old one dropped in step 0) ────────────────
ALTER TABLE marketing_recipients
  ADD CONSTRAINT marketing_recipients_org_email_unique
  UNIQUE (organization_id, email);

-- ── 7. Rewrite registration trigger ─────────────────────────────────────────
-- ON CONFLICT DO NOTHING → DO UPDATE: re-registering parents get their
-- contact enriched (school, phone, child name) instead of silently skipped.
CREATE OR REPLACE FUNCTION public.auto_add_registrant_to_marketing_list()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
declare
  v_auto_enabled  boolean;
  v_parent_email  text;
  v_parent_name   text;
  v_parent_phone  text;
  v_child_first   text;
  v_child_last    text;
  v_school_name   text;
  v_area          text;
begin
  if (TG_OP = 'UPDATE') then
    if NEW.status is not distinct from OLD.status then return NEW; end if;
  end if;
  if NEW.status is null or NEW.status <> 'confirmed' then return NEW; end if;

  select auto_subscribe_registrants into v_auto_enabled
  from organizations where id = NEW.organization_id;
  if v_auto_enabled is not true then return NEW; end if;

  select p.email,
         nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         nullif(trim(coalesce(p.phone, '')), '')
    into v_parent_email, v_parent_name, v_parent_phone
  from parents p where p.id = NEW.parent_id;
  if v_parent_email is null then return NEW; end if;

  select s.first_name, s.last_name
    into v_child_first, v_child_last
  from students s
  where s.id = NEW.student_id
    and s.organization_id = NEW.organization_id;

  if NEW.program_id is not null then
    select pl.name, nullif(trim(coalesce(pl.area, '')), '')
      into v_school_name, v_area
    from programs pr
    join program_locations pl
      on pl.id = pr.program_location_id
     and pl.organization_id = NEW.organization_id
    where pr.id = NEW.program_id
      and pr.organization_id = NEW.organization_id;
  elsif NEW.camp_session_id is not null then
    select coalesce(pl.name, cs.location_name), nullif(trim(coalesce(pl.area, '')), '')
      into v_school_name, v_area
    from camp_sessions cs
    left join program_locations pl
      on pl.id = cs.location_id
     and pl.organization_id = NEW.organization_id
    where cs.id = NEW.camp_session_id
      and cs.organization_id = NEW.organization_id;
  end if;

  if v_school_name is null then
    select pl.name, nullif(trim(coalesce(pl.area, '')), '')
      into v_school_name, v_area
    from students s
    join program_locations pl
      on pl.id = s.program_location_id
     and pl.organization_id = NEW.organization_id
    where s.id = NEW.student_id
      and s.organization_id = NEW.organization_id;
  end if;

  insert into marketing_recipients (
    organization_id, email, parent_name, phone, child_first_name, child_last_name,
    school_name, geo_segment, source, segments
  )
  values (
    NEW.organization_id,
    lower(v_parent_email),
    v_parent_name,
    v_parent_phone,
    v_child_first,
    v_child_last,
    v_school_name,
    v_area,
    'enrops_registration',
    array['registrant']::text[]
  )
  on conflict (organization_id, email) do update set
    parent_name      = coalesce(excluded.parent_name,      marketing_recipients.parent_name),
    phone            = coalesce(excluded.phone,             marketing_recipients.phone),
    child_first_name = coalesce(excluded.child_first_name,  marketing_recipients.child_first_name),
    child_last_name  = coalesce(excluded.child_last_name,   marketing_recipients.child_last_name),
    school_name      = coalesce(excluded.school_name,       marketing_recipients.school_name),
    geo_segment      = coalesce(excluded.geo_segment,       marketing_recipients.geo_segment),
    source           = case
                         when excluded.source = 'enrops_registration' then 'enrops_registration'
                         else coalesce(marketing_recipients.source, excluded.source)
                       end,
    segments         = (
      select coalesce(array_agg(distinct s order by s), '{}')
      from unnest(
        coalesce(excluded.segments, '{}') || coalesce(marketing_recipients.segments, '{}')
      ) s
      where s is not null and s <> ''
    );

  return NEW;
end;
$fn$;

COMMIT;
