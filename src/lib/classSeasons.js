// Which season a weekly class is filed under, and which seasons are on sale.
//
// ONE rule, read by every surface that asks "can families buy this class?": the
// family page, the share links, the class builder's done screen, the Programs
// page banner, the registration-questions picker, the instructor portal's
// past/current split and (Deno copy) the marketing email links.
//
// Two kinds of provider, chosen by CONFIG (organizations.classes_follow_dates,
// migration 20261123d), never by tenant:
//
//   classes_follow_dates = true  (every self-serve signup)
//     A class is filed under the season of its FIRST meeting day, and families
//     can buy classes from the open season and the three after it. The open
//     season moves forward on its own every night. Nobody switches anything.
//     This is the fix for "a January class was filed and shown as Fall 2026".
//
//   classes_follow_dates = false (school-year providers: J2S, Ukulele, ...)
//     Exactly as before: classes are filed under the open season and only that
//     season is on sale, until the provider switches it on Programs.
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

// The seasons whose weekly classes families can buy right now.
export function onSaleTerms(org) {
  const open = org?.active_registration_term;
  if (!open) return [];
  if (!followsDates(org)) return [open];
  const out = [open];
  let t = open;
  for (let i = 0; i < SEASONS_AHEAD; i += 1) {
    t = nextTerm(t);
    if (!t) break;
    out.push(t);
  }
  return out;
}

// Is this weekly class's season on sale? (Camps are sold by their dates and are
// not asked here; callers keep their isCampProgram branch.)
export function isTermOnSale(org, term) {
  return !!term && onSaleTerms(org).includes(term);
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
