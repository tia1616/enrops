// Pure formatting helpers for founder-notify. Extracted so they can be tested
// without standing up the HTTP handler (index.ts calls serve() at import time).

/**
 * Pull "City, ST" out of a Google-Places-formatted address such as
 * "SE Morrison St, Gresham, OR 97030, USA".
 *
 * There is no city or state COLUMN anywhere in the schema - organizations has
 * neither, and mailing_address is null for every self-serve org - so this string
 * is the only place the location lives. Returns null rather than guessing: a
 * blank line beats a wrong town.
 */
export function cityStateFrom(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = String(address).split(',').map((p) => p.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
    if (m && i > 0) return `${parts[i - 1]}, ${m[1]}`;
  }
  return null;
}

/** Local date-time in the operator's own timezone. Falls back to ISO on a bad tz. */
export function fmtWhen(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

/**
 * A calendar date (first_session_date / starts_on) is a DATE, not an instant.
 * Formatting it in UTC is deliberate - rendering it in a local timezone would
 * shift "Sep 15" to "Sep 14" for anyone west of GMT.
 */
export function fmtDate(d: string | null | undefined): string | null {
  if (!d) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }).format(new Date(`${d}T00:00:00Z`));
  } catch {
    return String(d);
  }
}

export function fmtMoney(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

/** HTML-escape for interpolation into the email body. */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The operator's personal name, or null when we do not really have one.
 *
 * org_members.name is null for half the real operators on prod, so the name they
 * typed at signup (on the auth user) is the fallback. But several operators
 * signed up with their BUSINESS name in that field, and echoing it as the
 * person's name would print the same string twice in one email.
 */
export function pickOperatorName(
  memberName: string | null | undefined,
  authFullName: string | null | undefined,
  authName: string | null | undefined,
  businessName: string | null | undefined,
): string | null {
  const member = (memberName ?? '').trim();
  if (member) return member;

  const candidate = String(authFullName ?? authName ?? '').trim();
  if (!candidate) return null;

  const business = String(businessName ?? '').trim().toLowerCase();
  if (business && candidate.toLowerCase() === business) return null;

  return candidate;
}
