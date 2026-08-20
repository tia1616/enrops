-- Take a family off the waiting list, because we told them in writing that we would.
--
-- The confirmation email says: "If your plans change and you would rather come off the
-- list, just reply to this email and we will take care of it." That reply lands in the
-- PROVIDER's inbox, and until now there was nothing they could do with it - the roster's
-- waiting list is read-only, so honouring the promise meant hand-written SQL. Jessica's
-- call, 2026-08-19: make the promise true.
--
-- The operator does it, not the family. That matches what the email actually promises
-- ("reply and WE will take care of it") and needs no parent-facing auth, no token, and no
-- second surface. A family-facing unsubscribe link is a bigger change than the promise
-- requires.
--
-- WHY status='cancelled' AND NOT cancelled_at ALONE.
-- Setting cancelled_at while leaving status='waitlist' looks tidier and is a trap. Two
-- objects key on status='waitlist' with no regard for cancelled_at:
--   * uniq_registrations_waitlist_student (20260819d) - the removed row would keep
--     occupying the one-per-child slot, so the family could never rejoin.
--   * waitlist_join's idempotency SELECT - it would find the removed row and hand back
--     its stale position, telling a family they are number 4 on a list the operator
--     cannot see (ProgramRoster filters cancelled_at is null).
-- Moving the status out of 'waitlist' clears both by construction rather than by adding
-- two more predicates that the next reader has to remember. It also means every existing
-- "not cancelled" reader excludes the row for free.

create or replace function public.waitlist_remove(
  p_registration_id uuid,
  p_org_id          uuid
)
returns table (removed boolean, remaining integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program uuid;
  v_n       integer;
begin
  -- AUTHORISATION FIRST, and on the ORG THE ROW ACTUALLY BELONGS TO - not on the org id
  -- the caller passed. Trusting p_org_id would let any editor of org A remove org B's
  -- waitlist rows by passing their own org id with someone else's registration id.
  select r.program_id into v_program
  from registrations r
  where r.id = p_registration_id
    and r.organization_id = p_org_id
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  if v_program is null then
    -- Already removed, never on the list, or not this org's. Same answer for all three:
    -- do not confirm or deny the row's existence to a caller who cannot see it.
    return query select false, 0;
    return;
  end if;

  if not can_edit_org(p_org_id) then
    raise exception 'waitlist_remove: not permitted for organisation %', p_org_id
      using errcode = '42501';
  end if;

  -- Serialise against joins and other removals on this program, so a concurrent join
  -- cannot take a position number this statement is about to reassign.
  perform pg_advisory_xact_lock(hashtext('waitlist:' || v_program::text));

  update registrations
     set status       = 'cancelled',
         cancelled_at = now(),
         -- CLEAR ANY LIVE INVITE. A removed family must stop holding the seat
         -- immediately: registration_holds_seat() counts a waitlist row whose
         -- waitlist_invite_expires_at is in the future, and leaving that set on a
         -- cancelled row would keep a chair reserved for someone who has left. The
         -- status change alone already drops it out of the rule's waitlist branch, but
         -- leaving a live token behind would also let the invite link still resolve.
         waitlist_invited_at        = null,
         waitlist_invite_expires_at = null,
         waitlist_invite_token      = null,
         waitlist_position          = null
   where id = p_registration_id;

  -- CLOSE THE GAP. Positions are what the family was told and what the operator reads,
  -- so leaving 1,3,4 after removing 2 makes both distrust the list. Renumber the
  -- survivors in their existing order; everyone behind the removed family moves up,
  -- which is both correct and the direction a family is happy to hear about.
  with ordered as (
    select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
    from registrations r
    where r.program_id = v_program
      and r.status = 'waitlist'
      and r.cancelled_at is null
  )
  update registrations r
     set waitlist_position = o.pos
    from ordered o
   where r.id = o.id
     and r.waitlist_position is distinct from o.pos;

  select count(*) into v_n
  from registrations r
  where r.program_id = v_program
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  return query select true, v_n;
end;
$$;

comment on function public.waitlist_remove(uuid, uuid) is
  'Take one family off a program waiting list, and renumber the rest so positions stay 1..N with no gaps. Sets status=cancelled (NOT cancelled_at alone - see the migration header: two objects key on status=waitlist and would strand the row) and clears any live invite so a removed family stops holding a seat. Authorises with can_edit_org on the row''s OWN organisation, never on the caller-supplied id. Returns (removed, remaining); removed=false for a row that is already gone or not this org''s. SECURITY DEFINER, authenticated only - called from the program roster.';

revoke all on function public.waitlist_remove(uuid, uuid) from public;
revoke execute on function public.waitlist_remove(uuid, uuid) from anon;
grant execute on function public.waitlist_remove(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Defence in depth on the join side.
--
-- With removal writing status='cancelled' the two stranding paths described above cannot
-- happen. But waitlist_join's idempotency SELECT should not DEPEND on that being the only
-- way a row ever gets cancelled - a future admin edit, a bulk fix or a data repair could
-- set cancelled_at and leave the status alone. Requiring cancelled_at is null costs
-- nothing and makes the function correct under both conventions.
-- ---------------------------------------------------------------------------

create or replace function public.waitlist_join(
  p_program_id uuid,
  p_parent_id  uuid,
  p_student_id uuid,
  p_org_id     uuid
)
returns table (waitlist_position integer, registration_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    raise exception 'waitlist_join: program % still has room - register instead of waitlisting', p_program_id
      using errcode = 'P0001';
  end if;

  -- Already on this list? Return the existing place rather than erroring or duplicating.
  -- cancelled_at is null: a family who was REMOVED must be able to rejoin at the back of
  -- the line, not be handed the position they had when they left.
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

  -- Next place in line, counting only LIVE rows for the same reason.
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
$$;

comment on function public.waitlist_join(uuid, uuid, uuid, uuid) is
  'Atomically place a child on an afterschool program''s waitlist and return their position. Takes a per-program advisory lock so concurrent joins cannot collide on a position. Re-validates same-org / open / not-partner-run / actually-full rather than trusting the caller, and is idempotent for a child already on the list. Only LIVE rows count for idempotency and numbering, so a family removed via waitlist_remove rejoins at the back of the line. A row created here holds NO seat: it carries no invite, and registration_holds_seat() only counts a waitlist row while waitlist_invite_expires_at is in the future (see 20260819f). SECURITY DEFINER, service_role only - called by the public join endpoint.';

revoke all on function public.waitlist_join(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.waitlist_join(uuid, uuid, uuid, uuid) from anon;
revoke execute on function public.waitlist_join(uuid, uuid, uuid, uuid) from authenticated;
grant execute on function public.waitlist_join(uuid, uuid, uuid, uuid) to service_role;
