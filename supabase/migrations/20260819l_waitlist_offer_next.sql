-- Offer the open place to the family at the top of the list.
--
-- Jessica's decision (2026-08-19): AUTO-invite the top of the list with a hold window,
-- not operator-picks. This is the atomic core of that: choosing who, stamping the hold,
-- and minting the single-use token, in one statement under one lock. The email is sent by
-- the caller AFTER this returns, because a send cannot be rolled back and this can.
--
-- THE EMAIL SAYS "A PLACE HAS OPENED UP". THIS FUNCTION IS WHAT MAKES THAT TRUE.
-- It refuses to offer unless a seat is genuinely free RIGHT NOW, counted with
-- registration_holds_seat() - the same rule the capacity gate enforces. Without that
-- check a cancellation and a re-registration in the same minute would produce an invite
-- to a class that is full again, and the family would click through to a 409 having been
-- told in writing the place was theirs. That is worse than never having a waitlist, which
-- is the reason the seat-hold was built before the sending.
--
-- IDEMPOTENT. If the top family already holds a LIVE invite this returns it unchanged
-- rather than minting a second token or restarting their clock. A retried cron tick, a
-- double webhook or an operator pressing twice must not shorten or extend a family's
-- window, and must never leave two valid links to one seat.

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

  if v_cap is null then
    raise exception 'waitlist_offer_next: program % is not this organisation''s, not open, or not ours to sell', p_program_id
      using errcode = '42501';
  end if;

  -- The family at the top of the live list, if there is one.
  select r.id, r.waitlist_position, r.waitlist_invite_expires_at, r.waitlist_invite_token,
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

  -- IS THERE ACTUALLY A FREE SEAT? Counted AFTER the live-invite case above, because a
  -- family already holding an offer is themselves occupying the seat - checking first
  -- would see a full class and refuse to return their own standing invite.
  --
  -- NULL capacity means uncapped, which cannot be "full", so a place is always available.
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
  'Offer the open place to the top of a program''s waiting list: stamps the hold window and mints a single-use token, atomically under the shared per-program advisory lock. REFUSES (P0001) unless a seat is genuinely free by registration_holds_seat(), so the invite email''s "a place has opened up" is true when it sends. Returns no rows when nobody is waiting, which is a normal outcome and not an error. Idempotent: a family already holding a live invite is returned unchanged, with their original token and deadline, so retries cannot restart their clock or issue a second link. SECURITY DEFINER, service_role only - the caller sends the email after this commits.';

revoke all on function public.waitlist_offer_next(uuid, uuid, interval) from public;
revoke execute on function public.waitlist_offer_next(uuid, uuid, interval) from anon;
revoke execute on function public.waitlist_offer_next(uuid, uuid, interval) from authenticated;
grant execute on function public.waitlist_offer_next(uuid, uuid, interval) to service_role;
