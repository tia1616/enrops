-- ============================================================================
-- Enrops STAGING — synthetic PEOPLE against the REAL J2S catalog
-- ============================================================================
-- Run AFTER load_catalog.sql (which copies J2S's real catalog/config from prod).
-- Creates 100% FAKE families, children, instructors, and registrations linked
-- to the REAL programs / camp_sessions / venues. No real PII.
--
-- Org: Journey to STEAM = 1adf10ad-d091-4aa0-82e3-af331468ea2b
-- All test login emails: @staging.enrops.test   password: EnropsStaging1
-- Idempotent: the cleanup block removes prior synthetic people (not the catalog).
-- ============================================================================
\set ON_ERROR_STOP on
set search_path = public, extensions, pg_catalog;
begin;

-- ---- Cleanup prior synthetic people (NEVER touches the copied catalog) -----
delete from public.camp_assignments    where instructor_id in (select id from public.instructors where email like '%@staging.enrops.test');
delete from public.program_assignments where instructor_id in (select id from public.instructors where email like '%@staging.enrops.test');
delete from public.contractor_onboarding_status where instructor_id in (select id from public.instructors where email like '%@staging.enrops.test');
delete from public.registrations where student_id in (select id from public.students where parent_id in (select id from public.parents where email like '%@staging.enrops.test'));
delete from public.students where parent_id in (select id from public.parents where email like '%@staging.enrops.test');
delete from public.marketing_recipients where email like '%@staging.enrops.test';
delete from public.parents  where email like '%@staging.enrops.test';
delete from public.instructors where email like '%@staging.enrops.test';
delete from public.org_members where email like '%@staging.enrops.test';
delete from auth.identities where user_id in (select id from auth.users where email like '%@staging.enrops.test');
delete from auth.users where email like '%@staging.enrops.test';

-- ---- Auth users (admin + 2 instructor + 2 parent logins) -------------------
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000001','authenticated','authenticated',
   'admin@staging.enrops.test', crypt('EnropsStaging1', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000011','authenticated','authenticated',
   'instructor1@staging.enrops.test', crypt('EnropsStaging1', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000012','authenticated','authenticated',
   'instructor2@staging.enrops.test', crypt('EnropsStaging1', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000021','authenticated','authenticated',
   'parent1@staging.enrops.test', crypt('EnropsStaging1', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000022','authenticated','authenticated',
   'parent2@staging.enrops.test', crypt('EnropsStaging1', gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now(), now()
from auth.users u where u.email like '%@staging.enrops.test';

-- ---- Admin membership in the real J2S org ----------------------------------
insert into public.org_members (organization_id, auth_user_id, email, name, role, accepted_at)
values ('1adf10ad-d091-4aa0-82e3-af331468ea2b','00a00000-0000-0000-0000-000000000001',
        'admin@staging.enrops.test', 'Staging Admin', 'owner', now());

-- ---- Instructors (2 with logins + 8 bulk) ----------------------------------
insert into public.instructors (id, organization_id, auth_user_id, first_name, last_name, email, phone, is_active, onboarding_status, contractor_tier, shirt_size)
values
 ('14570000-0000-0000-0000-000000000001','1adf10ad-d091-4aa0-82e3-af331468ea2b','00a00000-0000-0000-0000-000000000011','Riley','Chen','instructor1@staging.enrops.test','503-555-1001',true,'complete','lead','M'),
 ('14570000-0000-0000-0000-000000000002','1adf10ad-d091-4aa0-82e3-af331468ea2b','00a00000-0000-0000-0000-000000000012','Sam','Patel','instructor2@staging.enrops.test','503-555-1002',true,'complete','developing','L');

insert into public.instructors (id, organization_id, first_name, last_name, email, phone, is_active, onboarding_status, contractor_tier, shirt_size)
select
  ('14570000-0000-0000-0000-0000000000'||lpad(to_hex(2+g),2,'0'))::uuid,
  '1adf10ad-d091-4aa0-82e3-af331468ea2b',
  (array['Jordan','Taylor','Morgan','Casey','Avery','Quinn','Drew','Reese'])[g],
  (array['Nguyen','Garcia','Lee','Brooks','Flores','Kim','Reyes','Ortiz'])[g],
  'inst'||(2+g)||'@staging.enrops.test',
  '503-555-10'||lpad((2+g)::text,2,'0'),
  true,
  (array['complete','complete','in_progress','pending_background_check','invited','complete','in_progress','not_invited'])[g],
  case when g % 2 = 0 then 'lead' else 'developing' end,
  (array['S','M','L','XL','M','L','S','XL'])[g]
from generate_series(1,8) g;

insert into public.contractor_onboarding_status
  (instructor_id, organization_id, overall_status, checkr_status, stripe_connect_status, stripe_connect_account_id, background_check_source)
values
 ('14570000-0000-0000-0000-000000000001','1adf10ad-d091-4aa0-82e3-af331468ea2b','complete','clear','complete','acct_stg_inst1','checkr'),
 ('14570000-0000-0000-0000-000000000002','1adf10ad-d091-4aa0-82e3-af331468ea2b','complete','clear','complete','acct_stg_inst2','checkr');

-- ---- Parents (2 login + 28 bulk) -------------------------------------------
insert into public.parents (id, first_name, last_name, email, phone, auth_id, vip_status)
values
 ('11110000-0000-0000-0000-000000000021','Dana','Sullivan','parent1@staging.enrops.test','503-555-2001','00a00000-0000-0000-0000-000000000021','returning'),
 ('11110000-0000-0000-0000-000000000022','Chris','Walsh','parent2@staging.enrops.test','503-555-2002','00a00000-0000-0000-0000-000000000022','new');

insert into public.parents (id, first_name, last_name, email, phone, vip_status)
select
  ('11110000-0000-0000-0000-'||lpad(to_hex(g),12,'0'))::uuid,
  (array['Alex','Blake','Cameron','Dakota','Emery','Finley','Gray','Harper','Indigo','Jamie','Kai','Logan','Marley','Noel','Oakley','Parker','Rowan','Sage','Tatum','River','Sky','Lane','Hayden','Sawyer','Ari','Brett','Devon','Ellis'])[g],
  (array['Adams','Bell','Cruz','Diaz','Evans','Ford','Gray','Hill','Ivers','Jones','Klein','Long','Marsh','Nash','Owens','Price','Quinn','Rhodes','Stone','Tate','Vance','Webb','York','Zane','Abbott','Boyd','Cole','Dunn'])[g],
  'parent'||(g+2)||'@staging.enrops.test',
  '503-555-20'||lpad((g+2)::text,2,'0'),
  (array['none','none','returning','new'])[1 + (g % 4)]
from generate_series(1,28) g;

-- ---- Students (40 bulk + 2 for login parents), placed at REAL venues -------
insert into public.students (id, organization_id, parent_id, first_name, last_name, grade, program_location_id)
select
  gen_random_uuid(),
  '1adf10ad-d091-4aa0-82e3-af331468ea2b',
  p.id,
  (array['Ada','Ben','Cleo','Dev','Ella','Finn','Gus','Hana','Ivy','Jude','Kit','Lia','Max','Nova','Otto','Posy','Remy','Sol','Tess','Uri','Vera','Wren','Xavi','Yael','Zola','Beau','Cora','Dash','Eve','Flynn','Gia','Hugo','Iris','Jett','Kira','Leo','Mira','Nico','Opal','Pax'])[g],
  p.last_name,
  (g % 6) + 1,
  loc.id
from generate_series(1,40) g
join lateral (select id, last_name from public.parents where email like '%@staging.enrops.test' order by id offset ((g-1) % 30) limit 1) p on true
join lateral (select id from public.program_locations where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' order by slug offset (g % 61) limit 1) loc on true;

insert into public.students (id, organization_id, parent_id, first_name, last_name, grade, program_location_id)
select v.sid, '1adf10ad-d091-4aa0-82e3-af331468ea2b', v.pid, v.fn, v.ln, v.gr,
       (select id from public.program_locations where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' order by slug limit 1)
from (values
   ('22220000-0000-0000-0000-000000000021'::uuid,'11110000-0000-0000-0000-000000000021'::uuid,'Milo','Sullivan',3),
   ('22220000-0000-0000-0000-000000000022'::uuid,'11110000-0000-0000-0000-000000000022'::uuid,'Juno','Walsh',2)
) v(sid,pid,fn,ln,gr);

-- ---- Registrations (40: ~20 camp / ~20 afterschool) on REAL programs/camps -
insert into public.registrations
  (id, organization_id, parent_id, student_id, camp_session_id, program_id,
   status, payment_method, payment_status, amount_cents, photo_release_consent, photo_release_consent_at, registered_at)
select
  gen_random_uuid(), '1adf10ad-d091-4aa0-82e3-af331468ea2b', s.parent_id, s.id,
  case when g % 2 = 0 then camp.id else null end,
  case when g % 2 = 1 then prog.id else null end,
  'confirmed','stripe','paid',
  case when g % 2 = 0 then coalesce(camp.price_cents,22500) else coalesce(prog.price_cents,18000) end,
  true, now(), now() - (g || ' days')::interval
from generate_series(1,40) g
join lateral (select id, parent_id from public.students where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' and parent_id in (select id from public.parents where email like '%@staging.enrops.test') order by id offset ((g-1) % 40) limit 1) s on true
join lateral (select id, price_cents from public.camp_sessions where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' and status='active' order by id offset ((g-1) % 40) limit 1) camp on true
join lateral (select id, price_cents from public.programs where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' order by id offset ((g-1) % 80) limit 1) prog on true;

-- login parents each get a confirmed afterschool reg (visible in parent portal)
insert into public.registrations
  (id, organization_id, parent_id, student_id, program_id, status, payment_method, payment_status, amount_cents, photo_release_consent, photo_release_consent_at)
select gen_random_uuid(), '1adf10ad-d091-4aa0-82e3-af331468ea2b', st.parent_id, st.id, prog.id,
       'confirmed','stripe','paid', coalesce(prog.price_cents,18000), true, now()
from (values ('22220000-0000-0000-0000-000000000021'::uuid),('22220000-0000-0000-0000-000000000022'::uuid)) v(sid)
join public.students st on st.id = v.sid
join lateral (select id, price_cents from public.programs where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' and status='open' order by id limit 1) prog on true;

-- ---- Camp assignments: synthetic instructors lead the first 24 active camps -
insert into public.camp_assignments (organization_id, camp_session_id, instructor_id, role, status)
select '1adf10ad-d091-4aa0-82e3-af331468ea2b', cs.id, ins.id, 'lead', 'published'
from (select id, row_number() over (order by id) rn from public.camp_sessions
      where organization_id='1adf10ad-d091-4aa0-82e3-af331468ea2b' and status='active' limit 24) cs
join lateral (select id from public.instructors
              where email like '%@staging.enrops.test' and is_active
              order by id offset ((cs.rn-1) % 10) limit 1) ins on true;

commit;
