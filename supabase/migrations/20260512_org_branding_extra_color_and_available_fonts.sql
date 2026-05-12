-- Multi-tenant branding additions, applied via Supabase MCP on 2026-05-12.
--
-- Adds:
--   1. org_branding.extra_color    -- 4th brand color slot for tenants whose
--                                      palette needs more than primary/secondary/accent
--                                      (e.g. J2S has the red-orange #E85B37 alongside purple+orange).
--   2. org_branding.page_bg_color  -- per-tenant page/email background override.
--   3. available_fonts             -- curated dropdown of Google Fonts for onboarding,
--                                      with the @import URL fragment and a fallback stack
--                                      for email/print clients that strip web fonts.
--   4. FK from org_branding.heading_font + body_font into available_fonts(name)
--      so tenants can only pick from the supported list.

ALTER TABLE org_branding
  ADD COLUMN IF NOT EXISTS extra_color   TEXT,
  ADD COLUMN IF NOT EXISTS page_bg_color TEXT;

COMMENT ON COLUMN org_branding.extra_color IS
  'Optional 4th brand color (e.g. a secondary accent). Used on flyers, registration pages, and any marketing surface where a 4th color helps.';
COMMENT ON COLUMN org_branding.page_bg_color IS
  'Page/email background color. Null = platform neutral default. Set this when the tenant wants their branded surfaces on a tinted background.';

UPDATE org_branding
  SET extra_color   = '#E85B37',
      page_bg_color = '#F4F1FF'
  WHERE organization_id = '1adf10ad-d091-4aa0-82e3-af331468ea2b';

CREATE TABLE IF NOT EXISTS available_fonts (
  name              TEXT PRIMARY KEY,
  category          TEXT NOT NULL CHECK (category IN ('heading', 'body')),
  google_fonts_param TEXT NOT NULL,
  fallback_stack    TEXT NOT NULL,
  display_order     INTEGER NOT NULL DEFAULT 100,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE available_fonts IS
  'Curated Google Fonts the platform offers tenants during onboarding. Two categories (heading, body). Code joins on name to get the Google Fonts URL fragment and a fallback stack for email/print clients that strip web fonts.';
COMMENT ON COLUMN available_fonts.google_fonts_param IS
  'The family= parameter for Google Fonts CSS API (e.g. ''Nunito+Sans:wght@400;600;700''). Combine multiple with &family=.';
COMMENT ON COLUMN available_fonts.fallback_stack IS
  'CSS font stack used after the web font, sized so Gmail/Outlook still get something close. Should not include the web font name itself; the rendering code prepends it.';

ALTER TABLE available_fonts ENABLE ROW LEVEL SECURITY;
CREATE POLICY available_fonts_public_read ON available_fonts FOR SELECT USING (true);

INSERT INTO available_fonts (name, category, google_fonts_param, fallback_stack, display_order) VALUES
  ('Titan One',        'heading', 'Titan+One',                                  '''Avenir Next Heavy'',''Trebuchet MS'',Helvetica,sans-serif', 10),
  ('Fredoka',          'heading', 'Fredoka:wght@400;500;600;700',               '''Avenir Next'',''Trebuchet MS'',Helvetica,sans-serif',       20),
  ('Quicksand',        'heading', 'Quicksand:wght@400;500;600;700',             '''Avenir Next'',''Trebuchet MS'',Helvetica,sans-serif',       30),
  ('Poppins',          'heading', 'Poppins:wght@400;500;600;700',               '''Avenir Next'',Helvetica,sans-serif',                       40),
  ('Montserrat',       'heading', 'Montserrat:wght@400;500;600;700',            '''Avenir Next'',Helvetica,sans-serif',                       50),
  ('Playfair Display', 'heading', 'Playfair+Display:wght@400;500;600;700',      'Georgia,''Times New Roman'',serif',                          60),
  ('Bungee',           'heading', 'Bungee',                                     '''Trebuchet MS'',Helvetica,sans-serif',                      70),
  ('Nunito Sans',      'body',    'Nunito+Sans:wght@400;600;700;800',           '''Avenir Next'',Helvetica,Arial,sans-serif',                 10),
  ('Inter',            'body',    'Inter:wght@400;500;600;700',                 '-apple-system,''Helvetica Neue'',Helvetica,sans-serif',     20),
  ('Open Sans',        'body',    'Open+Sans:wght@400;500;600;700',             'Helvetica,Arial,sans-serif',                                 30),
  ('Lato',             'body',    'Lato:wght@400;700',                          'Helvetica,Arial,sans-serif',                                 40),
  ('Source Sans 3',    'body',    'Source+Sans+3:wght@400;500;600;700',         'Helvetica,Arial,sans-serif',                                 50),
  ('Roboto',           'body',    'Roboto:wght@400;500;700',                    'Helvetica,Arial,sans-serif',                                 60),
  ('Work Sans',        'body',    'Work+Sans:wght@400;500;600;700',             'Helvetica,Arial,sans-serif',                                 70)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE org_branding
  ALTER COLUMN heading_font DROP DEFAULT,
  ALTER COLUMN body_font    DROP DEFAULT;

ALTER TABLE org_branding
  ADD CONSTRAINT org_branding_heading_font_fk
    FOREIGN KEY (heading_font) REFERENCES available_fonts(name) ON UPDATE CASCADE ON DELETE SET NULL,
  ADD CONSTRAINT org_branding_body_font_fk
    FOREIGN KEY (body_font)    REFERENCES available_fonts(name) ON UPDATE CASCADE ON DELETE SET NULL;
