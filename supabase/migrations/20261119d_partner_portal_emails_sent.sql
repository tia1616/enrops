-- Partner portal step 3: "Emails sent" on each provider's record, so a partner
-- can see that a reminder really went out (Stacey Allington, City of Vancouver,
-- 2026-11-09). The pattern is myCOI's: the log lives on the vendor's own page,
-- not in a global feed.
--
-- Nothing new is sent and nothing new is stored. This reads the ledger the
-- expiry emails already write (record_expiry_notices, 20261102c). That ledger
-- is claim-then-send (_shared/claimThenSend.ts): the row is written just before
-- the send and DELETED if the send fails, so a row that stays is an email that
-- went out. sent_at is NOT NULL; the `sent_at is not null` below is belt and
-- braces, not the guard.
--
-- WHAT A PARTNER MAY SEE - exactly what its page already shows, never more:
--   document reminders: documents of this provider shared with this partner
--     (partner_id null = every partner, or this partner), the rule
--     PartnerProviderDetail uses for the Documents table. A deleted document's
--     reminders drop out with it.
--   background check reminders: an instructor who has agreed to share with
--     partners (the same consent partner_portal_instructors honours) AND has had
--     a confirmed class or camp at one of this login's sites. "Has had", not
--     "has now": this is a history, and a reminder that went out while Riley
--     taught at Happy Valley must not vanish when the class ends (review
--     2026-11-19). Withdrawn consent hides them again, as on the instructor list.
-- Recipients are a COUNT, never addresses: the provider's own staff emails are
-- the provider's business.
--
-- WHO MAY READ: private.partner_portal_scope (20261119a), the same gate as the
-- classes and the instructor list.

create or replace function public.partner_portal_emails_sent(p_partner_id uuid)
returns table(
  sent_at timestamptz, kind text, subject_type text, doc_type text, about text,
  expires_on date, tier integer, recipients integer
)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_org uuid;
  v_sites uuid[];
  v_ok boolean;
begin
  select s.organization_id, s.site_ids, s.allowed into v_org, v_sites, v_ok
  from private.partner_portal_scope(p_partner_id) s;
  if not coalesce(v_ok, false) then
    return;
  end if;

  return query
  select n.sent_at, 'expiry_reminder'::text, n.subject_type, d.doc_type, d.title,
         n.expires_on, n.tier, n.recipients
  from public.record_expiry_notices n
  join public.provider_documents d on d.id = n.subject_id and d.organization_id = v_org
  where n.organization_id = v_org
    and n.subject_type = 'document'
    and n.sent_at is not null
    and (d.partner_id is null or d.partner_id = p_partner_id)

  union all

  select n.sent_at, 'expiry_reminder'::text, n.subject_type, null::text,
         btrim(coalesce(i.first_name, '') || ' ' || coalesce(i.last_name, '')),
         n.expires_on, n.tier, n.recipients
  from public.record_expiry_notices n
  join public.instructors i on i.id = n.subject_id and i.organization_id = v_org
  where n.organization_id = v_org
    and n.subject_type = 'background_check'
    and n.sent_at is not null
    and i.partner_sharing_agreed_at is not null
    and (
      exists (
        select 1 from public.program_assignments pa
        join public.programs pr on pr.id = pa.program_id
        join public.program_locations pl on pl.id = pr.program_location_id
        where pa.instructor_id = i.id and pa.organization_id = v_org and pa.status = 'confirmed'
          and pl.partner_id = p_partner_id and (v_sites is null or pl.id = any(v_sites)))
      or exists (
        select 1 from public.camp_assignments ca
        join public.camp_sessions cs on cs.id = ca.camp_session_id
        join public.program_locations pl on pl.id = cs.location_id
        where ca.instructor_id = i.id and ca.organization_id = v_org and ca.status = 'confirmed'
          and pl.partner_id = p_partner_id and (v_sites is null or pl.id = any(v_sites)))
    )

  order by 1 desc
  limit 50;
end;
$$;
revoke all on function public.partner_portal_emails_sent(uuid) from public, anon;
grant execute on function public.partner_portal_emails_sent(uuid) to authenticated;
