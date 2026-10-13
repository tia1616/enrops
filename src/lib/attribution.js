// Which email brought a family to the registration page.
//
// Campaign emails link to the registration page with utm_* tags on the URL
// (added server-side, supabase/functions/_shared/emailAttribution.ts). A family
// rarely registers on the page they land on - they browse the catalog, leave, come
// back - so the tags are remembered on the device and handed to create-registration
// when they check out, which stores them on each registration row.
//
// LAST TOUCH, 30 days. A newer tagged link replaces an older one; an untagged
// visit never erases a tag. That is the answer to "which email did they click
// last before registering", which is the question this exists to settle.
//
// What is stored is the campaign's own id and the touchpoint's id - nothing about
// the person. The server re-sanitises it (create-registration), so a hand-edited
// localStorage value cannot put anything but short tag text on a registration.

const KEY = 'enrops_attr_v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ATTRIBUTION_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const VALUE_OK = /^[A-Za-z0-9._~:/ -]{1,100}$/;

function store() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** The utm_* tags on a query string, or null when there are none worth keeping. */
export function parseAttribution(search) {
  let params;
  try { params = new URLSearchParams(search || ''); } catch { return null; }
  const out = {};
  for (const f of ATTRIBUTION_FIELDS) {
    const v = (params.get(f) || '').trim();
    if (VALUE_OK.test(v)) out[f] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Remember tags found on the current URL. No tags on the URL = leave what is stored alone. */
export function captureAttribution(search, now = Date.now(), storage = store()) {
  const tags = parseAttribution(search ?? (typeof window !== 'undefined' ? window.location.search : ''));
  if (!tags || !storage) return null;
  try { storage.setItem(KEY, JSON.stringify({ tags, at: now })); } catch { /* private mode / full: not worth failing a page for */ }
  return tags;
}

/** The remembered tags if still fresh, else null. Never throws. */
export function readAttribution(now = Date.now(), storage = store()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const { tags, at } = JSON.parse(raw);
    if (!tags || typeof at !== 'number' || now - at > TTL_MS || now < at - 60_000) return null;
    return parseAttribution(new URLSearchParams(tags).toString());
  } catch { return null; }
}
