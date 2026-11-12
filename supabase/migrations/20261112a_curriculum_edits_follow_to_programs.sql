-- 20261112a: a class's rename / description edit reaches the programs that show it.
--
-- WHY. programs.curriculum (the name on every card, roster and email) and
-- programs.short_description are COPIES taken when the program is built. Editing
-- the class in Offerings never reached them, so a rename left the old name on the
-- schedule: prod 2026-11-12, 10 programs still said "Minecraft Coders" months
-- after the class became "Minecraft Makers", and the Level 2 class's
-- prerequisite note named a Level 1 that no card showed.
--
-- THE RULE (one place): when a curriculum's name or short_description changes,
-- every program LINKED to it that still shows the OLD value takes the NEW one.
-- A program whose text differs from the old value was written for that program
-- on purpose (a site note, a custom blurb) and is left alone - only 38 of 126
-- linked prod programs carry the class description verbatim, so a blanket
-- overwrite would erase real work.
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
  -- No "skip a blank name" guard, on purpose: the editor saves mid-typing, so a
  -- momentary "" is one step of a chain (old -> "" -> new). Skipping it would
  -- leave programs on the old name while the class moves on, and every later
  -- step would then fail the equals-OLD test - the rename would never arrive.
  if new.name is distinct from old.name then
    update public.programs p
       set curriculum = new.name
     where p.curriculum_id = new.id
       and p.organization_id = new.organization_id
       and btrim(coalesce(p.curriculum, '')) = btrim(coalesce(old.name, ''));
  end if;

  if new.short_description is distinct from old.short_description then
    update public.programs p
       set short_description = nullif(btrim(coalesce(new.short_description, '')), '')
     where p.curriculum_id = new.id
       and p.organization_id = new.organization_id
       -- blank = blank too: a linked program with no description picks up the
       -- class's first one, which is what the program wizard would have done.
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
