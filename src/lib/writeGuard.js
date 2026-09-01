// A write that changed NOTHING must never report success.
//
// WHY THIS EXISTS. On 2026-09-01 a `viewer` at J2S could open a child on Class
// rosters, edit a field, click Save, and watch it say "SAVED" while the database
// was untouched. Two things had to be true at once, and both were:
//
//   1. The "View / Edit" button had no role gate, so a viewer could reach the
//      form (Refund and Remove beside it were gated; this one was not).
//   2. The save did `.update(...).eq("id", id)` and checked only `if (error)`.
//
// The second is the one that matters, and it is not obvious: when RLS refuses an
// UPDATE it does not raise an error. The row simply falls outside the policy's
// USING clause, Postgres updates ZERO rows, and PostgREST returns 204 with no
// error at all. Every `if (error) throw error` write therefore takes the happy
// path and reports success. `students` and `registrations` are gated on
// `can_edit_org` = owner/admin/staff, so for a viewer that is exactly what
// happened - a silent no-op, announced as a save.
//
// This is a CLASS, not an incident: 110 update/upsert calls under src/ report
// success without proving a row was affected. It bites wherever a role can
// REACH a control that RLS will refuse - so fixing the reachability alone leaves
// the same lie armed for the next role, the next policy edit, or a cross-tenant
// id. New write paths should come through here.
//
// HOW. Ask the write to hand back what it changed (`.select("id")`) and treat an
// empty array as a refusal. An UPDATE matching a row returns that row even when
// no value actually differs, so this does not misfire on a no-op save - only on
// a write that touched nothing at all.
//
//   requireWritten(
//     await supabase.from("students").update(fields).eq("id", s.id).select("id"),
//     "this student's details",
//   );
//
// NOT a permission check. It is the LAST line of defence, deliberately after the
// UI gate rather than instead of it: a viewer should never see an armed Save
// button in the first place (that is the caller's job), and this is what catches
// the case nobody predicted.

// Thrown when a write completed without touching a row. Carries `refused` so a
// caller can word its own message; the default text is safe to show a person.
export class WriteRefusedError extends Error {
  constructor(what) {
    super(
      `Nothing was saved${what ? ` to ${what}` : ""}. You may not have permission ` +
      `to change this, or it may have been removed.`,
    );
    this.name = "WriteRefusedError";
    this.refused = true;
    this.what = what ?? null;
  }
}

// Pass the AWAITED result of a supabase write that ends in `.select(...)`.
// Re-throws a real PostgREST error unchanged (callers already handle those), and
// throws WriteRefusedError when the write matched no rows. Returns the rows so
// this can wrap a write whose result the caller still needs.
export function requireWritten(result, what) {
  const { data, error } = result ?? {};
  if (error) throw error;
  // `data` is an array for .select() without .single(). A null/undefined data
  // with no error means the select was omitted - that is a programming error
  // here, and treating it as success would restore the exact bug this prevents.
  if (!Array.isArray(data) || data.length === 0) throw new WriteRefusedError(what);
  return data;
}

// True for the error this module throws, so a catch block can tell "you were
// refused" apart from "the network fell over" without string-matching a message.
export function isWriteRefused(e) {
  return !!e && e.refused === true;
}
