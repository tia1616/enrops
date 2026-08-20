-- Two guards on waitlist_offer_next: an uncapped class must not jam its queue, and a hold
-- that has already run out must not be silently re-offered to the same family.
--
-- 1. NULL CAPACITY WAS STANDING IN FOR "NO ROW FOUND".
--
--    The function read max_capacity and seats_taken with SELECT INTO, then decided the
--    program was not this org's / not open / not ours to sell by testing `v_cap is null`.
--    But NULL max_capacity is a perfectly ordinary program - it means UNCAPPED, which the
--    capacity gate and program_seat_counts both treat as "never full". So clearing the
--    Capacity box on a class that has people waiting made every offer raise 42501, and the
--    queue stopped moving permanently: nobody is ever invited, nothing logs it as a
--    capacity problem, and the families sit there. An operator typing in the box and then
--    emptying it again is all it takes.
--
--    It also made the `v_cap is not null` half of the free-seat test at the bottom dead
--    code, which is why that line reads as though it handles uncapped classes and does not.
--
--    Fixed with plpgsql's own found-flag, which is what the test was reaching for: FOUND
--    answers "did the SELECT match a row", and says nothing about the VALUE of a column in
--    that row. The two questions are now asked separately.
--
-- 2. A LAPSED HOLD COULD BE RE-OFFERED FOREVER.
--
--    The top-of-list family is handed back untouched while their invite is live. But once
--    it has EXPIRED the function fell straight through and minted a brand new token for
--    the same family - re-offering a place to someone whose 24 hours already ran out, which
--    is the opposite of the decision that a lapsed family comes off the list.
--
--    That is only reachable when the expiry step has not yet cancelled the row: normally it
--    runs first in the same tick, but it can fail, and the sweep used to carry on to the
--    offer step regardless. The result was a loop that re-offered the same lapsed family on
--    every tick, and could email them a fresh invite each time.
--
--    So this refuses, with its own error code, rather than papering over it. P0002 means
--    "expiry has not caught up with this row yet"; the caller skips the program and the
--    next tick, with expiry working, does the right thing. Deliberately NOT silently
--    skipping to the next family in line: their positions have not been renumbered yet, so
--    "next" is not yet a question this function can answer correctly.

