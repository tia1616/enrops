-- One family, one place in the queue. waitlist_join deduped on student_id, which
-- is the one key that cannot survive the thing families actually do.
--
-- WHAT HAPPENED, 2026-09-09, prod.
-- Sharie Grant joined the Irvington Minecraft waitlist at 17:00 for "Madison
-- Weatherspoon". Unsure it had worked, she did it again 51 seconds later and
-- typed "Madison Wwatherspoon". join-waitlist matches an existing child on FIRST
-- AND LAST name, so the typo missed, and it minted a second students row. This
-- function then deduped on p_student_id, which was now a different uuid, so it
-- happily wrote her a SECOND waitlist place.
--
-- The damage was not two emails. It was two PLACES: positions 1 and 2, both held
-- by one child who wanted one seat. When seats freed, waitlist_offer_next offered
-- to both (18:00 and 18:45), and both offers HELD A SEAT via
-- registration_holds_seat's waitlist branch. A fourteen-seat class with twelve
-- paid children read 14/14 and turned everyone else away, for one family.
--
-- WHY FIRST NAME AS WELL AS student_id. This is settled ground: the abandoned-
-- registration suppression module hit the identical trap and wrote it down --
-- "Each abandoned attempt mints its own students row, so the confirmed
-- registration points at a different student_id for the same real child (Molly
-- Ackley exists twice on the Ukulele Project roster). Matching on student_id
-- would therefore fail on precisely the case this module exists to fix." Same
-- root cause, same answer, so this uses the same key rather than a second
-- spelling of it: one parent, one offering, one normalised child FIRST name.
--
-- WHY NOT FIRST *AND* LAST. That is what join-waitlist's student matcher already
-- does, and it is what failed here -- the typo was in the surname. Adding the
-- surname to this key would reproduce the bug it is meant to close.
--
-- WHY THIS IS NOT PER PARENT. Siblings. A family waitlisting two different
-- children for one class must get two places; collapsing by parent alone would
-- silently drop one of them. Two siblings sharing a first name would collapse,
-- which the suppression module also considered and dismissed as not a real case.
--
-- NORMALISATION matches normalizeChildName in abandonedSuppression.ts: trim,
-- lower, collapse internal whitespace. Prod carries 47 first names with a
-- trailing space, so trimming is load-bearing, not cosmetic.
--
-- IDEMPOTENT BY DESIGN, and unchanged in that respect: a repeat join still
-- returns the existing position instead of erroring, so the family sees "you are
-- number 3" both times rather than a failure. Only the matching key moves.
--
-- Everything else in the function is byte-identical: the advisory lock, the
-- org/open/ours-to-sell gate, the WL003 has-room gate, and the position
-- assignment. Copied from pg_get_functiondef, not from an older migration file.
--
-- ONE MORE THING THE DEDUPE GAINED, called out because it is easy to read as a
-- narrowing: the old select had NO parent_id filter, matching on student_id
-- alone. This one requires parent_id. That cannot lose a match, because
-- join-waitlist -- the function's only caller, code-side or DB-side -- never
-- hands it a student belonging to anyone else: it resolves p_student_id only
-- from registrations it has already filtered to p_parent_id, and otherwise
-- inserts a fresh students row with parent_id = p_parent_id. Prod carries zero
-- registrations whose parent_id differs from the student's owning parent
-- (checked 2026-09-09). The filter is what makes the NAME half safe -- without
-- it, "any child called Molly on this waitlist" would collapse two unrelated
-- families into one place.

create or replace function public.waitlist_join(
  p_program_id uuid,
  p_parent_id  uuid,
  p_student_id uuid,
  p_org_id     uuid
)
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
  v_child    text;
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

  -- The child this join is FOR, normalised the same way abandonedSuppression.ts
  -- normalises: trim, lower, collapse internal runs of whitespace.
  select nullif(regexp_replace(btrim(lower(s.first_name)), '\s+', ' ', 'g'), '')
    into v_child
  from students s
  where s.id = p_student_id;

  -- ALREADY IN THIS QUEUE? EITHER key counts - this is a SUPERSET of the old rule,
  -- never a replacement for it:
  --
  --   r.student_id = p_student_id   the old key. Still correct whenever it fires,
  --                                 and it catches a case the name key cannot: the
  --                                 same students row whose first name was edited
  --                                 between joins. Dropping it, as the first draft
  --                                 of this migration did, would have traded one
  --                                 duplicate-place bug for a narrower one.
  --   normalised first name         the new key, for the case that actually
  --                                 happened: a re-join mints a fresh students row
  --                                 (and a typo'd surname slips past
  --                                 join-waitlist's first+last matcher), so
  --                                 student_id differs for the same real child.
  --
  -- LEFT JOIN, not INNER: a waitlist row with a null student_id (none on prod
  -- today) must still be able to match on the student_id key rather than becoming
  -- invisible to the dedupe and silently earning a second place.
  select r.id, r.waitlist_position into v_existing
  from registrations r
  left join students s2 on s2.id = r.student_id
  where r.program_id = p_program_id
    and r.parent_id  = p_parent_id
    and r.status = 'waitlist'
    and r.cancelled_at is null
    and (
      r.student_id = p_student_id
      or (
        v_child is not null
        and nullif(regexp_replace(btrim(lower(s2.first_name)), '\s+', ' ', 'g'), '') = v_child
      )
    )
  order by r.waitlist_position asc nulls last
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
  'Join a waitlist idempotently under a per-program advisory lock. Within one parent and one program, dedupes on student_id OR normalised child FIRST name - both keys, not one: keying on student_id ALONE gave one child two places, two offers and two held seats on prod 2026-09-09, because a family who re-joins (or typos a surname) mints a fresh students row. The name key is the same key, and the same reasoning, as abandonedSuppression.ts; student_id is kept because it catches the case the name key cannot, a child whose first name was edited between joins. Per child rather than per parent so siblings each keep a place.';
