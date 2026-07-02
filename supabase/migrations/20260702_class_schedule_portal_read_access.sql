-- Feed read-access for class_schedule (additive; staging + prod same pass).
--
-- 1. instructor_self_read_class_schedule: instructors read their OWN assigned
--    classes for the instructor portal. Instructors are NOT org_members, so the
--    members-only read policy hides their rows. Mirrors
--    instructor_self_assignments_read on camp_assignments.
--
-- 2. class_schedule_public: family-facing "what's happening" for outside-
--    registration tenants (their families have no Enrops account, so this shows
--    on the public /:slug page). A VIEW exposes ONLY safe columns — never
--    instructor_email / notes / instructor_id — scoped to publicly-listed orgs.
--    This is a SECURITY DEFINER view by design (same pattern as
--    public_org_directory): controlled public projection of an RLS-protected
--    table. A blanket public read policy would instead expose every column
--    (incl. coach email) to anon, which we explicitly do not want.

drop policy if exists instructor_self_read_class_schedule on public.class_schedule;
create policy instructor_self_read_class_schedule on public.class_schedule
  for select using (
    instructor_id in (select id from instructors where auth_user_id = auth.uid())
  );

create or replace view public.class_schedule_public as
  select
    cs.id,
    cs.organization_id,
    cs.title,
    cs.day_of_week,
    cs.start_time,
    cs.end_time,
    cs.location_text,
    cs.age_min,
    cs.age_max,
    cs.capacity
  from public.class_schedule cs
  where cs.status = 'active'
    and cs.organization_id in (select id from public_org_directory);

grant select on public.class_schedule_public to anon, authenticated;
