// Deno twin of src/lib/roomLabel.js. Same rule, same wording, same precedence -
// the full reasoning lives in that file and is not duplicated here beyond the
// two lines that matter. Keep the behaviour identical; a divergence between these
// two is the exact bug the module exists to end (same arrangement as
// waiverText.js / waiverText.ts).
//
//   1. The CLASS room wins over the SITE room (Happy Valley Library's site row
//      holds the summer camp room, the after-school class holds its own).
//   2. A value starting with a digit gets the word "Room"; a value that already
//      names a place ("Makerspace", "Room 111") is printed as typed. Callers
//      must NOT add the word themselves.
//
// Camps keep the site-room PRECEDENCE (they have no class room), but the camp
// surfaces that call through here do take this WORDING - see the "CAMPS" note in
// the .js twin, which lists which camp surfaces moved and which did not.

export function roomDisplay(
  classRoom: string | null | undefined,
  siteRoom: string | null | undefined,
): string | null {
  const room = String(classRoom ?? "").trim() || String(siteRoom ?? "").trim();
  if (!room) return null;
  return /^\d/.test(room) ? `Room ${room}` : room;
}

// WHERE THE CLASS MEETS, as one string - see the .js twin for the full reasoning.
// Takes the three RAW values rather than a finished room label so that no caller
// can forget the class-beats-site precedence. Either half may be missing; both
// absent is null, so one test decides whether to print anything.
export function venueLabel(
  siteName: string | null | undefined,
  classRoom: string | null | undefined,
  siteRoom: string | null | undefined,
): string | null {
  const site = String(siteName ?? "").trim();
  return [site, roomDisplay(classRoom, siteRoom)].filter(Boolean).join(" · ") || null;
}
