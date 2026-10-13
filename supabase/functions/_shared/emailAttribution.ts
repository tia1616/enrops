// Which campaign email a registration came from.
//
// Two halves, one vocabulary:
//   - withEmailAttribution(): the SEND side. Adds utm_* tags to the register link
//     in a campaign email.
//   - sanitizeAttribution(): the RECEIVE side. create-registration takes whatever
//     the browser remembers and keeps only short tag text, because the browser is
//     not trusted - a hand-edited value must not put anything else on a row.
//
// The tags carry the campaign's own id and the touchpoint's id. Nothing about the
// recipient: not their address, not their name.

export const ATTRIBUTION_FIELDS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export const EMAIL_UTM_SOURCE = "enrops_email";

const VALUE_OK = /^[A-Za-z0-9._~:/ -]{1,100}$/;

export type Attribution = Partial<Record<(typeof ATTRIBUTION_FIELDS)[number], string>>;

/** Keep only known tag names with short, plain values. Null when nothing is left. */
export function sanitizeAttribution(raw: unknown): Attribution | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Attribution = {};
  for (const f of ATTRIBUTION_FIELDS) {
    const v = typeof src[f] === "string" ? (src[f] as string).trim() : "";
    if (VALUE_OK.test(v)) out[f] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Add campaign tags to a link that points at OUR site. Anything else is returned
 *  untouched: an operator's override URL may be a partner's page, and a tag on
 *  someone else's address is noise at best and a broken signed link at worst.
 *  Tags already on the URL win, so an operator who hand-tagged a link keeps theirs. */
export function withEmailAttribution(
  url: string,
  siteOrigin: string,
  tags: { campaignId: string; touchpointId: string },
): string {
  try {
    const u = new URL(url);
    if (u.origin !== new URL(siteOrigin).origin) return url;
    const set = (k: string, v: string) => { if (!u.searchParams.has(k)) u.searchParams.set(k, v); };
    set("utm_source", EMAIL_UTM_SOURCE);
    set("utm_medium", "email");
    set("utm_campaign", tags.campaignId);
    set("utm_content", tags.touchpointId);
    return u.toString();
  } catch {
    return url;
  }
}
