-- review_request automation — "Ask for a review" a few weeks after a family
-- joins. DUAL-ANCHOR: fires off confirmed registrations (N days after first
-- session) AND off marketing_recipients contacts (N days after the contact was
-- added), so it works for registration tenants (J2S) AND contact-only tenants
-- (Richelle's Kumon families, who have 0 registrations). Mirrors the proven
-- birthday dual-anchor pattern in lifecycle-automations-cron.
--
-- mailing_type = 'marketing': a review ask is promotional, not a service
-- update, so the cron honors marketing_suppressions on BOTH audience paths and
-- appends a CAN-SPAM unsubscribe link (added by wrapInShell for marketing
-- templates only — informational sends are unchanged).
--
-- Additive + dormant: seeds one platform template row. No org gets it until an
-- operator toggles it on (creates an automations row). Idempotent — safe to
-- re-run. Applied to staging AND prod in the same pass (parity).

-- 1. Widen the trigger_type CHECK to allow the new delayed dual-anchor trigger.
--    Purely additive: existing values are preserved, one new value added.
ALTER TABLE public.automation_templates
  DROP CONSTRAINT IF EXISTS automation_templates_trigger_type_check;

ALTER TABLE public.automation_templates
  ADD CONSTRAINT automation_templates_trigger_type_check
  CHECK (trigger_type = ANY (ARRAY[
    'event_registration_confirmed',
    'days_before_first_session',
    'days_after_first_session',
    'session_midpoint',
    'session_last_day',
    'birthday',
    'event_registration_abandoned',
    'survey_pending',
    'contact_added',
    'contact_dormant',
    'days_after_engagement'
  ]));

-- 2. Seed the review_request template. Idempotent on the UNIQUE(key).
INSERT INTO public.automation_templates (
  key, display_name, description,
  trigger_type, applies_to_program_type, mailing_type,
  default_subject, default_body, default_timing,
  time_saved_minutes_per_send, push_to_parent_portal, is_v1_enabled, sort_order
) VALUES (
  'review_request',
  'Ask for a review',
  'Ask families for a review a few weeks after they join. Reaches enrolled families and imported contacts alike. Paste your review link into the message.',
  'days_after_engagement',
  'all',
  'marketing',
  'A quick favor, {{first_name}}?',
  '<p style="margin:0 0 16px;">Hi {{first_name}},</p>
<p style="margin:0 0 16px;">It''s been a little while since {{child_first_name}} started with {{org_name}}, and we''d love to know how it''s going.</p>
<p style="margin:0 0 16px;">If you have a minute, a short review really helps other families find us, and it means a lot to our team. You can leave one here:</p>
<p style="margin:0 0 16px;"><a href="https://your-review-link-here" style="color:#674EE8;font-weight:600;">Leave a quick review</a></p>
<p style="margin:0 0 16px;">And if there''s anything we could be doing better, just reply to this email. We read every one.</p>
<p style="margin:0;">Warmly,<br>{{sender_name}}</p>',
  '{"days_after": 42}'::jsonb,
  4,
  false,
  true,
  110
)
ON CONFLICT (key) DO NOTHING;
