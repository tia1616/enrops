-- Chunk 3.6.01 — AI Campaign Builder: schema + per-tenant config
-- See: Downloads/01_database.md

-- marketing_campaigns: AI draft provenance + approval audit
ALTER TABLE marketing_campaigns
  ADD COLUMN IF NOT EXISTS draft_source text
    CHECK (draft_source IN ('manual', 'ai_assisted')),
  ADD COLUMN IF NOT EXISTS draft_inputs jsonb,
  ADD COLUMN IF NOT EXISTS draft_model text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id);

-- marketing_recipients: AI-resolved segment buckets (distinct from existing `tags`)
ALTER TABLE marketing_recipients
  ADD COLUMN IF NOT EXISTS segments text[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_marketing_recipients_segments
  ON marketing_recipients USING gin (segments);

-- organizations: per-tenant sender identity + brand voice
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_sender_name text,
  ADD COLUMN IF NOT EXISTS default_sender_email text,
  ADD COLUMN IF NOT EXISTS sending_domain text,
  ADD COLUMN IF NOT EXISTS brand_voice jsonb DEFAULT '{}'::jsonb;

-- program_locations: informal names parents use (for Q2 resolution)
ALTER TABLE program_locations
  ADD COLUMN IF NOT EXISTS name_aliases text[] DEFAULT '{}';

-- J2S seed (idempotent, ONLY hardcoded J2S identity in this build)
UPDATE organizations
SET
  default_sender_name = COALESCE(default_sender_name, 'Jessica @ Journey to STEAM'),
  default_sender_email = COALESCE(default_sender_email, 'jessica@updates.journeytosteam.com'),
  sending_domain = COALESCE(sending_domain, 'updates.journeytosteam.com'),
  brand_voice = CASE
    WHEN brand_voice = '{}'::jsonb OR brand_voice IS NULL THEN
      jsonb_build_object(
        'closer', 'Future-ready skills, right after school.',
        'tone', 'warm, parent-facing, outcomes-based',
        'do_not_use', jsonb_build_array('feel proud', 'gain confidence'),
        'do_use', jsonb_build_array('kids design', 'kids code', 'kids build'),
        'audience', 'parents of K-5 enrichment students',
        'additional_notes', 'Pop culture themes (Pokémon, Minecraft, LEGO) welcome.'
      )
    ELSE brand_voice
  END
WHERE id = '1adf10ad-d091-4aa0-82e3-af331468ea2b';
