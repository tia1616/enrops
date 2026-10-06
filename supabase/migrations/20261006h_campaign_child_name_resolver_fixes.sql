-- Two /code-review findings against resolve_registration_child_names
-- (20261006d_campaign_child_name_resolver.sql), both CONFIRMED, fixed here.
--
-- FINDING 1 — confirmed-only, not just non-cancelled. The old WHERE clause
-- was `coalesce(r.status, '') <> 'cancelled'`, which admits 'pending' (an
-- unfinished checkout) and 'waitlist' registrations. The field this function
-- replaced (marketing_recipients.child_first_name) was only ever written for
-- a CONFIRMED registration (auto_add_registrant_to_marketing_list's own
-- guard), and review_request's parallel resolver in
-- lifecycle-automations-cron/index.ts filters `.eq("status", "confirmed")`
-- for the exact same lookup. A parent's abandoned checkout, or a waitlisted
-- sibling, for the program a campaign targets could resolve and name a child
-- who never actually registered, where "your child" used to render. Now
-- `r.status = 'confirmed'`, matching both of those.
--
-- FINDING 2 — scope 2 (the program_name-snapshot fallback, used when a
-- campaign has no explicit program_ids/camp_session_ids) matched on
-- curriculum TEXT with no date bound at all, across every confirmed
-- registration a family has ever had. Confirmed reachable on live prod data:
-- a curriculum name gets reused across terms/years, so a family with
-- different children registered for it in different eras had BOTH children's
-- names joined into a single campaign about the CURRENT term. Fixed by
-- bounding scope-2 matches to within 200 days of the MOST RECENT matching
-- session date for that (email, program_name) pair — wide enough to keep a
-- multi-week/multi-month term together and to cover a retroactive send fired
-- weeks or months after the term ended (the SU26 catch-up was ~1 month
-- after), narrow enough to exclude a full year's gap between repeat
-- offerings of the same curriculum name. A registration with NO session date
-- at all (neither camp_sessions.starts_on nor programs.first_session_date
-- set) is excluded from scope 2 rather than included unboundedly — the safe
-- failure direction here is a missing name, not a wrongly-joined one.
create or replace function public.resolve_registration_child_names(
  p_organization_id uuid,
  p_email text,
  p_program_ids uuid[],
  p_camp_session_ids uuid[],
  p_program_name text
)
returns text[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  with scope1 as (
    select r.id, s.first_name
    from registrations r
    join students s on s.id = r.student_id
    join parents  p on p.id = r.parent_id
    where r.organization_id = p_organization_id
      and r.status = 'confirmed'
      and lower(btrim(p.email)) = lower(btrim(p_email))
      and s.first_name is not null and btrim(s.first_name) <> ''
      and (coalesce(array_length(p_program_ids, 1), 0) > 0 or coalesce(array_length(p_camp_session_ids, 1), 0) > 0)
      and (r.program_id = any(p_program_ids) or r.camp_session_id = any(p_camp_session_ids))
  ),
  scope2_candidates as (
    select r.id, s.first_name,
           coalesce(cs.starts_on, pr.first_session_date) as session_date
    from registrations r
    join students s on s.id = r.student_id
    join parents  p on p.id = r.parent_id
    left join programs pr on pr.id = r.program_id
    left join camp_sessions cs on cs.id = r.camp_session_id
    where r.organization_id = p_organization_id
      and r.status = 'confirmed'
      and lower(btrim(p.email)) = lower(btrim(p_email))
      and s.first_name is not null and btrim(s.first_name) <> ''
      and coalesce(array_length(p_program_ids, 1), 0) = 0
      and coalesce(array_length(p_camp_session_ids, 1), 0) = 0
      and p_program_name is not null and btrim(p_program_name) <> ''
      and lower(btrim(coalesce(cs.curriculum_name, pr.curriculum, ''))) = lower(btrim(p_program_name))
  ),
  scope2 as (
    select id, first_name
    from scope2_candidates
    where session_date >= (select max(session_date) from scope2_candidates) - interval '200 days'
  ),
  scoped_regs as (
    select id, first_name from scope1
    union all
    select id, first_name from scope2
  )
  select case when count(*) = 0 then null
         else array_agg(distinct btrim(first_name) order by btrim(first_name))
         end
  from scoped_regs;
$function$;

comment on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) is
  'For one marketing_recipients row, the real child name(s) on their CONFIRMED registration(s) scoped to a campaign''s program/camp picks, or (when the campaign has none) to the recipient''s program_name snapshot matched within a 200-day window of the most recent matching session (never across a year-apart repeat of the same curriculum name). NULL means "could not resolve — caller should fall back to the denormalized child_first_name column", never an empty send-time hole. Internal helper, not directly grantable (reads parents/students across the org) — callers are get_campaign_recipients and marketing_campaign_child_name_fallback_preview, both of which gate on org access themselves.';

-- Grants are untouched by CREATE OR REPLACE (same signature, no new column),
-- but re-assert them anyway — the anon-grant-trap discipline this whole
-- migration chain follows is "never assume a grant survived," not "assume it
-- did because the mechanism usually preserves it."
revoke all on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) from public;
revoke all on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) from anon;
revoke all on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) from authenticated;
grant execute on function public.resolve_registration_child_names(uuid, text, uuid[], uuid[], text) to service_role;
