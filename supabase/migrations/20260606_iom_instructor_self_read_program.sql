-- Gap found in the 2026-06-06 BGC/sensitive-data review: the instructor self-read
-- policy on instructor_offer_messages only covered camp_assignment_id, so a real
-- (non-impersonated) after-school instructor could not read their own offer thread
-- (admin replies) — program_assignment_id rows were RLS-blocked. Add program coverage.
-- (The matching INSERT path is the service-role respond-to-assignment edge fn, which
-- bypasses RLS, so no instructor INSERT policy change is needed.)
create policy instructor_self_iom_read_program
  on public.instructor_offer_messages
  for select
  using (
    program_assignment_id in (
      select pa.id
      from public.program_assignments pa
      join public.instructors i on i.id = pa.instructor_id
      where i.auth_user_id = auth.uid()
    )
  );
