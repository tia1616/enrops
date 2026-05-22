-- Instructor Portal v1, Chunk A: atomic emergency-contact replace primitive.
--
-- 1) RPC replace_emergency_contacts(uuid, uuid, jsonb)
--    SECURITY DEFINER so it runs as owner; search_path pinned to prevent
--    hijacking. The function does NOT authenticate -- the caller (the
--    edge function update-instructor-profile, via service_role) has already
--    resolved and authorized the instructor before invoking this.
--    Delete + insert run inside the function body's implicit transaction so
--    a thrown error rolls back the delete (no zero-contacts gap).
--
-- 2) REVOKE/GRANT -- close the SECURITY DEFINER privilege escalation
--    foot-gun. Default Postgres grants EXECUTE on functions to PUBLIC; with
--    SECURITY DEFINER that means any authenticated user (or anon) could
--    invoke this via PostgREST RPC with arbitrary p_instructor_id and wipe
--    that target's contacts. Lock execution to service_role only.
--
-- 3) instructor_delete_ec policy -- defense-in-depth DELETE policy on
--    contractor_emergency_contacts. Not on the live write path (the RPC
--    uses SECURITY DEFINER, edge function uses service_role; both bypass
--    RLS). Exists so any future direct-client code doesn't silently fail
--    or expose another instructor's contacts.
--
-- Applied 2026-05-22.

create or replace function public.replace_emergency_contacts(
  p_instructor_id   uuid,
  p_organization_id uuid,
  p_contacts        jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c    jsonb;
  idx  int := 0;
begin
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

comment on function public.replace_emergency_contacts(uuid, uuid, jsonb) is
  'Atomic replace of an instructor''s emergency contacts. SECURITY DEFINER, search_path pinned. EXECUTE restricted to service_role; called only by the update-instructor-profile edge function after it has resolved + authorized the instructor. is_primary derived from array position (index 0 = true).';

revoke execute on function public.replace_emergency_contacts(uuid, uuid, jsonb) from public;
revoke execute on function public.replace_emergency_contacts(uuid, uuid, jsonb) from anon, authenticated;
grant  execute on function public.replace_emergency_contacts(uuid, uuid, jsonb) to service_role;

create policy instructor_delete_ec
  on public.contractor_emergency_contacts
  for delete
  using ( instructor_id = private.current_instructor_id() );
