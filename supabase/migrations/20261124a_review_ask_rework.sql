-- Review ask rework (J2S Reviews Playbook section 4; ops manual section 10).
--
-- What changes, platform-wide (no tenant is named anywhere in this file):
--   1. New trigger 'days_after_last_session'. N = 0 means 6 pm org-local on the
--      last date derive_program_session_dates returns for the program.
--      Chosen PER AUTOMATION (automations.trigger_override), not by rewriting the
--      template, so a contact-only tenant keeps 'days_after_engagement'.
--   2. A second copy variant for withdrawn / refunded registrations
--      (template default + per-org override), and a per-automation reply-to.
--   3. organizations.google_review_url: where the tracked button lands.
--      NULL = the ask does not send (fail closed, logged), never a guessed URL.
--   4. org_household_flags: staff / instructor / owner households, never asked.
--      Instructor households are matched live by email (review_ask_excluded_emails),
--      so a new instructor is excluded without anyone remembering to flag them.
--   5. review_asks: one row per (automation, registration, term). It is the
--      per-term "already asked" ledger, the click record (tracked redirect),
--      the reminder record, and what the admin per-program view reads.
--   6. Template 'check_in_camp': camp day-1 evening check-in, camps only.
--   7. review_request template defaults: one Google button, no star links.
--
-- Additive. Nothing existing is dropped or narrowed (the CHECK below only adds
-- a value: BEFORE = 18 values, AFTER = the same 18 + 1, LOST = none).
-- Supabase 10/30 grant change: new tables get explicit grants below.
-- Apply to STAGING first, then PROD in the same pass (parity).

begin;

-- 1. Trigger value ------------------------------------------------------------
alter table public.automation_templates
  drop constraint if exists automation_templates_trigger_type_check;
alter table public.automation_templates
  add constraint automation_templates_trigger_type_check
  check (trigger_type = any (array[
    'event_registration_confirmed','days_before_first_session','days_after_first_session',
    'session_midpoint','session_last_day','birthday','event_registration_abandoned',
    'survey_pending','contact_added','contact_dormant','days_after_engagement',
    'days_before_no_school','instructor_birthday','operator_initiated','partner_roster',
    'class_photos_uploaded','installment_reminder','final_class_photo',
    'days_after_last_session'
  ]));

-- Per-automation trigger choice. NULL = the template's own trigger_type.
-- Only triggers that are interchangeable for the same email are allowed here.
alter table public.automations
  add column if not exists trigger_override text
    check (trigger_override is null or trigger_override in ('days_after_last_session','days_after_engagement')),
  add column if not exists reply_to_override text
    check (reply_to_override is null or reply_to_override ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column if not exists withdrawn_subject_override text,
  add column if not exists withdrawn_body_override text,
  -- Reminder to families with no click, N days after the ask. NULL/0 = off.
  add column if not exists reminder_days_after smallint
    check (reminder_days_after is null or reminder_days_after between 1 and 14);

comment on column public.automations.trigger_override is
  'NULL = use automation_templates.trigger_type. Lets one org run review_request off the last session while another runs it off engagement.';
comment on column public.automations.reply_to_override is
  'NULL = org default reply-to (org_branding.email_reply_to). Set when a specific person should get the replies to this one automation.';

-- 2. Withdrawn/refunded copy defaults on the template ---------------------------
alter table public.automation_templates
  add column if not exists default_withdrawn_subject text,
  add column if not exists default_withdrawn_body text;

-- 3. Where the review button lands ---------------------------------------------
alter table public.organizations
  add column if not exists google_review_url text
    check (google_review_url is null or google_review_url ~* '^https://');
comment on column public.organizations.google_review_url is
  'The org''s Google review form link (e.g. https://g.page/r/<id>/review). The review ask button goes through review-go, which records the click and redirects here. NULL = review asks do not send.';

-- 4. Staff / instructor / owner households ------------------------------------
-- Keyed by EMAIL, not parent_id: admins cannot read parents rows (parents RLS
-- hides most registered parents), and every admin surface that opens a family
-- (the Contacts drawer) already works by email. The exclusion function expands
-- a flagged address to its whole household.
create table if not exists public.org_household_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and email like '%@%'),
  flag text not null check (flag in ('staff','instructor','owner')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (organization_id, email)
);
comment on table public.org_household_flags is
  'Households this org must never send a review ask to (Google: no reviews from staff, instructors, owners or their families). Instructor households are ALSO matched live by email in review_ask_excluded_emails.';

alter table public.org_household_flags enable row level security;
create policy org_household_flags_read on public.org_household_flags
  for select to authenticated using (check_org_access(organization_id));
