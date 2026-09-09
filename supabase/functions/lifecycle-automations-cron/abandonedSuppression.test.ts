// Unit tests for abandoned-registration suppression.
// Run: deno test abandonedSuppression.test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  offeringIdOf,
  normalizeChildName,
  buildResolvedIndex,
  isGenuinelyAbandoned,
} from "./abandonedSuppression.ts";

// ── The real rows this fix exists for ───────────────────────────────────────
// Pulled from prod on 2026-09-07. Allison Ackley abandoned checkout on 8/29,
// came back and paid on 8/31, and was emailed "you almost signed up" thirteen
// minutes later. Note the two details that make this hard: the two students
// rows are DIFFERENT ids for the same real child, and the first one's
// first_name carries a trailing space.
const ALLISON = "893858e2-63e1-42b5-8fb5-0218f0c18ccd";
const UKULELE_AT_ASTOR = "a93c9155-7f15-478a-b2e2-fd1218a82eb8";

/** Shape the audience query returns: parent + offering are EMBEDDED objects. */
function pendingRow(opts: {
  parentId: string | null;
  programId?: string;
  campSessionId?: string;
  childFirstName?: unknown;
}) {
  return {
    id: "pending-row",
    parent_id: opts.parentId,
    parents: opts.parentId ? { id: opts.parentId, first_name: "A", email: "a@example.com" } : null,
    students: "childFirstName" in opts ? { first_name: opts.childFirstName } : null,
    programs: opts.programId ? { id: opts.programId, curriculum: "Ukulele Club" } : null,
    camp_sessions: opts.campSessionId ? { id: opts.campSessionId, curriculum_name: "Camp" } : null,
  };
}

/** Shape the lookup query returns: parent + offering are SCALAR columns. */
function resolvedRow(opts: {
  parentId: string;
  programId?: string | null;
  campSessionId?: string | null;
  childFirstName?: unknown;
}) {
  return {
    parent_id: opts.parentId,
    program_id: opts.programId ?? null,
    camp_session_id: opts.campSessionId ?? null,
    students: "childFirstName" in opts ? { first_name: opts.childFirstName } : null,
  };
}

// ── normalizeChildName ──────────────────────────────────────────────────────

Deno.test("normalizeChildName collapses INTERNAL whitespace, not just the ends", () => {
  // Trimming is what carries the Ackley case below. The internal collapse
  // covers multi-word first names, where the same stray space lands in the
  // middle and trimming alone would not catch it.
  assertEquals(normalizeChildName("Molly "), "molly");
  assertEquals(normalizeChildName("Molly"), "molly");
  assertEquals(normalizeChildName("Mary  Jo"), "mary jo");
  assertEquals(normalizeChildName("  Mary   Jo  "), "mary jo");
  assertEquals(normalizeChildName("Molly \t\n"), "molly");
});

Deno.test("normalizeChildName returns null for anything with no name left", () => {
  // Null rather than "" so callers can tell "no name on file" from a real name.
  // Matching on "" would make every nameless row equal to every other.
  assertEquals(normalizeChildName(""), null);
  assertEquals(normalizeChildName("   "), null);
  assertEquals(normalizeChildName(null), null);
  assertEquals(normalizeChildName(undefined), null);
  assertEquals(normalizeChildName(42), null);
  assertEquals(normalizeChildName({ first_name: "Molly" }), null);
});

// ── offeringIdOf ────────────────────────────────────────────────────────────

Deno.test("offeringIdOf reads both row shapes the cron produces", () => {
  // Embedded (audience query) and scalar (lookup query) must agree, or the two
  // sides of the comparison never meet.
  assertEquals(offeringIdOf({ programs: { id: "p1" } }), "program:p1");
  assertEquals(offeringIdOf({ program_id: "p1" }), "program:p1");
  assertEquals(offeringIdOf({ camp_sessions: { id: "c1" } }), "camp:c1");
  assertEquals(offeringIdOf({ camp_session_id: "c1" }), "camp:c1");
  // A scalar column present-but-null must fall through to the camp, not win.
  assertEquals(offeringIdOf({ program_id: null, camp_session_id: "c1" }), "camp:c1");
});

