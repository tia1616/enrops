// Browser half of the gift arithmetic. Mirrors
// supabase/functions/_shared/scholarshipFund.ts, the same way
// src/lib/platformFee.js mirrors _shared/computePlatformFee.ts.
//
// The two halves cannot drift on the RATE, because neither owns it: both read
// `cover_fee_pct` off the org_scholarship_fund row (the browser gets it through
// org-fee-config). What is duplicated here is only the rounding, and the test
// in scholarshipFund.test.mjs pins it against the same cases the Deno test uses.

// The extra a donor adds so processing does not come out of their gift.
export function coverFeeCents(giftCents, coverFee, cfg) {
  if (!coverFee) return 0;
  if (!Number.isFinite(giftCents) || giftCents <= 0) return 0;
  const pct = Number(cfg?.cover_fee_pct);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.max(0, Math.round(giftCents * pct));
}

// What the card is actually charged for the gift line.
export function chargedGiftCents(giftCents, coverFee, cfg) {
  const gift = Number.isFinite(giftCents) && giftCents > 0 ? Math.round(giftCents) : 0;
  if (!gift) return 0;
  return gift + coverFeeCents(gift, coverFee, cfg);
}

// Is this amount one the server will accept? Used to disable the Pay button and
// say why, rather than letting the family reach Stripe and bounce off a 400.
//
// This is the COURTESY check. create-checkout re-runs the same bounds against
// the same DB row and is the authoritative one - a browser can lie about both
// the amount and the config it claims to have read.
export function giftWithinBounds(giftCents, cfg) {
  if (!cfg?.enabled) return false;
  if (!Number.isInteger(giftCents) || giftCents <= 0) return false;
  return giftCents >= cfg.min_cents && giftCents <= cfg.max_cents;
}

// "$5" / "$12.50" - presets are whole dollars, custom amounts may not be.
export function formatGift(cents) {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

// Parse what someone typed into the custom box into cents, or null if it is not
// a usable amount yet. Deliberately tolerant while typing ("", "1.", "$12") and
// strict about what it returns: whole cents or nothing.
export function parseGiftInput(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d*(\.\d{0,2})?$/.test(cleaned)) return null;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}
