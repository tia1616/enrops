-- Ennie chat (provider onboarding chunk 3): one row per question a provider
-- asks Ennie, answered or not.
--
-- Why every question (not just the unanswered ones): Jessica 11/24 - the log is
-- how the guides improve. `answered` false = the guides had nothing, which is a
-- candidate for a new guide. `sources` = which guide sections the answer used.
-- `rating` = the provider's thumbs up (1) or down (-1).
--
-- Writers:
--   - ennie-help edge fn (service_role): inserts the row after the model call.
--   - the provider (authenticated): may set `rating` on their OWN row, nothing else
--     (column-level UPDATE grant + own-row policy).
-- Readers:
--   - ennie-help (service_role): the per-person daily cap count.
--   - submit-feedback (caller's JWT): loads the caller's own rows for one
--     conversation to attach the transcript to a "Send to the enrops team" email.
--   - platform admins (SQL / future screen).
-- No anon access. No authenticated INSERT: a provider can't forge a row that
-- would later be mailed to Jessica as "what Ennie said".

create table if not exists public.ennie_questions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  auth_user_id uuid not null,
  conversation_id uuid not null,
  question text not null check (char_length(question) between 1 and 1000),
  answer text,
  answered boolean not null default false,
  sources text[] not null default '{}',
  rating smallint check (rating in (-1, 1)),
  page_path text,
  model text,
  input_tokens integer,
  cache_read_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);

create index if not exists ennie_questions_user_created_idx
  on public.ennie_questions (auth_user_id, created_at desc);
create index if not exists ennie_questions_conversation_idx
  on public.ennie_questions (conversation_id, created_at);

alter table public.ennie_questions enable row level security;

-- 10/30 Supabase change: new tables get no automatic grants. Grant exactly what
-- each role needs.
revoke all on public.ennie_questions from anon, authenticated, public;
grant select, insert, update, delete on public.ennie_questions to service_role;
grant select on public.ennie_questions to authenticated;
grant update (rating) on public.ennie_questions to authenticated;

drop policy if exists ennie_questions_own_read on public.ennie_questions;
create policy ennie_questions_own_read on public.ennie_questions
  for select to authenticated
  using (auth_user_id = auth.uid() or public.is_platform_admin());

drop policy if exists ennie_questions_own_rate on public.ennie_questions;
create policy ennie_questions_own_rate on public.ennie_questions
  for update to authenticated
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
