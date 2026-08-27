// Display helpers for instructor names.
//
// Rule of thumb: anywhere a human reads an instructor's name day-to-day —
// schedule, emails, internal admin UI — use preferred_name when populated,
// else fall back to first_name. Legal surfaces (contractor agreement,
// tax forms) keep using first_name + last_name directly.
//
// Example: Rebecca / Bo — first_name='Rebecca', preferred_name='Bo'. The
// schedule and offer emails should say "Bo"; the signed agreement says
// "Rebecca". One column, two contexts.

// What to STORE in preferred_name, given what someone typed.
//
// Returns '' for anything that is not actually a different name, so the column
// holds a preference or nothing at all — never a copy of the legal first name.
//
// Why this exists: Jeff's team onboarded on 2026-08-26 and reported that the
// nickname "automatically" became the legal name. It is not automatic — nothing
// in this codebase copies one field to the other, and of the 9 they created that
// day, 6 left it blank. What happens is that the question reads as "what is
// your name?", so someone called Lana answers "Lana". That is a correct answer
// to the question as it was asked, which is why the wording changed too.
//
// Storing first_name here is a no-op for the GREETING — displayFirstName returns
// the same string either way — so normalising costs nothing where it matters and
// makes the box mean one thing: "I go by something else". Existing rows heal on
// their owner's next save.
//
// IT IS NOT A NO-OP EVERYWHERE, and the earlier version of this comment said it
// was. Found by reviewing the three builds as one release, 2026-08-27. The rule
// is hand-spelled ~35 times across the app in two different shapes:
//
//   shape 1  (preferred || first) + last     -> clearing changes nothing
//   shape 2  preferred ALONE, else first+last -> clearing changes the string
//
// Shape 2 lives on five ADMIN surfaces — InstructorsTab, AssignSubModal, Payroll,
// ClassReports, AudienceContacts — where a cleared row goes from "Avery" to
// "Avery Flores". That is fuller, not worse, and Payroll in particular wants the
// full name, so it is accepted rather than fixed. But it is a real visible change
// on six production rows and the invariant test below cannot see it: that test
// pins displayFirstName and displayFullName only, which is the scope the
// guarantee actually holds for.
//
// The 35 spellings are the underlying problem — one rule, one place — and that is
// its own cleanup, on the board rather than in this change.
//
// SPACE-insensitive but CASE-SENSITIVE, and the case half is not fussiness.
//
// The guarantee that makes clearing this column safe is that it changes nothing
// anybody reads — displayFirstName returns the same string before and after. A
// case-insensitive match breaks that guarantee: clearing preferred_name 'zach'
// against first_name 'Zach' silently re-capitalises someone who typed their own
// name in lower case on purpose, which is a rename, not a clean-up. The first
// draft here was case-insensitive and the invariant test in
// instructorName.test.mjs caught it.
//
// Trim-insensitivity is safe by contrast, because displayFirstName already
// trims before it uses the value, so ' Chelsea ' and 'Chelsea' read identically.
//
// The narrower rule still clears every row this was written for. Queried on
// production 2026-08-27: SIX rows carry a preferred name equal to the legal
// first name — Lana and Zach at The Ukulele Project, Austyn, Chelsea, Rose and
// Zeke at Journey to STEAM — and all six are exact matches after trimming, so
// none of them survives the case-sensitive rule. (An earlier draft of this
// comment said five; it came from a query that filtered on is_active and
// dropped Austyn.)
export function normalizePreferredName(preferred, firstName) {
  const p = typeof preferred === 'string' ? preferred.trim() : '';
  if (!p) return '';
  const f = typeof firstName === 'string' ? firstName.trim() : '';
  if (f && p === f) return '';
  return p;
}

export function displayFirstName(instructor, fallback = 'there') {
  if (!instructor) return fallback;
  const preferred = instructor.preferred_name?.trim?.();
  if (preferred) return preferred;
  return instructor.first_name || fallback;
}

export function displayFullName(instructor) {
  if (!instructor) return '';
  const first = displayFirstName(instructor, '');
  const last = instructor.last_name || '';
  return `${first} ${last}`.trim();
}
