// Pricing engine.
//
// Source of truth for per-program price:
//   programs.price_cents              — standard price (always set)
//   programs.early_bird_price_cents   — optional, per-row early-bird price
//   programs.early_bird_deadline      — optional, per-row deadline (date)
//
// `basePriceForItem` reads from those columns. The per-session-rate formula
// below is kept ONLY as a fallback for programs that somehow lack price_cents.
// In practice every program row has price_cents (NOT NULL in schema).
//
// J2S-specific business rules still hardcoded here (revisit for multi-tenant):
//   - VIP: $240/term × 3 terms = $720 (locked per-term anchor)
//   - Sibling discount: 10% off for child 2+
//   - Coding-robotics keyword list used by the formula fallback
//   - LEGACY_PRICE_CENTS / LEGACY_DEADLINE: fallback-only safety net,
//     used if a row is missing both early_bird_* columns
//
// Stacking order (unchanged):
//   1. Base from DB (early-bird if active, else standard)
//   2. Sibling discount for children 2+
//   3. Promo code on remaining subtotal
//
// All money math in cents. Never floats for currency.

// Fallback-only per-session rates. Live data should use programs.price_cents.
export const STANDARD_RATE_CENTS = 3562.5;  // $35.625/session ($285/8)
export const CODING_RATE_CENTS = 3737.5;    // $37.375/session ($299/8)

// Used only by the formula fallback for detecting coding-vs-standard tier
// when program_type isn't set. Multi-tenant: deprecate once all rows have
// program_type populated.
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

// Fallback-only. Live rows carry their own early_bird_price_cents /
// early_bird_deadline. These constants kick in only if a row is missing both.
export const LEGACY_PRICE_CENTS = 27500;
export const LEGACY_DEADLINE = '2026-06-05';
export const VIP_PRICE_PER_TERM_CENTS = 24000;
export const VIP_TERMS_COUNT = 3;
export const VIP_TOTAL_CENTS = VIP_PRICE_PER_TERM_CENTS * VIP_TERMS_COUNT;
export const SIBLING_DISCOUNT_PCT = 10;
export const INSTALLMENT_MIN_CENTS = 20000;

export function isLegacyActive(today = new Date()) {
  const deadline = new Date(LEGACY_DEADLINE + 'T23:59:59');
  return today < deadline;
}

// How far a wall-clock reading in `timeZone` sits from UTC at a given instant.
// Positive west of Greenwich. Derived from Intl rather than a table so it is
// right across daylight saving without a dependency.
function zoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value;
  // Some engines render midnight as hour 24; % 24 normalises it.
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second),
  );
  return utcMs - asUTC;
}

// Is the early bird still running? dateStr is 'YYYY-MM-DD' from a Postgres date
// column, and the deadline day COUNTS, to its last moment, in the BUSINESS's own
// timezone (organizations.timezone).
//
// IT USED TO END AT THE UTC END OF DAY, which is not the end of anybody's day.
// A Nov 2 deadline expired at 3:59:59pm Pacific — the clocks go back on Nov 1, so
// Portland is UTC-8 — and a parent buying at 11pm on the last evening paid full
// price. The last evening of an early bird is the one that matters. Worse, the
// live class list on the business's own website compares against local midnight,
// so for those eight hours the website advertised the early-bird price while
// checkout charged the standard one.
//
// The zone is a parameter, never a constant: businesses on this platform run in
// Eastern, Mountain and Phoenix as well as Pacific, and a hardcoded Pacific
// cutoff would quietly end an Eastern business's early bird at 9pm. Defaults to
// UTC so a caller that has not been given an organisation keeps exactly the
// behaviour it had rather than silently moving a price.
export function isEarlyBirdActive(dateStr, today = new Date(), timeZone = 'UTC') {
  if (!dateStr) return false;
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return false;
  // Midnight at the START of the day after the deadline, in that zone. Expressed
  // as an exclusive upper bound so the deadline day is whole, to the millisecond.
  const wall = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  // Twice: the first offset is read at the wrong instant when the correction
  // crosses a daylight-saving change, and the second lands on the right side.
  let end = wall + zoneOffsetMs(wall, timeZone);
  end = wall + zoneOffsetMs(end, timeZone);
  return today.getTime() < end;
}

