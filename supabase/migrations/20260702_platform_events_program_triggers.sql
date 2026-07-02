-- Platform-usage capture for the two PROGRAM actions that are pure client-side
-- table writes (no edge function to hook): create a program, publish a program.
-- SECURITY DEFINER triggers so they log regardless of who made the write, and
-- entirely server-side (no front-end change). Fail-safe via the doorway.

-- Publish = status transitions to 'open'.
create or replace function intelligence.tg_program_published()
returns trigger
language plpgsql
security definer
set search_path = public, intelligence
as $$
begin
  -- Fire on each real draft->open transition (the guard prevents open->open
  -- and other-column updates from firing). NO dedupe key: a re-publish is a
  -- genuine, repeated use of the publish feature and should count.
  if new.status = 'open' and (old.status is distinct from 'open') then
    perform public.log_platform_event(
      'programs', 'program_published', 'success',
      new.organization_id, auth.uid(),
      jsonb_build_object('program_id', new.id),
      now(), null
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_program_published on public.programs;
create trigger trg_program_published
  after update of status on public.programs
  for each row execute function intelligence.tg_program_published();

-- Create = a new program row (status draft or open).
create or replace function intelligence.tg_program_created()
returns trigger
language plpgsql
security definer
set search_path = public, intelligence
as $$
begin
  perform public.log_platform_event(
    'programs', 'program_created', 'success',
    new.organization_id, auth.uid(),
    jsonb_build_object('program_id', new.id, 'status', new.status),
    now(), 'program_created:' || new.id::text
  );
  -- Created-and-published in one write (status='open' at insert): the update
  -- trigger never sees an INSERT, so log the publish here too, or born-open
  -- programs are invisible to publish metrics.
  if new.status = 'open' then
    perform public.log_platform_event(
      'programs', 'program_published', 'success',
      new.organization_id, auth.uid(),
      jsonb_build_object('program_id', new.id, 'born_open', true),
      now(), null
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_program_created on public.programs;
create trigger trg_program_created
  after insert on public.programs
  for each row execute function intelligence.tg_program_created();