create policy org_household_flags_insert on public.org_household_flags
  for insert to authenticated with check (can_edit_org(organization_id));
create policy org_household_flags_update on public.org_household_flags
  for update to authenticated using (can_edit_org(organization_id)) with check (can_edit_org(organization_id));
create policy org_household_flags_delete on public.org_household_flags
  for delete to authenticated using (can_edit_org(organization_id));
grant select, insert, update, delete on public.org_household_flags to authenticated;
grant all on public.org_household_flags to service_role;

-- Every address that belongs to an excluded household, with why.
-- Household = parents.email UNION student_contacts.email for that parent's
-- students (same definition as every other send exclusion).
create or replace function public.review_ask_excluded_emails(p_org uuid)
returns table (email text, reason text)
language sql stable security definer set search_path = public as $$
  with seed as (
    -- Flagged by the operator, plus every active-or-not instructor of this org
    -- (auto: a new instructor is excluded without anyone flagging them).
    select f.email, f.flag from org_household_flags f where f.organization_id = p_org
    union
    select distinct lower(trim(i.email)), 'instructor' from instructors i
    where i.organization_id = p_org and i.email is not null and trim(i.email) <> ''
  ),
  -- The parent rows those addresses belong to (this org's families only), via
  -- the parent's own address OR a student contact's address on their child.
  households as (
    select distinct pa.id as parent_id, s.flag
    from seed s
    join parents pa on lower(trim(pa.email)) = s.email
    join registrations r on r.parent_id = pa.id and r.organization_id = p_org
    union
    select distinct st.parent_id, s.flag
    from seed s
    join student_contacts sc on lower(trim(sc.email)) = s.email and sc.organization_id = p_org
    join students st on st.id = sc.student_id
  )
  select lower(trim(pa.email)), h.flag from households h join parents pa on pa.id = h.parent_id
  where pa.email is not null
  union
  select lower(trim(sc.email)), h.flag from households h
    join students s on s.parent_id = h.parent_id
    join student_contacts sc on sc.student_id = s.id and sc.organization_id = p_org
  where sc.email is not null and trim(sc.email) <> ''
  union
  select email, flag from seed;
$$;
revoke all on function public.review_ask_excluded_emails(uuid) from public, anon, authenticated;
grant execute on function public.review_ask_excluded_emails(uuid) to service_role;

-- 5. Review ask ledger ----------------------------------------------------------
create table if not exists public.review_asks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  registration_id uuid not null references public.registrations(id) on delete cascade,
  program_id uuid references public.programs(id) on delete set null,
  term text not null,
  family_email text not null,           -- lower(trim()), the per-term dedup unit
  variant text not null check (variant in ('standard','withdrawn')),
  asked_at timestamptz,                 -- NULL until the email actually sent
  reminded_at timestamptz,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  click_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (automation_id, registration_id, term)
);
comment on table public.review_asks is
  'One row per registration covered by a review ask, per term. Written only by lifecycle-automations-cron and review-go (service role). Clicks are per registration: a family email covering two children records the click on both rows.';
create index if not exists review_asks_family_idx on public.review_asks (organization_id, term, family_email);
create index if not exists review_asks_reminder_due_idx on public.review_asks (asked_at)
  where reminded_at is null and first_clicked_at is null and asked_at is not null;
create index if not exists review_asks_program_idx on public.review_asks (program_id);

alter table public.review_asks enable row level security;
create policy review_asks_read on public.review_asks
  for select to authenticated using (check_org_access(organization_id));
grant select on public.review_asks to authenticated;
-- Default privileges hand anon SELECT on new tables; RLS already blocks it
-- (policies are TO authenticated), but take the grant away too.
revoke all on public.review_asks from anon;
revoke all on public.org_household_flags from anon;
grant all on public.review_asks to service_role;

-- Atomic click record: one call marks every row of the family's ask.
create or replace function public.record_review_click(p_ask_id uuid)
returns text
language sql security definer set search_path = public as $$
  with a as (select organization_id, automation_id, term, family_email from review_asks where id = p_ask_id),
  upd as (
    update review_asks ra
       set first_clicked_at = coalesce(ra.first_clicked_at, now()),
           last_clicked_at = now(),
           click_count = ra.click_count + 1
      from a
     where ra.organization_id = a.organization_id and ra.automation_id = a.automation_id
       and ra.term = a.term and ra.family_email = a.family_email and ra.asked_at is not null
    returning ra.organization_id
  )
  select o.google_review_url from organizations o where o.id = (select organization_id from a);
