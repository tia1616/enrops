-- Chunk 1: a family can join the waitlist for a full afterschool class.
--
-- Decisions (Jessica, 2026-08-19): afterschool only; light join form (child + parent
-- contact, no payment); joining creates a parent account; auto-invite the top of the
-- list when a seat opens (that part is chunk 2).
--
-- Existing scaffolding this uses rather than reinventing: registrations.status already
-- allows 'waitlist' in its CHECK, registrations.waitlist_position already exists, and
-- registration_holds_seat() already returns FALSE for 'waitlist' - so a waitlist row
-- does not occupy a seat and the capacity gate ignores it. Nothing there needed changing.
--
-- SUPERSEDED, 20260819f (same day, later): registration_holds_seat() no longer returns
-- false for every waitlist row. One carrying an unexpired invite DOES hold a seat, so an
-- offered place cannot be sold out from under the family deciding on it. A row this
-- function creates still holds nothing, because it sets no invite columns.

-- ---------------------------------------------------------------------------
-- 1. One waitlist row per child per class.
--
-- There is NO unique index on (program_id, student_id) for afterschool today - only
-- uniq_registrations_camp_student, which is camps-only. That absence is exactly how one
-- child ended up holding NINE rows on the same class (create-registration inserts
-- students rather than upserting, so every checkout retry made a fresh pair). A waitlist
-- must not inherit that.
--
-- PARTIAL, on status='waitlist' only. It deliberately does NOT constrain paid
-- registrations: fixing the duplicate-paid-rows problem is a separate change with its own
-- backfill question (prod has real duplicates today), and widening this index to cover
-- them would fail to create.
create unique index if not exists uniq_registrations_waitlist_student
  on public.registrations (program_id, student_id)
  where status = 'waitlist';

-- ---------------------------------------------------------------------------
-- 2. Atomic join.
--
-- Position assignment is a read-max-then-insert, which is the same race the capacity
-- gate could not close in the edge function. Here it CAN be closed, because the whole
-- thing is one statement in one transaction: take a per-program advisory lock, then
-- compute and insert. Two families joining the same instant get 4 and 5, never 4 and 4.
--
-- SECURITY DEFINER because the caller is the public join endpoint holding the service
-- role, and because it must read seat counts that RLS hides. service_role EXECUTE only.
--
-- It re-validates everything rather than trusting the caller: same-org, published, ours
-- to sell, and ACTUALLY FULL. That last one matters - offering a waitlist for a class
-- with room would strand a family who could simply have registered.
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
  -- Serialise joins for THIS program only.
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  -- The class must be this org's, open, ours to sell, and full.
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
  -- Rejoining is a normal thing for a family to try when they are unsure it worked.
  select r.id, r.waitlist_position into v_existing
  from registrations r
  where r.program_id = p_program_id
    and r.student_id = p_student_id
    and r.status = 'waitlist'
  limit 1;

  if v_existing.id is not null then
    return query select v_existing.waitlist_position, v_existing.id;
    return;
  end if;

  -- Next place in line. Counts only live waitlist rows, so a family who was invited or
  -- withdrew does not leave a hole that shifts everyone else's number.
  select coalesce(max(r.waitlist_position), 0) + 1 into v_next
  from registrations r
  where r.program_id = p_program_id and r.status = 'waitlist';

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
  'Atomically place a child on an afterschool program''s waitlist and return their position. Takes a per-program advisory lock so concurrent joins cannot collide on a position. Re-validates same-org / open / not-partner-run / actually-full rather than trusting the caller, and is idempotent for a child already on the list. Waitlist rows do NOT hold a seat: registration_holds_seat() returns false for status=waitlist. SECURITY DEFINER, service_role only - called by the public join endpoint.';

revoke all on function public.waitlist_join(uuid, uuid, uuid, uuid) from public;
revoke execute on function public.waitlist_join(uuid, uuid, uuid, uuid) from anon;
revoke execute on function public.waitlist_join(uuid, uuid, uuid, uuid) from authenticated;
grant execute on function public.waitlist_join(uuid, uuid, uuid, uuid) to service_role;
