// Grouping recipients into one email per (ADDRESS, FAMILY), with unreachable
// addresses held OUT of the send.
//
// Split from familyNotify.test.ts, which covers the send loop. This half is
// about WHO ends up in the list, and every case below is one prod actually
// contains rather than an invented one:
//   - 12 children across the two live orgs have a guardian address identical to
//     the account holder's, so keying by parent would send two identical emails
//   - the OES Pokemon class returns 13 recipients whose addresses were ALL
//     minted by a partner-run roster import, so a flat list would report 13
//     sent while 13 bounced
//   - an address can serve two different families in one class, and merging
//     those tells each household who else is in the class

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { groupRecipientsByAddress } from '../familyNotify.ts';

const row = (over: Record<string, unknown> = {}) => ({
  recipient_email: 'a@x.test',
  recipient_name: 'Ada Adams',
  recipient_kind: 'parent',
  parent_id: 'par1',
  student_id: 'stu1',
  student_first_name: 'Ryan',
  audience: 'enrolled',
  unreachable_reason: null,
  ...over,
});

Deno.test('THE 12-CASE TRAP: guardian address identical to the parent is ONE email', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_kind: 'parent', recipient_email: 'jess@j2s.test', recipient_name: 'Jessica Vorster' }),
    row({ recipient_kind: 'guardian', recipient_email: 'jess@j2s.test', recipient_name: 'Jessica Vorster' }),
  ]);
  assertEquals(out.sendable.length, 1, 'one inbox, one email');
  assertEquals(out.sendable[0].child_count, 1, 'and the child is not named twice');
  assertEquals(out.sendable[0].student_first_name, 'Ryan');
  assertEquals(out.sendable[0].kinds, ['guardian', 'parent']);
});

Deno.test('a DIFFERENT second guardian is a second recipient', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_kind: 'parent', recipient_email: 'mum@x.test', recipient_name: 'Mum M' }),
    row({ recipient_kind: 'guardian', recipient_email: 'dad@x.test', recipient_name: 'Dad D' }),
  ]);
  assertEquals(out.sendable.map((r) => r.email), ['dad@x.test', 'mum@x.test'], 'both, ordered by address');
});

Deno.test('two children in one class = ONE email naming both (the Yu Zhou bug)', () => {
  const out = groupRecipientsByAddress([
    row({ student_id: 'stu1', student_first_name: 'Ryan' }),
    row({ student_id: 'stu2', student_first_name: 'Evan' }),
  ]);
  assertEquals(out.sendable.length, 1);
  assertEquals(out.sendable[0].student_first_name, 'Ryan and Evan');
  assertEquals(out.sendable[0].child_count, 2);
});

Deno.test('case-different addresses are one inbox', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'Sam@X.test' }),
    row({ recipient_email: 'sam@x.test', student_id: 'stu2', student_first_name: 'Evan' }),
  ]);
  assertEquals(out.sendable.length, 1);
  assertEquals(out.sendable[0].email, 'sam@x.test');
  assertEquals(out.sendable[0].student_first_name, 'Ryan and Evan');
});

Deno.test('the account holder names the email, not whichever row came first', () => {
  const guardianFirst = groupRecipientsByAddress([
    row({ recipient_kind: 'guardian', recipient_email: 's@x.test', recipient_name: 'Guardian G' }),
    row({ recipient_kind: 'parent', recipient_email: 's@x.test', recipient_name: 'Account Holder' }),
  ]);
  assertEquals(guardianFirst.sendable[0].name, 'Account Holder');
  const guardianOnly = groupRecipientsByAddress([
    row({ recipient_kind: 'guardian', recipient_email: 'g@x.test', recipient_name: 'Guardian G' }),
  ]);
  assertEquals(guardianOnly.sendable[0].name, 'Guardian G');
});

Deno.test('waitlist rows are tagged so the operator can see what they selected', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'e@x.test', audience: 'enrolled' }),
    row({ recipient_email: 'w@x.test', audience: 'waitlist', student_id: 'stu9', student_first_name: 'Wanda' }),
  ]);
  assertEquals(out.sendable.find((r) => r.email === 'w@x.test')!.audiences, ['waitlist']);
  assertEquals(out.sendable.find((r) => r.email === 'e@x.test')!.audiences, ['enrolled']);
});