create or replace function public.waitlist_offer_next(
  p_program_id uuid,
  p_org_id     uuid,
  p_hold       interval default interval '24 hours'
)
returns table (
  registration_id   uuid,
  already_invited   boolean,
  invite_token      text,
  expires_at        timestamptz,
  parent_email      text,
  parent_first_name text,
  child_first_name  text,
  waitlist_position integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cap      integer;
  v_taken    bigint;
  v_row      record;
  v_token    text;
  v_expires  timestamptz;
begin
  -- One offer at a time per program. Shares the key with waitlist_join and
  -- waitlist_remove, so a join, a removal and an offer cannot interleave.
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  -- The class must be this org's, and still ours to sell.
  select sc.max_capacity, sc.seats_taken into v_cap, v_taken
  from program_seat_counts(array[p_program_id]) sc
  join programs p on p.id = sc.program_id
  where p.organization_id = p_org_id
    and p.status = 'open'
    and coalesce(p.runs_own_registration, false) = false;

  -- DID THE SELECT MATCH A ROW - not "is max_capacity set". An uncapped class matches
  -- here and returns a NULL capacity, and must carry on to the offer.
  if not found then
    raise exception 'waitlist_offer_next: program % is not this organisation''s, not open, or not ours to sell', p_program_id
      using errcode = '42501';
  end if;

  -- The family at the top of the live list, if there is one.
  select r.id, r.waitlist_position, r.waitlist_invited_at,
         r.waitlist_invite_expires_at, r.waitlist_invite_token,
         pa.email as parent_email, pa.first_name as parent_first, s.first_name as child_first
    into v_row
  from registrations r
  join parents pa on pa.id = r.parent_id
  join students s on s.id = r.student_id
  where r.program_id = p_program_id
    and r.status = 'waitlist'
    and r.cancelled_at is null
  order by r.waitlist_position, r.registered_at
  limit 1;

  if v_row.id is null then
    -- Nobody waiting. Not an error: a seat opening on a class with an empty list is the
    -- normal case, and the caller should simply do nothing.
    return;
  end if;

  -- ALREADY HOLDING A LIVE OFFER? Hand it back untouched. Their clock keeps running.
  if v_row.waitlist_invite_expires_at is not null
     and v_row.waitlist_invite_expires_at > now() then
    return query select v_row.id, true, v_row.waitlist_invite_token,
                        v_row.waitlist_invite_expires_at, v_row.parent_email,
                        v_row.parent_first, v_row.child_first, v_row.waitlist_position;
    return;
  end if;

  -- HELD AN OFFER THAT HAS RUN OUT? Then this row should already have been cancelled by
  -- waitlist_expire_invites, and re-offering it would hand the same family a second 24
  -- hours they are no longer entitled to. Refuse and let expiry catch up.
  if v_row.waitlist_invited_at is not null
     and v_row.waitlist_invite_expires_at is not null
     and v_row.waitlist_invite_expires_at <= now() then
    raise exception 'waitlist_offer_next: top of list on program % holds a lapsed invite that expiry has not cleared yet', p_program_id
      using errcode = 'P0002';
  end if;

  -- IS THERE ACTUALLY A FREE SEAT? Counted AFTER the live-invite case above, because a
  -- family already holding an offer is themselves occupying the seat - checking first
  -- would see a full class and refuse to return their own standing invite.
  --
  -- NULL capacity means uncapped, which cannot be "full", so a place is always available.
  -- That branch is now genuinely reachable: until this migration an uncapped class raised
  -- 42501 above and never got here.
  if v_cap is not null and v_cap > 0 and v_taken >= v_cap then
    raise exception 'waitlist_offer_next: program % has no free seat to offer (% of %)', p_program_id, v_taken, v_cap
      using errcode = 'P0001';
  end if;

  -- Two UUIDs of entropy. pgcrypto is not installed on either environment, and
  -- gen_random_uuid() is core; 256 bits is far past guessable and the column carries a
  -- unique index so a collision would error rather than cross wires.
  v_token   := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + p_hold;

  update registrations
     set waitlist_invited_at        = now(),
         waitlist_invite_expires_at = v_expires,
         waitlist_invite_token      = v_token
   where id = v_row.id;

  return query select v_row.id, false, v_token, v_expires, v_row.parent_email,
                      v_row.parent_first, v_row.child_first, v_row.waitlist_position;
end;
$$;

comment on function public.waitlist_offer_next(uuid, uuid, interval) is
  'Offer the open place to the top of a program''s waiting list: stamps the hold window and mints a single-use token, atomically under the shared per-program advisory lock. REFUSES (P0001) unless a seat is genuinely free by registration_holds_seat(), so the invite email''s "a place has opened up" is true when it sends. Refuses with P0002 when the top of the list holds an invite that has already lapsed - that row belongs to waitlist_expire_invites, and re-offering it would give the same family a second window; the caller skips and the next tick handles it. Uses plpgsql FOUND, not a NULL max_capacity, to decide whether the program matched: an UNCAPPED class is a normal class and its queue must keep moving. Returns no rows when nobody is waiting, which is a normal outcome and not an error. Idempotent: a family already holding a live invite is returned unchanged, with their original token and deadline, so retries cannot restart their clock or issue a second link. SECURITY DEFINER, service_role only - the caller sends the email after this commits.';

revoke all on function public.waitlist_offer_next(uuid, uuid, interval) from public;
revoke execute on function public.waitlist_offer_next(uuid, uuid, interval) from anon;
revoke execute on function public.waitlist_offer_next(uuid, uuid, interval) from authenticated;
grant execute on function public.waitlist_offer_next(uuid, uuid, interval) to service_role;
