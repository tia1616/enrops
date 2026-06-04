-- ============================================================================
-- Enrops STAGING synthetic seed  (Wave A: tenant, catalog, people, regs, logins)
-- ============================================================================
-- 100% FAKE data. No prod PII. Safe to run only against the STAGING project
-- (mumfymlapolsfdnpewci). Idempotent-ish: wrapped in a transaction; re-running
-- after a successful run will conflict on unique keys — truncate first if needed.
--
-- Fixed UUIDs use recognizable prefixes so fake rows are obvious:
--   org=0e11..  cycles=0c1c..  locations=01cc..  curricula=0c11..
--   instructors=1457..  auth users=00a0..
-- All test login emails use @staging.enrops.test ; password = EnropsStaging1
-- ============================================================================

-- ---- Cleanup (makes this script safely re-runnable) -----------------------
delete from public.marketing_sends     where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.marketing_recipients where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.marketing_campaigns where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.registrations       where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.camp_assignments    where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.contractor_onboarding_status where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.students            where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.parents             where email like '%@staging.enrops.test';
delete from public.camp_sessions       where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.programs            where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.instructors         where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.scheduling_cycles   where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.curricula           where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.program_locations   where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.org_branding        where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.org_members         where organization_id='0e110000-0000-0000-0000-000000000001';
delete from public.organizations       where id='0e110000-0000-0000-0000-000000000001';
delete from auth.identities where user_id in (select id from auth.users where email like '%@staging.enrops.test');
delete from auth.users      where email like '%@staging.enrops.test';

-- ---- Organization ---------------------------------------------------------
insert into public.organizations
  (id, slug, name, legal_name, email, phone, website, status, platform_plan,
   stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled,
   instructor_pay_enabled, instructor_pay_model, timezone, stripe_country,
   pay_camp_morning_hours, pay_camp_full_day_hours, alert_email,
   default_sender_name, default_sender_email)
values
  ('0e110000-0000-0000-0000-000000000001', 'steamworks-staging', 'STEAMworks (Staging)',
   'STEAMworks Staging LLC', 'hello@steamworks.test', '503-555-0100', 'https://steamworks.test',
   'active', 'pilot', 'acct_staging_fake', 'active', true, true,
   true, 'enrops_platform', 'America/Los_Angeles', 'US',
   4.00, 8.00, 'staging-alerts@staging.enrops.test',
   'STEAMworks', 'hello@steamworks.test');

insert into public.org_branding (organization_id, hero_headline, hero_subtext, email_from_name, email_reply_to)
values ('0e110000-0000-0000-0000-000000000001', 'STEAMworks (Staging)',
        'Hands-on STEAM enrichment — staging sandbox', 'STEAMworks', 'hello@steamworks.test');

-- ---- Auth users (admin + 2 instructor logins + 2 parent logins) -----------
-- password for all = EnropsStaging1
insert into auth.users
  (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
   created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_sso_user, is_anonymous)
