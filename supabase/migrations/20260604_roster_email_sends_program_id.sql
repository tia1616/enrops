-- roster_email_sends: support afterschool PROGRAM rosters, not just camps.
-- Camps log with camp_session_id; afterschool programs log with program_id.
-- One of the two is set per row (camp roster vs program roster email).

alter table public.roster_email_sends
  alter column camp_session_id drop not null;

alter table public.roster_email_sends
  add column if not exists program_id uuid references public.programs(id) on delete cascade;

create index if not exists roster_email_sends_program_id_idx
  on public.roster_email_sends (program_id);
