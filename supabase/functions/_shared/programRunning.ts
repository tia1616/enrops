// Is an after-school program actually happening? One place, because FIVE
// different writers touch session_delivery_confirmations, four of them need
// this answer, and not one of them had it.
//
// WHY THIS EXISTS. derive_program_session_schedule() walks a program's weekly
// cadence from first_session_date, minus school/district closures, and knows
// NOTHING about programs.status. It returns sessions for a cancelled class
// exactly as it does for a live one - verified against prod on 2026-09-07: the
// cancelled Astor Monday program (d9b4d378) still returned 2026-09-14, 09-21,
// 09-28, 10-05. Every writer below treated that RPC (or nothing at all) as its
// "does this class meet" check, so a cancelled class kept generating
// confirmation rows, and an admin's "Confirm & pay" would turn one into real
// money for a class nobody ever taught.
//
// THE RPC IS NOT THE PLACE TO FIX IT. Seven callers depend on it, including the
// PARENT dashboard and the Stripe receipt + calendar-invite path, which
// legitimately want the dates a cancelled class WAS going to meet ("your
// Monday class was 9/14-11/9"). Narrowing the RPC would change parent-facing
// output to fix an instructor-pay bug. So the guard lives at the writers, and
// the status lists live here so there is one spelling of the rule.
//
// programs_status_check (identical on prod + staging, read back 2026-09-07):
//   draft | open | closed | cancelled
//
//   open      RUNNING. Enrolling, meets weekly.
//   closed    RUNNING. Enrollment shut, the class STILL MEETS. Nothing writes
//             this status today (0 rows on prod), so this is a forward-looking
//             call, and it is deliberately the same call the instructor portal
//             already makes: InstructorPortal.jsx excludes only cancelled and
//             draft, so a closed class renders its card AND its check-in. If
//             the money path disagreed, an instructor would mark a closed class
//             taught and then never be payable for it.
//   cancelled NOT RUNNING. Does not meet. This is the bug above.
//   draft     NOT RUNNING. Not published; no family can enrol and no
//             instructor has been sent it.
//
// UNKNOWN is a status the constraint does not have yet, and the two kinds of
// caller must treat it DIFFERENTLY, which is why this returns a state rather
// than a boolean:
//   - the seeder (session-confirmation-cron) is PERMISSIVE on unknown: refusing
//     to seed would silently drop a real class's session off Payroll, and the
//     existing note in that function warns about exactly that. It seeds and
//     records the surprise in its error summary.
//   - the three money writers are FAIL-CLOSED on unknown: a status nobody has
//     reasoned about must not become approved pay on its own.
//
// WHO USES THIS, AND WHO DELIBERATELY DOES NOT:
//   session-confirmation-cron  guards (seeds no row for a class that does not meet)
//   admin-confirm-session      guards (never turns an unclaimed day into pay)
//   confirm-session-taught     guards (an instructor cannot mark a dead class taught)
//   confirm-session-delivery   guards. THERE ARE TWO instructor self-confirm
//     endpoints, not one, and the first draft of this fix only guarded the
//     other. confirm-session-taught takes an assignment + a date; this one
//     takes an existing pending confirmation id and flips it to 'self'. A row
//     seeded this morning for a class cancelled this afternoon lives exactly
//     there, so the seeder's guard does not cover it.
//   confirm-sub-delivery       DOES NOT GUARD, on purpose. A row in
//     assignment_substitutions with status confirmed/taught exists only because
//     a human accepted a specific date and covered it. That IS "a sub taught
//     it". Cancelling the class later must not retroactively deny that sub
//     their pay, and the phantom this module exists to stop cannot reach that
//     path: a class that never met has nobody offered a sub slot on it. The
//     asymmetry is the point - the guarded writers refuse days NOBODY claims to
//     have taught, this one pays a day somebody did.

// Pinned to 2.39.0 to match every calling function and the other _shared
// modules. An unpinned @2 resolves to a different build whose SupabaseClient is
// a structurally different type, so every caller fails to type-check.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export const RUNNING_PROGRAM_STATUSES = ['open', 'closed'] as const;
export const NOT_RUNNING_PROGRAM_STATUSES = ['cancelled', 'draft'] as const;

export type ProgramRunState =
  | 'running'      // the class meets; a session on it can become pay
  | 'not_running'  // cancelled or draft; nothing about it may become pay
  | 'unknown'      // a status not in programs_status_check as of 2026-09-07
  | 'missing';     // no such program row

/**
 * Pure classifier, so the rule can be unit-tested without a database.
 * `null`/`undefined` means "the row had no status", which is not the same as a
 * missing row - callers that fetched nothing report 'missing' themselves.
 */
export function classifyProgramStatus(status: string | null | undefined): ProgramRunState {
  if (status == null) return 'unknown';
  if ((RUNNING_PROGRAM_STATUSES as readonly string[]).includes(status)) return 'running';
  if ((NOT_RUNNING_PROGRAM_STATUSES as readonly string[]).includes(status)) return 'not_running';
  return 'unknown';
}

/**
 * Batch lookup: program_id -> run state. One query however many ids, because
 * the cron asks about every assignment it holds.
 *
 * On a query error this returns `error` set and an EMPTY map - it does not
 * guess. The caller decides what a failed lookup means for it (the money path
 * refuses; the cron records the error).
 */
export async function fetchProgramRunStates(
  supabase: SupabaseClient,
  programIds: string[],
): Promise<{ states: Map<string, ProgramRunState>; statuses: Map<string, string | null>; error: string | null }> {
  const states = new Map<string, ProgramRunState>();
  const statuses = new Map<string, string | null>();
  const ids = [...new Set(programIds.filter(Boolean))];
  if (ids.length === 0) return { states, statuses, error: null };

  const { data, error } = await supabase
    .from('programs')
    .select('id, status')
    .in('id', ids);
  if (error) return { states, statuses, error: error.message };

  for (const row of (data ?? []) as Array<{ id: string; status: string | null }>) {
    states.set(row.id, classifyProgramStatus(row.status));
    statuses.set(row.id, row.status ?? null);
  }
  // An id the query did not return has no program row at all.
  for (const id of ids) {
    if (!states.has(id)) {
      states.set(id, 'missing');
      statuses.set(id, null);
    }
  }
  return { states, statuses, error: null };
}

/**
 * Single-program convenience for the three money writers. `state` is what to
 * branch on; `status` is for the error payload / log line, so an operator sees
 * WHY a confirmation was refused instead of a bare code.
 */
export async function fetchProgramRunState(
  supabase: SupabaseClient,
  programId: string,
): Promise<{ state: ProgramRunState; status: string | null; error: string | null }> {
  const { states, statuses, error } = await fetchProgramRunStates(supabase, [programId]);
  if (error) return { state: 'unknown', status: null, error };
  return {
    state: states.get(programId) ?? 'missing',
    status: statuses.get(programId) ?? null,
    error: null,
  };
}

/**
 * The money-path rule in one place: only a class that is definitely running
 * may turn into a pay line. Fail-closed on unknown, missing, and lookup errors.
 */
export function mayBecomePay(state: ProgramRunState): boolean {
  return state === 'running';
}
