// feeConfig — which fee numbers actually apply to an organisation, today.
//
// Money layer (17 Sept 2026) section 4: "Per-organisation setting with an end
// date, not a hardcoded exception. Jeff needs it now; Custom will need it
// later."
//
// An organisation carries its own platform_fee_* columns. Some of those are
// NEGOTIATED - Jeff is 1% through 31 December 2030 - and a negotiated rate that
// nothing can end is indistinguishable from a hardcoded exception, which is the
// thing the doc says not to build. platform_fee_override_until is that end
// date, and this function is the only place that reads it.
//
// ONE RESOLVER, AND THE BROWSER NEVER SEES THE RULE. org-fee-config calls this
// and sends the RESULT to the registration flow, so the family-facing helper in
// src/lib/platformFee.js needs to know nothing about end dates or defaults - it
// is handed numbers that are already correct. A second copy of an expiry rule
// in the browser would be a second place for it to be wrong, and it would be
// wrong in front of a parent.

import { PlatformFeeConfig } from './computePlatformFee.ts';

/** The columns every caller must select for resolveFeeConfig to work. */
export const ORG_FEE_COLUMNS =
  'platform_fee_card_pct, platform_fee_ach_pct, platform_fee_cap_cents, ' +
  'platform_fee_ach_cap_cents, platform_fee_floor_cents, platform_fee_override_until';

/**
 * Read the platform's default pricing.
 *
 * Returns null on ANY failure, and null means "the org keeps its own terms" -
 * see resolveFeeConfig. Deliberately swallows the error after logging it: a
 * settings lookup must never be the thing that stops a family paying, and the
 * safe fallback is the org's agreed numbers, not a refused checkout.
 *
 * Needs a service-role client: platform_settings is admin-only under RLS.
 */
// deno-lint-ignore no-explicit-any
export async function loadPlatformFeeDefaults(admin: any): Promise<PlatformDefaultFeeConfig | null> {
  try {
    const { data, error } = await admin
      .from('platform_settings')
      .select('value')
      .eq('key', 'default_fee_config')
      .maybeSingle();
    if (error) {
      console.error('[feeConfig] default_fee_config lookup failed:', error.message);
      return null;
    }
    return (data?.value ?? null) as PlatformDefaultFeeConfig | null;
  } catch (err) {
    console.error('[feeConfig] default_fee_config lookup threw:', err);
    return null;
  }
}

/**
 * Overlay the resolved fee numbers onto a wider org config object, leaving
 * every non-fee field (stripe_account_id, charge model, and so on) untouched.
 *
 * This is the shape the charge paths want: they hold a ConnectOrgConfig that is
 * mostly routing, and only the fee half is subject to an end date.
 */
export function withResolvedFee<T extends OrgFeeRow>(
  org: T,
  defaults: PlatformDefaultFeeConfig | null | undefined,
  asOf: Date = new Date(),
): T {
  const fee = resolveFeeConfig(org, defaults, asOf);
  return {
    ...org,
    platform_fee_card_pct: fee.platform_fee_card_pct,
    platform_fee_ach_pct: fee.platform_fee_ach_pct,
    platform_fee_cap_cents: fee.platform_fee_cap_cents,
    platform_fee_ach_cap_cents: fee.platform_fee_ach_cap_cents,
    platform_fee_floor_cents: fee.platform_fee_floor_cents,
  };
}

/** The platform's own pricing, from platform_settings.default_fee_config. */
export interface PlatformDefaultFeeConfig {
  card_pct?: number | null;
  ach_pct?: number | null;
  floor_cents?: number | null;
  card_cap_cents?: number | null;
  ach_cap_cents?: number | null;
}

/** The organisations columns this cares about. */
export interface OrgFeeRow extends PlatformFeeConfig {
  /**
   * Last date the org's OWN columns apply, inclusive. null = never expires.
   * A `date` column, so it arrives as 'YYYY-MM-DD'.
   */
  platform_fee_override_until?: string | null;
}

export interface ResolvedFeeConfig extends PlatformFeeConfig {
  /** True when the org's own terms have lapsed and defaults are in force. */
  usedPlatformDefaults: boolean;
}

