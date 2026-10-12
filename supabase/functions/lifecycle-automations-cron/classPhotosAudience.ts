// Who gets the "New class photos" email, and about which day. Pure, so it is
// tested without a database (classPhotosAudience.test.ts).
//
// THE DAY IS THE UPLOAD DAY, in the provider's timezone - not the class day the
// photo is filed against. An instructor who files Wednesday's photos on Friday has
// shared new photos on Friday, and Friday is when the family has something new to
// look at.
//
// ONLY CLOSED DAYS. The daily run emails about days that have ENDED (yesterday and
// a short look-back), never today: ten photos taken across an afternoon become one
// email the next morning instead of an email for the first photo and silence for
// the other nine (the ledger's one-send-per-key rule would swallow them).
//
// THE LOOK-BACK covers a missed or failed daily run. The context key carries the
// day, so a day already emailed is never emailed again however often it is seen.

import { addDays, orgToday } from "./welcomeWindow.ts";

export const PHOTO_LOOKBACK_DAYS = 3;

export interface PhotoRow { program_id: string; created_at: string }
export interface PhotoDay { programId: string; day: string; count: number }

/** YYYY-MM-DD of an instant in a timezone - orgToday, applied to that instant. */
export function localDay(iso: string, timezone: string | null | undefined): string {
  return orgToday(timezone, new Date(iso));
}

/**
 * Class + upload-day pairs worth an email: days from (today - lookback) up to and
 * including yesterday, in the provider's timezone. Today is excluded on purpose.
 */
export function photoDaysToNotify(
  photos: PhotoRow[],
  timezone: string | null | undefined,
  today: string,
  lookbackDays = PHOTO_LOOKBACK_DAYS,
  // The local day the provider's email was (last) switched on. Days before it
  // are never emailed about: a provider who switches it back on after a week off
  // must not mail families about photos from while it was off, and the very
  // first run does not reach back over days before the email existed.
  enabledDay: string | null = null,
): PhotoDay[] {
  const lookbackStart = addDays(today, -lookbackDays);
  const earliest = enabledDay && enabledDay > lookbackStart ? enabledDay : lookbackStart;
  const byKey = new Map<string, PhotoDay>();
  for (const p of photos) {
    if (!p?.program_id || !p?.created_at) continue;
    const day = localDay(p.created_at, timezone);
    if (day < earliest || day >= today) continue;
    const key = `${p.program_id}|${day}`;
    const cur = byKey.get(key) ?? { programId: p.program_id, day, count: 0 };
    cur.count += 1;
    byKey.set(key, cur);
  }
  return [...byKey.values()].sort((a, b) => (a.day + a.programId).localeCompare(b.day + b.programId));
}

export interface EnrolledReg {
  program_id: string;
  parent_id: string;
  parent_email: string | null;
  parent_first_name: string | null;
  child_first_name: string | null;
  program_name: string | null;
}

export interface ClassPhotoRecipient {
  context_key: string;
  program_id: string;
  day: string;
  photo_count: number;
  parent_id: string;
  parent_email: string;
  parent_first_name: string | null;
  child_first_names: string[];
  program_name: string;
}

export function classPhotoContextKey(programId: string, day: string, parentId: string): string {
  return `class_photos:program:${programId}:day:${day}:parent:${parentId}`;
}

/**
 * One recipient per family per class per upload day. Siblings in the same class
 * are ONE email naming both children; a family with children in two classes that
 * both shared photos gets one email per class (each links to the same tab, but
 * each names its own class). Grouped by PARENT ID, never by email address, so two
 * households sharing an address are still two families.
 */
export function classPhotoRecipients(days: PhotoDay[], regs: EnrolledReg[]): ClassPhotoRecipient[] {
  const regsByProgram = new Map<string, EnrolledReg[]>();
  for (const r of regs) {
    if (!r?.parent_id || !r.parent_email?.includes("@")) continue;
    // A roster import with no real address stores a placeholder ending in
    // @import.local - the same rule program_message_recipients flags as
    // 'placeholder_email'. Never mail it; this email goes out by default.
    if (r.parent_email.trim().toLowerCase().endsWith("@import.local")) continue;
    const list = regsByProgram.get(r.program_id) ?? [];
    list.push(r);
    regsByProgram.set(r.program_id, list);
  }
  const out: ClassPhotoRecipient[] = [];
  for (const d of days) {
    const byParent = new Map<string, ClassPhotoRecipient>();
    for (const r of regsByProgram.get(d.programId) ?? []) {
      const key = classPhotoContextKey(d.programId, d.day, r.parent_id);
      let rec = byParent.get(key);
      if (!rec) {
        rec = {
          context_key: key,
          program_id: d.programId,
          day: d.day,
          photo_count: d.count,
          parent_id: r.parent_id,
          parent_email: r.parent_email!,
          parent_first_name: r.parent_first_name,
          child_first_names: [],
          // "their class" reads naturally in "shared new photos from {{program_name}}".
          program_name: r.program_name || "their class",
        };
        byParent.set(key, rec);
      }
      const kid = r.child_first_name?.trim();
      if (kid && !rec.child_first_names.includes(kid)) rec.child_first_names.push(kid);
    }
    out.push(...byParent.values());
  }
  return out;
}
