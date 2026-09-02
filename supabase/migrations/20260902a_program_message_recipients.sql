-- WHO gets a message about ONE class. Additive: a NEW function, nothing dropped,
-- so program_note_recipients and its two callers are untouched.
--
-- WHY NOT REUSE program_note_recipients. Its audience is wrong for this in two
-- ways, both measured on prod 2026-09-02:
--   1. It does NOT filter on payment, so it includes PENDING CHECKOUTS - 9 rows
--      on J2S today. Jessica: "only students paid and enrolled should be in on
--      the recipient list."
--   2. It returns only the account-holder parent. 92 J2S and 86 Ukulele enrolled
--      children have a SECOND guardian with an email who currently receives
--      nothing. Jessica: "both parents should also be emailed."
-- It also cannot include the waitlist, which cancelling a class needs.
--
-- THE ENROLLMENT RULE IS THE PLATFORM'S EXISTING ONE, not a stricter reading of
-- "paid". Un-cancelled AND (payment_status = 'paid' OR status = 'confirmed') is
-- what every roster, the roster PDF, ProgramsCalendar and the instructor portal
-- already mean by enrolled. Strictly-paid-only would have excluded 32 J2S
-- children who are confirmed-but-unpaid (hand-added / offline) and who DO appear
-- on the roster the operator is looking at while they write the email. An email
-- audience that silently disagrees with the roster on screen is the bug.
--
-- WAITLIST IS OPT-IN, and it is NOT simply "the rest of the rows". A waitlisted
-- registration CAN be paid (see the known "a family can pay and still be left
-- sitting on the waiting list" defect), so the enrolled branch excludes
-- status='waitlist' EXPLICITLY. Without that, a paid waitlisted family would be
-- emailed as though they had a place, which is worse than not emailing them.
--
-- FLAT ROWS ON PURPOSE. One row per (recipient address, child). Collapsing to one
-- message per address, naming every child that address is responsible for, is
-- done in supabase/functions/_shared/familyNotify.ts where it has tests - the
-- same split as program_note_recipients + groupFamilyRecipients, whose per-CHILD
-- email against a per-PARENT list is how Yu Zhou's second son went unmentioned
-- on 2026-08-14.

create or replace function public.program_message_recipients(
  p_program_id uuid,
  p_org_id uuid,
  p_include_waitlist boolean default false
)
returns table (
  recipient_email   text,
  recipient_name    text,
  recipient_kind    text,   -- 'parent' (account holder) | 'guardian' (second contact)
  parent_id         uuid,
  student_id        uuid,
  student_first_name text,
  audience          text    -- 'enrolled' | 'waitlist'
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role text;
begin
  -- Read the JWT role defensively: the setting may be absent or not valid JSON
  -- depending on how the call arrives, and a failure to PARSE it must never
  -- become a failure to AUTHORISE. Same shape as program_note_recipients.
  begin
    v_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '');
  exception when others then
    v_role := '';
  end;

  if v_role <> 'service_role' then
    if auth.uid() is null
       or not (can_edit_org(p_org_id) or is_platform_admin()) then
      -- PN001, the same private code its sibling raises for the same meaning.
      -- Deliberately NOT a P0xxx class: those belong to plpgsql itself, so a
      -- caller matching on them would swallow every bare RAISE in the stack.
      raise exception 'not_authorised_for_org' using errcode = 'PN001';
    end if;
  end if;

  -- Tenant proof, not assertion: the class must belong to the org asked about.
  -- Returning empty (rather than raising) matches the sibling, so a stale
  -- program id in a URL is an empty recipient list, not an error page.
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
      case when r.status = 'waitlist' then 'waitlist' else 'enrolled' end as audience
    from registrations r
    where r.program_id = p_program_id
      and r.organization_id = p_org_id
      and r.cancelled_at is null
      and r.status <> 'cancelled'
      and (
        -- enrolled: the platform's rule, with waitlist excluded EXPLICITLY
        -- because a waitlisted row can also be paid.
        (r.status <> 'waitlist' and (r.payment_status = 'paid' or r.status = 'confirmed'))
        or (p_include_waitlist and r.status = 'waitlist')
      )
  )
  -- the account holder
  select
    lower(btrim(pa.email)),
    btrim(coalesce(pa.first_name,'') || ' ' || coalesce(pa.last_name,'')),
    'parent',
    ri.parent_id,
    ri.student_id,
    s.first_name,
    ri.audience
  from rows_in_scope ri
  join parents  pa on pa.id = ri.parent_id
  join students s  on s.id  = ri.student_id
  where btrim(coalesce(pa.email,'')) <> ''

  union all

  -- the second guardian, when one is on file WITH an address. sort_order is not
  -- used to pick a single "best" contact: every guardian with an email is a
  -- recipient, and de-duplication happens by ADDRESS afterwards (12 children
  -- across the two live orgs have a guardian email identical to the primary).
  select
    lower(btrim(sc.email)),
    btrim(coalesce(sc.first_name,'') || ' ' || coalesce(sc.last_name,'')),
    'guardian',
    ri.parent_id,
    ri.student_id,
    s.first_name,
    ri.audience
  from rows_in_scope ri
  join students s on s.id = ri.student_id
  join student_contacts sc
    on sc.student_id = ri.student_id
   and sc.role = 'guardian'
  where btrim(coalesce(sc.email,'')) <> '';
end;
$function$;

-- GRANTS. `revoke from public` does NOT remove anon's own EXECUTE, so anon is
-- revoked by name - this function reads parent and guardian email addresses and
-- must never be callable by an anonymous visitor. (2026-08-20: a DEFINER
-- function reachable by anon leaked parent emails on prod.)
revoke all on function public.program_message_recipients(uuid, uuid, boolean) from public;
revoke all on function public.program_message_recipients(uuid, uuid, boolean) from anon;
grant execute on function public.program_message_recipients(uuid, uuid, boolean) to authenticated;
grant execute on function public.program_message_recipients(uuid, uuid, boolean) to service_role;
