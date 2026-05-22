-- Add preferred_name + shirt_size to instructors.
-- Applied 2026-05-22 (migration already executed against project iuasfpztkmrtagivlhtj).

ALTER TABLE public.instructors
  ADD COLUMN preferred_name TEXT,
  ADD COLUMN shirt_size TEXT
    CHECK (shirt_size IS NULL OR shirt_size IN ('XS','S','M','L','XL','2XL','3XL'));

COMMENT ON COLUMN public.instructors.preferred_name IS
  'Optional. What the instructor goes by (e.g., Rebecca → "Bo"). Display layers should render preferred_name ?? first_name. Legal documents and tax forms still use first_name + last_name.';
COMMENT ON COLUMN public.instructors.shirt_size IS
  'Optional. Adult unisex t-shirt size for J2S apparel. One of XS, S, M, L, XL, 2XL, 3XL or NULL.';
