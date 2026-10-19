-- 20261019a_waitlist_close_on_confirm.sql
--
-- Close a family's waiting-list entry AT THE MOMENT their child is confirmed in the
-- class, by whatever route, instead of waiting up to 15 minutes for the sweep.
--
-- WHY A TRIGGER. A class registration becomes 'confirmed' in five places:
--   stripe-webhook (card / bank), create-checkout's $0 comp branch,
--   confirm_registration_paid_by_credit (all-credit), admin-import-program-roster
--   (the business imports a roster), and any operator edit. Only the first ever spent a
--   waiting-list entry, and only an invite-link one (waitlist_invite_consume_claim).
--   Instrumenting each caller would mean editing prod's stripe-webhook, which is
--   deliberately composed differently from staging's, and remembering the sixth caller
--   whenever it is written. A trigger on the row is one place that every route passes.
--
-- WHAT IT CLOSES. The same child in the same class: same parent, same program, and
-- either the same students row or the same normalised first name. That is the key
-- waitlist_join (20260909c) and waitlist_retire_enrolled (20261015d) already use.
-- Silent: no email, the child is in the class.
--
-- THE LATENT GAP THIS ALSO CLOSES. A family who came through the invite link and then
-- paid $0 (100%-off code) or entirely with credit was never spent: neither path calls
-- consume_claim. Their waitlist row kept its claim forever, because
-- waitlist_release_stale_claims only releases a claim whose registration has stopped
-- holding a seat (a confirmed one never does), and the sweep, expiry and offers all skip
-- claimed rows. So this trigger also closes a claimed row whose claim IS the
-- registration being confirmed - exactly what consume_claim does on the card path, which
-- now finds nothing to do and returns 0 (stripe-webhook treats 0 as the normal case).
-- A row claimed by a DIFFERENT, still-pending checkout is left alone: that family is
-- mid-payment elsewhere and the claim shape forbids cancelling it.
--
-- IT MUST NOT BREAK A PAYMENT. This runs inside the write that confirms a family's
-- money. Three guards keep it from failing or stalling that write:
--   * pg_try_advisory_xact_lock, not pg_advisory_xact_lock. The waitlist RPCs take
--     'waitlist:'||program_id first; if one holds it right now this SKIPS rather than
--     waits, so it cannot block a webhook or deadlock against the sweep. A skip is
--     caught by the sweep's waitlist_retire_enrolled within one tick.
--   * SET lock_timeout = 500ms on the function. Not every writer of a waitlist row takes
--     the advisory lock (waitlistSweep.ts stamps waitlist_last_offered_at and undoes an
--     unsent offer over plain PostgREST), so the row UPDATEs below can still meet a row
--     lock. Without a short limit, that wait runs into PostgREST's 8s statement_timeout,
--     and a statement timeout (57014, query_canceled) is the ONE error `when others`
--     does not catch: it would cancel the family's confirm. A lock_timeout raises 55P03,
--     which the block below does catch. Proven on staging 10/19: OTHERS let 57014 escape.
--   * The work sits in its own BEGIN ... EXCEPTION block. Any other error rolls back only
--     that block, raises a WARNING into the Postgres log, and the confirm proceeds.
--
-- THE ROW BEING CONFIRMED MAY ITSELF BE THE WAITLIST ROW. admin-import-program-roster
-- looks a child up by (program, student) with no status filter, finds their waitlist row
-- and turns IT into the confirmed registration. That row then still carries its queue
-- position and invite token, and the queue keeps a gap where it was. So when OLD.status
-- was 'waitlist', the confirmed row's waitlist fields are cleared and the queue
-- renumbered. (Clearing only those columns does not re-fire this trigger, which is
-- scoped to status and cancelled_at.)
--
-- 2. waitlist_retire_enrolled() - the sweep backstop - is widened by one term: a
--    claimed row whose claim points at a CONFIRMED registration is now retirable too
--    (and its claim is nulled, as registrations_waitlist_claim_shape requires). Without
--    this, a confirm whose trigger skipped on a busy lock would leave the claimed row
--    stuck exactly as before. Everything else in that function is byte-identical to
--    20261015d (ENROLLED stays status 'confirmed' only - see that migration).

-- 1. THE TRIGGER --------------------------------------------------------------------
create or replace function public.waitlist_close_on_confirm()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
-- Bounded row-lock waits: see the header. Scoped to this function's execution only.
set lock_timeout to '500ms'
as $function$
declare
  v_child    text;
  v_n        integer;
  v_promoted boolean := false;
