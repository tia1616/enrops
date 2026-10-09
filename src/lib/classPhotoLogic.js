// The pure rules behind class photos, kept apart from classPhotos.js (which talks
// to Supabase) so they can be tested by importing them directly.

/** The class day as YYYY-MM-DD in the viewer's local zone (matches the portal's todayLocalISO). */
export function todayLocalISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The children in a class the instructor must keep OUT of the frame.
 *
 * ONLY A RECORDED YES IS PERMISSION. `photo_release_consent` is nullable: on prod
 * 56 confirmed registrations hold null (rostered in by hand, never asked) beside 7
 * confirmed explicit refusals. Treating null as "fine" would put a child nobody
 * ever asked in a photo every family can see, so everything that is not exactly
 * true is listed. Rows are the same registrations RosterSection loads; callers
 * pass them through isOnRoster first so a cancelled child is not listed.
 */
export function childrenWithoutPhotoPermission(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r?.photo_release_consent === true) continue;
    const s = r?.student;
    const name = [s?.first_name, s?.last_name].filter(Boolean).join(" ").trim();
    if (!name) continue;
    out.push({ id: s?.id ?? r?.id, name, declined: r?.photo_release_consent === false });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const UPLOAD_ERRORS = {
  class_photos_off: "Class photos are switched off for your organization.",
  not_allowed_for_this_class: "You are not set up to take photos for this class on this day.",
  class_day_not_happened: "That class day hasn't happened yet.",
  not_a_jpeg: "That file isn't a photo we can use.",
  image_unreadable: "That photo couldn't be read. Try taking it again.",
  file_too_large: "That photo is too large.",
  not_found: "That class couldn't be found.",
};

export function uploadErrorMessage(code) {
  return UPLOAD_ERRORS[code] || "That photo didn't upload. Check your connection and try again.";
}

/** Group rows by class day, newest first, for the family gallery. */
export function groupByDay(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!map.has(r.session_date)) map.set(r.session_date, []);
    map.get(r.session_date).push(r);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, photos]) => ({ date, photos }));
}
