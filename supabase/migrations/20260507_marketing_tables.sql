-- Marketing module tables — Stage 1
-- Run date: 2026-05-07
--
-- Tables: marketing_groups, marketing_plans, marketing_emails,
--         marketing_automations, marketing_automation_templates
-- All multi-tenant via organization_id + RLS.

-- ============================================================
-- 1. marketing_groups — saved filter-based audiences
-- ============================================================
CREATE TABLE IF NOT EXISTS marketing_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  filter_rules JSONB NOT NULL DEFAULT '{}',
  -- filter_rules shape: { school_id?, area?, program_id?, status? }
  cached_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketing_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketing_groups_org_access" ON marketing_groups
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid() AND accepted_at IS NOT NULL
    )
  );

-- ============================================================
-- 2. marketing_plans — multi-send campaigns toward a goal
-- ============================================================
CREATE TABLE IF NOT EXISTS marketing_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT 'custom',
    -- term_enrollment | camp_enrollment | custom
  status TEXT NOT NULL DEFAULT 'draft',
    -- draft | running | complete | paused
  date_start DATE,
  date_end DATE,
  target_group_ids UUID[] DEFAULT '{}',
  total_sends INTEGER NOT NULL DEFAULT 0,
  sends_complete INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketing_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketing_plans_org_access" ON marketing_plans
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid() AND accepted_at IS NOT NULL
    )
  );

-- ============================================================
-- 3. marketing_emails — drafts, scheduled, and sent emails
-- ============================================================
CREATE TABLE IF NOT EXISTS marketing_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  plan_id UUID REFERENCES marketing_plans(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  send_mode TEXT NOT NULL DEFAULT 'one',
    -- one | split_by_school | split_by_class | split_by_area
  target_group_ids UUID[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
    -- draft | scheduled | sending | sent | failed
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  total_recipients INTEGER DEFAULT 0,
  total_sent INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  template_key TEXT,
    -- schedule_change | cancellation | sales_promo | blank | NULL
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE marketing_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketing_emails_org_access" ON marketing_emails
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid() AND accepted_at IS NOT NULL
    )
  );

-- ============================================================
-- 4. marketing_automations — per-org automation config
-- ============================================================
CREATE TABLE IF NOT EXISTS marketing_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  template_id UUID NOT NULL, -- references marketing_automation_templates
  enabled BOOLEAN NOT NULL DEFAULT true,
  subject_override TEXT,
  body_override TEXT,
  timing_config JSONB DEFAULT '{}',
    -- e.g. { "days_before": 7 } for Welcome, { "days_after": 14 } for How's it going
  total_sent_30d INTEGER NOT NULL DEFAULT 0,
  last_fired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, template_id)
);

ALTER TABLE marketing_automations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketing_automations_org_access" ON marketing_automations
  FOR ALL USING (
    organization_id IN (
      SELECT organization_id FROM org_members
      WHERE auth_user_id = auth.uid() AND accepted_at IS NOT NULL
    )
  );

-- ============================================================
-- 5. marketing_automation_templates — system-level starter templates
-- ============================================================
CREATE TABLE IF NOT EXISTS marketing_automation_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
    -- registration_complete | days_before_start | days_after_start
    -- session_halfway | session_complete | student_birthday
  default_subject TEXT NOT NULL,
  default_body TEXT NOT NULL,
  default_timing JSONB DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No RLS on templates — they're system-level, read by all authenticated users.
ALTER TABLE marketing_automation_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketing_automation_templates_read" ON marketing_automation_templates
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ============================================================
-- Seed the 6 starter automation templates
-- ============================================================
INSERT INTO marketing_automation_templates (slug, name, description, trigger_type, default_subject, default_body, default_timing, sort_order)
VALUES
  ('thank_you', 'Thank you', 'Fires when payment confirms', 'registration_complete',
   'You''re all set, {{parent_first_name}}!',
   'Hi {{parent_first_name}},

Thank you for registering {{student_first_name}} for {{class_name}} at {{school_name}}! We''re excited to have them join us.

Class starts {{day_of_week}}, {{first_session_date}} at {{start_time}}.

If you have any questions before then, just reply to this email.

Future-ready skills, right after school.',
   '{}', 1),

  ('welcome', 'Welcome', '7 days before first session', 'days_before_start',
   '{{student_first_name}}''s class starts next {{day_of_week}}!',
   'Hi {{parent_first_name}},

Just a friendly reminder — {{student_first_name}}''s {{class_name}} class at {{school_name}} begins next {{day_of_week}}, {{first_session_date}} at {{start_time}}.

Their instructor is {{instructor_first_name}}. Please make sure to bring a water bottle!

We can''t wait to see them there.

Future-ready skills, right after school.',
   '{"days_before": 7}', 2),

  ('hows_it_going', 'How''s it going', '14 days after first session', 'days_after_start',
   'How''s {{student_first_name}} enjoying class?',
   'Hi {{parent_first_name}},

{{student_first_name}} has been in {{class_name}} at {{school_name}} for a couple of weeks now — we hope they''re having a great time!

If you have any questions or feedback, just reply to this email. We love hearing from families.

Future-ready skills, right after school.',
   '{"days_after": 14}', 3),

  ('mid_term_recap', 'Mid-term recap', 'Halfway through sessions — pulls curriculum mid_term_skills', 'session_halfway',
   'Halfway update: {{student_first_name}} in {{class_name}}',
   'Hi {{parent_first_name}},

{{student_first_name}} is halfway through {{class_name}} at {{school_name}}! Here''s what they''ve been working on:

{{mid_term_skills}}

Keep up the great work, {{student_first_name}}!

Future-ready skills, right after school.',
   '{}', 4),

  ('final_recap', 'Final recap', 'After last session — pulls curriculum final_skills', 'session_complete',
   '{{student_first_name}} completed {{class_name}}!',
   'Hi {{parent_first_name}},

Congratulations — {{student_first_name}} has completed {{class_name}} at {{school_name}}! Here''s a summary of what they learned:

{{final_skills}}

We''d love to have them back next term. Keep an eye out for enrollment details!

Future-ready skills, right after school.',
   '{}', 5),

  ('happy_birthday', 'Happy birthday', 'Fires on student birthday (when birthdate populated)', 'student_birthday',
   'Happy birthday, {{student_first_name}}! 🎂',
   'Hi {{parent_first_name}},

Wishing {{student_first_name}} the happiest of birthdays from all of us at {{organization_name}}!

We hope their special day is full of fun, creativity, and maybe even a little STEAM magic. 🎉

Future-ready skills, right after school.',
   '{}', 6)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_marketing_groups_org ON marketing_groups(organization_id);
CREATE INDEX IF NOT EXISTS idx_marketing_plans_org ON marketing_plans(organization_id);
CREATE INDEX IF NOT EXISTS idx_marketing_emails_org ON marketing_emails(organization_id);
CREATE INDEX IF NOT EXISTS idx_marketing_emails_plan ON marketing_emails(plan_id);
CREATE INDEX IF NOT EXISTS idx_marketing_emails_status ON marketing_emails(status);
CREATE INDEX IF NOT EXISTS idx_marketing_automations_org ON marketing_automations(organization_id);
