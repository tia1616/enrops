-- Platform-usage triggers for the remaining actions that are pure client-side
-- table writes (no edge function to hook): campaign sent, curriculum published,
-- payroll approved. SECURITY DEFINER + fail-safe via the doorway. No front-end.

-- Campaign sent = marketing_campaigns.status transitions to 'sending' (the approve).
create or replace function intelligence.tg_campaign_sent()
returns trigger language plpgsql security definer
set search_path = public, intelligence as $$
begin
  if new.status = 'sending' and (old.status is distinct from 'sending') then
    perform public.log_platform_event(
      'campaigns', 'campaign_sent', 'success',
      new.organization_id, coalesce(new.approved_by, auth.uid()),
      jsonb_build_object('campaign_id', new.id), now(), null
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_campaign_sent on public.marketing_campaigns;
create trigger trg_campaign_sent
  after update of status on public.marketing_campaigns
  for each row execute function intelligence.tg_campaign_sent();

-- Curriculum published = curricula.status transitions to 'published'.
create or replace function intelligence.tg_curriculum_published()
returns trigger language plpgsql security definer
set search_path = public, intelligence as $$
begin
  if new.status = 'published' and (old.status is distinct from 'published') then
    perform public.log_platform_event(
      'curricula', 'curriculum_published', 'success',
      new.organization_id, auth.uid(),
      jsonb_build_object('curriculum_id', new.id), now(), null
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_curriculum_published on public.curricula;
create trigger trg_curriculum_published
  after update of status on public.curricula
  for each row execute function intelligence.tg_curriculum_published();

-- Payroll approved = session_delivery_confirmations.pay_status -> 'approved'
-- (fires per day/row; bulk-approve logs one per confirmation, which is accurate).
create or replace function intelligence.tg_payroll_approved()
returns trigger language plpgsql security definer
set search_path = public, intelligence as $$
begin
  if new.pay_status = 'approved' and (old.pay_status is distinct from 'approved') then
    perform public.log_platform_event(
      'payroll', 'payroll_approved', 'success',
      new.organization_id, auth.uid(),
      jsonb_build_object('confirmation_id', new.id), now(), null
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_payroll_approved on public.session_delivery_confirmations;
create trigger trg_payroll_approved
  after update of pay_status on public.session_delivery_confirmations
  for each row execute function intelligence.tg_payroll_approved();
