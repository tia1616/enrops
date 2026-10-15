-- 20261015d_waitlist_retire_enrolled_and_drop_unreachable.sql
--
-- Two ways a waiting-list row went wrong on prod for The Ukulele Project, 10/13-10/14,
-- both in Ukulele Club at Palisades. Two new functions, both called only by
-- lifecycle-automations-cron/waitlistSweep.ts. Nothing existing is redefined.
--
-- 1. waitlist_retire_enrolled()
--    A parent was on the list for their child, got an offer, and then registered and paid
--    through the ordinary class page rather than the invite link. That minted a SECOND
--    students row for the child, so nothing tied the paid registration to the waitlist row.
--    The waitlist row stayed open, its offer ran out, and the sweep emailed her "that
--    place has been passed on" about a class her child was already in.
--
--    Only the invite-link path ever spent a waitlist row (waitlist_invite_consume_claim,
--    by claim). Every other way in - the class page, an operator adding the child, a
--    comp - left it standing. Rather than instrument each of those, the sweep asks the
--    question directly every tick, which is the same reasoning waitlistSweep.ts gives
--    for not hanging offers off cancellation: "is this family already in the class?"
--    is one question for every path, including the next one somebody adds.
--
--    SAME CHILD = the key waitlist_join already uses (20260909c): same parent, same
--    program, and either the same students row OR the same normalised first name.
--    student_id alone is precisely the key that failed here. Normalisation is copied,
--    not rewritten: trim, lower, collapse internal whitespace.
--
--    ENROLLED = status 'confirmed' and cancelled_at null. Deliberately NARROWER than
--    registration_is_enrolled() in the staffing2 work (20261015a there, not yet on
--    either database), which also counts payment_status 'paid'. A wrong match here
--    silently removes a family from a list, so this takes the strict reading: prod
--    holds rows with status 'cancelled', payment_status 'paid' and cancelled_at null
--    (apps-script-roster-sync cancels without stamping cancelled_at), and the wider
--    predicate would count those children as still in the class. Every live paid
--    class registration on prod is 'confirmed', so the narrower test loses no real case.
--    Do NOT "unify" this with registration_is_enrolled without fixing that half-state.
--
--    SILENT: no email. The family is in the class; there is nothing to tell them.
--    CLAIMED rows are skipped: a claim means a checkout is in flight and
--    waitlist_invite_consume_claim spends that row on payment. A cancelled row may not
--    carry a claim (registrations_waitlist_claim_shape), so touching one would also
--    fail the whole statement. If the claim dies, release_stale_claims clears it and
--    this catches the row on the next tick.
--
-- 2. waitlist_drop_unreachable(p_registration_id, p_invite_token)
--    A parent joined with a "<name>@yahoo" address, no ".com". Every 15 minutes
--    the sweep offered her the place, Resend refused the address (422), the sweep
--    rolled the offer back so it could "retry", and the next tick did it all again:
--    78 failed sends over two days. Worse, rolling back left her at the head of the
--    queue, so the family behind her and the class's second free seat were never
--    offered at all.
--
--    Retrying is right for a Resend hiccup and wrong for an address that can never
--    work. For that case the sweep now calls this, which takes the family off the list
--    the same way an expired offer does (Jessica 2026-08-19: an offer that cannot be
--    taken up costs the place), so the seat goes to the next family in the same tick.
--    The one failed send is logged by the sweep as "Resend 422: ...", which the
--    Didn't-send panel already shows the business as "the email address on file looks
--    invalid", so they can reach the family another way.
--
--    TARGETED BY TOKEN, like the sweep's own undo: if anything moved the row since this
--    tick minted the offer (an operator removing them, a consume), the token no longer
--    matches and this does nothing.
--
-- Both take the same per-program advisory lock as every other waitlist writer, sorted,
-- and renumber with the same expression as waitlist_remove / waitlist_expire_invites.

