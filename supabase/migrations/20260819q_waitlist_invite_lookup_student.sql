-- waitlist_invite_lookup must return the STUDENT the invite belongs to.
--
-- Two defects, one missing column.
--
-- 1. EVERY accepted invite created a duplicate child. The accept page hands the family
--    into ordinary registration, and create-registration's child loop inserts a fresh
--    `students` row unconditionally. So the child who joined the waiting list in June and
--    the child who took the place in August were two different student rows for one human:
--    two roster entries, split attendance, and `uniq_registrations_waitlist_student`
--    (which exists precisely to stop one child holding two places) unable to see they were
--    the same child. 100% of accepted invites, not an edge case.
--
-- 2. The invite token bought a seat for ANY child. The seat credit in
--    create-registration was keyed on program + org only, so a FORWARDED link let a
--    stranger type their own child's name and take the held seat - and the consume step
--    then cancelled the invited family's row, with no notice to them.
--
-- Both close the same way: the invited child's identity has to come from the TOKEN, not
-- from the browser's payload. So the lookup returns `student_id`, create-registration
-- reuses that student for the invited child instead of inserting one, and the held seat is
-- credited only to a cart line that is actually bound to it.
--
-- DROP AND RECREATE, NOT `create or replace`. Adding a column to a RETURNS TABLE changes
-- the function's output type, which Postgres refuses to do in place ("cannot change return
-- type of existing function"). The drop is safe here and is NOT the hazard 20260819i has:
-- this function has anon and authenticated REVOKED (service_role only), so no anon grant
-- is being pulled out from under a live page. The grants are re-applied below in the same
-- transaction, so there is no window where service_role cannot call it.

drop function if exists public.waitlist_invite_lookup(text);

create function public.waitlist_invite_lookup(p_token text)
returns table (
  registration_id   uuid,
  program_id        uuid,
  organization_id   uuid,
  org_slug          text,
  expires_at        timestamptz,
  program_name      text,
  site_name         text,
  -- The child this place is being held for. NOT returned to the browser by
  -- waitlist-accept: it is used server-side, inside create-registration, so the
  -- registration that finishes the job attaches to the child who has been waiting
  -- rather than to a second copy of them.
  student_id        uuid,
  child_first_name  text,
  child_last_name   text,
  child_grade       integer,
  parent_first_name text,
  parent_last_name  text,
  parent_email      text,
  parent_phone      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.program_id, r.organization_id, o.slug,
         r.waitlist_invite_expires_at,
         p.curriculum, pl.name,
         r.student_id,
         s.first_name, s.last_name, s.grade,
         pa.first_name, pa.last_name, pa.email, pa.phone
  from registrations r
  join organizations o on o.id = r.organization_id
  join programs p on p.id = r.program_id
  left join program_locations pl on pl.id = p.program_location_id
  join students s on s.id = r.student_id
  join parents pa on pa.id = r.parent_id
  where r.waitlist_invite_token = p_token
    and r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    and r.waitlist_invite_expires_at > now()
    -- An empty or whitespace token must never match. Belt and braces: the column is
    -- NULL on every uninvited row, so `= ''` could not match anyway, but a future
    -- backfill writing '' would silently hand every waitlist row to anyone.
    and coalesce(nullif(btrim(p_token), ''), null) is not null;
$$;

comment on function public.waitlist_invite_lookup(text) is
  'Resolve a waitlist invite token to the one registration it belongs to, with the prefill the accept page needs and the student_id the checkout path needs. Returns NO ROWS for an unknown, expired, spent or cancelled token - the page words those identically on purpose, so a response cannot confirm a token once existed. The token IS the credential here: this is how an invited family, who has no account, reads a row that RLS otherwise hides. student_id is deliberately NOT forwarded to the browser by waitlist-accept; it exists so create-registration can register the child who has been waiting instead of inserting a duplicate of them, and so the held seat is credited to that child alone. SECURITY DEFINER, service_role only - reached through the public waitlist-accept endpoint.';

revoke all on function public.waitlist_invite_lookup(text) from public;
revoke execute on function public.waitlist_invite_lookup(text) from anon;
revoke execute on function public.waitlist_invite_lookup(text) from authenticated;
grant execute on function public.waitlist_invite_lookup(text) to service_role;