Deno.test("offeringIdOf namespaces programs and camps so ids cannot collide", () => {
  const sharedId = "00000000-0000-4000-8000-000000000001";
  assertEquals(offeringIdOf({ program_id: sharedId }), `program:${sharedId}`);
  assertEquals(offeringIdOf({ camp_session_id: sharedId }), `camp:${sharedId}`);
  assertEquals(
    offeringIdOf({ program_id: sharedId }) === offeringIdOf({ camp_session_id: sharedId }),
    false,
  );
});

Deno.test("offeringIdOf returns null when a registration has no offering", () => {
  assertEquals(offeringIdOf({}), null);
  assertEquals(offeringIdOf({ program_id: null, camp_session_id: null }), null);
  assertEquals(offeringIdOf(null), null);
});

// ── The regression this fix exists for ──────────────────────────────────────

Deno.test("REGRESSION: the parent who already paid is not chased again", () => {
  // Allison's real rows. Different student_id, trailing space on the pending
  // one. Matching on student_id fails here; matching on a trim-only name fails
  // here. This must come out suppressed.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: UKULELE_AT_ASTOR, childFirstName: "Molly" }),
  ]);
  const stillPending = pendingRow({
    parentId: ALLISON,
    programId: UKULELE_AT_ASTOR,
    childFirstName: "Molly ",
  });

  assertEquals(isGenuinelyAbandoned(stillPending, index), false);
});

Deno.test("a parent with nothing resolved still gets the nudge", () => {
  const index = buildResolvedIndex([]);
  const stillPending = pendingRow({
    parentId: ALLISON,
    programId: UKULELE_AT_ASTOR,
    childFirstName: "Molly",
  });

  assertEquals(isGenuinelyAbandoned(stillPending, index), true);
});

// ── Per-child, not per-parent ───────────────────────────────────────────────

Deno.test("enrolling one sibling does not suppress the other's real abandonment", () => {
  // The case that rules out a parent-level match. Henry got registered; Milo
  // genuinely did not. Milo's nudge must survive.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Henry" }),
  ]);

  const milo = pendingRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Milo" });
  const henry = pendingRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Henry" });

  assertEquals(isGenuinelyAbandoned(milo, index), true);
  assertEquals(isGenuinelyAbandoned(henry, index), false);
});

Deno.test("both siblings enrolled suppresses both leftovers", () => {
  // The Voorhees family's actual prod shape: two kids, three programs, every
  // pending row shadowed by a confirmed one for the same child.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Henry" }),
    resolvedRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Milo" }),
  ]);

  const milo = pendingRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Milo" });
  const henry = pendingRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Henry" });

  assertEquals(isGenuinelyAbandoned(milo, index), false);
  assertEquals(isGenuinelyAbandoned(henry, index), false);
});

// ── Scoping: the key must not be looser than the claim ──────────────────────

Deno.test("resolving one offering does not suppress a different one", () => {
  // Registering Molly for the Tuesday club says nothing about the Thursday one.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: "prog-tuesday", childFirstName: "Molly" }),
  ]);
  const thursday = pendingRow({
    parentId: ALLISON,
    programId: "prog-thursday",
    childFirstName: "Molly",
  });

  assertEquals(isGenuinelyAbandoned(thursday, index), true);
});

Deno.test("another family's child of the same name does not suppress this one", () => {
  const index = buildResolvedIndex([
    resolvedRow({ parentId: "other-parent", programId: "prog-1", childFirstName: "Molly" }),
  ]);
  const mine = pendingRow({ parentId: ALLISON, programId: "prog-1", childFirstName: "Molly" });

  assertEquals(isGenuinelyAbandoned(mine, index), true);
});

