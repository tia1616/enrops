// Preset avatar registry for the instructor portal v1.
//
// The DB column instructors.photo_url is a misnomer post-portal-v1: it
// stores an avatar KEY (e.g. "bottts-1"), not a URL. avatarUrl() resolves
// a key to the actual hosted Supabase Storage URL.
//
// The 8 SVGs are pre-hosted in the public-assets bucket (verified
// 2026-05-22). DiceBear bottts style is free for commercial use without
// attribution.
//
// IMPORTANT: the canonical list of valid avatar keys lives here. The
// edge function update-instructor-profile hardcodes its own copy of the
// same 8 keys (Deno cannot import from src/). Both locations carry a
// comment pointing at the other. Drift risk is low — 8 short strings —
// but flagged so it's not silent.

const STORAGE_BASE =
  'https://iuasfpztkmrtagivlhtj.supabase.co/storage/v1/object/public/public-assets/avatars';

export const AVATARS = [
  { key: 'bottts-1', seed: 'astro', label: 'Robot 1' },
  { key: 'bottts-2', seed: 'bolt', label: 'Robot 2' },
  { key: 'bottts-3', seed: 'comet', label: 'Robot 3' },
  { key: 'bottts-4', seed: 'delta', label: 'Robot 4' },
  { key: 'bottts-5', seed: 'echo', label: 'Robot 5' },
  { key: 'bottts-6', seed: 'flux', label: 'Robot 6' },
  { key: 'bottts-7', seed: 'gamma', label: 'Robot 7' },
  { key: 'bottts-8', seed: 'helix', label: 'Robot 8' },
];

// The unset-state placeholder. Resolves to bottts-1 so we always render a
// real image rather than a missing/broken state. Frontend can still detect
// "user hasn't picked yet" by checking instructor.photo_url == null and
// show different chrome (e.g. a "pick an avatar" prompt on profile).
export const DEFAULT_AVATAR = AVATARS[0];

const KEY_SET = new Set(AVATARS.map((a) => a.key));

export function isValidAvatarKey(key) {
  return typeof key === 'string' && KEY_SET.has(key);
}

// Resolve a key (or null/unknown) to a hosted URL. Never returns null —
// unknown keys fall back to DEFAULT_AVATAR so the UI never tries to render
// a broken image.
export function avatarUrl(key) {
  const safe = isValidAvatarKey(key) ? key : DEFAULT_AVATAR.key;
  return `${STORAGE_BASE}/${safe}.svg`;
}
