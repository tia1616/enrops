-- waitlist_join must not signal "the class has room" with P0001.
--
-- P0001 is the SQLSTATE Postgres assigns to ANY bare `raise exception 'msg'` with no
-- explicit errcode - it is the default, not a code that means anything in particular. So
-- using it as the private signal for one specific business outcome ("class still has room,
-- register instead") means that outcome is indistinguishable from any other bare exception
-- raised anywhere in the call: a future guard added to this function, or a trigger that
-- fires on the registrations INSERT and raises without a code, all arrive at the caller as
-- P0001. join-waitlist then tells the family "that class has room after all, go register" -
-- when the join actually failed. They go to register, the class is full, and nothing
-- explains it.
--
-- waitlist_offer_next was already moved off P0001/P0002 onto the private class WL001/WL002
-- (20260819v). This is the same fix for the join pair, which that pass missed: give the
-- "has room" outcome its own code, WL003, so anything else surfacing as a bare P0001 falls
-- through to the caller's generic "could not add you, please try again" - the safe message -
-- instead of the confident, wrong one.
--
-- Nothing else changes. The 42501 ("not this org's / not open / not ours to sell") stays,
-- because 42501 = insufficient_privilege is a real, specific SQLSTATE whose meaning matches
-- the case and is not the accidental default. Only the overloaded P0001 moves.

create or replace function public.waitlist_join(p_program_id uuid, p_parent_id uuid, p_student_id uuid, p_org_id uuid)
 returns table(waitlist_position integer, registration_id uuid)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_is_full  boolean;
  v_next     integer;
  v_reg_id   uuid;
  v_existing record;
begin
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  select sc.is_full into v_is_full
  from program_seat_counts(array[p_program_id]) sc
  join programs p on p.id = sc.program_id
  where p.organization_id = p_org_id
    and p.status = 'open'
    and coalesce(p.runs_own_registration, false) = false;

  if v_is_full is null then
    raise exception 'waitlist_join: program % is not this organisation''s, not open, or not ours to sell', p_program_id
      using errcode = '42501';
  end if;

  if not v_is_full then
    -- WL003, a PRIVATE code - NOT P0001, which is the default for any bare raise and so
    -- cannot be told apart from an unrelated failure. See the header.
    raise exception 'waitlist_join: program % still has room - register instead of waitlisting', p_program_id
      using errcode = 'WL003';
  end if;

  select r.id, r.waitlist_position into v_existing
  from registrations r
  where r.program_id = p_program_id
    and r.student_id = p_student_id
    and r.status = 'waitlist'
    and r.cancelled_at is null
  limit 1;

  if v_existing.id is not null then
    return query select v_existing.waitlist_position, v_existing.id;
    return;
  end if;

  select coalesce(max(r.waitlist_position), 0) + 1 into v_next
  from registrations r
  where r.program_id = p_program_id
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  insert into registrations (
    program_id, student_id, parent_id, organization_id,
    status, payment_status, amount_cents, waitlist_position
  )
  values (
    p_program_id, p_student_id, p_parent_id, p_org_id,
    'waitlist', 'unpaid', 0, v_next
  )
  returning id into v_reg_id;

  return query select v_next, v_reg_id;
end;
$function$;

comment on function public.waitlist_join(uuid, uuid, uuid, uuid) is
  'Atomically place a child on an afterschool program''s waitlist and return their position. Per-program advisory lock so concurrent joins cannot collide on a position. Re-validates same-org / open / not-partner-run / actually-full, and is idempotent for a child already live on the list (cancelled_at is null, so a removed family rejoins at the back). Raises 42501 when the program is not this org''s / not open / not ours to sell, and WL003 - a PRIVATE code, not the default-bare-raise P0001 - when the class still has room and the family should register instead. A row created here holds NO seat. SECURITY DEFINER, service_role only.';

revoke all on function public.waitlist_join(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.waitlist_join(uuid, uuid, uuid, uuid) from anon;
revoke execute on function public.waitlist_join(uuid, uuid, uuid, uuid) from authenticated;
grant execute on function public.waitlist_join(uuid, uuid, uuid, uuid) to service_role;