/**
 * HOW THE DATE IS COMPARED, AND WHICH WAY IT ERRS.
 *
 * `platform_fee_override_until` is a date with no timezone, and "has today
 * passed" has no single answer across timezones: UTC rolls over while it is
 * still the previous afternoon in Portland. Comparing bare UTC dates would end
 * an organisation's negotiated terms at 5pm on their last day.
 *
 * So the terms lapse only after the date has passed EVERYWHERE - one full day
 * of grace past the stated date. The direction is the point, not the day: an
 * org keeping an agreed rate a few hours longer than the letter of the
 * agreement costs enrops a rounding error, while ending it early charges a
 * provider, or a family, a price nobody agreed to. Fail toward the promise
 * that was made.
 *
 * Timezone-free on purpose. Reading the org's own timezone here would make the
 * fee depend on a field with one writer and no settings surface, and would put
 * a tenant-shaped branch inside a money rule.
 */
function overrideHasLapsed(until: string | null | undefined, asOf: Date): boolean {
  if (!until) return false; // no end date: the org's terms never expire
  const lastDay = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(lastDay)) return false; // unparseable: keep the org's terms
  const graceEnds = lastDay + 2 * 24 * 60 * 60 * 1000; // end of the day after
  return asOf.getTime() >= graceEnds;
}

/**
 * A number, or null for anything that is not one.
 *
 * THE EXPLICIT null/undefined/'' CHECKS ARE LOAD-BEARING, and an earlier draft
 * left them out. `Number(null)` is 0 and `Number('')` is 0 - both finite - so a
 * defaults row with a missing bank rate coerced to a perfectly valid 0% and
 * sailed past the guard below, making every bank payment free. Its own test
 * caught it. `Number.isFinite` does not mean "was a number"; it means "is not
 * NaN or Infinity", and null is neither.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A usable RATE: present, numeric and above zero. */
function rate(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

/**
 * The fee config actually in force for this organisation.
 *
 * FAIL DIRECTION, and it is the whole reason this returns rather than throws:
 * if the org's terms have lapsed but the platform defaults cannot be read -
 * the settings row is missing, empty, or malformed - it returns the ORG'S OWN
 * config, unchanged, and flags nothing as defaulted. Inventing a price because
 * a settings row went missing is how a family gets charged a number nobody
 * chose. The org's own terms are at worst out of date; they were at least
 * agreed.
 */
export function resolveFeeConfig(
  org: OrgFeeRow,
  defaults: PlatformDefaultFeeConfig | null | undefined,
  asOf: Date = new Date(),
): ResolvedFeeConfig {
  const own: ResolvedFeeConfig = {
    platform_fee_card_pct: org.platform_fee_card_pct,
    platform_fee_ach_pct: org.platform_fee_ach_pct,
    platform_fee_floor_cents: org.platform_fee_floor_cents ?? null,
    platform_fee_cap_cents: org.platform_fee_cap_cents ?? null,
    platform_fee_ach_cap_cents: org.platform_fee_ach_cap_cents ?? null,
    usedPlatformDefaults: false,
  };

  if (!overrideHasLapsed(org.platform_fee_override_until, asOf)) return own;

  // Lapsed. Defaults must supply BOTH rates, and both above zero, to be
  // usable. A defaults object with a card rate and no bank rate would silently
  // make every bank payment free, which is a pricing change nobody asked for;
  // so would a zero typed into either. Partial or zero is treated as
  // unreadable, and unreadable means the org keeps its own terms.
  //
  // A genuine 0% organisation is expressed by not setting an end date at all,
  // not by a platform default of zero.
  const cardPct = rate(defaults?.card_pct);
  const achPct = rate(defaults?.ach_pct);
  if (cardPct === null || achPct === null) return own;

  return {
    platform_fee_card_pct: cardPct,
    platform_fee_ach_pct: achPct,
    platform_fee_floor_cents: num(defaults?.floor_cents),
    platform_fee_cap_cents: num(defaults?.card_cap_cents),
    platform_fee_ach_cap_cents: num(defaults?.ach_cap_cents),
    usedPlatformDefaults: true,
  };
}
