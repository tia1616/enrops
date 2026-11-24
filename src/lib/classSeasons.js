// Which season a weekly class is filed under, and whether families can buy it.
//
// ONE rule, read by every surface that asks "can families buy this class?": the
// family page, the share links, the class builder's done screen, the Programs
// page banner, the registration-questions picker, the instructor portal's
// past/current split, (Deno copy) the marketing email links, and checkout
// (create-registration refuses a class past its last session).
//
// A weekly class is on sale when BOTH hold (isClassOnSale):
//   1. its season is on sale (isTermOnSale, below), and
//   2. it has not finished: today is on or before its LAST SESSION
//      (Jessica 2026-11-24). This is the per-class registration window other
//      platforms use (Sawyer's "Open Registration", Jackrabbit enrolling after
//      the start date): a running class keeps selling until it ends, and the
//      provider can Unpublish to stop it sooner.
//
// Which seasons are on sale is CONFIG (organizations.classes_follow_dates,
// migration 20261123d), never tenant:
//
//   classes_follow_dates = true  (every self-serve signup)
//     A class is filed under the season of its FIRST meeting day. Any season up
//     to three after the open one is on sale, INCLUDING earlier seasons, so a
//     Fall class still running in December stays on sale until its last
//     session. The open season moves forward on its own every night.
//
//   classes_follow_dates = false (school-year providers: J2S, Ukulele, ...)
//     Classes are filed under the open season and only that season is on sale,
//     until the provider switches it on Programs. Rule 2 still applies, so a
//     finished class in the open season drops off. Moving these providers to
//     classes_follow_dates later is a settings change, not new code.
//
// Pure (no supabase import), so the repo's plain-node test runner can load it.
import { campTermForDate } from "./programSchedule.js";

const SEASONS = ["WI", "SP", "SU", "FA"];
const TERM_RE = /^(WI|SP|SU|FA)(\d{2})$/;

// How many seasons AFTER the open one are also on sale for a date-following org:
// a year ahead, so a class built in the fall for next summer is buyable.
export const SEASONS_AHEAD = 3;

// "FA26" -> 107; same ordering as SQL term_ordinal(). null for a non-season code.
export function termOrdinal(term) {
  const m = typeof term === "string" ? TERM_RE.exec(term.trim()) : null;
  if (!m) return null;
  return Number(m[2]) * 4 + SEASONS.indexOf(m[1]);
}

// "FA26" -> "WI27". null for a non-season code.
export function nextTerm(term) {
  const n = termOrdinal(term);
  if (n === null) return null;
  const next = n + 1;
  return `${SEASONS[next % 4]}${String(Math.floor(next / 4) % 100).padStart(2, "0")}`;
}

export function followsDates(org) {
  return org?.classes_follow_dates === true;
}

// Is this weekly class's season on sale? (Camps are sold by their dates and are
// not asked here; callers keep their isCampProgram branch.)
//
// Date-following: any season up to SEASONS_AHEAD after the open one, earlier
// seasons included (whether an earlier class is still running is rule 2's job,
// isClassOnSale). Season-switching: the open season only.
export function isTermOnSale(org, term) {
  const open = org?.active_registration_term;
  if (!term || !open) return false;
  if (!followsDates(org)) return term === open;
  const o = termOrdinal(open);
  const t = termOrdinal(term);
  if (o === null || t === null) return term === open;
  return t <= o + SEASONS_AHEAD;
}

// Can families buy this weekly class today? Its season is on sale AND it has
// not finished. lastSessionIso comes from class_last_sessions (20261124c); when
// it is unknown (no dates yet, or that read failed) only the season decides,
// which is exactly the behaviour before the last-session rule existed.
export function isClassOnSale(org, program, lastSessionIso, todayIso) {
  if (!isTermOnSale(org, program?.term)) return false;
  if (!lastSessionIso || !todayIso) return true;
  return String(lastSessionIso).slice(0, 10) >= String(todayIso).slice(0, 10);
}

// The season a weekly class is filed under. For a date-following org, the season
// of its first meeting day, always, with no clamp to the open season: the
// builder also re-saves EXISTING classes, and a clamp would silently move a
// September class into Winter the first time it was edited in December.
// Otherwise the open season, as before.
export function classTermFor(org, firstMeetingIso) {
  const open = org?.active_registration_term ?? null;
  if (!followsDates(org)) return open;
  return campTermForDate(firstMeetingIso) || open;
}

// Has this class's season already ended? A LATER season is never "past" (an
// instructor's Winter class is upcoming during Fall, not history).
export function isPastTerm(org, term) {
  const o = termOrdinal(org?.active_registration_term);
  const t = termOrdinal(term);
  if (o === null || t === null) return false;
  return t < o;
}
