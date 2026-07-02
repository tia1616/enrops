-- Add the structured instructor link to class_schedule.
-- Idempotent + separate from the create migration so an environment that already
-- created class_schedule (staging) picks up the column too. On a fresh prod
-- create, the create migration already includes it and this is a no-op.
alter table public.class_schedule
  add column if not exists instructor_id uuid references instructors(id) on delete set null;

create index if not exists class_schedule_instructor_idx
  on public.class_schedule(instructor_id) where instructor_id is not null;
