-- Lapse the offers nobody claimed, and free the seats they were holding.
--
-- Jessica's decision, 2026-08-19: a family whose 24-hour hold runs out COMES OFF THE
-- LIST. They were emailed, given a day, and the email told them in writing that the place
-- would go to the next family. Keeping them on would mean either offering the same seat
-- to someone who already ignored it, or a list whose number 1 is never actually next.
--
-- WHY THIS IS A SWEEP AND NOT A TRIGGER. An expired invite is not an event anything
-- fires - it is the ABSENCE of an event, the passage of a deadline. Nothing writes to the
-- row at the moment it lapses, so there is nothing to hang a trigger on.
--
-- SILENT BY DESIGN. This sends nothing. It runs at any hour, including 3am, because
-- freeing a seat is data and mailing a parent is not. Not notifying the lapsed family is
-- a real cost - if the invite went to spam they lose the place without ever knowing - and
-- worth revisiting, but it was not part of the decision and inventing an email here would
-- be building past the ask.

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
  v_prog uuid;
begin
  -- Take the lapsed rows first, into a temp set, so the renumber below knows exactly
  -- which programs changed. Doing it as one UPDATE ... RETURNING and renumbering
  -- afterwards would leave no record of which queues need closing up.
  create temp table _lapsed on commit drop as
  select r.id, r.program_id, r.organization_id, pa.email as parent_email,
         s.first_name as child_first_name
  from registrations r
  join parents pa on pa.id = r.parent_id
  join students s on s.id = r.student_id
  where r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    -- <= now(), not < now(): a hold that expires exactly on the tick is over.
    and r.waitlist_invite_expires_at <= now();

  if not exists (select 1 from _lapsed) then
    return;
  end if;

  update registrations r
     set status                     = 'cancelled',
         cancelled_at               = now(),
         waitlist_invited_at        = null,
         waitlist_invite_expires_at = null,
         waitlist_invite_token      = null,
         waitlist_position          = null
    from _lapsed l
   where r.id = l.id;

  -- Close the gap on every affected queue, one program at a time under that program's
  -- own lock - the same key waitlist_join / _remove / _offer_next / _invite_consume use,
  -- so a family joining while this sweep runs cannot take a number it is reassigning.
  for v_prog in select distinct l.program_id from _lapsed l loop
    perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text));
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

  return query
    select l.id, l.program_id, l.organization_id, l.parent_email, l.child_first_name
    from _lapsed l;
end;
$$;

comment on function public.waitlist_expire_invites() is
  'Sweep: every waitlist invite whose hold has run out is cancelled (Jessica 2026-08-19 - a lapsed family comes OFF the list, because the invite email promised the place would go to the next family), its invite columns cleared so it stops holding a seat, and each affected queue renumbered 1..N under that program''s advisory lock. Returns the lapsed rows so the caller can log them. Sends nothing and is safe to run at any hour. Idempotent: a second run finds nothing, because the rows it touched are no longer status=waitlist. SECURITY DEFINER, service_role only - called from lifecycle-automations-cron.';

revoke all on function public.waitlist_expire_invites() from public;
revoke execute on function public.waitlist_expire_invites() from anon;
revoke execute on function public.waitlist_expire_invites() from authenticated;
grant execute on function public.waitlist_expire_invites() to service_role;
