-- "Payment coming up" email: tells a family their next payment-plan charge is
-- three days away. Before this, a family heard nothing until a charge had already
-- happened (or failed), and parents wrote to the provider asking why their card
-- was charged without warning.
--
-- WHEN IT SENDS. Three days before the charge date, from the daily run, one email
-- per CHARGE (a two-child cart is one charge, one email). The audience is computed
-- in lifecycle-automations-cron (resolveInstallmentReminderAudience, rules in
-- installmentReminderAudience.ts); this file only adds the template. It never
-- touches process-installments, which stays the only thing that charges a card.
--
-- NO DOLLAR AMOUNT. What a family is charged includes their agreed share of the
-- enrops service fee, which only the charger rebuilds (from the whole cart and the
-- provider's fee settings as of the plan's start). A second copy of that math in
-- an email could disagree with the charge, so v1 names the date and the children.
--
-- ON BY DEFAULT (Jessica, 2026-10-30), OPT-OUT like class_photos: a provider with
-- no row is sending, a provider who switched it off has enabled = false and stays
-- off. The cron materialises the missing row through ensure_default_on_automation
-- (20261012a, generic over the template key) before it loads automations.
-- src/lib/entitlements.js isOptOutAutomation says the same thing to the Comms screen.
--
-- Applied to staging first; prod in the same pass as the cron deploy.

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
    'class_photos_uploaded','installment_reminder'
  ]));

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
   default_subject, default_body, default_timing, time_saved_minutes_per_send,
   push_to_parent_portal, is_v1_enabled, sort_order, audience, audiences, lifecycle_stage)
values (
  'installment_reminder', 'Payment coming up',
  'Gives families a heads-up three days before their next payment-plan charge, so it never comes as a surprise. One email per charge, sent the morning three days ahead. It does not send for a payment that is already due, or for a registration that has been cancelled or refunded.',
  'installment_reminder', 'both', 'informational',
  'Upcoming payment for {{child_first_name}}',
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>' ||
  '<p style="margin:0 0 16px;">A quick heads-up: the {{installment_label}} payment for {{child_first_name}} in {{program_name}} will be charged to the card on file on {{charge_date}}.</p>' ||
  -- No sign-off line: the email shell already appends the sender's signature.
  '<p style="margin:0;">Nothing to do if that card is still good. If it has changed, just reply to this email and we will help.</p>',
  '{}'::jsonb,
  2, false, true, 75, 'families', array['families']::text[], 'anytime')
on conflict (key) do update set
  display_name = excluded.display_name, description = excluded.description,
  trigger_type = excluded.trigger_type, applies_to_program_type = excluded.applies_to_program_type,
  mailing_type = excluded.mailing_type, default_subject = excluded.default_subject,
  default_body = excluded.default_body, default_timing = excluded.default_timing,
  time_saved_minutes_per_send = excluded.time_saved_minutes_per_send,
  push_to_parent_portal = excluded.push_to_parent_portal, is_v1_enabled = excluded.is_v1_enabled,
  sort_order = excluded.sort_order, audience = excluded.audience, audiences = excluded.audiences,
  lifecycle_stage = excluded.lifecycle_stage;

commit;