Deno.test('junk rows cannot become a send to nobody', () => {
  assertEquals(groupRecipientsByAddress([]).sendable, []);
  assertEquals(groupRecipientsByAddress(undefined as never).sendable, []);
  assertEquals(groupRecipientsByAddress([row({ recipient_email: '   ' })]).sendable.length, 0);
  const noName = groupRecipientsByAddress([row({ student_first_name: null })]);
  assertEquals(noName.sendable[0].child_count, 1);
  assertEquals(noName.sendable[0].student_first_name, 'your child');
});

Deno.test('ONE INBOX, TWO FAMILIES: never one email naming both households children', () => {
  // A grandparent minding two cousins, or a nanny guardian for two households.
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'nan@x.test', recipient_kind: 'guardian',
          parent_id: 'famA', student_id: 'kidA', student_first_name: 'Ada' }),
    row({ recipient_email: 'nan@x.test', recipient_kind: 'guardian',
          parent_id: 'famB', student_id: 'kidB', student_first_name: 'Bo' }),
  ]);
  assertEquals(out.sendable.length, 2, 'two separate pieces of business, two emails');
  assertEquals(out.sendable.map((r) => r.student_first_name).sort(), ['Ada', 'Bo']);
  for (const g of out.sendable) {
    assertEquals(g.child_count, 1);
    assertEquals(g.student_first_name.includes(' and '), false, 'no cross-family merge');
  }
});

Deno.test('same inbox, SAME family, both roles: still exactly one email', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_kind: 'parent', parent_id: 'famA', student_id: 'kid1', student_first_name: 'Ryan', recipient_email: 'me@x.test' }),
    row({ recipient_kind: 'guardian', parent_id: 'famA', student_id: 'kid1', student_first_name: 'Ryan', recipient_email: 'me@x.test' }),
    row({ recipient_kind: 'parent', parent_id: 'famA', student_id: 'kid2', student_first_name: 'Evan', recipient_email: 'me@x.test' }),
  ]);
  assertEquals(out.sendable.length, 1, 'one family, one inbox, one email');
  assertEquals(out.sendable[0].student_first_name, 'Ryan and Evan');
  assertEquals(out.sendable[0].child_count, 2);
});

Deno.test('a nameless child is counted even though it cannot be named', () => {
  // KNOWN LIMITATION, pinned so it cannot change silently. Zero students on prod
  // or staging have a blank first name and registration requires one.
  const out = groupRecipientsByAddress([
    row({ student_id: 'kid1', student_first_name: 'Ryan' }),
    row({ student_id: 'kid2', student_first_name: null }),
  ]);
  assertEquals(out.sendable[0].child_count, 2, 'both children are accounted for');
  assertEquals(out.sendable[0].student_first_name, 'Ryan', 'and the unnamed one cannot be greeted');
});

// ── unreachable addresses are held OUT of the send ─────────────────────────
Deno.test('THE OES CASE: a placeholder address is never sendable', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'ada.smith.1.0@import.local', unreachable_reason: 'placeholder_email' }),
    row({ recipient_email: 'bo.jones.2.1@import.local', unreachable_reason: 'placeholder_email',
          parent_id: 'par2', student_id: 'stu2', student_first_name: 'Bo' }),
    row({ recipient_email: 'real@x.test', parent_id: 'par3', student_id: 'stu3', student_first_name: 'Cy' }),
  ]);
  assertEquals(out.sendable.map((r) => r.email), ['real@x.test'], 'only the real address is sendable');
  assertEquals(out.unreachable.length, 2, 'and the others are REPORTED, not dropped');
  assertEquals(out.unreachable.every((r) => r.unreachable_reason === 'placeholder_email'), true);
  // The operator can still name the affected children to chase the school.
  assertEquals(out.unreachable.map((r) => r.student_first_name).sort(), ['Bo', 'Ryan']);
});

Deno.test('unreachable is STICKY: one bad row keeps the whole address out', () => {
  // Fails closed. The same address arriving once flagged and once not must not be
  // promoted back into the send by the unflagged row.
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'x@import.local', unreachable_reason: 'placeholder_email' }),
    row({ recipient_email: 'x@import.local', unreachable_reason: null, student_id: 'stu2', student_first_name: 'Evan' }),
  ]);
  assertEquals(out.sendable.length, 0, 'never promoted back into the send');
  assertEquals(out.unreachable.length, 1);
  assertEquals(out.unreachable[0].child_count, 2);
});

Deno.test('a class where nobody is reachable sends to nobody and says so', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'a@import.local', unreachable_reason: 'placeholder_email' }),
  ]);
  assertEquals(out.sendable, []);
  assertEquals(out.unreachable.length, 1);
});