begin
  -- Only a class registration that is now live and confirmed.
  if NEW.status is distinct from 'confirmed' or NEW.cancelled_at is not null
     or NEW.program_id is null or NEW.parent_id is null then
    return NEW;
  end if;
  -- Only on the TRANSITION into that state. An edit to some other column of an
  -- already-confirmed row (the trigger is scoped to status/cancelled_at, but a no-op
  -- write of either still fires it) has nothing new to say.
  if TG_OP = 'UPDATE' and OLD.status = 'confirmed' and OLD.cancelled_at is null then
    return NEW;
  end if;

  begin
    -- Non-blocking: see the header. A busy queue is the sweep's to finish.
    if not pg_try_advisory_xact_lock(hashtext('waitlist:' || NEW.program_id::text)) then
      return NEW;
    end if;

    -- Normalised exactly as waitlist_join / waitlist_retire_enrolled do.
    select nullif(regexp_replace(btrim(lower(s.first_name)), '\s+', ' ', 'g'), '')
      into v_child
    from students s
    where s.id = NEW.student_id;

    update registrations w
       set status = 'cancelled', cancelled_at = now(),
           waitlist_invited_at = null, waitlist_invite_expires_at = null,
           waitlist_invite_token = null, waitlist_position = null,
           waitlist_claimed_registration_id = null
      from students ws
     where ws.id = w.student_id
       and w.program_id = NEW.program_id
       and w.parent_id  = NEW.parent_id
       and w.id <> NEW.id
       and w.status = 'waitlist' and w.cancelled_at is null
       and (w.waitlist_claimed_registration_id is null
            or w.waitlist_claimed_registration_id = NEW.id)
       and (
         w.student_id = NEW.student_id
         or (v_child is not null
             and nullif(regexp_replace(btrim(lower(ws.first_name)), '\s+', ' ', 'g'), '') = v_child)
       );
    get diagnostics v_n = row_count;

    -- The waitlist row itself was promoted (roster import): it is the registration now,
    -- so it gives up its place in the queue and its invite. See the header.
    if TG_OP = 'UPDATE' and OLD.status = 'waitlist' then
      update registrations
         set waitlist_position = null, waitlist_invited_at = null,
             waitlist_invite_expires_at = null, waitlist_invite_token = null
       where id = NEW.id
         and (waitlist_position is not null or waitlist_invite_token is not null
              or waitlist_invited_at is not null or waitlist_invite_expires_at is not null);
      v_promoted := true;
    end if;

    if v_n > 0 or v_promoted then
      -- Close the gap. The same expression as every other waitlist writer.
      with ordered as (
        select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
        from registrations r
        where r.program_id = NEW.program_id and r.status = 'waitlist' and r.cancelled_at is null
      ) update registrations r set waitlist_position = o.pos from ordered o
       where r.id = o.id and r.waitlist_position is distinct from o.pos;
    end if;
  exception when others then
    -- Never let this stop a confirmation. The sweep will retire the row instead.
    raise warning 'waitlist_close_on_confirm skipped for registration %: % (%)',
      NEW.id, sqlerrm, sqlstate;
  end;

  return NEW;
end;
$function$;

comment on function public.waitlist_close_on_confirm() is
  'AFTER INSERT/UPDATE trigger on registrations: when a class registration becomes '
  'confirmed, silently close that same child''s waiting-list entry in the same class '
  '(same parent + program, same students row or same normalised first name), including '
  'an entry whose invite claim is this registration. Non-blocking (try-lock) and '
  'exception-guarded so it can never fail or stall the confirm; waitlist_retire_enrolled '
  'in the sweep is the backstop.';

revoke all on function public.waitlist_close_on_confirm() from public;
revoke all on function public.waitlist_close_on_confirm() from anon;
revoke all on function public.waitlist_close_on_confirm() from authenticated;

drop trigger if exists trg_waitlist_close_on_confirm on public.registrations;
create trigger trg_waitlist_close_on_confirm
  after insert or update of status, cancelled_at on public.registrations
  for each row
  when (NEW.status = 'confirmed' and NEW.cancelled_at is null and NEW.program_id is not null)
  execute function public.waitlist_close_on_confirm();

-- 2. THE SWEEP BACKSTOP, WIDENED BY ONE TERM ------------------------------------------
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
    and (w.waitlist_claimed_registration_id is null
         or exists (select 1 from registrations cc
                    where cc.id = w.waitlist_claimed_registration_id
                      and cc.status = 'confirmed' and cc.cancelled_at is null))
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
           waitlist_invite_token = null, waitlist_position = null,
           -- A cancelled row may not carry a claim (registrations_waitlist_claim_shape).
           waitlist_claimed_registration_id = null
     where w.status = 'waitlist' and w.cancelled_at is null
       and (w.waitlist_claimed_registration_id is null
            or exists (select 1 from registrations cc
                       where cc.id = w.waitlist_claimed_registration_id
                         and cc.status = 'confirmed' and cc.cancelled_at is null))
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
  'the waitlist_join key (20260909c). Skips rows claimed by a checkout still in flight, but '
  'retires a row whose claim points at a CONFIRMED registration (20261019a). Renumbers each '
  'affected queue. The sweep backstop for trg_waitlist_close_on_confirm. service_role only.';

revoke all on function public.waitlist_retire_enrolled() from public;
revoke all on function public.waitlist_retire_enrolled() from anon;
revoke all on function public.waitlist_retire_enrolled() from authenticated;
grant execute on function public.waitlist_retire_enrolled() to service_role;
