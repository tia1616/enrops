-- WHO gets a message about ONE class.
--
-- THIS FILE IS THE CANONICAL TEXT. It was rewritten 2026-09-02 after the
-- deployed function had moved twice (unreachable_reason, then the cancelled
-- group) while the file still held the first 3-argument version - so git
-- disagreed with BOTH databases, and the two databases disagreed with each other
-- because one had been given the commented text and one a trimmed copy. The
-- bodies are hashed in the parity check, so a comment-only difference reads as
-- drift and has to be re-triaged every time. One text, applied to both.
--
-- WHY NOT REUSE program_note_recipients. Its audience is wrong here in two ways,
-- both measured on prod 2026-09-02:
--   1. It does NOT filter on payment, so it includes PENDING CHECKOUTS - 9 rows
--      on J2S. Jessica: "only students paid and enrolled should be in on the
--      recipient list."
--   2. It returns only the account-holder parent. 92 J2S and 86 Ukulele enrolled
--      children have a SECOND guardian with an email who receives nothing.
--      Jessica: "both parents should also be emailed."
--
-- ENROLLED IS THE PLATFORM'S EXISTING RULE - un-cancelled AND (paid OR
-- confirmed). Not a stricter reading of "paid": that would have dropped 32 J2S
-- children who are confirmed-but-unpaid and DO appear on the roster the operator
-- is reading. Jessica: "if a kid is confirmed, like maybe a provider added a
-- scholarship student for free or took payment outside enrops, they still need
-- to be included."
--
-- THREE GROUPS, TWO OPT-IN, and the third exists because of a real dead end.
-- A refund sets registrations.status='cancelled' AND cancelled_at (all 11
-- refunded rows on prod are that shape), so a refunded family left the recipient
-- list permanently - the City View class on prod is cancelled with 2 refunded
-- families and returned ZERO reachable people. Sawyer's answer is a separate
-- "canceled" tab you can still message from; this is the same idea as an
-- audience flag. NOT by putting them back on the roster: a refunded child on an
-- instructor's printed roster is a child who is not coming being expected.
--
-- FLAT ROWS ON PURPOSE. One row per (recipient address, child). Collapsing to
-- one message per (address, family) is done in _shared/familyNotify.ts where it
-- has tests.

drop function if exists public.program_message_recipients(uuid, uuid, boolean);
drop function if exists public.program_message_recipients(uuid, uuid, boolean, boolean);

create function public.program_message_recipients(
  p_program_id uuid,
  p_org_id uuid,
  p_include_waitlist boolean default false,
  p_include_cancelled boolean default false
)
returns table (
  recipient_email   text,
  recipient_name    text,
  recipient_kind    text,
  parent_id         uuid,
  student_id        uuid,
  student_first_name text,
  audience          text,
  unreachable_reason text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role text;
begin
  -- Read the JWT role defensively: a failure to PARSE it must never become a
  -- failure to AUTHORISE. Same shape as program_note_recipients.
  begin
    v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  exception when others then
    v_role := '';
  end;

  if v_role <> 'service_role' then
    if auth.uid() is null
       or not (can_edit_org(p_org_id) or is_platform_admin()) then
      -- PN001: a private class. Deliberately NOT P0xxx, which belongs to plpgsql
      -- itself - a caller matching on those would swallow every bare RAISE.
      raise exception 'not_authorised_for_org' using errcode = 'PN001';
    end if;
  end if;

  -- Tenant PROOF, not assertion. Empty rather than raising, so a stale program
  -- id in a URL is an empty list and not an error page.
  if not exists (
    select 1 from programs p
    where p.id = p_program_id and p.organization_id = p_org_id
  ) then
    return;
  end if;

  return query
  with rows_in_scope as (
    select
      r.id,
      r.parent_id,
      r.student_id,
      case
        when r.cancelled_at is not null or r.status = 'cancelled' then 'cancelled'
        when r.status = 'waitlist' then 'waitlist'
        else 'enrolled'
      end as audience
    from registrations r
    where r.program_id = p_program_id
      and r.organization_id = p_org_id
      and (
        -- ENROLLED. Waitlist excluded EXPLICITLY, because a waitlisted row can
        -- also be paid - otherwise a paid waiting family is emailed as though
        -- they hold a place.
        (r.cancelled_at is null and r.status <> 'cancelled'
           and r.status <> 'waitlist'
           and (r.payment_status = 'paid' or r.status = 'confirmed'))
        -- WAITING: opt-in.
        or (p_include_waitlist and r.cancelled_at is null and r.status = 'waitlist')
        -- CANCELLED / REFUNDED: opt-in, and the only way to reach a family after
        -- a refund has taken them off the roster.
        or (p_include_cancelled and (r.cancelled_at is not null or r.status = 'cancelled'))
      )
  )
  select
    lower(btrim(pa.email)),
    btrim(coalesce(pa.first_name,'') || ' ' || coalesce(pa.last_name,'')),
    'parent',
    ri.parent_id,
    ri.student_id,
    s.first_name,
    ri.audience,
    -- Returned to be COUNTED and SHOWN, never emailed. Of the 32
    -- confirmed-but-unpaid after-school registrations on prod, 22 are OES - a
    -- school that runs its own registration - and all 22 carry an @import.local
    -- address minted by the roster importers. 36 parents hold one and none has a
    -- login. Filtering only on "email is not empty" handed the operator "13
    -- recipients" on one class where zero were deliverable. invite-parents
    -- already skips this domain and counts it as skippedNoEmail; same rule.
    case when lower(btrim(pa.email)) like '%@import.local' then 'placeholder_email' end
  from rows_in_scope ri
  join parents  pa on pa.id = ri.parent_id
  join students s  on s.id  = ri.student_id
  where btrim(coalesce(pa.email,'')) <> ''

  union all

  -- The second guardian. Every guardian with an email is a recipient;
  -- de-duplication happens by (address, family) afterwards, because 12 children
  -- across the two live orgs have a guardian address identical to the primary.
  select
    lower(btrim(sc.email)),
    btrim(coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,'')),
    'guardian',
    ri.parent_id,
    ri.student_id,
    s.first_name,
    ri.audience,
    case when lower(btrim(sc.email)) like '%@import.local' then 'placeholder_email' end
  from rows_in_scope ri
  join students s on s.id = ri.student_id
  join student_contacts sc
    on sc.student_id = ri.student_id
   and sc.role = 'guardian'
  where btrim(coalesce(sc.email,'')) <> '';
end;
$function$;

-- GRANTS. `revoke from public` does NOT remove anon's own EXECUTE, so anon is
-- revoked by name - this function returns parent and guardian email addresses.
-- (2026-08-20: a DEFINER function reachable by anon leaked parent emails on prod.)
revoke all on function public.program_message_recipients(uuid, uuid, boolean, boolean) from public;
revoke all on function public.program_message_recipients(uuid, uuid, boolean, boolean) from anon;
grant execute on function public.program_message_recipients(uuid, uuid, boolean, boolean) to authenticated;
grant execute on function public.program_message_recipients(uuid, uuid, boolean, boolean) to service_role;
