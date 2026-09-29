// Who counts as a CLASS for an automation, and who counts as a CAMP.
//
// Since 2026-09-25 a camp is a PROGRAM with class_days set, not a camp_sessions
// row. That means every camp registration also satisfies `program_id is not
// null`, so the class-only automations (welcome_afterschool, check_in,
// partner_roster) silently started including camps and nobody chose that.
//
// These two helpers exist so the rule is applied the SAME way in all five
// places, and so the exclusion can be tested without a database. The decision
// itself is delegated to isCampProgram — the one definition, shared with the
// no-school resolver and matching the SQL session walk. Deliberately NOT a SQL
// filter on class_days: `class_days = '{}'` passes CHECK programs_class_days_valid
// (array_length of an empty array is NULL, and a CHECK passes on NULL), and such
// a row is a CLASS to isCampProgram but would be a CAMP to `class_days IS NULL`.
//
// The failure these guard against is not subtle: a 3-day camp getting a
// "how are the first two weeks going?" note 11 days after it ended, and a camp
// roster emailed to a school that has nothing to do with it.
import { isCampProgram } from "./noSchoolDates.ts";

/** A row shaped like `programs` — only class_days is read. */
export type ProgramLike = { class_days?: unknown } | null | undefined;

/** A registration row with its joined program, as the resolvers select it. */
export type RegistrationLike = { programs?: ProgramLike } | null | undefined;

/**
 * Program rows that are CLASSES. Used by both partner_roster phases, which
 * query `programs` directly.
 */
export function classProgramsOnly<T extends ProgramLike>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((p) => !isCampProgram(p as { class_days?: unknown }));
}

/**
 * Registration rows whose joined program is a CLASS. Used by the after-school
 * welcome and the check-in, which query `registrations` with `programs!inner`.
 */
export function classRegistrationsOnly<T extends RegistrationLike>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((r) => !isCampProgram(r?.programs as { class_days?: unknown }));
}

/**
 * Registration rows whose joined program is a CAMP. The exact complement of
 * classRegistrationsOnly, so the two audiences can never overlap and can never
 * both miss a family.
 */
export function campRegistrationsOnly<T extends RegistrationLike>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((r) => isCampProgram(r?.programs as { class_days?: unknown }));
}
