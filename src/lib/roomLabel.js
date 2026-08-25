// THE one rule for showing a room, for browser code. The Deno twin that edge
// functions import is supabase/functions/_shared/roomLabel.ts and must stay
// byte-identical in behaviour (same pattern as waiverText.js / waiverText.ts).
//
// WHY THIS EXISTS. A room lives in two columns:
//   programs.room                  - per CLASS, typed in the program editor
//   program_locations.room_number  - per SITE, typed in the location editor
// Every surface used to decide for itself which one to read and how to word it,
// so on 2026-08-25 the instructor portal showed a room on 4 of 32 open FA26
// classes while 15 had one typed on the class, the roster email preferred the
// class, the offer emails read only the site, and three of them printed
// "Room Room 111". Jessica: "can't you just make all the places the room shows
// draw from one place so they're all the same?"
//
// THE CLASS WINS, and Happy Valley Library is why rather than being a data bug:
// one site row serves 6 summer camp sessions AND 3 after-school classes, so its
// room_number holds the SUMMER room ("Community Room B") while the after-school
// class carries "Community Room A". Camps read only the site row, so both values
// are correct for their own audience and neither can be deleted. Preferring the
// class is what lets each audience see its own room.
//
// THE WORDING. Real J2S values today: "9", "203", "C102", "Room 111",
// "Makerspace", "Stage", "Kindy Tables", "Community Room A", "Kindergarten
// room", "Computer Lab". Callers used to write `Room ${value}` themselves, which
// produced "Room Room 111" and "Room Stage". A value STARTING WITH A DIGIT is a
// bare number and gets the word; anything that already names a place is printed
// as the operator typed it. Callers must never add the word back - that is the
// whole point of returning a finished label.
//
// KNOWN LIMIT of that heuristic, so nobody reads more into it than it does: a
// value that starts with a digit AND already names a place - "2nd floor lounge",
// "3rd grade classroom" - comes back as "Room 2nd floor lounge". No prod value
// looks like that today (checked 2026-08-25, all 32 open FA26 classes), and the
// only honest fix is an explicit per-value choice rather than a cleverer regex.
//
// CAMPS: their PRECEDENCE is untouched - camp_sessions has no room column, so a
// camp caller passes null as classRoom and still shows the site room (Jessica,
// 2026-08-25: "don't worry about camps they're over and we'll fix later"). But
// the camp surfaces that DO go through here now get this WORDING, which is not
// the same as untouched: the instructor portal's camp detail, the camp sub email
// and the camp branch of offer-reminders-cron lost their hardcoded "Room "
// prefix, while email-camp-roster, send-offers, send-patch-offer and
// Schedule.jsx still write it themselves. So camp surfaces currently disagree
// with each other on wording. Deliberate and low-stakes while camps are dormant;
// finish it when camps come back, with the locations/programs unification.

export function roomDisplay(classRoom, siteRoom) {
  const room = String(classRoom ?? "").trim() || String(siteRoom ?? "").trim();
  if (!room) return null;
  return /^\d/.test(room) ? `Room ${room}` : room;
}