Deno.test("a camp registration does not suppress a program with the same id", () => {
  const sharedId = "00000000-0000-4000-8000-000000000001";
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, campSessionId: sharedId, childFirstName: "Molly" }),
  ]);
  const program = pendingRow({ parentId: ALLISON, programId: sharedId, childFirstName: "Molly" });
  const camp = pendingRow({ parentId: ALLISON, campSessionId: sharedId, childFirstName: "Molly" });

  assertEquals(isGenuinelyAbandoned(program, index), true);
  assertEquals(isGenuinelyAbandoned(camp, index), false);
});

// ── Fail direction: unclear identity suppresses rather than sends ───────────

Deno.test("a nameless pending row falls back to the parent-level answer", () => {
  // We cannot tell this attempt apart from the one that succeeded, so we do not
  // send. Over-suppressing costs a marketing touch; sending costs a family's
  // trust in whether their child has a place.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: UKULELE_AT_ASTOR, childFirstName: "Molly" }),
  ]);

  for (const nameless of [null, "", "   ", undefined]) {
    const row = pendingRow({
      parentId: ALLISON,
      programId: UKULELE_AT_ASTOR,
      childFirstName: nameless,
    });
    assertEquals(isGenuinelyAbandoned(row, index), false, `nameless: ${JSON.stringify(nameless)}`);
  }
});

Deno.test("a nameless pending row is still chased when the parent resolved nothing", () => {
  // The fallback must not swallow every nameless row — only those whose parent
  // already has an outcome for that offering.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: "some-other-program", childFirstName: "Molly" }),
  ]);
  const row = pendingRow({ parentId: ALLISON, programId: UKULELE_AT_ASTOR, childFirstName: null });

  assertEquals(isGenuinelyAbandoned(row, index), true);
});

Deno.test("a pending row we cannot identify is never mailed", () => {
  const index = buildResolvedIndex([]);

  // No offering to compare against.
  assertEquals(isGenuinelyAbandoned(pendingRow({ parentId: ALLISON }), index), false);
  // No parent to attribute it to.
  assertEquals(
    isGenuinelyAbandoned(pendingRow({ parentId: null, programId: UKULELE_AT_ASTOR }), index),
    false,
  );
});

// ── Index construction ──────────────────────────────────────────────────────

Deno.test("buildResolvedIndex skips rows it cannot key, without poisoning the sets", () => {
  // A resolved row with no offering must not become a null-keyed entry that
  // suppresses unrelated pending rows.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: null, campSessionId: null, childFirstName: "Molly" }),
    { parent_id: null, program_id: "prog-1", students: { first_name: "Molly" } },
    null,
    undefined,
  ]);

  assertEquals(index.byChild.size, 0);
  assertEquals(index.byParent.size, 0);
  assertEquals(
    isGenuinelyAbandoned(
      pendingRow({ parentId: ALLISON, programId: "prog-1", childFirstName: "Molly" }),
      index,
    ),
    true,
  );
});

Deno.test("buildResolvedIndex records a parent-level entry even for a nameless row", () => {
  // The row still proves the parent reached an outcome for that offering, which
  // is what the fallback needs, even though it cannot say for which child.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: "prog-1", childFirstName: null }),
  ]);

  assertEquals(index.byChild.size, 0);
  assertEquals(index.byParent.has(`${ALLISON}|program:prog-1`), true);
});

Deno.test("buildResolvedIndex tolerates an empty or missing row set", () => {
  assertEquals(buildResolvedIndex([]).byParent.size, 0);
  assertEquals(buildResolvedIndex(undefined as unknown as unknown[]).byParent.size, 0);
});

// ── Statuses ────────────────────────────────────────────────────────────────

