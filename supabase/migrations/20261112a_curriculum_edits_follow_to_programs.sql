-- 20261112a: a class's rename / description edit reaches the programs that show it.
--
-- WHY. programs.curriculum (the name on every card, roster and email) and
-- programs.short_description are COPIES taken when the program is built. Editing
-- the class in Offerings never reached them, so a rename left the old name on the
-- schedule: prod 2026-11-12, 10 programs still said "Minecraft Coders" months
-- after the class became "Minecraft Makers", and the Level 2 class's
-- prerequisite note named a Level 1 that no card showed.
--
-- THE RULE (one place): when a PUBLISHED curriculum's name or short_description
-- changes, every program LINKED to it that is not cancelled or finished and
-- still shows the OLD value takes the NEW one.
--
--  - Text that differs from the old value was written for that program on
--    purpose (a site note, a custom blurb) and is left alone. Only 38 of 126
--    linked prod programs carry the class description verbatim, so a blanket
--    overwrite would erase real work.
--  - PUBLISHED only. extract-curriculum-details (re-upload) rewrites name and
--    description with fresh AI text in the same UPDATE that sets status
--    'extracted' - that text is unreviewed and must not reach live cards.
--    KNOWN GAP: edits made while a class is 'extracted' are not carried when
--    it is republished (the status flip has no old text to compare against).
--    Re-uploading a class that already has scheduled programs is rare; edit
--    the description once more after publishing to carry it.
--  - Cancelled programs keep the name they ran under. Programs with an
--    end_date in the past do too - but weekly classes rarely set end_date
--    (98 of 109 open linked prod programs, 2026-11-12), so a finished weekly
--    class that is still 'open' IS renamed. Harmless for a cosmetic rename;
--    tighten here if a last-session date ever becomes a column.
--  - A blank name never cascades (the editor no longer saves one either).
--  - Blank program description = blank old description: a linked program with
--    no description picks up the class's, as the program wizard would have.
--
-- NOT camp_sessions. Its curriculum_name is deliberately different from the
-- curriculum title on 44 of 51 prod camps, and apps-script-roster-sync uses it
-- as an identity key (Lacamas sibling weeks match on .eq('curriculum_name')), so
-- rewriting it could split a camp from its siblings.
--
-- SECURITY DEFINER so a permitted curricula edit is never silently half-applied
-- by programs RLS; scoped to the curriculum's own organization so it can never
-- reach another tenant's rows. A trigger function cannot be called over
-- PostgREST, but EXECUTE is revoked from public/anon/authenticated anyway.
--
-- Compared TRIMMED: the editor saves on every keystroke pause, and a trailing
-- space on either side must not make a program look "customised".

create or replace function public.tg_curriculum_edits_follow_to_programs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from 'published' then
    return null;
  end if;

  if new.name is distinct from old.name and btrim(coalesce(new.name, '')) <> '' then
    update public.programs p
       set curriculum = new.name
     where p.curriculum_id = new.id
       and p.organization_id = new.organization_id
       and p.status is distinct from 'cancelled'
       and (p.end_date is null or p.end_date >= current_date)
       and btrim(coalesce(p.curriculum, '')) = btrim(coalesce(old.name, ''));
  end if;

  if new.short_description is distinct from old.short_description then
    update public.programs p
       set short_description = nullif(btrim(coalesce(new.short_description, '')), '')
     where p.curriculum_id = new.id
       and p.organization_id = new.organization_id
       and p.status is distinct from 'cancelled'
       and (p.end_date is null or p.end_date >= current_date)
       and btrim(coalesce(p.short_description, '')) = btrim(coalesce(old.short_description, ''));
  end if;

  return null;
end;
$$;

revoke all on function public.tg_curriculum_edits_follow_to_programs() from public, anon, authenticated;

drop trigger if exists trg_curriculum_edits_follow_to_programs on public.curricula;
create trigger trg_curriculum_edits_follow_to_programs
  after update of name, short_description on public.curricula
  for each row
  when (old.name is distinct from new.name or old.short_description is distinct from new.short_description)
  execute function public.tg_curriculum_edits_follow_to_programs();
