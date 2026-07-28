// refundFeeProration — how much of Enrops's fee is still UNEARNED at the moment
// a refund happens.
//
// WHY THIS EXISTS. Arielle's Enrops_Refund_Setup_Checklist_v4.docx, section 2:
//
//   "Calculate % of program remaining at the moment the refund is requested:
//    sessions remaining / total sessions."
//   "Set Enrops' fee refund = application_fee x % remaining."
//     - Before program starts  -> 100% of Enrops fee refunded
//     - Mid-program            -> prorated to sessions remaining
//     - After program ends     -> 0% of Enrops fee refunded
//
// The point of the section is that this REPLACES a human judgement call:
// "This replaces any 'is this refund legit' judgment call with pure math off
// data we already store. Nothing here requires a human." So there is
// deliberately no reviewer, no override, and no discretion in this file.
//
// WHAT THIS DOES NOT TOUCH. The PARENT's refund amount. v4 section 2 again:
// "Parent's refund amount = whatever the operator's own stated cancellation
// policy promises. Never reduce it to cover Stripe's or Enrops' fees - card
// network rules prohibit shorting the cardholder." Proration applies ONLY to
// the application fee that comes back to the operator. Nothing here can ever
// lower what the family receives.
//
// HOW IT COMPOSES WITH THE MARGIN SPLIT. v4 says "application_fee x % remaining".
// On a DESTINATION charge our application fee is deliberately larger than our
// margin (margin + Stripe-fee uplift, see connectChargeParams.ts) and Stripe
// never returns its own processing fee, so the refundable base is the MARGIN,
// not the whole application fee - the split Jessica decided on 2026-07-25 and
// which _shared/refundFeeSplit.ts implements. On a DIRECT charge there is no
// uplift, so margin IS the whole application fee. Either way the base handed to
// this proration is "the part of our fee that is actually ours to give back",
// which is what v4 means by application_fee. See refundFeeSplit.ts.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

/** A date-only ISO string, yyyy-mm-dd. */
export type IsoDate = string;

/**
 * Today's date in a given IANA timezone, as yyyy-mm-dd.
 *
 * A bare new Date().toISOString() is UTC, which after 4-5pm Pacific has already
 * rolled over to tomorrow. On the boundary day that miscounts one session as
 * already delivered and quietly under-refunds the operator. Programs are local
 * events, so "has this session happened yet" is a local-date question.
 */
