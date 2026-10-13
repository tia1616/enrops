-- Which campaign email brought a family to register.
--
-- Campaign emails now tag their register link with utm_* (campaign id + touchpoint
-- id, see _shared/emailAttribution.ts); the registration page remembers the tags
-- on the device and create-registration stores the sanitised set here, one jsonb per
-- registration:  {"utm_source":"enrops_email","utm_medium":"email",
--                 "utm_campaign":"<marketing_campaigns.id>","utm_content":"<touchpoint id>"}
--
-- NULL means "we don't know" (a flyer, a friend, a Google search, or a family who
-- registered before this shipped) - NOT "not from email". The self-reported
-- how_heard answer is untouched and stays the only signal for those.
--
-- Additive and nullable: nothing existing reads or writes it, so prod can take it
-- ahead of the code. The column carries no person data - ids of OUR campaign and
-- touchpoint only.

alter table public.registrations
  add column if not exists attribution jsonb;

comment on column public.registrations.attribution is
  'utm tags from the campaign email link the family last clicked before registering (utm_campaign = marketing_campaigns.id, utm_content = marketing_campaign_touchpoints.id). NULL = unknown, not "not email". Sanitised server-side in create-registration.';
