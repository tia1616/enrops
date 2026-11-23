// The one address operators are told to email enrops at. enrops.com's MX is
// Google (checked 2026-11-23), so mail here is received. The Help tour and the
// "email taken" refusal both read it from here; supabase/functions/update-contact
// cannot import from src/ and carries the same literal.
export const HELP_EMAIL = "hello@enrops.com";
