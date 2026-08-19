-- The two halves of accepting an invite: look it up, and spend it.
--
-- The invite email links to /<org>/waitlist/<token>. That page has to tell a family whose
-- place it is, which class, and how long they have - none of which anon can read, because
-- registrations is behind RLS and this family has no account. So the TOKEN is the
-- credential: whoever holds it gets exactly one registration's worth of prefill and
-- nothing else.

-- ---------------------------------------------------------------------------
-- 1. LOOKUP. Read-only, and returns nothing at all unless the invite is live.
--
-- Deliberately returns NO ROWS for unknown / expired / already-spent, rather than a row
-- with a reason code. The page needs to distinguish "expired" from "never existed" to
-- word its message, but the DIFFERENCE is not worth leaking: a valid-looking token that
-- says "expired" confirms it once existed. The page says the same honest thing either
-- way ("this invitation is no longer valid"), so one silence covers both.
-- ---------------------------------------------------------------------------

create or replace function public.waitlist_invite_lookup(p_token text)
returns table (
  registration_id   uuid,
  program_id        uuid,
  organization_id   uuid,
  org_slug          text,
  expires_at        timestamptz,
  program_name      text,
  site_name         text,
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
         s.first_name, s.last_name, s.grade,
         pa.first_name, pa.last_name, pa.email, pa.phone
  from registrations r
  join organizations o on o.id = r.organization_id
  join programs p on p.id = r.program_id
  left join program_locations pl on pl.id = p.program_location_id
  join students s on s.id = r.student_id
  join parents pa on pa.id = r.parent_id
  where r.waitlist_invite_token = p_token
    and r.status = 'waitlist'
    and r.cancelled_at is null
    and r.waitlist_invite_expires_at is not null
    and r.waitlist_invite_expires_at > now()
    -- An empty or whitespace token must never match. Belt and braces: the column is
    -- NULL on every uninvited row, so `= ''` could not match anyway, but a future
    -- backfill writing '' would silently hand every waitlist row to anyone.
    and coalesce(nullif(btrim(p_token), ''), null) is not null;
$$;

comment on function public.waitlist_invite_lookup(text) is
  'Resolve a waitlist invite token to the one registration it belongs to, with the prefill the accept page needs. Returns NO ROWS for an unknown, expired, spent or cancelled token - the page words those identically on purpose, so a response cannot confirm a token once existed. The token IS the credential here: this is how an invited family, who has no account, reads a row that RLS otherwise hides. SECURITY DEFINER, service_role only - reached through the public waitlist-accept endpoint.';

revoke all on function public.waitlist_invite_lookup(text) from public;
revoke execute on function public.waitlist_invite_lookup(text) from anon;
revoke execute on function public.waitlist_invite_lookup(text) from authenticated;
grant execute on function public.waitlist_invite_lookup(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. CONSUME. Spend the invite, once.
--
-- Called by create-registration AFTER the real registration rows exist. The family is
-- now enrolled, so their waitlist row stops being a waitlist row: it is cancelled, its
-- token cleared, and the queue behind them closes up.
--
-- SINGLE USE IS ENFORCED BY THE WHERE CLAUSE, not by the caller remembering. The update
-- matches only while the token is still present, so a replayed link updates zero rows and
-- returns false. That matters because the link goes in an email, and email links get
-- clicked twice, forwarded, and prefetched by scanners.
-- ---------------------------------------------------------------------------

create or replace function public.waitlist_invite_consume(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program uuid;
  v_hit     boolean := false;
begin
  select r.program_id into v_program
  from registrations r
  where r.waitlist_invite_token = p_token
    and r.status = 'waitlist'
    and r.cancelled_at is null;

  if v_program is null then
    return false;
  end if;

  -- Same key as join / remove / offer, so the renumber below cannot interleave with them.
  perform pg_advisory_xact_lock(hashtext('waitlist:' || v_program::text));

  update registrations
     set status                     = 'cancelled',
         cancelled_at               = now(),
         waitlist_invite_token      = null,
         waitlist_invited_at        = null,
         waitlist_invite_expires_at = null,
         waitlist_position          = null
   where waitlist_invite_token = p_token
     and status = 'waitlist'
     and cancelled_at is null;

  get diagnostics v_hit = row_count;
  if not v_hit then
    return false;
  end if;

  -- Close the gap, exactly as waitlist_remove does. Someone leaving by accepting a place
  -- and someone leaving by asking to come off must not renumber differently.
  with ordered as (
    select r.id, row_number() over (order by r.waitlist_position, r.registered_at) as pos
    from registrations r
    where r.program_id = v_program
      and r.status = 'waitlist'
      and r.cancelled_at is null
  )
  update registrations r
     set waitlist_position = o.pos
    from ordered o
   where r.id = o.id
     and r.waitlist_position is distinct from o.pos;

  return true;
end;
$$;

comment on function public.waitlist_invite_consume(text) is
  'Spend a waitlist invite after the family has actually registered: cancels the waitlist row, clears the token so the link cannot be replayed, and renumbers the queue behind them the same way waitlist_remove does. Single use is enforced in the WHERE clause, not by the caller - a second click updates nothing and returns false. Deliberately does NOT check expiry: create-registration validates that before writing, and once real registration rows exist, refusing to tidy the waitlist row would leave the family holding a phantom place. SECURITY DEFINER, service_role only.';

revoke all on function public.waitlist_invite_consume(text) from public;
revoke execute on function public.waitlist_invite_consume(text) from anon;
revoke execute on function public.waitlist_invite_consume(text) from authenticated;
grant execute on function public.waitlist_invite_consume(text) to service_role;
