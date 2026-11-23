-- "Final class photo" reminder: emails whoever teaches a class's last session
-- (the assigned instructor, or the substitute covering that day) to take a class
-- photo and share it in enrops. Sends 2-7 days before (normally exactly 7) and
-- the morning of. Classes only, not partner-run, only for providers with class
-- photos on. The audience is computed in lifecycle-automations-cron
-- (resolveFinalClassPhotoAudience); this file only adds the template.
--
-- ON BY DEFAULT like class photos and its family email (opt-out: the cron
-- materialises an enabled row via ensure_default_on_automation, never
-- overriding an explicit off). src/lib/entitlements.js isOptOutAutomation and
-- the cron's DEFAULT_ON_TEMPLATE_KEYS say the same thing.
--
-- Staging first, then prod in its release pass.

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
    'class_photos_uploaded','installment_reminder','final_class_photo'
  ]));

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
   default_subject, default_body, default_timing, time_saved_minutes_per_send,
   push_to_parent_portal, is_v1_enabled, sort_order, audience, audiences, lifecycle_stage)
values (
  'final_class_photo', 'Final class photo reminder',
  'Reminds the instructor teaching a class''s last session to take a class photo and share it in enrops, so every family sees it. Sends a week before the last class and again that morning. Goes to the substitute if one is covering that day.',
  'final_class_photo', 'afterschool', 'informational',
  'Final class photo for {{program_name}}',
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>' ||
  '<p style="margin:0 0 16px;">The last {{program_name}} class at {{location_name}} is {{last_class_date}}. Please take a group photo of the class that day and share it in enrops, so every family gets to see it.</p>' ||
  '<p style="margin:0 0 16px;">Open the class in your instructor portal and add it under Class photos. The portal shows any child whose family has not said yes to photos, so you can keep them out of the shot.</p>' ||
  '<p style="margin:0;"><a href="{{instructor_portal_url}}" style="font-weight:600;">Open my classes</a></p>',
  '{}'::jsonb,
  2, false, true, 66, 'instructors', array['instructors']::text[], 'wrapping_up')
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
