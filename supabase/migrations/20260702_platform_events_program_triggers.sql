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
  if new.status = 'open' and (old.status is distinct from 'open') then
    perform public.log_platform_event(
      'programs', 'program_published', 'success',
      new.organization_id, auth.uid(),
      jsonb_build_object('program_id', new.id),
      now(), 'program_published:' || new.id::text
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
  return new;
end;
$$;

drop trigger if exists trg_program_created on public.programs;
create trigger trg_program_created
  after insert on public.programs
  for each row execute function intelligence.tg_program_created();
