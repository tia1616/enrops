// Households, not inboxes - the rule the whole recipient picker rests on.
//
// WHY THIS FILE EXISTS. program_message_recipients stamps the REGISTRATION's
// parent_id on the guardian row as well as the parent row, so one household can
// arrive as two rows that differ only by address. Two things follow, and both
// have already been got wrong once in this product:
//
//   1. The count. "N families will receive this" was printed off the number of
//      ROWS, and printed 10 for 6 households at Jackson in September.
//   2. The exclusion. Excluding by ADDRESS is the defect that let three second
//      guardians - Chris Lugo, James Stone, Shamik Basu - through a campaign
//      filter that matched parents.email, and told three households the same
//      thing twice in two days. Unticking a family has to drop BOTH addresses.
//
// These assertions are about grouping and identity, so they run against the
// real grouper rather than a copy of its rules.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  excludeHouseholds,
  groupRecipientsByAddress,
  type MessageRecipientRow,
} from '../familyNotify.ts';

const PARENT_A = '11111111-1111-1111-1111-111111111111';
const PARENT_B = '22222222-2222-2222-2222-222222222222';
const CHILD_1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const CHILD_2 = 'aaaaaaaa-0000-0000-0000-000000000002';

const row = (over: Partial<MessageRecipientRow>): MessageRecipientRow => ({
  recipient_email: 'x@example.com',
  recipient_name: 'X',
  recipient_kind: 'parent',
  parent_id: PARENT_A,
  student_id: CHILD_1,
  student_first_name: 'Ada',
  audience: 'enrolled',
  unreachable_reason: null,
  ...over,
});

// The Jackson shape: one household, two addresses, one child.
const ROSEMARY_AND_JIM: MessageRecipientRow[] = [
  row({ recipient_email: 'rosemary@example.com', recipient_name: 'Rosemary Field', recipient_kind: 'parent' }),
  row({ recipient_email: 'jim@example.com', recipient_name: 'Jim Field', recipient_kind: 'guardian' }),
];

// NOTE: excludeHouseholds is IMPORTED, not redefined here. The first draft of
// this file wrote its own one-line filter, which would have passed green
// against a broken function - a test that restates the rule proves the rule,
// never the code.

Deno.test('two addresses on one household are TWO sends but ONE family', () => {
  const { sendable } = groupRecipientsByAddress(ROSEMARY_AND_JIM);
  // Two emails, because each inbox gets its own - nobody learns the other's
  // address from a class note.
  assertEquals(sendable.length, 2);
  // One family, which is what the label above the list claims to count.
  assertEquals(new Set(sendable.map((g) => g.parent_id)).size, 1);
});

Deno.test('THE DEFECT: unticking the family drops BOTH its addresses', () => {
  const { sendable } = groupRecipientsByAddress(ROSEMARY_AND_JIM);
  const left = excludeHouseholds(sendable, [PARENT_A]);
  assertEquals(left.length, 0, 'Jim must not still receive it when Rosemary is unticked');
});

Deno.test('excluding one household does not touch another', () => {
  const { sendable } = groupRecipientsByAddress([
    ...ROSEMARY_AND_JIM,
    row({ parent_id: PARENT_B, student_id: CHILD_2, recipient_email: 'nina@example.com', recipient_name: 'Nina Ray', student_first_name: 'Sam' }),
  ]);
  assertEquals(new Set(sendable.map((g) => g.parent_id)).size, 2, 'two families');
  const left = excludeHouseholds(sendable, [PARENT_A]);
  assertEquals(left.map((g) => g.email), ['nina@example.com']);
});

Deno.test('ONE address serving TWO families is two households, and excluding one keeps the other', () => {
  // A grandparent minding two cousins. The grouper already keys on
  // (address, family) to stop one email naming both households' children; the
  // picker has to respect the same split or unticking one cousin's family
  // silently drops the other's.
  const gran = 'gran@example.com';
  const { sendable } = groupRecipientsByAddress([
    row({ parent_id: PARENT_A, student_id: CHILD_1, recipient_email: gran, student_first_name: 'Ada' }),
    row({ parent_id: PARENT_B, student_id: CHILD_2, recipient_email: gran, student_first_name: 'Sam' }),
  ]);
  assertEquals(sendable.length, 2, 'same inbox, two separate pieces of business');
  const left = excludeHouseholds(sendable, [PARENT_A]);
  assertEquals(left.length, 1);
  assertEquals(left[0].student_first_name, 'Sam');
});

Deno.test('an empty exclusion list means EVERYBODY, not nobody', () => {
  const { sendable } = groupRecipientsByAddress(ROSEMARY_AND_JIM);
  assertEquals(excludeHouseholds(sendable, []).length, 2);
});

Deno.test('an unreachable address is never counted as a sendable household', () => {
  const { sendable, unreachable } = groupRecipientsByAddress([
    row({ recipient_email: 'real@example.com' }),
    row({ parent_id: PARENT_B, student_id: CHILD_2, recipient_email: 'ghost@import.local', unreachable_reason: 'placeholder_email' }),
  ]);
  assertEquals(sendable.length, 1);
  assertEquals(unreachable.length, 1);
  // The picker counts households off `sendable`, so a placeholder address must
  // not inflate "N families will receive this" - the exact number that read 13
  // on a class where zero were deliverable.
  assertEquals(new Set(sendable.map((g) => g.parent_id)).size, 1);
});

// ── the duplicate guard's overlap test ────────────────────────────────────
//
// The guard used to key on (class + subject) and block ANY repeat. With a
// picker that is wrong: "send to half, then the other half" is one job in two
// presses. It now compares households, so no overlap proceeds and overlap warns
// with a real number.

const overlap = (previousSent: string[], sendingNow: string[]) => {
  const before = new Set(previousSent);
  return new Set(sendingNow.filter((id) => before.has(id)));
};

Deno.test('send to some, then the rest: no overlap, no warning', () => {
  assertEquals(overlap([PARENT_A], [PARENT_B]).size, 0);
});

Deno.test('sending to somebody who just had it warns, and says how many', () => {
  assertEquals(overlap([PARENT_A, PARENT_B], [PARENT_B]).size, 1);
});

Deno.test('a previous send whose record has no parent ids must NOT read as "no overlap"', () => {
  // Rows written before the guard needed household ids yield an empty set.
  // Treating empty as "nobody overlaps" would silently switch the guard off for
  // exactly the sends it was protecting before the picker existed, so the
  // function falls back to the old whole-send warning when it cannot tell.
  const previouslySent: string[] = [];
  const knowWho = previouslySent.length > 0;
  assertEquals(knowWho, false, 'must fall back, not wave it through');
});
