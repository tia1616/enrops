// Server-authoritative pricing + promo validation.
//
// This is the single source of truth for what a cart costs. The browser's
// numbers are display-only; create-registration and create-checkout recompute
// here from the DB so the charge, the registration rows, and the platform fee
// all agree, and a tampered client total can never underpay.
//
// Mirrors the stacking order of the client display engine (src/lib/pricing.js):
//   1. base   = program price (early-bird price if its deadline is still active)
//   2. sibling = org's sibling_discount_pct off each additional child
//   3. promo   = validated code, allocated across lines proportionally
// All math in integer cents. Never floats for currency.

export type DiscountType = 'percent' | 'fixed';

export interface ProgramPricing {
  id: string;
  price_cents: number;
  early_bird_price_cents: number | null;
  early_bird_deadline: string | null; // 'YYYY-MM-DD'
}

// One priced line = one registration-to-be. child_index drives the sibling rule.
export interface CartLineInput {
  program: ProgramPricing;
  child_index: number;      // 0 = first child, >0 = sibling
  is_vip?: boolean;
  vip_price_cents?: number;  // locked per-term VIP price when is_vip
}

export interface PromoCodeRow {
  id: string;
  organization_id: string;
  code: string;
  discount_type: DiscountType;
  discount_value: number;   // percent: whole %; fixed: dollars
  active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
  used_count: number | null;
  per_family_limit: number | null;
  min_subtotal_cents: number | null;
  scope_program_ids: string[] | null;
}

export interface PricedLine {
  program_id: string;
  child_index: number;
  base_cents: number;         // catalog price used (early-bird if active)
  sibling_discount_cents: number;
  promo_discount_cents: number;
  amount_cents: number;       // NET after sibling + promo (what is charged)
  discount_cents: number;     // sibling + promo on this line (gross = amount + discount)
  is_vip: boolean;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal_cents: number;         // sum of base (gross)
  sibling_total_cents: number;
  promo_discount_cents: number;
  total_cents: number;            // NET total actually charged
}

// How far a wall-clock reading in `timeZone` sits from UTC at a given instant.
// Positive west of Greenwich.
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return utcMs - asUTC;
}

// The early-bird gate. The deadline day counts to its last moment in the
// BUSINESS's timezone (organizations.timezone), not in UTC.
//
// LINE FOR LINE THE SAME as src/lib/pricing.js isEarlyBirdActive. This decides
// the amount Stripe charges and that one decides the price on screen; if the two
// readings of the calendar ever differ, a family is quoted one number and billed
// another. Any change here is a change there, in the same commit.
//
// It used to end at 23:59:59 UTC, which is 3:59:59pm Pacific on a November date —
// so a parent buying on the last evening paid full price while the business's own
// website still advertised the discount. Defaults to UTC so a caller that has not
// been handed an organisation keeps the behaviour it had.
export function isEarlyBirdActive(
  dateStr: string | null,
  now: Date = new Date(),
  timeZone = 'UTC',
): boolean {
  if (!dateStr) return false;
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return false;
  const wall = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  let end = wall + zoneOffsetMs(wall, timeZone);
  end = wall + zoneOffsetMs(end, timeZone);
  return now.getTime() < end;
}

export function basePriceForProgram(
  p: ProgramPricing,
  now: Date = new Date(),
  timeZone = 'UTC',
): number {
  const standard = p.price_cents;
  const eb = p.early_bird_price_cents;
  if (eb != null && eb < standard && isEarlyBirdActive(p.early_bird_deadline, now, timeZone)) {
    return eb;
  }
  return standard;
}

export interface PromoValidation {
  valid: boolean;
  reason?: string;        // machine-ish reason for logs
  message?: string;       // plain-language, safe to show a family
}

