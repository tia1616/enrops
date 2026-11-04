-- Seed requirement profiles for J2S's three parks (Jessica 2026-11-04 "load them"),
-- worded from each park's agreement on file. Runs as the J2S owner through
-- set_partner_requirement_detail, the same path the admin screen uses.
do $$
declare
  v_org uuid := '1adf10ad-d091-4aa0-82e3-af331468ea2b';
  v_uid uuid;
  hv uuid; van uuid; wl uuid;
  ok boolean;
begin
  select m.auth_user_id into v_uid from org_members m join auth.users u on u.id = m.auth_user_id
   where m.organization_id = v_org and m.role = 'owner' and u.email = 'jessica@journeytosteam.com' limit 1;
  select id into hv from partners where organization_id = v_org and partner_name = 'Happy Valley Parks and Rec';
  select id into van from partners where organization_id = v_org and partner_name = 'Vancouver Parks and Rec';
  select id into wl from partners where organization_id = v_org and partner_name = 'West Linn Parks and Rec';
  if v_uid is null or hv is null or van is null then raise exception 'lookup failed % % %', v_uid, hv, van; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  ok := public.set_partner_requirement_detail(van, 'insurance',
    'General liability $1M per occurrence / $2M aggregate. Sexual abuse and molestation $1M per occurrence. The City of Vancouver named as additional insured (endorsements CG 20 10 and CG 20 37 included with the certificate) and as certificate holder. Written on an occurrence basis by an insurer licensed in Washington.',
    '2026 Recreation Services Agreement, Appendix B (page 6)');
  if not ok then raise exception 'van insurance refused'; end if;
  ok := public.set_partner_requirement_detail(van, 'background_check',
    'Every staff member or instructor working with participants has cleared a Washington State Patrol background check before all classes and camps.',
    '2026 Recreation Services Agreement, page 2, item h');
  if not ok then raise exception 'van bgc refused'; end if;
  ok := public.set_partner_requirement_detail(hv, 'insurance',
    'General liability $2M per occurrence / $2M aggregate. Sexual abuse and molestation $1M per claim, accepted in place of the city''s background check.',
    'enrops spec v3 Happy Valley profile; the Scope of Work (page 2) says only "Obtain Insurance from Provider/Contractor"');
  if not ok then raise exception 'hv insurance refused'; end if;
  if wl is not null then
  ok := public.set_partner_requirement_detail(wl, 'background_check',
    'The provider runs background checks on all staff and instructors who may teach or work with participants.',
    'Independent Contractor Agreement, clause 3');
  if not ok then raise exception 'wl bgc refused'; end if;
  end if;
  perform set_config('role', 'postgres', true);
end $$;
select json_agg(json_build_object('park', p.partner_name, 'key', x.requirement_key, 'source', x.source) order by p.partner_name, x.requirement_key) r
from partner_requirement_details x join partners p on p.id = x.partner_id;
