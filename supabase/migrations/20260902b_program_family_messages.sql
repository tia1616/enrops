-- The record of a message an operator sent to ONE class's families.
--
-- WHY A NEW TABLE rather than reusing one of the two that nearly fit:
--   roster_email_sends          is the PARTNER roster send - it carries
--                               partner_id and roster_camper_count, and its
--                               readers mean "we emailed the school". Putting
--                               family sends in it would make every reader
--                               disambiguate two different things.
--   program_curriculum_changes  has the right SHAPE (family_recipients jsonb,
--                               sent/failed counts) but is welded to the
--                               curriculum swap: from_/to_curriculum_id are
--                               NOT NULL-shaped columns describing that event.
-- Generalising a live audit table with existing rows and two readers is a bigger,
-- riskier change than adding one; the curriculum audit stays as it is.
--
-- ONE ROW PER SEND, with the per-recipient outcome in `recipients`. That mirrors
-- roster_email_sends and program_curriculum_changes deliberately - a person
-- reading this wants "what did I send, to whom, and did it land", and a
-- row-per-recipient table answers the third question while making the first two
-- a GROUP BY.
--
-- `recipients` HOLDS THE ADDRESSES AS SENT. It is the only way to answer "did
-- Yu Zhou actually get it" afterwards, and the reason a per-recipient `status`
-- exists at all: a row-level status only says whether ANYONE got it, so a
-- contact whose own address failed on a partial send is otherwise
-- indistinguishable from one who received it (the same defect ba39be80 fixed for
-- the camp roster send).

create table if not exists public.program_family_messages (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  program_id        uuid not null references public.programs(id) on delete cascade,
  sent_by_user_id   uuid,
  sent_at           timestamptz not null default now(),
  subject           text not null,
  body_text         text not null,
  -- What the operator chose, kept because it explains the recipient list. A send
  -- of 14 when the class has 12 enrolled is only explicable if you know the
  -- waitlist was included.
  include_waitlist  boolean not null default false,
  recipient_count   integer not null default 0,
  sent_count        integer not null default 0,
  failed_count      integer not null default 0,
  -- 'sent' | 'partial' | 'failed' | 'no_recipients'. Text rather than an enum to
  -- match every sibling send-log table in this schema.
  status            text not null default 'sent',
  recipients        jsonb not null default '[]'::jsonb
);

create index if not exists idx_program_family_messages_program
  on public.program_family_messages (program_id, sent_at desc);
create index if not exists idx_program_family_messages_org
  on public.program_family_messages (organization_id, sent_at desc);

alter table public.program_family_messages enable row level security;

-- READ: any member of the org, including a viewer. Seeing what was sent to
-- families is exactly what a read-only role is for, and it contains no money.
-- WRITE: nobody through the API. The edge function writes with the service key,
-- which bypasses RLS, so there is deliberately no INSERT/UPDATE/DELETE policy -
-- an audit row must not be forgeable or editable from a browser.
drop policy if exists members_read_program_family_messages on public.program_family_messages;
create policy members_read_program_family_messages
  on public.program_family_messages
  for select
  using (is_org_member(organization_id) or is_platform_admin());

-- GRANTS, separately from RLS, because grants fail FIRST and the tools lie about
-- them. anon is revoked by name: `revoke from public` does not remove anon's own
-- privileges, and these rows contain parent email addresses.
revoke all on table public.program_family_messages from public;
revoke all on table public.program_family_messages from anon;
grant select on table public.program_family_messages to authenticated;
grant all    on table public.program_family_messages to service_role;