// Validate a promo against a cart. `priorRedemptions` = existing rows in
// promo_redemptions for this code (all, and this family's), so max_uses and
// per_family_limit are enforced against real usage, not the stale used_count int.
export function validatePromo(
  code: PromoCodeRow | null,
  ctx: {
    orgId: string;
    lineProgramIds: string[];
    afterSiblingSubtotalCents: number;
    totalRedemptions: number;      // count across all families
    familyRedemptions: number;     // count for this parent
    now?: Date;
  },
): PromoValidation {
  if (!code) return { valid: false, reason: 'not_found', message: "That code isn't valid." };
  const now = ctx.now ?? new Date();
  if (code.organization_id !== ctx.orgId) return { valid: false, reason: 'wrong_org', message: "That code isn't valid." };
  if (!code.active) return { valid: false, reason: 'inactive', message: 'That code is no longer active.' };
  if (code.starts_at && now < new Date(code.starts_at)) return { valid: false, reason: 'not_started', message: "That code isn't active yet." };
  if (code.expires_at && now > new Date(code.expires_at)) return { valid: false, reason: 'expired', message: 'That code has expired.' };
  if (code.max_uses != null && ctx.totalRedemptions >= code.max_uses) return { valid: false, reason: 'used_up', message: 'That code has reached its usage limit.' };
  if (code.per_family_limit != null && ctx.familyRedemptions >= code.per_family_limit) return { valid: false, reason: 'family_limit', message: "You've already used that code." };
  if (code.min_subtotal_cents != null && ctx.afterSiblingSubtotalCents < code.min_subtotal_cents) {
    return { valid: false, reason: 'below_min', message: 'Your cart is below the minimum for that code.' };
  }
  if (code.scope_program_ids && code.scope_program_ids.length) {
    const anyInScope = ctx.lineProgramIds.some((pid) => code.scope_program_ids!.includes(pid));
    if (!anyInScope) return { valid: false, reason: 'out_of_scope', message: "That code doesn't apply to anything in your cart." };
  }
  return { valid: true };
}

// Total promo discount on the after-sibling subtotal, clamped to the subtotal.
function promoDiscountCents(code: PromoCodeRow, afterSiblingSubtotal: number): number {
  let raw = 0;
  if (code.discount_type === 'percent') raw = Math.round(afterSiblingSubtotal * (Number(code.discount_value) / 100));
  else raw = Math.round(Number(code.discount_value) * 100);
  return Math.min(Math.max(0, raw), afterSiblingSubtotal);
}

// Price the whole cart. `validatedPromo` is a code that already passed
// validatePromo (or null). Promo is spread across lines in proportion to each
// line's after-sibling amount; the rounding remainder lands on the largest line
// so the per-line nets sum EXACTLY to the charged total.
export function priceCart(
  lines: CartLineInput[],
  // timeZone is the ORGANISATION's (organizations.timezone). It decides only one
  // thing: whether the early-bird deadline has passed. Omitted, it falls back to
  // UTC, which is the behaviour this had before — so an unwired caller keeps its
  // prices rather than silently moving them by a few hours.
  opts: {
    siblingPct: number | null;
    validatedPromo: PromoCodeRow | null;
    now?: Date;
    timeZone?: string;
  },
): PricingResult {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone || 'UTC';
  const sibPct = opts.siblingPct == null ? 0 : Number(opts.siblingPct);

  // Pass 1: base + sibling per line.
  const work = lines.map((l) => {
    const base = l.is_vip ? (l.vip_price_cents ?? 0) : basePriceForProgram(l.program, now, tz);
    // Sibling applies to every additional child (child_index > 0), VIP included —
    // matches src/lib/pricing.js so the server total equals the review screen.
    const sibling = l.child_index > 0 ? Math.round(base * (sibPct / 100)) : 0;
    return { l, base, sibling, afterSibling: base - sibling, promo: 0 };
  });

  const subtotal = work.reduce((s, w) => s + w.base, 0);
  const siblingTotal = work.reduce((s, w) => s + w.sibling, 0);
  const afterSiblingSubtotal = subtotal - siblingTotal;

  // Pass 2: allocate promo proportionally across after-sibling amounts.
  let promoTotal = 0;
  if (opts.validatedPromo && afterSiblingSubtotal > 0) {
    promoTotal = promoDiscountCents(opts.validatedPromo, afterSiblingSubtotal);
    let allocated = 0;
    let largestIdx = 0;
    work.forEach((w, i) => {
      const share = Math.round(promoTotal * (w.afterSibling / afterSiblingSubtotal));
      w.promo = share;
      allocated += share;
      if (w.afterSibling > work[largestIdx].afterSibling) largestIdx = i;
    });
    // Put the rounding remainder on the largest line so sum is exact.
    const remainder = promoTotal - allocated;
    if (remainder !== 0) work[largestIdx].promo += remainder;
    // Guard: never let a line go negative.
    work.forEach((w) => { if (w.promo > w.afterSibling) w.promo = w.afterSibling; });
  }

  const pricedLines: PricedLine[] = work.map((w) => ({
    program_id: w.l.program.id,
    child_index: w.l.child_index,
    base_cents: w.base,
    sibling_discount_cents: w.sibling,
    promo_discount_cents: w.promo,
    amount_cents: w.afterSibling - w.promo,
    discount_cents: w.sibling + w.promo,
    is_vip: !!w.l.is_vip,
  }));

  const totalNet = pricedLines.reduce((s, l) => s + l.amount_cents, 0);

  return {
    lines: pricedLines,
    subtotal_cents: subtotal,
    sibling_total_cents: siblingTotal,
    promo_discount_cents: promoTotal,
    total_cents: totalNet,
  };
}