export function todayInTimezone(timezone: string | null | undefined, now: Date = new Date()): IsoDate {
  const tz = timezone || 'America/Los_Angeles';
  try {
    // en-CA formats as yyyy-mm-dd, which is exactly the shape we compare on.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // An unknown timezone string must never break a refund. Fall back to UTC.
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Fraction of the program still undelivered, 0..1, from the session dates.
 *
 * A session dated TODAY counts as remaining. The alternative (counting today as
 * delivered) would take the fee for a class the family may not have attended
 * yet on the day they cancelled, and every ambiguous case here should land on
 * the side of giving our fee back rather than keeping it.
 *
 * Returns 1 when there are no dates to reason about. That is deliberate: an
 * unknown schedule must not silently let Enrops KEEP a fee it cannot justify.
 * Fail generous, and let the caller log that it happened.
 */
export function sessionsRemainingFraction(sessionDates: IsoDate[], asOf: IsoDate): number {
  const dates = (sessionDates || []).filter((d) => typeof d === 'string' && d.length >= 10).sort();
  if (dates.length === 0) return 1;

  const remaining = dates.filter((d) => d.slice(0, 10) >= asOf).length;
  if (remaining === 0) return 0;            // program finished -> 0% per v4
  if (remaining === dates.length) return 1; // not started yet  -> 100% per v4
  return remaining / dates.length;
}

/**
 * Expand a camp's start/end dates + weekday list into the dates it actually
 * meets. Camps have no derive_program_session_dates() equivalent because they
 * are a contiguous block rather than a weekly series.
 *
 * class_days holds lowercase weekday names ('monday'..'friday'). When it is
 * null or empty, every day in the range counts - that is the widest reading and
 * therefore the one that refunds the most fee.
 */
export function campSessionDates(
  startsOn: IsoDate | null,
  endsOn: IsoDate | null,
  classDays: string[] | null,
): IsoDate[] {
  if (!startsOn) return [];
  const last = endsOn || startsOn;
  if (last < startsOn) return [];

  const wanted = new Set((classDays || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean));
  const NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  const out: IsoDate[] = [];
  // Iterate in UTC to avoid a local-timezone shift moving a date across midnight.
  const cursor = new Date(`${startsOn}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return [];

  // Camps are days-to-weeks; the cap is a runaway guard on bad data, not a limit
  // any real camp can reach.
  for (let i = 0; i < 400 && cursor.getTime() <= end.getTime(); i++) {
    const name = NAMES[cursor.getUTCDay()];
    if (wanted.size === 0 || wanted.has(name)) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export interface ProrationResult {
  /** 0..1, what v4 calls "% remaining". */
  fraction: number;
  /** Dates the proration was computed from; [] when unknown. */
  sessionDates: IsoDate[];
  /** The local date used as "the moment the refund is requested". */
  asOf: IsoDate;
  /**
   * How the schedule was resolved. 'unknown' means we could not find a schedule
   * and defaulted to a full refund of our fee - worth logging, never worth
   * blocking on.
   */
  source: 'program' | 'camp' | 'unknown';
}

interface ProrationRegistration {
  organization_id: string;
  program_id: string | null;
  camp_session_id: string | null;
}

type DbLike = SupabaseClient;

/**
 * Resolve the session-remaining fraction for one registration.
 *
 * Never throws and never returns null: a refund must not be blocked because a
 * schedule lookup failed. Every failure path lands on fraction 1 (refund our
 * whole margin), which is the pre-proration behaviour and the generous side.
 */
export async function loadProration(
  db: DbLike,
  reg: ProrationRegistration,
  now: Date = new Date(),
): Promise<ProrationResult> {
  let timezone: string | null = null;
  try {
    const { data } = await db.from('organizations').select('timezone').eq('id', reg.organization_id).maybeSingle();
    timezone = (data as { timezone?: string | null } | null)?.timezone ?? null;
  } catch {
    // fall through to the default timezone
  }
  const asOf = todayInTimezone(timezone, now);

  // Programs: derive_program_session_dates() already accounts for location
  // closures, district closures and early-release exceptions, and it handles
  // both schedule_mode 'count' and 'range' (both populate session_count).
  // Recomputing the weekly series here would drift from the operator's real
  // calendar the first time a closure was added.
  if (reg.program_id) {
    try {
      const { data, error } = await db.rpc('derive_program_session_dates', { p_program_id: reg.program_id });
      if (!error && Array.isArray(data) && data.length > 0) {
        const dates = (data as unknown[]).map((d) => String(d).slice(0, 10));
        return { fraction: sessionsRemainingFraction(dates, asOf), sessionDates: dates, asOf, source: 'program' };
      }
    } catch {
      // fall through to unknown
    }
    return { fraction: 1, sessionDates: [], asOf, source: 'unknown' };
  }

  if (reg.camp_session_id) {
    try {
      const { data } = await db
        .from('camp_sessions')
        .select('starts_on, ends_on, class_days')
        .eq('id', reg.camp_session_id)
        .maybeSingle();
      const camp = data as { starts_on?: string | null; ends_on?: string | null; class_days?: string[] | null } | null;
      if (camp?.starts_on) {
        const dates = campSessionDates(camp.starts_on, camp.ends_on ?? null, camp.class_days ?? null);
        if (dates.length > 0) {
          return { fraction: sessionsRemainingFraction(dates, asOf), sessionDates: dates, asOf, source: 'camp' };
        }
      }
    } catch {
      // fall through to unknown
    }
    return { fraction: 1, sessionDates: [], asOf, source: 'unknown' };
  }

  return { fraction: 1, sessionDates: [], asOf, source: 'unknown' };
}
