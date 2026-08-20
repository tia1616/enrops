-- The expiry sweep must lock BEFORE it looks, cancel only what is still lapsed, and report
-- only what it actually changed.
--
-- Three defects in 20260819n, all of the same shape: the function decided what to do at one
-- moment and did it at another, with nothing holding the world still in between.
--
-- 1. THE UPDATE WAS UNGUARDED. It matched on `r.id = l.id` alone, using a snapshot taken
--    earlier in the call. Anything that happened to the row in between was overwritten:
--    most importantly an overlapping tick that had just OFFERED that family a fresh place.
--    The new invite - token, deadline and all - was destroyed, and because the snapshot
--    still listed the row, the caller then emailed the family to say their hold had run
--    out. The family holds a live-looking link that reports "no longer valid", plus a note
--    saying they lost a place they were being given at that second.
--
-- 2. THE LOCK CAME AFTER THE WRITE. The per-program advisory lock was taken in the
--    renumbering loop, which runs AFTER the cancellation. So the one window that needed
--    protecting - between reading the lapsed set and cancelling it - was the only window
--    with no lock at all. The lock is now taken for every affected program BEFORE the
--    snapshot, in program-id order so two callers cannot deadlock against each other.
--
-- 3. IT RETURNED ROWS IT HAD NOT TOUCHED. The return set was the snapshot, not the result
--    of the UPDATE, so a row already handled by another tick was still reported as newly
--    lapsed - and the caller sends one "your hold has run out" email per returned row.
--    That is the duplicate-lapse-email path. The function now returns the UPDATE's own
--    RETURNING set, so a row is reported lapsed only if THIS call is what lapsed it.
--
-- Together these make overlapping ticks safe at the row level, which is what the
-- overlap-protection concern was really about: a second tick now cancels nothing the first
-- already cancelled, destroys no fresh invite, and sends no second lapse note.
--
-- THE UPDATE IS SCOPED TO THE LOCKED PROGRAMS, deliberately. A row that lapses in some
-- other program between the lock loop and the UPDATE is left for the next tick rather than
-- cancelled without its lock held - a minute of latency instead of an unsynchronised write.

create or replace function public.waitlist_expire_invites()
returns table (
  registration_id uuid,
  program_id      uuid,
  organization_id uuid,
  parent_email    text,
  child_first_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_progs uuid[];
  v_prog  uuid;
begin
  -- Which queues have a lapsed hold right now. Read first only to know what to LOCK;
  -- nothing is decided on the strength of this list, because the guarded UPDATE below
  -- re-tests every condition once the locks are held.
  select coalesce(array_agg(distinct r.program_id order by r.program_id), '{}')
    into v_progs
  from registrations r
  where r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    -- <= now(), not < now(): a hold that expires exactly on the tick is over.
    and r.waitlist_invite_expires_at <= now();

  if cardinality(v_progs) = 0 then
    return;
  end if;

  -- Same key waitlist_join / _remove / _offer_next / _invite_consume use, so a join, a
  -- removal, an offer and this cannot interleave. Ordered, so two concurrent sweeps take
  -- them in the same sequence and cannot each hold what the other needs.
  foreach v_prog in array v_progs loop
    perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text));
  end loop;

  create temp table _done (
    id uuid, program_id uuid, organization_id uuid, parent_id uuid, student_id uuid
  ) on commit drop;

  -- EVERY CONDITION RE-TESTED IN THE WRITE ITSELF. This is what makes a stale snapshot
  -- harmless: a row that has since been offered a fresh place has its expiry in the
  -- FUTURE and no longer matches, so it is left alone instead of being flattened.
  with upd as (
    update registrations r
       set status                     = 'cancelled',
           cancelled_at               = now(),
           waitlist_invited_at        = null,
           waitlist_invite_expires_at = null,
           waitlist_invite_token      = null,
           waitlist_position          = null
     where r.status = 'waitlist'
       and r.cancelled_at is null
       and r.waitlist_invite_expires_at is not null
       and r.waitlist_invite_expires_at <= now()
       and r.program_id = any (v_progs)
    returning r.id, r.program_id, r.organization_id, r.parent_id, r.student_id
  )
  insert into _done select * from upd;

  if not exists (select 1 from _done) then
    -- Another tick got there first. Nothing lapsed HERE, so nothing is reported and no
    -- lapse note is sent by the caller. This is the duplicate-email path closing.
    return;
  end if;

  -- Close the gap on every queue this call actually changed. The locks are already held.
  for v_prog in select distinct d.program_id from _done d order by 1 loop
    with ordered as (
      select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
      from registrations r
      where r.program_id = v_prog
        and r.status = 'waitlist'
        and r.cancelled_at is null
    )
    update registrations r
       set waitlist_position = o.pos
      from ordered o
     where r.id = o.id
       and r.waitlist_position is distinct from o.pos;
  end loop;

  -- The display fields are joined on AFTER the write, off the ids that actually changed.
  return query
    select d.id, d.program_id, d.organization_id, pa.email, s.first_name
    from _done d
    join parents pa on pa.id = d.parent_id
    join students s on s.id = d.student_id;
end;
$$;

comment on function public.waitlist_expire_invites() is
  'Sweep: every waitlist invite whose hold has run out is cancelled (Jessica 2026-08-19 - a lapsed family comes OFF the list, because the invite email promised the place would go to the next family), its invite columns cleared so it stops holding a seat, and each affected queue renumbered 1..N. Takes each affected program''s advisory lock BEFORE reading, in program-id order, and re-tests every expiry condition inside the UPDATE itself - so an overlapping tick cannot destroy an invite that was freshly offered between the read and the write. Returns the UPDATE''s own RETURNING set, NOT the earlier snapshot: a row is reported lapsed only if this call is what lapsed it, which is what stops a second tick sending a second "your hold has run out" email. Rows lapsing in programs locked after the snapshot are left for the next tick. Sends nothing and is safe to run at any hour. SECURITY DEFINER, service_role only - called from lifecycle-automations-cron.';

revoke all on function public.waitlist_expire_invites() from public;
revoke execute on function public.waitlist_expire_invites() from anon;
revoke execute on function public.waitlist_expire_invites() from authenticated;
grant execute on function public.waitlist_expire_invites() to service_role;
