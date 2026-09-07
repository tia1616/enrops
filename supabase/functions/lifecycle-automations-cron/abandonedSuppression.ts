// abandonedSuppression.ts — which stale `pending` registrations are REALLY abandoned.
//
// A pending row is not proof of an abandoned signup. A parent who drops off at
// checkout and then comes back and registers properly leaves the first attempt
// behind as a permanent `pending` row: nothing reconciles it. The abandoned
// automation read those rows literally and told paid families they never signed
// up. On 2026-09-07 a Ukulele parent emailed the founder asking whether her
// daughter was actually enrolled. She was, and had paid, and we had emailed her
// "you almost signed up, want to finish?" thirteen minutes after her payment
// cleared (paid 14:47:04Z, mailed 15:00:28Z). Three families on prod had been
// told this, one of them J2S's own.
//
// The rule this module implements: a pending row is abandoned only if the SAME
// PARENT has not already reached an outcome for the SAME OFFERING with the SAME
// CHILD.
//
// Why "any non-pending status" counts as an outcome — confirmed, waitlist and
// cancelled all mean this parent got a real answer for that offering rather
// than trailing off at checkout, and "you almost signed up" is false for all
// three. Only `pending` is an unfinished attempt.
//
// KNOWN COST of including `cancelled`: a parent who cancels and MUCH later
// starts a fresh registration for the same child and offering, then abandons
// that one, is never nudged — the old cancelled row suppresses the new attempt
// forever. Accepted deliberately. The obvious sharpening, "only suppress when
// the outcome post-dates the pending row", trades this quiet missed nudge for
// the loud failure we are fixing: a parent already enrolled who re-opens the
// registration form leaves a NEWER pending row behind, and would be told they
// never signed up. Silence is the cheaper error.
//
// Why PER CHILD and not per parent — a family that enrols one sibling and
// genuinely abandons the other still deserves the nudge for the one they
// dropped. Suppressing at parent level would silently eat that.
//
// Why the child's NAME and not student_id — the duplicate row IS the problem.
// Each abandoned attempt mints its own students row, so the confirmed
// registration points at a different student_id for the same real child (Molly
// Ackley exists twice on the Ukulele Project roster). Matching on student_id
// would therefore fail on precisely the case this module exists to fix. Within
// one parent and one offering a first name is a sufficient discriminator, and
// siblings sharing one is not a real case.
//
// Direction of failure is deliberate throughout: where identity is unclear this
// module suppresses rather than sends. Sending is the irreversible half, and a
// wrongly-sent "you never finished" to a family that paid is the exact damage
// it exists to prevent. A missed recovery nudge is a lost marketing touch.

/**
 * Which offering a registration is for, namespaced so a program id and a camp
 * session id can never compare equal.
 *
 * Reads BOTH row shapes the cron uses: the audience query embeds
 * `programs(id)` / `camp_sessions(id)`, while the cheap lookup query selects
 * the scalar `program_id` / `camp_session_id` columns. Returns null for a
 * registration attached to neither, which must never match anything.
 */
export function offeringIdOf(row: any): string | null {
  const programId = row?.program_id ?? row?.programs?.id ?? null;
  if (programId) return `program:${programId}`;
  const campId = row?.camp_session_id ?? row?.camp_sessions?.id ?? null;
  if (campId) return `camp:${campId}`;
  return null;
}

/**
 * Fold a child's name to a comparable form.
 *
 * Trimming is what carries the case this fix was written for: the registration
 * form stored one spelling of the child as "Molly " and the other as "Molly".
 *
 * The internal collapse is for multi-word first names ("Mary  Jo"), where the
 * same slip lands in the middle and trimming alone would not catch it. It is
 * also why this matches on the FIRST name alone rather than first+last: fold
 * "Molly " into "Molly  Ackley" and the doubled space moves inside, where a
 * trim-only comparison misses it. Collapsing means neither spelling can drift.
 *
 * Returns null when nothing is left, so callers can tell "no name on file"
 * apart from a real name instead of matching everyone on "".
 */
export function normalizeChildName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const folded = name.trim().toLowerCase().replace(/\s+/g, " ");
  return folded.length > 0 ? folded : null;
}

/** Lookup built from a parent's already-resolved registrations. */
export interface ResolvedIndex {
  /** `parentId|offering|childFirstName` — the precise answer. */
  byChild: Set<string>;
  /** `parentId|offering` — the fallback when a child cannot be named. */
  byParent: Set<string>;
}

/**
 * Index every non-pending registration these parents already hold. Rows with no
 * identifiable offering are skipped: they cannot match a pending row, and
 * letting them in under a null key would suppress unrelated rows.
 *
 * TENANCY IS THE CALLER'S JOB and it is not optional. A parent row is shared
 * across organizations (membership lives in parent_org_relationships, not on
 * `parents`), so the same parent_id can hold registrations at two providers.
 * These keys carry no organization, so feeding in rows from another org would
 * let provider B's confirmed registration silence provider A's nudge. Both
 * queries in resolveAbandonedAudience filter organization_id for that reason.
 */
export function buildResolvedIndex(resolvedRows: readonly unknown[]): ResolvedIndex {
  const byChild = new Set<string>();
  const byParent = new Set<string>();

  for (const raw of resolvedRows ?? []) {
    const row = raw as any;
    const offering = offeringIdOf(row);
    const parentId = row?.parent_id ?? row?.parents?.id ?? null;
    if (!offering || !parentId) continue;

    byParent.add(`${parentId}|${offering}`);
    const child = normalizeChildName(row?.students?.first_name);
    if (child) byChild.add(`${parentId}|${offering}|${child}`);
  }

  return { byChild, byParent };
}

/**
 * True when this pending registration is a genuine abandonment worth chasing.
 *
 * A row with no identifiable parent or offering returns false — we cannot prove
 * it is unfinished, so we do not mail it. A row whose child cannot be named
 * falls back to the parent-level answer, which over-suppresses at worst.
 */
export function isGenuinelyAbandoned(pendingRow: any, index: ResolvedIndex): boolean {
  const offering = offeringIdOf(pendingRow);
  const parentId = pendingRow?.parent_id ?? pendingRow?.parents?.id ?? null;
  if (!offering || !parentId) return false;

  const child = normalizeChildName(pendingRow?.students?.first_name);
  return child
    ? !index.byChild.has(`${parentId}|${offering}|${child}`)
    : !index.byParent.has(`${parentId}|${offering}`);
}