Deno.test("the index ignores status entirely — identity is all it keys on", () => {
  // Which statuses count as "resolved" is the CALLER's decision, made by the
  // .neq("status","pending") filter on the lookup query. This module must never
  // grow its own opinion about status: if it did, the two would drift and only
  // one of them would be visible in a review of either file.
  const index = buildResolvedIndex([
    { ...resolvedRow({ parentId: ALLISON, programId: "prog-1", childFirstName: "Molly" }), status: "cancelled" },
    { ...resolvedRow({ parentId: ALLISON, programId: "prog-2", childFirstName: "Molly" }), status: "waitlist" },
    { ...resolvedRow({ parentId: ALLISON, programId: "prog-3", childFirstName: "Molly" }), status: "confirmed" },
    // Even a row the caller should never hand over is indexed, not second-guessed.
    { ...resolvedRow({ parentId: ALLISON, programId: "prog-4", childFirstName: "Molly" }), status: "pending" },
  ]);

  for (const prog of ["prog-1", "prog-2", "prog-3", "prog-4"]) {
    const row = pendingRow({ parentId: ALLISON, programId: prog, childFirstName: "Molly" });
    assertEquals(isGenuinelyAbandoned(row, index), false, `program: ${prog}`);
  }
});

Deno.test("CALLER CONTRACT: the lookup still selects every non-pending status", () => {
  // The test above deliberately proves the module is status-blind, which leaves
  // exactly one place where waitlist and cancelled can silently stop counting as
  // resolved: the query in index.ts. Narrowing it to .eq("status","confirmed")
  // would re-break suppression for those two and no unit test of this module
  // could see it. So assert the predicate itself.
  const source = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const lookup = source.slice(source.indexOf("const { data: resolvedRows"));

  assertEquals(
    lookup.includes('.neq("status", "pending")'),
    true,
    'the resolved-registration lookup must stay .neq("status","pending") — an .eq() narrowing would let waitlist/cancelled rows stop suppressing',
  );
  assertEquals(
    lookup.slice(0, lookup.indexOf(";")).includes('.eq("organization_id"'),
    true,
    "the resolved-registration lookup must stay org-scoped — parents are shared across tenants",
  );
});

// ── The nameless-counterpart hole ───────────────────────────────────────────
// Added 2026-09-09 during the review that took this module to prod. The
// child-level set only ever gains NAMED rows, so a resolved registration with
// no usable child name used to leave a hole that a NAMED pending row fell
// straight through - the paid-family email this module exists to prevent.

Deno.test("a nameless resolved row suppresses a named leftover for the same offering", () => {
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: "prog-1", childFirstName: null }),
  ]);

  assertEquals(index.byParentUnnamed.has(`${ALLISON}|program:prog-1`), true);
  assertEquals(
    isGenuinelyAbandoned(
      pendingRow({ parentId: ALLISON, programId: "prog-1", childFirstName: "Molly" }),
      index,
    ),
    false,
  );
});

Deno.test("a nameless resolved row does NOT reach across offerings", () => {
  // Distrust is scoped to the parent+offering we could not name. A different
  // class is still judged per child, so this must remain a real abandonment.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: ALLISON, programId: "prog-1", childFirstName: null }),
  ]);

  assertEquals(
    isGenuinelyAbandoned(
      pendingRow({ parentId: ALLISON, programId: "prog-2", childFirstName: "Molly" }),
      index,
    ),
    true,
  );
});

Deno.test("the sibling nudge survives when every resolved row is named", () => {
  // The naive fix for the hole - suppress when EITHER set matches - would break
  // exactly this, collapsing the per-child rule back to per-parent.
  const index = buildResolvedIndex([
    resolvedRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Henry" }),
  ]);

  assertEquals(index.byParentUnnamed.size, 0);
  assertEquals(
    isGenuinelyAbandoned(
      pendingRow({ parentId: "voorhees", programId: "prog-1", childFirstName: "Milo" }),
      index,
    ),
    true,
  );
});