values
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000001','authenticated','authenticated',
   'admin@staging.enrops.test', extensions.crypt('EnropsStaging1', extensions.gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000011','authenticated','authenticated',
   'instructor1@staging.enrops.test', extensions.crypt('EnropsStaging1', extensions.gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000012','authenticated','authenticated',
   'instructor2@staging.enrops.test', extensions.crypt('EnropsStaging1', extensions.gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000021','authenticated','authenticated',
   'parent1@staging.enrops.test', extensions.crypt('EnropsStaging1', extensions.gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false),
  ('00000000-0000-0000-0000-000000000000','00a00000-0000-0000-0000-000000000022','authenticated','authenticated',
   'parent2@staging.enrops.test', extensions.crypt('EnropsStaging1', extensions.gen_salt('bf')), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false, false);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, 'email',
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       now(), now(), now()
from auth.users u
where u.id in ('00a00000-0000-0000-0000-000000000001','00a00000-0000-0000-0000-000000000011',
               '00a00000-0000-0000-0000-000000000012','00a00000-0000-0000-0000-000000000021',
               '00a00000-0000-0000-0000-000000000022');

-- admin membership
insert into public.org_members (organization_id, auth_user_id, email, name, role, accepted_at)
values ('0e110000-0000-0000-0000-000000000001','00a00000-0000-0000-0000-000000000001',
        'admin@staging.enrops.test', 'Staging Admin', 'owner', now());

-- ---- Locations (5) --------------------------------------------------------
insert into public.program_locations (id, organization_id, name, slug, district, address, contact_name, contact_email, contact_phone)
values
 ('01cc0000-0000-0000-0000-000000000001','0e110000-0000-0000-0000-000000000001','Maplewood Elementary','maplewood','West Hills SD','100 Maple St, Portland, OR','Front Office','office@maplewood.test','503-555-0201'),
 ('01cc0000-0000-0000-0000-000000000002','0e110000-0000-0000-0000-000000000001','Riverbend Elementary','riverbend','West Hills SD','220 River Rd, Portland, OR','Front Office','office@riverbend.test','503-555-0202'),
 ('01cc0000-0000-0000-0000-000000000003','0e110000-0000-0000-0000-000000000001','Oak Park Elementary','oak-park','East Valley SD','340 Oak Ave, Beaverton, OR','Front Office','office@oakpark.test','503-555-0203'),
 ('01cc0000-0000-0000-0000-000000000004','0e110000-0000-0000-0000-000000000001','Cedar Grove Community Center','cedar-grove','East Valley SD','55 Cedar Ln, Beaverton, OR','Site Lead','site@cedargrove.test','503-555-0204'),
 ('01cc0000-0000-0000-0000-000000000005','0e110000-0000-0000-0000-000000000001','Summit STEM Hub','summit-hub','Metro','900 Summit Blvd, Portland, OR','Site Lead','site@summit.test','503-555-0205');

-- ---- Curricula (6) --------------------------------------------------------
insert into public.curricula (id, organization_id, name, short_description, format, status, age_range_min, age_range_max, grade_min, grade_max, session_count)
values
 ('0c110000-0000-0000-0000-000000000001','0e110000-0000-0000-0000-000000000001','LEGO WeDo Builders','Intro robotics with LEGO WeDo','afterschool','published',6,9,1,4,8),
 ('0c110000-0000-0000-0000-000000000002','0e110000-0000-0000-0000-000000000001','Scratch Coding Quest','Game design in Scratch','afterschool','published',8,12,3,7,8),
 ('0c110000-0000-0000-0000-000000000003','0e110000-0000-0000-0000-000000000001','EV3 Robotics Lab','Advanced LEGO EV3 robotics','summer_camp','published',9,13,4,8,5),
 ('0c110000-0000-0000-0000-000000000004','0e110000-0000-0000-0000-000000000001','Python Pioneers','First steps in Python','summer_camp','published',10,14,5,9,5),
 ('0c110000-0000-0000-0000-000000000005','0e110000-0000-0000-0000-000000000001','Minecraft Engineering','Redstone & engineering in Minecraft','afterschool','published',8,12,3,7,8),
 ('0c110000-0000-0000-0000-000000000006','0e110000-0000-0000-0000-000000000001','Junior Makers','Tinkering & maker basics','summer_camp','published',5,8,0,3,5);

-- ---- Scheduling cycles (2) ------------------------------------------------
insert into public.scheduling_cycles (id, organization_id, name, cycle_type, starts_on, ends_on, status)
values
 ('0c1c0000-0000-0000-0000-0000000000c1','0e110000-0000-0000-0000-000000000001','Summer 2026','summer_camp','2026-06-22','2026-08-14','published'),
 ('0c1c0000-0000-0000-0000-0000000000a5','0e110000-0000-0000-0000-000000000001','Fall 2026','afterschool','2026-09-08','2026-12-11','scheduling');

-- ---- Camp sessions (12: 3 weeks x 2 locations x 2 half-days, capped) -------
insert into public.camp_sessions
  (id, organization_id, cycle_id, location_id, location_name, curriculum_id, curriculum_name,
   curriculum_category, week_num, session_type, starts_on, ends_on, start_time, end_time, price_cents, status)
select
  gen_random_uuid(),
  '0e110000-0000-0000-0000-000000000001',
  '0c1c0000-0000-0000-0000-0000000000c1',
  loc.id, loc.name,
  cur.id, cur.name,
  (array['lego','coding','robotics'])[1 + ((wk + half) % 3)],
  wk,
  case when half = 0 then 'morning' else 'afternoon' end,
  (date '2026-06-22' + ((wk-1) * 7)),
  (date '2026-06-22' + ((wk-1) * 7) + 4),
  case when half = 0 then time '09:00' else time '13:00' end,
  case when half = 0 then time '12:00' else time '16:00' end,
  case when half = 0 then 22500 else 22500 end,
  'active'
from generate_series(1,6) wk
cross join generate_series(0,1) half
join lateral (select id, name from public.program_locations
              where organization_id='0e110000-0000-0000-0000-000000000001'
              order by slug offset ((wk-1) % 2) limit 1) loc on true
join lateral (select id, name from public.curricula
              where organization_id='0e110000-0000-0000-0000-000000000001' and format='summer_camp'
              order by name offset ((wk+half) % 3) limit 1) cur on true;

-- ---- Programs (afterschool, 8) --------------------------------------------
insert into public.programs
  (id, organization_id, curriculum_id, program_location_id, curriculum, day_of_week, price_cents,
   status, program_type, price_tier, age_format, term, grade_min, grade_max, max_capacity,
   first_session_date, start_time, end_time)
select
  gen_random_uuid(),
  '0e110000-0000-0000-0000-000000000001',
  cur.id, loc.id, cur.name,
  (array['Monday','Tuesday','Wednesday','Thursday'])[1 + (g % 4)],
  18000,
  'open',
  case when cur.name in ('Scratch Coding Quest','Minecraft Engineering') then 'coding_robotics' else 'standard' end,
  case when cur.name in ('Scratch Coding Quest','Minecraft Engineering') then 'coding_robotics' else 'standard' end,
  'grade', 'FA26', 1, 5, 16,
  (date '2026-09-08' + (g % 5)), '15:30', '16:30'
from generate_series(1,8) g
join lateral (select id, name from public.curricula
              where organization_id='0e110000-0000-0000-0000-000000000001' and format='afterschool'
              order by name offset (g % 3) limit 1) cur on true
join lateral (select id from public.program_locations
              where organization_id='0e110000-0000-0000-0000-000000000001'
              order by slug offset (g % 5) limit 1) loc on true;

-- ---- Instructors (10; first 2 have logins) --------------------------------
insert into public.instructors (id, organization_id, auth_user_id, first_name, last_name, email, phone, is_active, onboarding_status, contractor_tier, shirt_size)
values
 ('14570000-0000-0000-0000-000000000001','0e110000-0000-0000-0000-000000000001','00a00000-0000-0000-0000-000000000011','Riley','Chen','instructor1@staging.enrops.test','503-555-1001',true,'complete','lead','M'),
 ('14570000-0000-0000-0000-000000000002','0e110000-0000-0000-0000-000000000001','00a00000-0000-0000-0000-000000000012','Sam','Patel','instructor2@staging.enrops.test','503-555-1002',true,'complete','developing','L');

insert into public.instructors (id, organization_id, first_name, last_name, email, phone, is_active, onboarding_status, contractor_tier, shirt_size)
select
  ('14570000-0000-0000-0000-0000000000'||lpad(to_hex(2+g),2,'0'))::uuid,
  '0e110000-0000-0000-0000-000000000001',
  (array['Jordan','Taylor','Morgan','Casey','Avery','Quinn','Drew','Reese'])[g],
  (array['Nguyen','Garcia','Lee','Brooks','Flores','Kim','Reyes','Ortiz'])[g],
  'inst'||(2+g)||'@staging.enrops.test',
  '503-555-10'||lpad((2+g)::text,2,'0'),
  true,
  (array['complete','complete','in_progress','pending_background_check','invited','complete','in_progress','not_invited'])[g],
  case when g % 2 = 0 then 'lead' else 'developing' end,
  (array['S','M','L','XL','M','L','S','XL'])[g]
from generate_series(1,8) g;

-- contractor onboarding rows for the 2 fully-cleared instructors
insert into public.contractor_onboarding_status
  (instructor_id, organization_id, overall_status, checkr_status, stripe_connect_status, stripe_connect_account_id, background_check_source)
values
 ('14570000-0000-0000-0000-000000000001','0e110000-0000-0000-0000-000000000001','complete','clear','complete','acct_stg_inst1','checkr'),
 ('14570000-0000-0000-0000-000000000002','0e110000-0000-0000-0000-000000000001','complete','clear','complete','acct_stg_inst2','checkr');

-- ---- Parents (2 login + 28 bulk = 30) -------------------------------------
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

-- ---- Students (40; ~1.3 per parent) ---------------------------------------
insert into public.students (id, organization_id, parent_id, first_name, last_name, grade, program_location_id)
select
  gen_random_uuid(),
  '0e110000-0000-0000-0000-000000000001',
  p.id,
  (array['Ada','Ben','Cleo','Dev','Ella','Finn','Gus','Hana','Ivy','Jude','Kit','Lia','Max','Nova','Otto','Posy','Remy','Sol','Tess','Uri','Vera','Wren','Xavi','Yael','Zola','Beau','Cora','Dash','Eve','Flynn','Gia','Hugo','Iris','Jett','Kira','Leo','Mira','Nico','Opal','Pax'])[g],
  p.last_name,
  (g % 6) + 1,
  loc.id
from generate_series(1,40) g
join lateral (select id, last_name from public.parents order by id offset ((g-1) % 30) limit 1) p on true
join lateral (select id from public.program_locations
              where organization_id='0e110000-0000-0000-0000-000000000001'
              order by slug offset (g % 5) limit 1) loc on true;

-- ---- Registrations (50: ~25 camp, ~25 afterschool; confirmed+paid) --------
insert into public.registrations
  (id, organization_id, parent_id, student_id, camp_session_id, program_id,
   status, payment_method, payment_status, amount_cents, photo_release_consent, photo_release_consent_at, registered_at)
select
  gen_random_uuid(),
  '0e110000-0000-0000-0000-000000000001',
  s.parent_id, s.id,
  case when g % 2 = 0 then camp.id else null end,
  case when g % 2 = 1 then prog.id else null end,
  'confirmed', 'stripe', 'paid',
  case when g % 2 = 0 then 22500 else 18000 end,
  true, now(), now() - (g || ' days')::interval
from generate_series(1,40) g
join lateral (select id, parent_id from public.students
              where organization_id='0e110000-0000-0000-0000-000000000001'
              order by id offset ((g-1) % 40) limit 1) s on true
join lateral (select id from public.camp_sessions
              where organization_id='0e110000-0000-0000-0000-000000000001'
              order by id offset ((g-1) % 12) limit 1) camp on true
join lateral (select id from public.programs
              where organization_id='0e110000-0000-0000-0000-000000000001'
              order by id offset ((g-1) % 8) limit 1) prog on true;

-- Guarantee the 2 login parents each have a confirmed afterschool reg visible in the parent portal
insert into public.students (id, organization_id, parent_id, first_name, last_name, grade, program_location_id)
values
 ('22220000-0000-0000-0000-000000000021','0e110000-0000-0000-0000-000000000001','11110000-0000-0000-0000-000000000021','Milo','Sullivan',3,'01cc0000-0000-0000-0000-000000000001'),
 ('22220000-0000-0000-0000-000000000022','0e110000-0000-0000-0000-000000000001','11110000-0000-0000-0000-000000000022','Juno','Walsh',2,'01cc0000-0000-0000-0000-000000000002');

insert into public.registrations
  (id, organization_id, parent_id, student_id, program_id, status, payment_method, payment_status, amount_cents, photo_release_consent, photo_release_consent_at)
select gen_random_uuid(), '0e110000-0000-0000-0000-000000000001', st.parent_id, st.id, prog.id,
       'confirmed','stripe','paid',18000,true,now()
from (values ('22220000-0000-0000-0000-000000000021'::uuid),('22220000-0000-0000-0000-000000000022'::uuid)) v(sid)
join public.students st on st.id = v.sid
join lateral (select id from public.programs where organization_id='0e110000-0000-0000-0000-000000000001' order by id limit 1) prog on true;

-- ---- Camp assignments (one lead instructor per camp session) --------------
insert into public.camp_assignments (organization_id, camp_session_id, instructor_id, role, status)
select '0e110000-0000-0000-0000-000000000001', cs.id, ins.id, 'lead', 'published'
from (select id, row_number() over (order by id) rn from public.camp_sessions
      where organization_id='0e110000-0000-0000-0000-000000000001') cs
join lateral (select id from public.instructors
              where organization_id='0e110000-0000-0000-0000-000000000001' and is_active
              order by id offset ((cs.rn-1) % 10) limit 1) ins on true;