// 'YYYY-MM-DD' -> 'June 5'. Fixed to UTC to avoid TZ wobble shifting the day.
export function formatEarlyBirdDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// DB-first standard price. Falls back to the formula only when price_cents
// isn't set (shouldn't happen for live data — column is NOT NULL).
export function standardPriceFor(program) {
  if (!program) return 0;
  if (program.price_cents != null) return program.price_cents;
  return calculateProgramPrice(program);
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

// Formula-fallback price: session_count × per-session rate. Used only when
// program.price_cents is missing; live data should hit standardPriceFor instead.
export function calculateProgramPrice(program) {
  if (!program) return 0;
  // Fallbacks for pre-migration data
  const sessionCount = program.session_count || 8;
  const programType =
    program.program_type || detectProgramType(program.curriculum);
  const rate =
    programType === 'coding_robotics' ? CODING_RATE_CENTS : STANDARD_RATE_CENTS;
  return Math.round(sessionCount * rate);
}

// timeZone is the ORGANISATION's (organizations.timezone), and decides only one
// thing: whether the early-bird deadline has passed. Omitted, it falls back to
// UTC — the behaviour this had before — so a caller that has not been wired up
// keeps its prices rather than having them move by a few hours unannounced.
export function basePriceForItem({ program, isVip, today = new Date(), timeZone = 'UTC' }) {
  if (isVip) {
    // VIP is per-term anchor. Cart expands a VIP item into 3 lines (Fall +
    // Winter + Spring), each at $240. create-registration writes $240 to each
    // of the 3 registration rows directly.
    return {
      base_cents: VIP_PRICE_PER_TERM_CENTS,
      label: 'All 3 Terms',
      is_legacy: false,
      is_vip: true,
      standard_cents: VIP_PRICE_PER_TERM_CENTS,
      early_bird_deadline: null,
    };
  }

  const standardPrice = standardPriceFor(program);

  // Per-row early bird from DB.
  const ebPrice = program?.early_bird_price_cents;
  const ebDeadline = program?.early_bird_deadline;
  if (
    ebPrice != null &&
    ebPrice < standardPrice &&
    isEarlyBirdActive(ebDeadline, today, timeZone)
  ) {
    return {
      base_cents: ebPrice,
      label: `Early bird (through ${formatEarlyBirdDate(ebDeadline)})`,
      is_legacy: true,
      is_vip: false,
      standard_cents: standardPrice,
      early_bird_deadline: ebDeadline,
    };
  }

  // Fallback safety net: if a row has neither early_bird_price_cents nor
  // early_bird_deadline, honor the global LEGACY discount (J2S launch behavior).
  // No live FA26 row hits this branch — kept for defensive parity until tenant 2.
  if (
    ebPrice == null &&
    ebDeadline == null &&
    isLegacyActive(today) &&
    LEGACY_PRICE_CENTS < standardPrice
  ) {
    return {
      base_cents: LEGACY_PRICE_CENTS,
      label: `Early bird (through ${formatEarlyBirdDate(LEGACY_DEADLINE)})`,
      is_legacy: true,
      is_vip: false,
      standard_cents: standardPrice,
      early_bird_deadline: LEGACY_DEADLINE,
    };
  }

  return {
    base_cents: standardPrice,
    label: 'Standard price',
    is_legacy: false,
    is_vip: false,
    standard_cents: standardPrice,
    early_bird_deadline: null,
  };
}

export function calculateCart(cart) {
  const lines = [];
  let subtotal_cents = 0;
  let sibling_total_cents = 0;

  // Sibling % from org config (threaded onto the cart once org-fee-config loads).
  // undefined = not loaded yet -> fall back to the legacy 10% so the display is
  // right for J2S from the first paint; null = org has it turned off (0%).
  const sibPct =
    cart.sibling_discount_pct === undefined
      ? SIBLING_DISCOUNT_PCT
      : cart.sibling_discount_pct == null
      ? 0
      : Number(cart.sibling_discount_pct);

  cart.children.forEach((child) => {
    child.items.forEach((item) => {
      const { base_cents, label, is_legacy, is_vip } = basePriceForItem({
        program: item.program,
        isVip: item.isVip,
        // Threaded onto the cart by Register once org-fee-config loads, exactly
        // as sibling_discount_pct is. Undefined until then, which falls back to
        // UTC — the behaviour this had before — rather than guessing a zone.
        timeZone: cart.timezone || 'UTC',
      });
      const sibling_cents =
        child.child_index > 0
          ? Math.round(base_cents * (sibPct / 100))
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
          // A CAMP'S DAYS, so the review line can say "Mon-Fri" instead of
          // "Mondays". formatDayLabel takes a program row OR one of these lines
          // and prefers class_days; without it here the line fell back to
          // day_of_week, which on a camp holds only its FIRST day. The last
          // screen before payment was describing a Monday-to-Friday camp as a
          // weekly Monday class.
          class_days: prog.class_days ?? null,
          start_time: prog.start_time,
          end_time: prog.end_time,
          term: prog.term,
          term_label: termLabel, // 'Fall' / 'Winter' / 'Spring' for VIP lines, null otherwise
          first_session_date: prog.first_session_date,
          sessions: prog.session_count || 8,
          // The raw value, WITHOUT the 8 fallback above. `sessions` feeds the
          // installment-window math, where defaulting to 8 is a reasonable guess;
          // the review line SHOWS this number to a family, where guessing "8
          // sessions" at a program that never said so is a claim we can't back.
          session_count: prog.session_count ?? null,
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

  // Allocate the promo across lines (proportional to each line's after-sibling
  // amount, remainder on the largest) so per-line NET amounts sum EXACTLY to
  // total_cents. Mirrors the server engine (promoPricing.ts) so the installment
  // breakdown on the review screen matches the discounted total and the charge.
  if (promo_discount_cents > 0 && after_sibling > 0) {
    let allocated = 0;
    let largestIdx = 0;
    lines.forEach((l, i) => {
      const share = Math.round(promo_discount_cents * (l.subtotal_cents / after_sibling));
      l.promo_discount_cents = share;
      allocated += share;
      if (l.subtotal_cents > lines[largestIdx].subtotal_cents) largestIdx = i;
    });
    const remainder = promo_discount_cents - allocated;
    if (remainder !== 0 && lines[largestIdx]) lines[largestIdx].promo_discount_cents += remainder;
    lines.forEach((l) => { if (l.promo_discount_cents > l.subtotal_cents) l.promo_discount_cents = l.subtotal_cents; });
  }
  lines.forEach((l) => {
    l.promo_discount_cents = l.promo_discount_cents || 0;
    l.amount_cents = l.subtotal_cents - l.promo_discount_cents; // NET after promo
  });

  return {
    lines,
    subtotal_cents,
    sibling_total_cents,
    promo_discount_cents,
    total_cents,
  };
}
