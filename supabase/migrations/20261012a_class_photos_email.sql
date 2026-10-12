-- "New class photos" email: tells a family their child's instructor shared photos,
-- and sends them to the Photos tab of the parent portal to see them (the portal,
-- not the email, is where the photos live - Jessica wants the visit).
--
-- WHEN IT SENDS. Only on days photos were actually uploaded: one email per family
-- per class per upload day, from the daily run the morning after (the day is
-- closed before anyone is emailed about it, so ten photos taken across an
-- afternoon are one email, not ten). The audience is computed in
-- lifecycle-automations-cron (resolveClassPhotosAudience); this file only adds
-- the template.
--
-- ON BY DEFAULT, like class photos themselves (Jessica, 2026-10-12). Every other
-- lifecycle automation is opt-IN (the cron only runs rows with enabled = true),
-- so this one is OPT-OUT the same way thank_you is: a provider with no row is
-- sending, a provider who switched it off has enabled = false and stays off.
-- The cron materialises the missing row (enabled = true) through
-- ensure_default_on_automation() before it loads automations, so it never
-- overrides an explicit off and needs no trigger on organizations for new
-- providers. src/lib/entitlements.js isOptOutAutomation says the same thing to
-- the Comms screen.
--
-- Applied to staging and prod in the same pass.

begin;

alter table public.automation_templates
  drop constraint if exists automation_templates_trigger_type_check;
alter table public.automation_templates
  add constraint automation_templates_trigger_type_check
  check (trigger_type = any (array[
    'event_registration_confirmed','days_before_first_session','days_after_first_session',
    'session_midpoint','session_last_day','birthday','event_registration_abandoned',
    'survey_pending','contact_added','contact_dormant','days_after_engagement',
    'days_before_no_school','instructor_birthday','operator_initiated','partner_roster',
    'class_photos_uploaded'
  ]));

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
   default_subject, default_body, default_timing, time_saved_minutes_per_send,
   push_to_parent_portal, is_v1_enabled, sort_order, audience, audiences, lifecycle_stage)
values (
  'class_photos', 'New class photos',
  'Lets families know when their child''s instructor has shared new class photos, with a link to see them in their family portal. Sends the morning after photos are added, at most once per class per day, and never on a day without photos.',
  'class_photos_uploaded', 'both', 'informational',
  'New photos from {{child_first_name}}''s {{program_name}} class',
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>' ||
  '<p style="margin:0 0 16px;">{{child_first_name}}''s instructor shared new photos from {{program_name}}. Take a look in your family portal.</p>' ||
  -- No sign-off line: the email shell already appends the sender's signature,
  -- and a second one read as a doubled goodbye in the first preview.
  '<p style="margin:0;"><a href="{{photos_url}}" style="font-weight:600;">See the photos</a></p>',
  '{}'::jsonb,
  2, false, true, 65, 'families', array['families']::text[], 'during')
on conflict (key) do update set
  display_name = excluded.display_name, description = excluded.description,
  trigger_type = excluded.trigger_type, applies_to_program_type = excluded.applies_to_program_type,
  mailing_type = excluded.mailing_type, default_subject = excluded.default_subject,
  default_body = excluded.default_body, default_timing = excluded.default_timing,
  time_saved_minutes_per_send = excluded.time_saved_minutes_per_send,
  push_to_parent_portal = excluded.push_to_parent_portal, is_v1_enabled = excluded.is_v1_enabled,
  sort_order = excluded.sort_order, audience = excluded.audience, audiences = excluded.audiences,
  lifecycle_stage = excluded.lifecycle_stage;

-- Give every active provider that has NO row for this template an enabled one.
-- A provider that has a row keeps it exactly as it is: inserting enabled = false
-- (or overwriting a stored false with true) would change what they chose.
-- Service-role only: the cron calls it; no operator or family can.
create or replace function public.ensure_default_on_automation(p_template_key text)
returns integer
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_template uuid;
  v_count integer;
begin
  select id into v_template from public.automation_templates where key = p_template_key;
  if v_template is null then
    return 0;
  end if;
  insert into public.automations (organization_id, template_id, enabled, enabled_at)
  select o.id, v_template, true, now()
  from public.organizations o
  where o.status = 'active'
    and not exists (
      select 1 from public.automations a
      where a.organization_id = o.id and a.template_id = v_template
    )
  on conflict (organization_id, template_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.ensure_default_on_automation(text) from public, anon, authenticated;
grant execute on function public.ensure_default_on_automation(text) to service_role;

commit;
