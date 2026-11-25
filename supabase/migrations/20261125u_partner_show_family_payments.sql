-- 20261125u: what families paid goes only to partners we split revenue with
-- (Jessica 2026-11-25: "Only revenue-split").
--
-- 20261125t showed every partner login the total families paid for a class.
-- Right for Happy Valley (their 10% is of what families paid), wrong for a
-- partner we pay flat rent or invoice per session: it shows them our gross.
--
-- partners.show_family_payments, OFF by default, so nothing is shown until
-- the provider turns it on for that partner (Classes tab of the partner's
-- page). The provider always sees the line on its own page, with `shared`
-- saying whether the partner sees it too. A partner's response keeps exactly
-- { sessions, money } (money null unless shared).
--
-- Every other line of partner_portal_class_summary is 20261125t's live body
-- (with its camp site-closure fix).

alter table public.partners
  add column if not exists show_family_payments boolean not null default false;

comment on column public.partners.show_family_payments is
  'Partner portal: show this partner what families paid for each class at its sites (revenue-split partners). Off by default.';

create or replace function public.partner_portal_class_summary(p_partner_id uuid, p_kind text, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_sites uuid[];
  v_ok boolean;
  v_admin boolean;
  v_shared boolean;
  v_enrops boolean;
  v_tz text;
  v_today date;
  v_found boolean;
  v_own boolean;
  v_dates date[];
  v_sessions jsonb;
  v_money jsonb := null;
begin
  if p_kind not in ('class', 'camp') then
    return null;
  end if;
  -- Who may see what: the roster's scope (partner_portal_class_roster).
  select s.organization_id, s.site_ids, s.allowed, s.is_provider_admin into v_org, v_sites, v_ok, v_admin
  from private.partner_portal_scope(p_partner_id) s;
  if not coalesce(v_ok, false) then
    return null;
  end if;
  select coalesce(o.uses_enrops_registration, true), coalesce(o.timezone, 'America/Los_Angeles')
    into v_enrops, v_tz
  from public.organizations o where o.id = v_org;
  select coalesce(p.show_family_payments, false) into v_shared
  from public.partners p where p.id = p_partner_id;
  v_shared := coalesce(v_shared, false);
  v_today := (now() at time zone v_tz)::date;

  -- The class must be at one of THIS login's sites, of this provider, and live
  -- (not draft, not cancelled). Anything else returns nothing.
  if p_kind = 'class' then
    select true, coalesce(pr.runs_own_registration, false),
           (select array_agg(d order by d) from unnest(public.derive_program_session_dates(pr.id)) d)
      into v_found, v_own, v_dates
    from public.programs pr
    join public.program_locations pl on pl.id = pr.program_location_id
    where pr.id = p_class_id and pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and pr.organization_id = v_org and pr.status = 'open';
  else
    select true, coalesce(cs.runs_own_registration, false),
           (select array_agg(g::date order by g)
              from generate_series(cs.starts_on, coalesce(cs.ends_on, cs.starts_on), interval '1 day') g
             where (coalesce(array_length(cs.class_days, 1), 0) = 0
                or lower(to_char(g, 'FMDay')) = any (select lower(btrim(x)) from unnest(cs.class_days::text[]) x))
               -- The site's own closures apply to camps too (as in
               -- derive_program_session_dates); the district calendar does not.
               and not (g::date = any (coalesce(pl.closure_dates, '{}'::date[]))))
      into v_found, v_own, v_dates
    from public.camp_sessions cs
    join public.program_locations pl on pl.id = cs.location_id
    where cs.id = p_class_id and pl.partner_id = p_partner_id
      and (v_sites is null or pl.id = any(v_sites))
      and cs.organization_id = v_org and cs.status = 'active';
  end if;
  if not coalesce(v_found, false) then
    return null;
  end if;

  -- Each scheduled date: held (an instructor confirmed it), upcoming, or not
  -- confirmed (past, no confirmation). Plus cancelled sessions (skips that
  -- were not restored), which the schedule no longer lists.
  select coalesce(jsonb_agg(jsonb_build_object('date', x.d, 'status', x.st) order by x.d), '[]'::jsonb)
    into v_sessions
  from (
    select d,
           case when exists (
                  select 1 from public.session_delivery_confirmations c
                  where c.session_date = d
                    and ((p_kind = 'class' and c.program_id = p_class_id)
                      or (p_kind = 'camp' and c.camp_session_id = p_class_id)))
                then 'held'
                when d >= v_today then 'upcoming'
                else 'not_confirmed' end as st
    from unnest(coalesce(v_dates, '{}'::date[])) d
    union all
    select k.session_date, 'cancelled'
    from public.program_session_skips k
    where p_kind = 'class' and k.program_id = p_class_id and k.restored_at is null
      and not (k.session_date = any (coalesce(v_dates, '{}'::date[])))
  ) x;

  -- What families actually paid: only where families registered through
  -- enrops, and to a partner only when the provider shares it (20261125u).
  -- Per child too (Jessica 2026-11-25: "put per person what they paid"),
  -- keyed by registration id = the roster's row_key: paid_cents and a status
  -- the page words: paid / paying (instalments still due) / free / refunded /
  -- processing (bank transfer in flight) / unpaid (on the roster, never charged).
  if v_enrops and not v_own and (coalesce(v_admin, false) or v_shared) then
    select jsonb_build_object(
             'children', count(*) filter (where t.collected > 0),
             'paid_cents', coalesce(sum(t.collected), 0),
             'by_child', coalesce(jsonb_agg(jsonb_build_object(
                'row_key', t.id,
                'paid_cents', t.collected,
                'status', case when t.collected > 0 and t.inst_due then 'paying'
                               when t.collected > 0 then 'paid'
                               when t.refunded > 0 then 'refunded'
                               when t.ach then 'processing'
                               -- On a plan with nothing paid (e.g. instalments paused when the
                               -- program was cancelled) is never "free", whatever payment_status says.
                               when t.payment_status = 'paid' and not t.has_inst then 'free'
                               else 'unpaid' end)), '[]'::jsonb))
      into v_money
    from (
      select r.id, r.payment_status,
             coalesce(r.ach_payment_state = 'processing', false) as ach,
             exists (select 1 from public.installments i where i.registration_id = r.id) as has_inst,
             -- Still due: pending, or paused on a failed card. Not 'paused_program_cancelled'.
             exists (select 1 from public.installments i where i.registration_id = r.id
                      and i.status in ('pending', 'paused_card_failed')) as inst_due,
             (select coalesce(sum(f.amount_cents), 0) from public.refunds f
               where f.registration_id = r.id and f.status = 'succeeded') as refunded,
             greatest(
               case when exists (select 1 from public.installments i where i.registration_id = r.id)
                    then (select coalesce(sum(i.amount_cents), 0) from public.installments i
                          where i.registration_id = r.id and i.status = 'paid')
                    when r.payment_status in ('paid', 'partial') then coalesce(r.amount_cents, 0)
                    else 0 end
               - (select coalesce(sum(f.amount_cents), 0) from public.refunds f
                  where f.registration_id = r.id and f.status = 'succeeded'),
               0) as collected
      from public.registrations r
      where ((p_kind = 'class' and r.program_id = p_class_id)
          or (p_kind = 'camp' and r.camp_session_id = p_class_id))
        and r.student_id is not null and private.registration_on_roster(r)
    ) t;
  end if;

  if coalesce(v_admin, false) then
    return jsonb_build_object('sessions', v_sessions, 'money', v_money, 'shared', v_shared);
  end if;
  return jsonb_build_object('sessions', v_sessions, 'money', v_money);
end;
$$;
revoke all on function public.partner_portal_class_summary(uuid, text, uuid) from public, anon;
grant execute on function public.partner_portal_class_summary(uuid, text, uuid) to authenticated;
