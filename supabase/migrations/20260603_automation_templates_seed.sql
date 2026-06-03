-- 20260603_automation_templates_seed.sql
--
-- Seed the v1 automation templates. is_v1_enabled gates the UI toggle AND the
-- cron load filter — templates marked false won't fire even if a stale toggle
-- somehow exists.
--
-- v1 ACTIVE (all 8 — cron wired or driven by stripe-webhook):
--   thank_you               (stripe-webhook fires it on checkout completion)
--   welcome_camp            (lifecycle cron, days_before_first_session=7)
--   welcome_afterschool     (lifecycle cron, days_before_first_session=7)
--   check_in                (lifecycle cron, days_after_first_session=14)
--   mid_recap               (lifecycle cron, session_midpoint via derive_program_session_dates)
--   final_recap             (lifecycle cron, session_last_day via derive_program_session_dates)
--   birthday                (lifecycle cron, matches students.birthdate month+day)
--   abandoned_registration  (lifecycle cron, event_registration_abandoned at 24h)
--
-- v1 COMING SOON (depends on a feature that doesn't yet exist in Enrops):
--   survey_nudge            (needs Enrops survey feature to ship first)
--
-- Stripe-dependence is enforced in the UI (see STRIPE_DEPENDENT_KEYS in
-- AutomationsTab.jsx). Descriptions stay neutral — the Locked status pill +
-- "Connect Stripe to unlock" Link below handle the conditional UX.
--
-- IMPORTANT — apostrophes inside $body$...$body$ are LITERAL. Use single
-- apostrophes (we're) NOT the SQL-escape doubled form (we''re). The doubled
-- form is only correct inside regular '...' or E'...' strings.
--
-- Tokens used in default bodies (all plain text):
--   {{first_name}}                    parent first name
--   {{child_first_name}}              student first name
--   {{org_name}}                      organization name
--   {{program_name}}                  curriculum name for THIS program
--   {{program_start_date}}            first session date (per-program)
--   {{program_end_date}}              last session date (per-program)
--   {{location_name}}                 program location
--   {{age_turning}}                   birthday-only: age this year
--   {{abandoned_resume_url}}          abandoned-reg only: resume checkout URL
--   {{registration_summary_block}}    thank-you only: auto-table from stripe-webhook

INSERT INTO automation_templates (
  key, display_name, description,
  trigger_type, applies_to_program_type, mailing_type,
  default_subject, default_body, default_timing,
  time_saved_minutes_per_send, push_to_parent_portal, is_v1_enabled, sort_order
) VALUES
(
  'thank_you', 'Thank-you',
  'Sends the moment a parent completes registration and checkout on Enrops. A fast branded confirmation reduces "did this go through?" replies and starts the parent relationship on the right foot.',
  'event_registration_confirmed', 'both', 'informational',
  E'You''re registered! 🎉',
  $body$<p>Hi {{first_name}}!</p>
<p>Thanks for signing up — we're so excited to have {{child_first_name}} with us. Here are the details:</p>
{{registration_summary_block}}
<p>We'll send a reminder before the first session. Questions? Hit reply.</p>
<p>— {{sender_name}}</p>$body$,
  '{}'::jsonb, 3, true, true, 10
),
(
  'welcome_camp', 'Welcome — camp',
  'Sends 7 days before camp begins, using the details you set up for the camp (date, location, what they''ll be doing). Parents who know what to expect show up calmer, ask fewer day-one questions, and are more likely to book the next camp.',
  'days_before_first_session', 'camps', 'informational',
  E'{{child_first_name}}''s camp starts {{program_start_date}}',
  $body$<p>Hi {{first_name}},</p>
<p>Quick heads-up: {{child_first_name}}'s {{program_name}} camp at {{location_name}} starts {{program_start_date}}.</p>
{{arrival_dismissal_block}}
<p><strong>What to bring:</strong> a water bottle, snacks, and a lunch if your child has a full day of camp.</p>
<p><strong>Pickup:</strong> if your child has your approval for something other than parent pick-up (e.g. they can walk home by themselves), please reply to this email so we can update the instructor.</p>
{{final_showcase_block}}
<p>Questions before the day? Hit reply.</p>
<p>See you soon,<br/>{{sender_name}}</p>
{{next_term_link_block}}$body$,
  '{"days_before": 7}'::jsonb, 3, true, true, 20
),
(
  'welcome_afterschool', 'Welcome — afterschool',
  'Sends 7 days before the program begins, using your program setup (date, location, curriculum). Sets day-one expectations so families and kids arrive ready — fewer week-one questions in your inbox.',
  'days_before_first_session', 'afterschool', 'informational',
  E'{{child_first_name}}''s after-school program starts {{program_start_date}}',
  $body$<p>Hi {{first_name}},</p>
<p>{{child_first_name}}'s {{program_name}} after-school program starts {{program_start_date}} at {{location_name}}.</p>
{{arrival_dismissal_block}}
<p>Excited to have them,<br/>{{sender_name}}</p>$body$,
  '{"days_before": 7}'::jsonb, 3, true, true, 30
),
(
  'check_in', 'Check-in (2 weeks in)',
  'Sends 2 weeks into your after-school program. Catches concerns early before they turn into pull-outs. A quick reply from you can save a registration — and a parent relationship.',
  'days_after_first_session', 'afterschool', 'informational',
  E'How''s it going so far?',
  $body$<p>Hi {{first_name}},</p>
<p>We're two weeks into {{child_first_name}}'s {{program_name}}. Hoping it's clicking!</p>
<p>Anything you'd want us to know — favorite parts, things to adjust, questions about what's next? Hit reply.</p>
<p>— {{sender_name}}</p>$body$,
  '{"days_after": 14}'::jsonb, 4, true, true, 40
),
(
  'mid_recap', 'Mid recap',
  'Sends halfway through your program. Builds parent confidence mid-stride and primes them for re-enrollment. Tip: upload your curriculum to make it easy to reference real skills and projects when you customize the body.',
  'session_midpoint', 'both', 'informational',
  E'Halfway there — {{child_first_name}}''s recap',
  $body$<p>Hi {{first_name}},</p>
<p>We're halfway through {{child_first_name}}'s {{program_name}}. Here's a quick check-in.</p>
{{mid_term_skills_block}}
<p>Questions? Hit reply.</p>
<p>— {{sender_name}}</p>$body$,
  '{}'::jsonb, 5, true, true, 50
),
(
  'final_recap', 'Final recap',
  'Sends on the last day. Closes the experience well so families are excited about next term before you even pitch it. Tip: upload your curriculum to make it easy to reference what they accomplished when you customize the body.',
  'session_last_day', 'both', 'informational',
  E'{{child_first_name}}''s last day with us!',
  $body$<p>Hi {{first_name}},</p>
<p>Today is {{child_first_name}}'s last day of {{program_name}}. We loved having them.</p>
{{final_recap_skills_block}}
{{final_showcase_block}}
<p>Thanks for sharing them with us.</p>
<p>— {{sender_name}}</p>
{{next_term_link_block}}$body$,
  '{}'::jsonb, 5, true, true, 60
),
(
  'birthday', 'Happy birthday',
  'Sends on the kid''s birthday to families with at least one Enrops registration. Uses the date of birth captured at registration. Small touch, big signal: parents notice when you remember their child.',
  'birthday', 'both', 'informational',
  E'Happy birthday, {{child_first_name}}!',
  $body$<p>Hi {{first_name}},</p>
<p>We couldn't let today go by without saying — happy birthday to {{child_first_name}}!</p>
<p>Hope it's a great one.</p>
<p>— {{sender_name}}</p>$body$,
  '{}'::jsonb, 2, true, true, 70
),
(
  'abandoned_registration', 'Abandoned registration',
  'Sends ~24 hours after a parent starts but doesn''t finish registration and checkout on Enrops. Recovers signups you''d otherwise lose — abandoned-cart reminders typically recover 5–15% of drop-offs (e-commerce industry benchmark).',
  'event_registration_abandoned', 'both', 'informational',
  E'You almost signed up — want to finish?',
  $body$<p>Hi {{first_name}},</p>
<p>Looks like you started signing {{child_first_name}} up for {{program_name}} but didn't finish. Want to pick up where you left off?</p>
<p><a href="{{abandoned_resume_url}}">Finish registering →</a></p>
<p>Need a hand? Hit reply.</p>
<p>— {{sender_name}}</p>$body$,
  '{"hours_after_pending": 24}'::jsonb, 4, true, true, 80
),
(
  'survey_nudge', 'Survey nudge',
  'Available when the Enrops survey feature ships. Sends a friendly reminder to parents who haven''t responded 2 days after the program ends, so you get the feedback you need to improve your programs.',
  'survey_pending', 'both', 'informational',
  E'Quick favor — how was {{program_name}}?',
  $body$<p>Hi {{first_name}},</p>
<p>Would you spare 2 minutes to tell us how {{child_first_name}}'s {{program_name}} went? Your feedback shapes what we do next.</p>
<p>[Survey link will go here when surveys ship.]</p>
<p>Thanks,<br/>{{sender_name}}</p>$body$,
  '{"days_after_last_session": 2}'::jsonb, 2, true, false, 90
);
