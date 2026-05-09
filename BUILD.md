# Enrops — Build Notes

## Before building: set env vars

Vite bakes `VITE_*` variables into the JS bundle at build time. If they're
missing, the Supabase client can't initialize and the deployed page
white-screens on load.

### For Claude (per-session)

Before running `npm run build`, fetch keys from Supabase and write `.env`:

1. Call `Supabase:get_project_url` with project_id `iuasfpztkmrtagivlhtj`
2. Call `Supabase:get_publishable_keys` with the same project_id
3. Write `.env` at project root with `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` set to those values
4. Then `npm run build`

The anon key is safe to expose client-side (protected by Supabase RLS).

### For humans

Copy `.env.template` to `.env`, fill in real values from
Supabase dashboard → Project Settings → API.

## Build output

- `dist/` goes to Netlify (drag-drop)
- Remove `netlify.toml` from the zip before uploading (causes build failures)

## Source backup

Zip everything EXCEPT `node_modules/`, `dist/`, `.git/`, and `.env`.
Upload to Drive "Enrops - Source of Truth" folder.
