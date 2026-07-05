-- Seed the welcome_contact automation template (contact-based, informational).
-- Fires when a NEW family is added to marketing_recipients (trigger contact_added),
-- unless the import marked them suppress_welcome=true ("existing families").
-- Tenant-neutral copy; no hardcoded org. Idempotent upsert on the unique key.
-- Applied to staging via MCP 2026-07-04; prod at release.

insert into public.automation_templates
  (key, display_name, description, trigger_type, applies_to_program_type, mailing_type,
   default_subject, default_body, default_timing, time_saved_minutes_per_send,
   push_to_parent_portal, is_v1_enabled, sort_order)
values (
  'welcome_contact',
  'Welcome — new family',
  'A warm hello sent automatically when you add a new family to your contacts. Skips anyone you mark as an existing family on import.',
  'contact_added',
  'all',
  'informational',
  'Welcome to {{org_name}}!',
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>
<p style="margin:0 0 16px;">Welcome to {{org_name}} — we''re so glad to have your family with us.</p>
<p style="margin:0 0 16px;">We''ll keep you in the loop with what''s coming up and how things are going. If you ever have a question, just reply to this email and a real person will get back to you.</p>
<p style="margin:0;">Warmly,<br>{{sender_name}}</p>',
  '{"days_window": 2}'::jsonb,
  4,
  false,
  true,
  100
)
on conflict (key) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  trigger_type = excluded.trigger_type,
  applies_to_program_type = excluded.applies_to_program_type,
  mailing_type = excluded.mailing_type,
  default_subject = excluded.default_subject,
  default_body = excluded.default_body,
  default_timing = excluded.default_timing,
  time_saved_minutes_per_send = excluded.time_saved_minutes_per_send,
  push_to_parent_portal = excluded.push_to_parent_portal,
  is_v1_enabled = excluded.is_v1_enabled,
  sort_order = excluded.sort_order;