$$;
revoke all on function public.record_review_click(uuid) from public, anon, authenticated;
grant execute on function public.record_review_click(uuid) to service_role;

-- Admin view: per program, for one org. check_org_access inside, so an
-- authenticated caller only ever sees their own org.
create or replace function public.review_ask_stats(p_org uuid)
returns table (program_id uuid, program_name text, term text, families_asked bigint,
               withdrawn_asked bigint, clicked bigint, reminded bigint, clicked_after_reminder bigint,
               last_asked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select ra.program_id, coalesce(p.curriculum, '(deleted class)'), ra.term,
         count(distinct ra.family_email) filter (where ra.asked_at is not null),
         count(distinct ra.family_email) filter (where ra.asked_at is not null and ra.variant = 'withdrawn'),
         count(distinct ra.family_email) filter (where ra.first_clicked_at is not null),
         count(distinct ra.family_email) filter (where ra.reminded_at is not null),
         count(distinct ra.family_email) filter (where ra.reminded_at is not null and ra.first_clicked_at > ra.reminded_at),
         max(ra.asked_at)
    from review_asks ra left join programs p on p.id = ra.program_id
   where ra.organization_id = p_org and check_org_access(p_org)
   group by ra.program_id, p.curriculum, ra.term;
$$;
revoke all on function public.review_ask_stats(uuid) from public, anon;
grant execute on function public.review_ask_stats(uuid) to authenticated, service_role;

-- 6. Camp day-1 check-in template (dormant until an org turns it on) ----------
insert into public.automation_templates (
  key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
  default_subject, default_body, default_timing, time_saved_minutes_per_send,
  push_to_parent_portal, is_v1_enabled, sort_order
) values (
  'check_in_camp',
  'Camp day-one check-in',
  'Asks camp families how day one went, the evening of the first camp day, so you can fix things before the next morning. Camps only.',
  'days_after_first_session', 'camps', 'informational',
  'How was day one, {{first_name}}?',
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>
<p style="margin:0 0 16px;">{{child_first_name}} just finished day one of {{program_name}}. If anything should be different tomorrow (drop-off, the group, the project, anything at all), reply tonight and we''ll get on it before drop-off.</p>
<p style="margin:0;">{{sender_name}}, {{org_name}}</p>',
  '{"days_after": 0}'::jsonb, 3, false, true,
  (select coalesce(sort_order, 40) + 1 from public.automation_templates where key = 'check_in')
) on conflict (key) do nothing;

-- 7. review_request platform defaults: one Google button, no stars -------------
-- Platform copy only (no tenant name or phone). Orgs with their own override
-- are untouched. {{review_link_url}} is the tracked review-go link.
update public.automation_templates set
  description = 'Asks every family for a Google review the evening their class or camp ends, with one reminder to anyone who has not clicked. Withdrawn and refunded families get their own wording. Staff, instructor and owner households are never asked.',
  default_subject = 'Two minutes for {{child_first_name}}''s class?',
  default_body = '<p style="margin:0 0 16px;">Hi {{first_name}},</p>
<p style="margin:0 0 16px;">{{child_first_name}} just finished {{program_name}}. Thank you for sharing them with us this term.</p>
<p style="margin:0 0 16px;">One favor: would you leave us a Google review? Two sentences is plenty. It is how the next family decides whether to try us.</p>
<p style="margin:0 0 16px;"><a href="{{review_link_url}}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#674EE8;color:#ffffff;font-weight:600;text-decoration:none;">Leave a Google review</a></p>
<p style="margin:0 0 16px;">If something should have been better, hit reply and tell me. I read every one, and it changes what we do next term.</p>
<p style="margin:0;">{{sender_name}}</p>',
  default_withdrawn_subject = 'Two minutes for {{program_name}}?',
  default_withdrawn_body = '<p style="margin:0 0 16px;">Hi {{first_name}},</p>
<p style="margin:0 0 16px;">Thank you for trying {{program_name}} with us this term.</p>
<p style="margin:0 0 16px;">One favor: would you leave us a Google review? Two sentences is plenty, whatever your experience was. It is how the next family decides whether to try us.</p>
<p style="margin:0 0 16px;"><a href="{{review_link_url}}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#674EE8;color:#ffffff;font-weight:600;text-decoration:none;">Leave a Google review</a></p>
<p style="margin:0 0 16px;">If something should have been better, hit reply and tell me. I read every one, and it changes what we do next term.</p>
<p style="margin:0;">{{sender_name}}</p>'
where key = 'review_request';

commit;
