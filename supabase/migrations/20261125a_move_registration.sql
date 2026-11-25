-- 20261125a_move_registration.sql
--
-- MOVE A CHILD FROM ONE CLASS TO ANOTHER, as one action, instead of a hand-written
-- `UPDATE registrations SET program_id` on prod. Four of those were done by hand
-- between 9/10 and 10/19 (notes on each row say so); every one was "no money moved".
--
-- THE RULE, from Jessica 2026-11-25 after looking at Activity Messenger, Sawyer,
-- Jackrabbit and Amilia: a move changes WHICH CLASS, never the money. Price
-- differences are settled separately (all four platforms do the same).
--
-- 1. move_registration(): the write, in one transaction, service_role only. The
--    admin-move-registration edge function authorises the caller (owner/admin of the
--    registration's org) and then calls this.
--
-- 2. waitlist_close_on_confirm() and its trigger now also fire on a CHANGE OF CLASS.
--    Before this, a confirmed row whose program_id changed was invisible to the
--    trigger (scoped to status/cancelled_at), so a child moved into a class where
--    they were on the waiting list kept their queue place until the 15-minute sweep
--    (waitlist_retire_enrolled). Fixed in the trigger, not in move_registration, so
--    ANY writer of program_id gets it - the hand UPDATE included.
--
-- WHAT A MOVE DELIBERATELY LEAVES ALONE (scoped 2026-11-25, every reader listed in
-- the build notes):
--   * money: amount_cents, discounts, payment status, installments, credits, refunds.
--     All are keyed by registration_id and follow the row unchanged.
--   * attendance_records already taken in the old class: they carry their own
--     program_id and are TRUE history of where the child was. Not rewritten.
--   * year-bundle sibling legs: separate registrations, untouched. The screen says so.
--   * the old class's freed seat: offered to its waiting list by the existing sweep.

-- 1. THE TRIGGER, now also on a change of class ------------------------------------
-- Byte-identical to 20261019a except the transition test, which now lets through an
-- already-confirmed row whose program_id changed. Body md5 before this migration was
-- de56c60abb0b7268fb94aa71ac3ff52e on BOTH staging and prod (checked 2026-11-25).
create or replace function public.waitlist_close_on_confirm()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
-- Bounded row-lock waits: see 20261019a. Scoped to this function's execution only.
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
  -- Only on the TRANSITION into that state - INCLUDING arriving in a new class. An
  -- edit to some other column of an already-confirmed row that stayed in the same
  -- class has nothing new to say. A confirmed row that MOVED class (20261125a) is
  -- newly confirmed in the class it arrived in, and its waiting-list entry there
  -- must close exactly as if it had just paid.
  if TG_OP = 'UPDATE' and OLD.status = 'confirmed' and OLD.cancelled_at is null
     and OLD.program_id is not distinct from NEW.program_id then
    return NEW;
  end if;

  begin
    -- The waitlist row itself was promoted (roster import): it is the registration now,
    -- so it gives up its place in the queue and its invite. See 20261019a. FIRST, and
    -- outside the advisory lock: it writes only the row this statement already holds,
    -- and nothing else ever revisits a confirmed row, so skipping it on a busy queue
    -- would leave the position and token on it for good. The queue's gap closes on the
    -- renumber below, or on the next renumber any waitlist exit performs.
    if TG_OP = 'UPDATE' and OLD.status = 'waitlist' then
      update registrations
         set waitlist_position = null, waitlist_invited_at = null,
             waitlist_invite_expires_at = null, waitlist_invite_token = null
       where id = NEW.id
         and (waitlist_position is not null or waitlist_invite_token is not null
              or waitlist_invited_at is not null or waitlist_invite_expires_at is not null);
      v_promoted := true;
    end if;

    -- Non-blocking: see 20261019a. A busy queue is the sweep's to finish.
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
  'confirmed, or a confirmed one moves to another class, silently close that same '
  'child''s waiting-list entry in the class it is now in (same parent + program, same '
  'students row or same normalised first name), including an entry whose invite claim '
  'is this registration. Non-blocking (try-lock) and exception-guarded so it can never '
  'fail or stall the write; waitlist_retire_enrolled in the sweep is the backstop.';

revoke all on function public.waitlist_close_on_confirm() from public;
revoke all on function public.waitlist_close_on_confirm() from anon;
revoke all on function public.waitlist_close_on_confirm() from authenticated;

-- program_id joins status and cancelled_at. The inner UPDATEs above write only
-- waitlist_* columns and status/cancelled_at on OTHER rows (whose WHEN clause is
-- false: they become 'cancelled'), so this does not re-fire on itself.
drop trigger if exists trg_waitlist_close_on_confirm on public.registrations;
create trigger trg_waitlist_close_on_confirm
  after insert or update of status, cancelled_at, program_id on public.registrations
  for each row
  when (NEW.status = 'confirmed' and NEW.cancelled_at is null and NEW.program_id is not null)
  execute function public.waitlist_close_on_confirm();

-- 2. THE MOVE ------------------------------------------------------------------------
-- Errors are raised with a stable machine key as the MESSAGE; the edge function maps
-- each key to a sentence. Capacity is NOT checked here: Jessica's call (2026-11-25)
-- is that an operator may fill a class past capacity after a warning, and the edge
-- function shows and confirms that warning before calling this.
create or replace function public.move_registration(
  p_registration_id   uuid,
  p_target_program_id uuid,
  p_note              text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r   registrations;
  src programs;
  tgt programs;
begin
  -- Row-locked so two moves (or a move and a refund) of one registration serialise.
  select * into r from registrations where id = p_registration_id for update;
  if not found then
    raise exception 'registration_not_found';
  end if;
  -- Class registrations only. Camp-session rows (camp_session_id) are a different
  -- shape; registrations_one_program_or_camp_session guarantees one or the other.
  if r.program_id is null then
    raise exception 'not_a_class_registration';
  end if;
  -- ENROLLED = confirmed and not cancelled, the same test registration_holds_seat
  -- makes first. On prod 2026-11-25 every live class registration with a place was
  -- 'confirmed' (881 rows); a pending checkout or a waiting-list row is not movable.
  if r.status is distinct from 'confirmed' or r.cancelled_at is not null then
    raise exception 'not_enrolled';
  end if;
  if r.program_id = p_target_program_id then
    raise exception 'same_class';
  end if;

  select * into src from programs where id = r.program_id;
  select * into tgt from programs where id = p_target_program_id;
  -- Same organization, proved from the rows rather than trusted from the caller.
  if tgt.id is null or tgt.organization_id is distinct from r.organization_id then
    raise exception 'target_not_found';
  end if;
  -- programs_status_check allows draft / open / closed / cancelled. Only an open
  -- class is a place a child can be put.
  if tgt.status is distinct from 'open' then
    raise exception 'target_not_open';
  end if;
  -- A class to a class, a camp to a camp. The same rule as isCampProgram
  -- (src/lib/programSchedule.js, _shared/campProgram.ts): a camp has class_days with
  -- at least one element. cardinality('{}') is 0, so an empty array is a CLASS here
  -- exactly as it is there - never `class_days is null`.
  if (coalesce(cardinality(src.class_days), 0) > 0)
     is distinct from (coalesce(cardinality(tgt.class_days), 0) > 0) then
    raise exception 'different_kind';
  end if;
  -- Never two places for one child in one class. There is no unique index that
  -- would stop it (only waiting-list rows have one), so it is checked here, under
  -- the row lock, with the same seat test the seat count uses.
  if exists (
    select 1 from registrations x
    where x.program_id = tgt.id
      and x.student_id = r.student_id
      and x.id <> r.id
      and x.status <> 'waitlist'
      and registration_holds_seat(x)
  ) then
    raise exception 'already_in_target';
  end if;

  update registrations
     set program_id = tgt.id,
         notes = case
           when nullif(btrim(coalesce(notes, '')), '') is null then p_note
           when nullif(btrim(coalesce(p_note, '')), '') is null then notes
           else notes || E'\n' || p_note
         end
   where id = r.id;

  return jsonb_build_object(
    'registration_id', r.id,
    'from_program_id', src.id,
    'to_program_id',   tgt.id
  );
end;
$function$;

comment on function public.move_registration(uuid, uuid, text) is
  'Move one confirmed class registration to another open class of the same kind in the '
  'same organization. Changes program_id and appends a note; never touches money. '
  'service_role only: admin-move-registration authorises the caller first.';

revoke all on function public.move_registration(uuid, uuid, text) from public;
revoke all on function public.move_registration(uuid, uuid, text) from anon;
revoke all on function public.move_registration(uuid, uuid, text) from authenticated;
grant execute on function public.move_registration(uuid, uuid, text) to service_role;
