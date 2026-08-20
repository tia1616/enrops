-- 20260820b_program_note_recipients.sql
--
-- ONE authoritative answer to "who gets a note about this class", read by BOTH
-- the operator's preview and the server that actually sends.
--
-- THE BUG THIS CLOSES. EditProgramCurriculumModal built its recipient preview by
-- selecting registrations -> parents as the SIGNED-IN OPERATOR, so RLS applied.
-- notify-program-curriculum-change builds the real send list with the service-role
-- client, which bypasses RLS. Those are different questions and they gave
-- different answers.
--
-- The gap is `members_see_org_parents`: an operator may only read a parent who has
-- a parent_org_relationships row for their org. Measured on PRODUCTION 2026-08-20:
--
--     Journey to STEAM  325 registered parents, 240 with no such row
--     The Ukulele Project 55 registered parents,   0 with no such row
--
-- So on a J2S class the preview could say "1 family will get a note" while the
-- send mailed three. Reproduced exactly that on staging (Happy Valley Library,
-- FA26: three families with addresses, preview showed one). The direction is the
-- dangerous one - the operator APPROVES a smaller list than what goes out, which
-- is the check-before-send rule broken by the product rather than by the person.
--
-- The modal's own comment already forbade this: "Must match
-- notify-program-curriculum-change's recipient query exactly ... if it shows a
-- family the server then does not mail (or worse, hides one it does), the preview
-- is a lie about who is being contacted." Two queries in two languages cannot be
-- kept identical by comment, which is why this is a function and not a fix to
-- either query.
--
-- WHY SECURITY DEFINER. The preview must see the same rows the send will, and the
-- send is service-role. Definer lets the operator's own client read exactly that
-- set for a program they are entitled to, without granting them the `parents`
-- table generally - so the parent-visibility RLS stays exactly as strict as it is
-- for every other surface. Only these six columns cross, for one program.
--
-- NOT FIXED HERE, deliberately: the 240 missing parent_org_relationships rows.
-- Backfilling them would change what operators can see across every parent
-- surface at once, which is a separate decision with its own review. This makes
-- the SEND PREVIEW honest without touching visibility anywhere else.

create or replace function public.program_note_recipients(
  p_program_id uuid,
  p_org_id     uuid
)
returns table (
  parent_id          uuid,
  parent_first_name  text,
  parent_last_name   text,
  parent_email       text,
  student_id         uuid,
  student_first_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- AUTHORISE THE AUTHENTICATED PATH. service_role has no auth.uid(); it is the
  -- edge function, which has already verified its caller is an owner/admin of the
  -- program's org before reaching here. For a real signed-in user this check is
  -- the only gate, so it must run whenever there IS a user.
  if auth.uid() is not null
     and not (can_edit_org(p_org_id) or is_platform_admin()) then
    raise exception 'not_authorised_for_org' using errcode = 'PN001';
  end if;

  -- Never trust the caller's org id: prove the program belongs to it. Without
  -- this, passing your own org id with someone else's program id would read their
  -- families through a definer function.
  if not exists (
    select 1 from programs p
    where p.id = p_program_id and p.organization_id = p_org_id
  ) then
    return;
  end if;

  return query
  select
    pa.id,
    pa.first_name,
    pa.last_name,
    pa.email,
    s.id,
    s.first_name
  from registrations r
  join parents  pa on pa.id = r.parent_id
  join students s  on s.id  = r.student_id
  where r.program_id = p_program_id
    and r.organization_id = p_org_id
    -- Exactly the send's own filters. A cancelled family is not in the class, and
    -- a WAITLISTED family has no place in it - telling them its curriculum changed
    -- would be a note about a class their child has not got into.
    and r.status <> 'cancelled'
    and r.status <> 'waitlist'
    and pa.email is not null;
end;
$$;

comment on function public.program_note_recipients(uuid, uuid) is
  'The single source of truth for who receives a note about a program. Read by BOTH EditProgramCurriculumModal (the operator preview) and notify-program-curriculum-change (the send), so the list an operator approves is the list that goes out. Exists because the preview ran under RLS and the send runs service-role: members_see_org_parents hides any parent with no parent_org_relationships row, which on prod 2026-08-20 was 240 of J2S''s 325 registered parents, so the preview could under-count a send. SECURITY DEFINER so the preview sees the send''s rows without widening parent visibility anywhere else. Authorises with can_edit_org whenever there is an auth.uid(); service_role callers are the edge function, which verifies its caller first. Returns nothing if the program does not belong to p_org_id. Grouping into one-entry-per-parent lives in familyRecipients.ts / familyRecipients.js, not here.';

revoke all on function public.program_note_recipients(uuid, uuid) from public;
grant execute on function public.program_note_recipients(uuid, uuid) to authenticated, service_role;
