-- 20261124d: never email a waitlist offer for a class checkout will refuse.
--
-- From 20261124c, create-registration refuses a class that has FINISHED (past
-- its last session, or a camp past its last day), and - when the business has
-- turned Late sign-ups off (organizations.late_join_allowed) - a class that has
-- STARTED. waitlist_offer_next knew neither, so a family could be emailed "a
-- spot opened, you have 24 hours" and then be refused at the last step.
--
-- The guard answers WL001, "no free seat to offer", which the waitlist sweep
-- (lifecycle-automations-cron/waitlistSweep.ts) already treats as the normal
-- quiet stop: no email, nothing flagged as an error. Same day boundary as
-- checkout: the business's own timezone, a session dated today still counts.
--
-- The body is the live function unchanged (pg_get_functiondef md5
-- e717456cb74cd71f589611ce9d2ea8be on staging AND prod, 2026-11-24) plus the one
-- guard block marked below. Grants are kept by CREATE OR REPLACE; read back.
create or replace function public.waitlist_offer_next(p_program_id uuid, p_org_id uuid, p_hold interval default '24:00:00'::interval)
 returns table(registration_id uuid, invite_token text, expires_at timestamp with time zone, parent_email text, parent_first_name text, child_first_name text, waitlist_position integer)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_cap integer; v_taken bigint; v_row record; v_token text; v_expires timestamptz; v_closed boolean;
begin
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  select sc.max_capacity, sc.seats_taken into v_cap, v_taken
  from program_seat_counts(array[p_program_id]) sc join programs p on p.id = sc.program_id
  where p.organization_id = p_org_id and p.status = 'open' and coalesce(p.runs_own_registration, false) = false;
  if not found then
    raise exception 'waitlist_offer_next: program % is not this organisation''s, not open, or not ours to sell', p_program_id using errcode = '42501';
  end if;

  -- NEW (20261124d): closed to sign-ups = no seat to offer.
  select case
           when coalesce(array_length(p.class_days, 1), 0) > 0 then
             p.end_date is not null
             and p.end_date < (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date
           else
             coalesce((select max(d) from unnest(x.dates) d)
                        < (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date, false)
             or (o.late_join_allowed = false
                 and (select count(*) from unnest(x.dates) d
                       where d >= (now() at time zone coalesce(o.timezone, 'America/Los_Angeles'))::date)
                     < coalesce(array_length(x.dates, 1), 0))
         end
    into v_closed
  from programs p
  join organizations o on o.id = p.organization_id
  cross join lateral (select derive_program_session_dates(p.id) as dates) x
  where p.id = p_program_id;
  if coalesce(v_closed, false) then
    raise exception 'waitlist_offer_next: program % has closed to sign-ups (finished, or started with late sign-ups off)', p_program_id using errcode = 'WL001';
  end if;
  -- END NEW

  select r.id, r.waitlist_position, r.waitlist_invited_at, r.waitlist_invite_expires_at, r.waitlist_invite_token,
         pa.email as parent_email, pa.first_name as parent_first, s.first_name as child_first
    into v_row
  from registrations r join parents pa on pa.id = r.parent_id join students s on s.id = r.student_id
  where r.program_id = p_program_id and r.status = 'waitlist' and r.cancelled_at is null
    and r.waitlist_invite_expires_at is null
    and r.waitlist_claimed_registration_id is null
  order by r.waitlist_position, r.registered_at limit 1;

  if v_row.id is null then
    if exists (
      select 1 from registrations r
      where r.program_id = p_program_id and r.status = 'waitlist' and r.cancelled_at is null
        and r.waitlist_invited_at is not null
        and r.waitlist_invite_expires_at is not null
        and r.waitlist_invite_expires_at <= now()
        and r.waitlist_claimed_registration_id is null
    ) then
      raise exception 'waitlist_offer_next: program % has nobody offerable and holds a lapsed invite that expiry has not cleared yet', p_program_id using errcode = 'WL002';
    end if;
    return;
  end if;

  if v_cap is not null and v_cap > 0 and v_taken >= v_cap then
    raise exception 'waitlist_offer_next: program % has no free seat to offer (% of %)', p_program_id, v_taken, v_cap using errcode = 'WL001';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + p_hold;
  update registrations set waitlist_invited_at = now(), waitlist_invite_expires_at = v_expires, waitlist_invite_token = v_token where id = v_row.id;
  return query select v_row.id, v_token, v_expires, v_row.parent_email, v_row.parent_first, v_row.child_first, v_row.waitlist_position;
end;
$function$;