-- 1 -------------------------------------------------------------------------------
create or replace function public.waitlist_retire_enrolled()
returns table(registration_id uuid, program_id uuid, organization_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_progs uuid[]; v_prog uuid;
begin
  -- Which queues to lock, found before locking. A row that becomes retirable between
  -- this probe and the update below is simply caught on the next tick.
  select coalesce(array_agg(distinct w.program_id order by w.program_id), '{}') into v_progs
  from registrations w
  left join students ws on ws.id = w.student_id
  where w.status = 'waitlist' and w.cancelled_at is null
    and w.waitlist_claimed_registration_id is null
    and exists (
      select 1 from registrations c
      left join students cs on cs.id = c.student_id
      where c.program_id = w.program_id
        and c.parent_id  = w.parent_id
        and c.id <> w.id
        and c.cancelled_at is null
        and c.status = 'confirmed'
        and (
          c.student_id = w.student_id
          or nullif(regexp_replace(btrim(lower(cs.first_name)), '\s+', ' ', 'g'), '')
             = nullif(regexp_replace(btrim(lower(ws.first_name)), '\s+', ' ', 'g'), '')
        )
    );
  if cardinality(v_progs) = 0 then return; end if;

  foreach v_prog in array v_progs loop
    perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text));
  end loop;

  drop table if exists _retired;
  create temp table _retired (id uuid, program_id uuid, organization_id uuid) on commit drop;

  -- Re-evaluated under the lock: the probe above only chose which locks to take.
  with upd as (
    update registrations w
       set status = 'cancelled', cancelled_at = now(),
           waitlist_invited_at = null, waitlist_invite_expires_at = null,
           waitlist_invite_token = null, waitlist_position = null
     where w.status = 'waitlist' and w.cancelled_at is null
       and w.waitlist_claimed_registration_id is null
       and w.program_id = any (v_progs)
       and exists (
         select 1 from registrations c
         left join students cs on cs.id = c.student_id
         left join students ws on ws.id = w.student_id
         where c.program_id = w.program_id
           and c.parent_id  = w.parent_id
           and c.id <> w.id
           and c.cancelled_at is null
           and c.status = 'confirmed'
           and (
             c.student_id = w.student_id
             or nullif(regexp_replace(btrim(lower(cs.first_name)), '\s+', ' ', 'g'), '')
                = nullif(regexp_replace(btrim(lower(ws.first_name)), '\s+', ' ', 'g'), '')
           )
       )
    returning w.id, w.program_id, w.organization_id
  ) insert into _retired select * from upd;

  if not exists (select 1 from _retired) then return; end if;

  for v_prog in select distinct d.program_id from _retired d order by 1 loop
    with ordered as (
      select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
      from registrations r where r.program_id = v_prog and r.status = 'waitlist' and r.cancelled_at is null
    ) update registrations r set waitlist_position = o.pos from ordered o
     where r.id = o.id and r.waitlist_position is distinct from o.pos;
  end loop;

  return query select d.id, d.program_id, d.organization_id from _retired d;
end;
$function$;

comment on function public.waitlist_retire_enrolled() is
  'Silently take a family off a waiting list once that same child is enrolled in the class '
  '(status confirmed, cancelled_at null) by any route, not only the invite link. Same child = '
  'same parent and program, and the same students row OR the same normalised first name - '
  'the waitlist_join key (20260909c). Skips claimed rows (mid-checkout). Renumbers each '
  'affected queue. Called by waitlistSweep.ts before expiry, so a family who registered '
  'directly is never sent a "your place has been passed on" note. service_role only.';

-- 2 -------------------------------------------------------------------------------
create or replace function public.waitlist_drop_unreachable(
  p_registration_id uuid,
  p_invite_token    text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_program uuid;
begin
  if p_registration_id is null or p_invite_token is null then return false; end if;

  select r.program_id into v_program
  from registrations r
  where r.id = p_registration_id;
  if v_program is null then return false; end if;

  perform pg_advisory_xact_lock(hashtext('waitlist:' || v_program::text));

  update registrations
     set status = 'cancelled', cancelled_at = now(),
         waitlist_invited_at = null, waitlist_invite_expires_at = null,
         waitlist_invite_token = null, waitlist_position = null
   where id = p_registration_id
     and waitlist_invite_token = p_invite_token
     and status = 'waitlist' and cancelled_at is null
     and waitlist_claimed_registration_id is null;
  if not found then return false; end if;

  with ordered as (
    select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
    from registrations r where r.program_id = v_program and r.status = 'waitlist' and r.cancelled_at is null
  ) update registrations r set waitlist_position = o.pos from ordered o
   where r.id = o.id and r.waitlist_position is distinct from o.pos;

  return true;
end;
$function$;

comment on function public.waitlist_drop_unreachable(uuid, text) is
  'Take a family off a waiting list because the invite could not be delivered to their '
  'address at all (Resend refused the To address). Targeted by the invite token this tick '
  'minted, so a row anything else has touched is left alone. Renumbers the queue. Called '
  'by waitlistSweep.ts instead of rolling the offer back, which retried forever and held '
  'the queue still. service_role only.';

-- GRANTS --------------------------------------------------------------------------
-- revoke from public does NOT remove anon's EXECUTE on Supabase, so anon and
-- authenticated are revoked by name. Read proacl back after applying.
revoke all on function public.waitlist_retire_enrolled() from public;
revoke all on function public.waitlist_retire_enrolled() from anon;
revoke all on function public.waitlist_retire_enrolled() from authenticated;
grant execute on function public.waitlist_retire_enrolled() to service_role;

revoke all on function public.waitlist_drop_unreachable(uuid, text) from public;
revoke all on function public.waitlist_drop_unreachable(uuid, text) from anon;
revoke all on function public.waitlist_drop_unreachable(uuid, text) from authenticated;
grant execute on function public.waitlist_drop_unreachable(uuid, text) to service_role;
