-- Review-pass fixes, SQL half. (Kept the 20260819v filename it was applied under; the
-- scope grew past "is not enrolled" during the /code-review max pass, hence this header.)
--
-- Six things:
--   1. A waiting family is not enrolled - stop skip_enrolled campaigns dropping them.        (#10-adjacent, orig v)
--   2. A waiting family is not an active registration - stop the platform overview           (orig v)
--      reading a waitlist-only tenant as busy.
--   3. waitlist_invite_lookup joins the student WITHOUT an org predicate, so a
--      registration in org A pointing at an org-B student would hand org B's child to
--      org A's public checkout. Add the predicate.                                           (#7)
--   4. waitlist_offer_next used P0002 - which is Postgres's RESERVED no_data_found - as a
--      sentinel. A future SELECT INTO STRICT or `exception when no_data_found` would raise
--      or swallow it silently. Moved both sentinels to a private class (WL001/WL002).        (#13)
--   5. waitlist_last_offered_at must record only offers that actually reached the family.
--      Stamping it inside the offer function marked "offered" a family whose email then
--      failed and was rolled back. The stamp moves to the caller, AFTER a successful send.   (#14)
--   6. waitlist_expire_invites returned an INNER join, so a lapsed row whose student or
--      parent had been removed was cancelled but dropped from the returned set - off the
--      list, no notice, undercounted. LEFT JOIN so the count is honest.                      (#12)

-- ── 3. Lookup: scope the student join to the registration's org ──────────────
-- students.organization_id is nullable, so `=` DROPS a null-org student rather than
-- matching cross-org - which is the safe direction here: a waitlist row always has its
-- student's org set (join-waitlist writes it), so a null-org student is legacy/imported
-- data that should fail to "invalid invite" (a safe reply-to-us dead end) rather than be
-- served to another tenant's checkout. Failure stays in the lookup, never a 500 on the
-- money path.
create or replace function public.waitlist_invite_lookup(p_token text)
returns table (
  registration_id   uuid,
  program_id        uuid,
  organization_id   uuid,
  org_slug          text,
  expires_at        timestamptz,
  program_name      text,
  site_name         text,
  student_id        uuid,
  child_first_name  text,
  child_last_name   text,
  child_grade       integer,
  parent_first_name text,
  parent_last_name  text,
  parent_email      text,
  parent_phone      text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.program_id, r.organization_id, o.slug,
         r.waitlist_invite_expires_at,
         p.curriculum, pl.name,
         r.student_id,
         s.first_name, s.last_name, s.grade,
         pa.first_name, pa.last_name, pa.email, pa.phone
  from registrations r
  join organizations o on o.id = r.organization_id
  join programs p on p.id = r.program_id
  left join program_locations pl on pl.id = p.program_location_id
  join students s on s.id = r.student_id and s.organization_id = r.organization_id
  join parents pa on pa.id = r.parent_id
  where r.waitlist_invite_token = p_token
    and r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    and r.waitlist_invite_expires_at > now()
    and coalesce(nullif(btrim(p_token), ''), null) is not null;
$$;

comment on function public.waitlist_invite_lookup(text) is
  'Resolve a waitlist invite token to the one registration it belongs to, with the prefill the accept page needs and the student_id the checkout path needs. The student is joined on r.organization_id as well as id, so a registration pointing cross-org (or at a null-org legacy student) resolves to NO ROWS rather than serving another tenant''s child. Returns NO ROWS for an unknown, expired, spent or cancelled token - the page words those identically on purpose. student_id is NOT forwarded to the browser by waitlist-accept; create-registration uses it to attach the registration to the child who was waiting rather than inserting a duplicate. SECURITY DEFINER, service_role only.';

revoke all on function public.waitlist_invite_lookup(text) from public;
revoke execute on function public.waitlist_invite_lookup(text) from anon;
revoke execute on function public.waitlist_invite_lookup(text) from authenticated;
grant execute on function public.waitlist_invite_lookup(text) to service_role;

-- ── 1. Campaigns: a WAITING family stays SKIPPED by skip_enrolled ────────────
-- REVERSED from this migration's first draft after the review (#10). The draft excluded
-- 'waitlist' from the skip so waiting families would receive skip_enrolled campaigns. That
-- is wrong: skip_enrolled campaigns say "register for X now", and a family waitlisted on X
-- either cannot (still full - that is why they are waiting) or, if a seat just opened,
-- would jump the auto-invite queue by clicking the campaign's public link first. Neither is
-- something to email them. So a waitlisted family is treated like an enrolled one HERE -
-- already engaged with this class, skip the register-now blast - which is exactly what the
-- original `<> 'cancelled'` did. This is the OPPOSITE call from the platform overview below,
-- and deliberately so: "should we send this person register-now?" (no for waitlist) is a
-- different question from "is this an active registration?" (also no for waitlist).
create or replace function public.get_campaign_recipients(p_campaign_id uuid)
 returns table(id uuid, email text, parent_name text, child_first_name text, child_last_name text, school_name text, city text, zip text, geo_segment text, segments text[])
 language sql
 security definer
 set search_path to 'public'
as $function$
  select
    mr.id, mr.email, mr.parent_name, mr.child_first_name, mr.child_last_name,
    mr.school_name, mr.city, mr.zip, mr.geo_segment, mr.segments
  from marketing_campaigns mc
  join marketing_recipients mr
    on mr.organization_id = mc.organization_id
   and mr.id = any(mc.approved_recipient_ids)
  where mc.id = p_campaign_id
    and (
      coalesce(mc.draft_inputs -> 'skip_enrolled', 'false'::jsonb) <> 'true'::jsonb
      or not exists (
        select 1
        from registrations rg
        join parents pa on pa.id = rg.parent_id
        where rg.organization_id = mc.organization_id
          -- Everyone except a cancelled family counts as "engaged with this class" and is
          -- skipped: enrolled AND waitlisted alike (see the header - a waiting family must
          -- not get a register-now blast). coalesce-to-'' keeps an UNKNOWN status on the
          -- skip side too, which is safe here.
          and coalesce(rg.status, '') <> 'cancelled'
          and lower(btrim(pa.email)) = lower(btrim(mr.email))
          and (
            rg.program_id::text in (
              select jsonb_array_elements_text(
                coalesce(mc.draft_inputs -> 'what' -> 'program_ids', '[]'::jsonb))
            )
            or rg.camp_session_id::text in (
              select jsonb_array_elements_text(
                coalesce(mc.draft_inputs -> 'what' -> 'camp_session_ids', '[]'::jsonb))
            )
          )
      )
    );
$function$;

revoke execute on function public.get_campaign_recipients(uuid) from public, anon, authenticated;
grant  execute on function public.get_campaign_recipients(uuid) to service_role;

-- ── 2. Platform overview: a waiting family is not an active registration ──────
-- DROP + CREATE, not REPLACE: this adds waitlist_registration_count to the RETURNS TABLE,
-- which changes the output type and cannot be done in place. Atomic inside this migration,
-- and the grant is re-applied below, so authenticated has no window without it. The screen
-- (is_platform_admin only) is low-traffic; nothing anon depends on it.
drop function if exists public.platform_operator_overview();
create or replace function public.platform_operator_overview()
 returns table(org_id uuid, org_name text, org_slug text, org_is_internal boolean, org_platform_plan text, org_created_at timestamp with time zone, stripe_connected boolean, stripe_charges_enabled boolean, member_count integer, signed_in_member_count integer, last_sign_in_at timestamp with time zone, live_program_count integer, live_camp_count integer, first_published_at timestamp with time zone, first_published_is_exact boolean, publish_log_starts_at timestamp with time zone, registration_count integer, active_registration_count integer, waitlist_registration_count integer, first_registration_at timestamp with time zone, last_registration_at timestamp with time zone, last_activity_at timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to 'public', 'intelligence', 'pg_temp'
as $function$
declare
  v_log_starts_at timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select min(e.occurred_at) into v_log_starts_at
  from intelligence.platform_events e
  where e.feature = 'programs' and e.action = 'program_published' and e.outcome = 'success';

  return query
  select
    o.id, o.name, o.slug,
    coalesce(o.is_internal, false),
    o.platform_plan, o.created_at,
    nullif(btrim(coalesce(o.stripe_account_id, '')), '') is not null,
    coalesce(o.stripe_charges_enabled, false),
    m.member_count, m.signed_in_count, m.last_sign_in_at,
    p.live_count, c.live_count,
    least(ev.first_published_at, p.first_published_at, c.first_published_at),
    case
      when least(ev.first_published_at, p.first_published_at, c.first_published_at) is null
        then null
      when ev.first_published_at is not null
       and ev.first_published_at <= coalesce(p.first_published_at, ev.first_published_at)
       and ev.first_published_at <= coalesce(c.first_published_at, ev.first_published_at)
        then true
      when c.first_published_at is not null
       and c.first_published_at <= coalesce(p.first_published_at, c.first_published_at)
        then true
      else false
    end,
    v_log_starts_at,
    r.reg_count, r.active_count, r.waitlist_count, r.first_at, r.last_at,
    greatest(p.last_created_at, c.last_created_at, r.last_at)
  from organizations o
  left join lateral (
    select
      count(*)::int                                              as member_count,
      count(*) filter (where u.last_sign_in_at is not null)::int as signed_in_count,
      max(u.last_sign_in_at)                                     as last_sign_in_at
    from org_members om
    left join auth.users u on u.id = om.auth_user_id
    where om.organization_id = o.id
  ) m on true
  left join lateral (
    select min(e.occurred_at) as first_published_at
    from intelligence.platform_events e
    where e.organization_id = o.id
      and e.feature = 'programs'
      and e.action  = 'program_published'
      and e.outcome = 'success'
  ) ev on true
  left join lateral (
    select
      count(*) filter (where pr.status = 'open')::int                   as live_count,
      min(pr.created_at) filter (
        where pr.status is not null and pr.status <> 'draft'
      )                                                                 as first_published_at,
      max(pr.created_at)                                                as last_created_at
    from programs pr
    where pr.organization_id = o.id
  ) p on true
  left join lateral (
    select
      count(*) filter (where cs.status = 'active')::int                 as live_count,
      min(cs.created_at) filter (
        where cs.status is not null and cs.status <> 'draft'
      )                                                                 as first_published_at,
      max(cs.created_at)                                                as last_created_at
    from camp_sessions cs
    where cs.organization_id = o.id
  ) c on true
  left join lateral (
    select
      count(*)::int                                                     as reg_count,
      -- Three counts, not two: a waiting family is neither active nor cancelled, and the
      -- overview screen needs to tell "nobody has signed up" apart from "everyone who
      -- signed up is waiting for a place". Rolling waitlist into cancelled made a
      -- waitlist-only tenant read as "all cancelled".
      count(*) filter (where coalesce(rg.status, '') not in ('cancelled', 'waitlist'))::int as active_count,
      count(*) filter (where rg.status = 'waitlist')::int                                   as waitlist_count,
      min(rg.registered_at)                                             as first_at,
      max(rg.registered_at)                                             as last_at
    from registrations rg
    where rg.organization_id = o.id
  ) r on true
  order by o.created_at;
end;
$function$;

revoke all on function public.platform_operator_overview() from public;
revoke all on function public.platform_operator_overview() from anon;
revoke all on function public.platform_operator_overview() from service_role;
grant execute on function public.platform_operator_overview() to authenticated;

-- ── 5. The "was this family ever offered a place?" column ────────────────────
-- Set by the CALLER (lifecycle-automations-cron) after the invite email is actually sent,
-- NOT inside waitlist_offer_next. Stamping it in the function marked a family "offered"
-- even when the send then failed and the offer was rolled back - the exact wrong answer in
-- the exact case the column exists for. Never cleared: it is history, not live state.
alter table public.registrations
  add column if not exists waitlist_last_offered_at timestamptz;

comment on column public.registrations.waitlist_last_offered_at is
  'When this family was last successfully SENT an offer of a place from the waiting list. Stamped by lifecycle-automations-cron after the invite email leaves Resend, never inside waitlist_offer_next (an offer whose email fails is rolled back and must not count). Never cleared - it answers "did this family ever get their turn?" after the offer is over. Holds NO seat and is read by no gate.';

-- ── 4. Offer: private sentinel codes, and no premature last_offered stamp ─────
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
  perform pg_advisory_xact_lock(hashtext('waitlist:' || p_program_id::text));

  select sc.max_capacity, sc.seats_taken into v_cap, v_taken
  from program_seat_counts(array[p_program_id]) sc
  join programs p on p.id = sc.program_id
  where p.organization_id = p_org_id
    and p.status = 'open'
    and coalesce(p.runs_own_registration, false) = false;

  -- FOUND, not "is v_cap null": an uncapped class matches here with a NULL capacity and
  -- must carry on to the offer.
  if not found then
    raise exception 'waitlist_offer_next: program % is not this organisation''s, not open, or not ours to sell', p_program_id
      using errcode = '42501';
  end if;

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
    return;
  end if;

  -- Already holding a LIVE offer? Hand it back untouched; their clock keeps running.
  if v_row.waitlist_invite_expires_at is not null
     and v_row.waitlist_invite_expires_at > now() then
    return query select v_row.id, true, v_row.waitlist_invite_token,
                        v_row.waitlist_invite_expires_at, v_row.parent_email,
                        v_row.parent_first, v_row.child_first, v_row.waitlist_position;
    return;
  end if;

  -- Held an offer that has RUN OUT? That row belongs to waitlist_expire_invites; re-offering
  -- it would hand the same family a second window. Refuse and let expiry catch up.
  -- WL002, a PRIVATE class code - NOT P0002, which is Postgres's reserved no_data_found and
  -- would be raised by a stray SELECT INTO STRICT or swallowed by a no_data_found handler.
  if v_row.waitlist_invited_at is not null
     and v_row.waitlist_invite_expires_at is not null
     and v_row.waitlist_invite_expires_at <= now() then
    raise exception 'waitlist_offer_next: top of list on program % holds a lapsed invite that expiry has not cleared yet', p_program_id
      using errcode = 'WL002';
  end if;

  -- A free seat? Counted after the live-invite case, since a family holding an offer is
  -- occupying the seat. NULL/<=0 capacity is uncapped and never full. WL001, not P0001.
  if v_cap is not null and v_cap > 0 and v_taken >= v_cap then
    raise exception 'waitlist_offer_next: program % has no free seat to offer (% of %)', p_program_id, v_taken, v_cap
      using errcode = 'WL001';
  end if;

  v_token   := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + p_hold;

  -- The live-offer trio only. waitlist_last_offered_at is stamped by the caller after the
  -- email sends (see the column comment), so a rolled-back offer never records as offered.
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
  'Offer the open place to the top of a program''s waiting list: stamps the live-offer trio (invited_at, expires_at, token) and mints a single-use token, atomically under the shared per-program advisory lock. REFUSES with WL001 unless a seat is genuinely free by registration_holds_seat(); refuses with WL002 when the top of the list holds an already-lapsed invite that expiry has not cleared (the caller skips, next tick handles it). WL001/WL002 are a private class, deliberately NOT P0001/P0002 - P0002 is Postgres''s reserved no_data_found. Does NOT stamp waitlist_last_offered_at; the caller does that after the email actually sends, so a rolled-back offer is not recorded as offered. Uses FOUND, not a NULL capacity, so an uncapped class keeps its queue moving. Idempotent for a family already holding a live invite. SECURITY DEFINER, service_role only.';

revoke all on function public.waitlist_offer_next(uuid, uuid, interval) from public;
revoke execute on function public.waitlist_offer_next(uuid, uuid, interval) from anon;
revoke execute on function public.waitlist_offer_next(uuid, uuid, interval) from authenticated;
grant execute on function public.waitlist_offer_next(uuid, uuid, interval) to service_role;

-- ── 6. Expire: LEFT JOIN so a lapsed row is never silently dropped ───────────
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
  select coalesce(array_agg(distinct r.program_id order by r.program_id), '{}')
    into v_progs
  from registrations r
  where r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    and r.waitlist_invite_expires_at <= now();

  if cardinality(v_progs) = 0 then
    return;
  end if;

  foreach v_prog in array v_progs loop
    perform pg_advisory_xact_lock(hashtext('waitlist:' || v_prog::text));
  end loop;

  -- drop-if-exists so a second call in the SAME transaction (a verifier running two selects
  -- in one txn) cannot hit 42P07 on the on-commit-drop temp table.
  drop table if exists _done;
  create temp table _done (
    id uuid, program_id uuid, organization_id uuid, parent_id uuid, student_id uuid
  ) on commit drop;

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
    return;
  end if;

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

  -- LEFT JOIN, not INNER: a row whose student or parent was removed is still genuinely
  -- lapsed and still in _done. An inner join would drop it here - cancelled, off the list,
  -- but absent from the count and never reported - so the caller could neither log it nor
  -- (where an address exists) tell the family. The caller skips a null email itself.
  return query
    select d.id, d.program_id, d.organization_id, pa.email, s.first_name
    from _done d
    left join parents pa on pa.id = d.parent_id
    left join students s on s.id = d.student_id;
end;
$$;

comment on function public.waitlist_expire_invites() is
  'Sweep: every waitlist invite whose hold has run out is cancelled (a lapsed family comes OFF the list), its invite columns cleared, and each affected queue renumbered. Locks each affected program BEFORE reading (program-id order) and re-tests every expiry condition inside the UPDATE, so an overlapping tick cannot flatten a freshly offered invite. Returns the UPDATE''s own RETURNING set via LEFT JOINs to parents/students, so a lapsed row whose student/parent was removed is still reported (and counted) rather than silently dropped; the caller skips a null email. A row reported here is one THIS call lapsed - the guard against a second lapse email. SECURITY DEFINER, service_role only.';

revoke all on function public.waitlist_expire_invites() from public;
revoke execute on function public.waitlist_expire_invites() from anon;
revoke execute on function public.waitlist_expire_invites() from authenticated;
grant execute on function public.waitlist_expire_invites() to service_role;
