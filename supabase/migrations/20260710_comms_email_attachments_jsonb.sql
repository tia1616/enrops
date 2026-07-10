-- Redesign of comms attachments: drop the token-based attachment_ids uuid[] in
-- favor of email_attachments jsonb.
--
-- Why: the first cut placed a raw {{attachment:<uuid>}} token in the email body
-- (exposed as tech jargon to non-technical operators, and the client-side
-- "sample data" preview couldn't expand it, so it showed literal brackets). The
-- new model renders each file as a Download button at the BOTTOM of the email
-- automatically (no body token, shown in the preview), with an optional per-file
-- "attach the file itself" flag.
--
-- Shape:  email_attachments jsonb = [ { "id": "<comms_attachments.id>", "attach": <bool> } ]
--   - every entry renders as a Download button (bottom of email)
--   - "attach": true also rides the raw file along (automations only; campaigns
--     are link-only because Resend's batch endpoint can't take attachments)
--
-- Applied to staging 2026-07-10. Prod at release (with the foundation migration).

alter table public.automations
  drop column if exists attachment_ids,
  add column if not exists email_attachments jsonb not null default '[]'::jsonb;

alter table public.saved_email_templates
  drop column if exists attachment_ids,
  add column if not exists email_attachments jsonb not null default '[]'::jsonb;

alter table public.marketing_campaign_touchpoints
  drop column if exists attachment_ids,
  add column if not exists email_attachments jsonb not null default '[]'::jsonb;
