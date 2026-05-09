// Pricing engine per Enrops Registration Spec §1 + locked overrides (April 22, 2026).
//
// LOCKED BUSINESS RULES:
//   - Standard rate: $35.625/session ($285 ÷ 8 sessions)
//   - Coding/Robotics rate: $37.375/session ($299 ÷ 8 sessions)
//   - Formula-based pricing: session_count × rate, rounded to nearest dollar
//   - One pricing model — no per-school overrides. 6 sessions costs the same everywhere.
//   - Legacy price: $275 flat for all tiers before June 5, 2026
//   - VIP: $240/term × 3 terms = $720 total (single price, locked)
//   - Sibling discount: 10% off for child 2+
//   - Promo codes: stack with sibling + VIP
//
// Stacking order:
//   1. Start with base (formula price OR legacy OR VIP)
//   2. Apply sibling discount for children 2+
//   3. Apply promo code on remaining subtotal
//
// All money math in cents. Never floats for currency.

// Per-session rates (in cents, not rounded — used as multipliers only)
export const STANDARD_RATE_CENTS = 3562.5;  // $35.625/session ($285/8)
export const CODING_RATE_CENTS = 3737.5;    // $37.375/session ($299/8)

// Keywords that identify coding/robotics programs (higher material cost)
// Matches against program.curriculum (case-insensitive, word boundary not required)
const CODING_ROBOTICS_KEYWORDS = [
  'minecraft',
  'coder',
  'coding',
  'robotics',
  'robot',
  'python',
  'mbot',
  'bricks & bots',
  'bricks and bots',
  'scratch',
  'computer',
  'AI',
];

export const LEGACY_PRICE_CENTS = 27500; // $275 flat
export const LEGACY_DEADLINE = '2026-06-05';
export const VIP_PRICE_PER_TERM_CENTS = 24000; // $240/term locked
export const VIP_TERMS_COUNT = 3;
export const VIP_TOTAL_CENTS = VIP_PRICE_PER_TERM_CENTS * VIP_TERMS_COUNT; // $720
export const SIBLING_DISCOUNT_PCT = 10;
export const INSTALLMENT_MIN_CENTS = 20000;

export function isLegacyActive(today = new Date()) {
  const deadline = new Date(LEGACY_DEADLINE + 'T23:59:59');
  return today < deadline;
}

export function formatMoney(cents) {
  if (cents == null) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

// Detect program type from curriculum name via keyword matching.
// Returns 'coding_robotics' if any keyword matches, 'standard' otherwise.
// Used as fallback when program.program_type is not set in DB.
export function detectProgramType(curriculum) {
  if (!curriculum) return 'standard';
  const lower = curriculum.toLowerCase();
  for (const kw of CODING_ROBOTICS_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return 'coding_robotics';
  }
  return 'standard';
}

// Calculate program price from session_count + program_type using per-session rate.
// Rounds to nearest dollar for clean pricing displays.
// Falls back gracefully if session_count or program_type aren't set yet (DB migration pending).
export function calculateProgramPrice(program) {
  if (!program) return 0;
  // Fallbacks for pre-migration data
  const sessionCount = program.session_count || 8;
  const programType =
    program.program_type || detectProgramType(program.curriculum);
  const rate =
    programType === 'coding_robotics' ? CODING_RATE_CENTS : STANDARD_RATE_CENTS;
  const raw = sessionCount * rate;
  // Round to nearest dollar (100 cents)
  return Math.round(raw / 100) * 100;
}

export function basePriceForItem({ program, isVip }) {
  if (isVip) {
    // VIP price PER TERM. The cart expands a VIP item into 3 cart lines
    // (Fall + Winter + Spring), each at this $240 price. Cart total naturally
    // sums to $720 across the 3 lines. The create-registration edge function
    // also writes $240 to each of the 3 registration rows directly.
    return {
      base_cents: VIP_PRICE_PER_TERM_CENTS,
      label: 'All 3 Terms',
      is_legacy: false,
      is_vip: true,
    };
  }
  // Calculate formula price from session_count + program_type
  const standardPrice = calculateProgramPrice(program);
  // Legacy is a discount, not a surcharge — only apply if it's cheaper than standard.
  if (isLegacyActive() && LEGACY_PRICE_CENTS < standardPrice) {
    return {
      base_cents: LEGACY_PRICE_CENTS,
      label: 'Early-bird price (before June 5)',
      is_legacy: true,
      is_vip: false,
    };
  }
  return {
    base_cents: standardPrice,
    label: 'Standard price',
    is_legacy: false,
    is_vip: false,
  };
}

export function calculateCart(cart) {
  const lines = [];
  let subtotal_cents = 0;
  let sibling_total_cents = 0;

  cart.children.forEach((child) => {
    child.items.forEach((item) => {
      const { base_cents, label, is_legacy, is_vip } = basePriceForItem({
        program: item.program,
        isVip: item.isVip,
      });
      const sibling_cents =
        child.child_index > 0
          ? Math.round(base_cents * (SIBLING_DISCOUNT_PCT / 100))
          : 0;
      const subtotal = base_cents - sibling_cents;

      // VIP: expand into 3 cart lines (one per term). Each at $240 per-term price.
      // Each line shows the term-specific program info (curriculum, first_session_date).
      // Standard: just one line as before.
      const programsForLines = item.isVip && item.vipBundle
        ? [
            { prog: item.vipBundle.fall, termLabel: 'Fall' },
            { prog: item.vipBundle.winter, termLabel: 'Winter' },
            { prog: item.vipBundle.spring, termLabel: 'Spring' },
          ]
        : [{ prog: item.program, termLabel: null }];

      programsForLines.forEach(({ prog, termLabel }) => {
        if (!prog) return; // safety: skip if winter/spring missing
        lines.push({
          child_index: child.child_index,
          label,
          program_id: prog.id,
          program_name: prog.curriculum,
          school_name: prog.school_name || prog.program_locations?.name || item.program.school_name || '',
          day_of_week: prog.day_of_week,
          start_time: prog.start_time,
          end_time: prog.end_time,
          term: prog.term,
          term_label: termLabel, // 'Fall' / 'Winter' / 'Spring' for VIP lines, null otherwise
          first_session_date: prog.first_session_date,
          sessions: prog.sessions || prog.session_count || 8,
          // VIP-only: surface Winter and Spring start dates for installment scheduling
          vip_winter_first_session_date:
            item.isVip && item.vipBundle?.winter?.first_session_date
              ? item.vipBundle.winter.first_session_date
              : null,
          vip_spring_first_session_date:
            item.isVip && item.vipBundle?.spring?.first_session_date
              ? item.vipBundle.spring.first_session_date
              : null,
          base_cents,
          sibling_discount_cents: sibling_cents,
          subtotal_cents: subtotal,
          is_legacy,
          is_vip,
        });

        subtotal_cents += base_cents;
        sibling_total_cents += sibling_cents;
      });
    });
  });

  const after_sibling = subtotal_cents - sibling_total_cents;
  let promo_discount_cents = 0;
  if (cart.promo) {
    if (cart.promo.discount_type === 'percent') {
      promo_discount_cents = Math.round(
        after_sibling * (Number(cart.promo.discount_value) / 100),
      );
    } else if (cart.promo.discount_type === 'fixed') {
      promo_discount_cents = Math.round(Number(cart.promo.discount_value) * 100);
    }
    promo_discount_cents = Math.min(promo_discount_cents, after_sibling);
  }

  const total_cents = Math.max(0, after_sibling - promo_discount_cents);

  return {
    lines,
    subtotal_cents,
    sibling_total_cents,
    promo_discount_cents,
    total_cents,
  };
}
