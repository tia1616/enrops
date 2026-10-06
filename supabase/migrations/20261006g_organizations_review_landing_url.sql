-- Where review-rate redirects a family after recording their score. NOT
-- hardcoded to journeytosteam.com in code — J2S is the only org with a
-- Phase-1 "how did we do" landing page today (ops manual section 10), and
-- the next tenant to turn this on will have a different one, or none yet.
-- NULL = review-rate falls back to a plain "thanks, got it" response instead
-- of guessing a URL.
alter table public.organizations
  add column review_landing_url text;

comment on column public.organizations.review_landing_url is
  'Base URL (no query string) of this org''s "how did we do" landing page, e.g. https://www.journeytosteam.com/how-did-we-do. review-rate appends ?score=N&p=<program>. NULL = no landing page configured yet; the endpoint returns a plain thank-you instead of redirecting.';
