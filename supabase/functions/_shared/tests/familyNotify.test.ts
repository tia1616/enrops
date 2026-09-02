// Drives the family send loop through its FAILURE paths, which is the only
// reason it is worth extracting. Against the real Resend API you can prove the
// happy path and nothing else; the branches that matter on a bad day are a
// non-ok response and a thrown fetch, and both are exercised here.
//
// The behaviours pinned below are the ones a real send depends on:
//   - ONE request per family, never a shared `to` (families in a class must not
//     learn each other's addresses from a class note)
//   - a failure for one family does NOT abort the rest
//   - reply_to is OMITTED, not null, when the org has none
//   - an unknown {placeholder} survives to the reader rather than being blanked

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  sendFamilyEmails,
  substitute,
  familyVars,
  tallyFamilySends,
} from '../familyNotify.ts';

const R = (n: number, over: Record<string, unknown> = {}) => ({
  parent_id: `p${n}`,
  name: `Parent${n} Family${n}`,
  email: `p${n}@example.com`,
  student_first_name: `Child${n}`,
  ...over,
});

// A fake Resend. `plan` decides what happens per call so a single test can mix
// success, rejection and an exception.
function fakeResend(plan: Array<'ok' | 'bad' | 'throw'>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const impl = ((url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    const outcome = plan[i++] ?? 'ok';
    if (outcome === 'throw') return Promise.reject(new Error('socket hang up'));
    if (outcome === 'bad') {
      return Promise.resolve({
        ok: false,
        status: 422,
        text: () => Promise.resolve('x'.repeat(500)),
        json: () => Promise.resolve({}),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ id: `re_${calls.length}` }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

Deno.test('one request per family, each addressed only to that family', async () => {
  const { impl, calls } = fakeResend(['ok', 'ok', 'ok']);
  const out = await sendFamilyEmails({
    recipients: [R(1), R(2), R(3)],
    subject: 'About {student_first_name}',
    bodyText: 'Hi {parent_first_name}',
    from: 'J2S <hi@j2s.test>',
    apiKey: 'k',
    fetchImpl: impl,
  });
  assertEquals(calls.length, 3, 'one POST per family');
  assertEquals(out.map((r) => r.status), ['sent', 'sent', 'sent']);
  // Each request carries exactly ONE address, and it is that family's.
  assertEquals(calls.map((c) => c.body.to), ['p1@example.com', 'p2@example.com', 'p3@example.com']);
  for (const c of calls) {
    assertEquals(Array.isArray(c.body.to), false, 'never an array of addresses');
  }
  assertEquals(out.map((r) => r.resend_message_id), ['re_1', 're_2', 're_3']);
});

Deno.test('THE POINT: one family failing does not stop the others', async () => {
  const { impl, calls } = fakeResend(['ok', 'bad', 'throw', 'ok']);
  const out = await sendFamilyEmails({
    recipients: [R(1), R(2), R(3), R(4)],
    subject: 's', bodyText: 'b', from: 'f', apiKey: 'k', fetchImpl: impl,
  });
  assertEquals(calls.length, 4, 'every family was still attempted');
  assertEquals(out.map((r) => r.status), ['sent', 'failed', 'failed', 'sent']);
  assertEquals(tallyFamilySends(out), { sent: 2, failed: 2, total: 4 });
  // The failures name WHICH family and why, or the audit row is useless.
  assertEquals(out[1].email, 'p2@example.com');
  assertEquals(out[1].failure_reason?.startsWith('resend 422: '), true);
  assertEquals(out[2].failure_reason, 'socket hang up');
  // A long provider error is truncated - this lands in a row a person reads.
  assertEquals(out[1].failure_reason!.length <= 220, true);
});

Deno.test('reply_to is omitted, not null, when the org has none', async () => {
  const { impl, calls } = fakeResend(['ok', 'ok']);
  await sendFamilyEmails({
    recipients: [R(1)], subject: 's', bodyText: 'b', from: 'f', apiKey: 'k', fetchImpl: impl,
  });
  assertEquals('reply_to' in calls[0].body, false, 'absent key, not a null Resend rejects');
  await sendFamilyEmails({
    recipients: [R(2)], subject: 's', bodyText: 'b', from: 'f',
    replyTo: 'hi@j2s.test', apiKey: 'k', fetchImpl: impl,
  });
  assertEquals(calls[1].body.reply_to, ['hi@j2s.test']);
});

Deno.test('placeholders: known ones fill, unknown ones survive to the reader', async () => {
  const { impl, calls } = fakeResend(['ok']);
  await sendFamilyEmails({
    recipients: [R(1)],
    subject: '{student_first_name} on {program_day}',
    bodyText: 'Hi {parent_first_name} - {Parent_First_Name} - {org_name}',
    vars: { program_day: 'Wednesdays', org_name: 'Journey to STEAM' },
    from: 'f', apiKey: 'k', fetchImpl: impl,
  });
  assertEquals(calls[0].body.subject, 'Child1 on Wednesdays');
  // The mis-cased one is left exactly as typed, so the typo is visible.
  assertEquals(calls[0].body.text, 'Hi Parent1 - {Parent_First_Name} - Journey to STEAM');
});

Deno.test('a nameless parent or child still reads like English', () => {
  assertEquals(familyVars({ parent_id: 'x', name: '', email: 'e' }).parent_first_name, 'there');
  assertEquals(familyVars({ parent_id: 'x', name: '   ', email: 'e' }).parent_first_name, 'there');
  assertEquals(
    familyVars({ parent_id: 'x', name: 'Yu Zhou', email: 'e', student_first_name: '' }).student_first_name,
    'your child',
  );
  assertEquals(familyVars({ parent_id: 'x', name: 'Yu Zhou', email: 'e' }).parent_first_name, 'Yu');
  // Caller extras win over nothing, but never clobber the two defaults' keys
  // unless the caller means to.
  assertEquals(familyVars({ parent_id: 'x', name: 'Yu Zhou', email: 'e' }, { org_name: 'X' }).org_name, 'X');
});

Deno.test('substitute is total: no template, no vars, no crash', () => {
  assertEquals(substitute('', {}), '');
  assertEquals(substitute(undefined as unknown as string, {}), '');
  assertEquals(substitute('plain text', {}), 'plain text');
  assertEquals(substitute('{a}{b}', { a: '1' }), '1{b}');
});

Deno.test('an empty class sends nothing and reports nothing sent', async () => {
  const { impl, calls } = fakeResend([]);
  const out = await sendFamilyEmails({
    recipients: [], subject: 's', bodyText: 'b', from: 'f', apiKey: 'k', fetchImpl: impl,
  });
  assertEquals(calls.length, 0, 'no class, no POST');
  assertEquals(tallyFamilySends(out), { sent: 0, failed: 0, total: 0 });
});

Deno.test('tally does not crash on a missing result list', () => {
  assertEquals(tallyFamilySends(undefined as never), { sent: 0, failed: 0, total: 0 });
});

// ── grouping: one email per ADDRESS ─────────────────────────────────────────
// The rows below are the shape program_message_recipients returns. The cases
// are the ones prod actually contains, not invented ones.
import { groupRecipientsByAddress } from '../familyNotify.ts';

const row = (over: Record<string, unknown> = {}) => ({
  recipient_email: 'a@x.test',
  recipient_name: 'Ada Adams',
  recipient_kind: 'parent',
  parent_id: 'par1',
  student_id: 'stu1',
  student_first_name: 'Ryan',
  audience: 'enrolled',
  ...over,
});

Deno.test('THE 12-CASE TRAP: guardian email identical to the parent is ONE email', () => {
  // Exactly the first staging class tested: same child, guardian address ==
  // primary address. Keyed by parent this is two rows and two identical emails.
  const out = groupRecipientsByAddress([
    row({ recipient_kind: 'parent',   recipient_email: 'jessica@j2s.test', recipient_name: 'Jessica Vorster' }),
    row({ recipient_kind: 'guardian', recipient_email: 'jessica@j2s.test', recipient_name: 'Jessica Vorster' }),
  ]);
  assertEquals(out.length, 1, 'one inbox, one email');
  assertEquals(out[0].child_count, 1, 'and the child is not named twice');
  assertEquals(out[0].student_first_name, 'Ryan');
  assertEquals(out[0].kinds, ['guardian', 'parent']);
});

Deno.test('a DIFFERENT second guardian is a second recipient', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_kind: 'parent',   recipient_email: 'mum@x.test', recipient_name: 'Mum M' }),
    row({ recipient_kind: 'guardian', recipient_email: 'dad@x.test', recipient_name: 'Dad D' }),
  ]);
  assertEquals(out.map((r) => r.email), ['dad@x.test', 'mum@x.test'], 'both, ordered by address');
  assertEquals(out.every((r) => r.student_first_name === 'Ryan'), true);
});

Deno.test('two children in one class = ONE email naming both (the Yu Zhou bug)', () => {
  const out = groupRecipientsByAddress([
    row({ student_id: 'stu1', student_first_name: 'Ryan' }),
    row({ student_id: 'stu2', student_first_name: 'Evan' }),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].student_first_name, 'Ryan and Evan');
  assertEquals(out[0].child_count, 2);
});

Deno.test('case-different addresses are one inbox', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'Sam@X.test' }),
    row({ recipient_email: 'sam@x.test', student_id: 'stu2', student_first_name: 'Evan' }),
  ]);
  assertEquals(out.length, 1);
  assertEquals(out[0].email, 'sam@x.test');
  assertEquals(out[0].student_first_name, 'Ryan and Evan');
});

Deno.test('the account holder names the email, not whichever row came first', () => {
  const guardianFirst = groupRecipientsByAddress([
    row({ recipient_kind: 'guardian', recipient_email: 's@x.test', recipient_name: 'Guardian G' }),
    row({ recipient_kind: 'parent',   recipient_email: 's@x.test', recipient_name: 'Account Holder' }),
  ]);
  assertEquals(guardianFirst[0].name, 'Account Holder');
  // With only a guardian on file, their name is used rather than nothing.
  const guardianOnly = groupRecipientsByAddress([
    row({ recipient_kind: 'guardian', recipient_email: 'g@x.test', recipient_name: 'Guardian G' }),
  ]);
  assertEquals(guardianOnly[0].name, 'Guardian G');
});

Deno.test('waitlist rows are tagged so the operator can see what they selected', () => {
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'e@x.test', audience: 'enrolled' }),
    row({ recipient_email: 'w@x.test', audience: 'waitlist', student_id: 'stu9', student_first_name: 'Wanda' }),
  ]);
  assertEquals(out.find((r) => r.email === 'w@x.test')!.audiences, ['waitlist']);
  assertEquals(out.find((r) => r.email === 'e@x.test')!.audiences, ['enrolled']);
});

Deno.test('junk rows cannot become a send to nobody', () => {
  assertEquals(groupRecipientsByAddress([]), []);
  assertEquals(groupRecipientsByAddress(undefined as never), []);
  // A row with no address is dropped, not emailed to ''.
  assertEquals(groupRecipientsByAddress([row({ recipient_email: '   ' })]).length, 0);
  // A child with no name still counts as a child, and reads as "your child".
  const noName = groupRecipientsByAddress([row({ student_first_name: null })]);
  assertEquals(noName[0].child_count, 1);
  assertEquals(noName[0].student_first_name, 'your child');
});

Deno.test('ONE INBOX, TWO FAMILIES: never one email naming both households children', () => {
  // A grandparent minding two cousins in the same class, or a nanny listed as
  // guardian for two households. Keyed by address alone these merge and each
  // family learns the other's child's name.
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'nan@x.test', recipient_kind: 'guardian',
          parent_id: 'famA', student_id: 'kidA', student_first_name: 'Ada' }),
    row({ recipient_email: 'nan@x.test', recipient_kind: 'guardian',
          parent_id: 'famB', student_id: 'kidB', student_first_name: 'Bo' }),
  ]);
  assertEquals(out.length, 2, 'two separate pieces of business, two emails');
  const names = out.map((r) => r.student_first_name).sort();
  assertEquals(names, ['Ada', 'Bo']);
  // Neither email may mention the other household's child.
  for (const g of out) {
    assertEquals(g.child_count, 1);
    assertEquals(g.student_first_name.includes(' and '), false, 'no cross-family merge');
  }
});

Deno.test('same inbox, SAME family, both roles: still exactly one email', () => {
  // The 12-case trap again, now under the compound key - it must NOT have been
  // broken by the fix for the cross-family case.
  const out = groupRecipientsByAddress([
    row({ recipient_email: 'me@x.test', recipient_kind: 'parent',   parent_id: 'famA', student_id: 'kid1', student_first_name: 'Ryan' }),
    row({ recipient_email: 'me@x.test', recipient_kind: 'guardian', parent_id: 'famA', student_id: 'kid1', student_first_name: 'Ryan' }),
    row({ recipient_email: 'me@x.test', recipient_kind: 'parent',   parent_id: 'famA', student_id: 'kid2', student_first_name: 'Evan' }),
  ]);
  assertEquals(out.length, 1, 'one family, one inbox, one email');
  assertEquals(out[0].student_first_name, 'Ryan and Evan');
  assertEquals(out[0].child_count, 2);
});

// KNOWN LIMITATION, pinned so it cannot change silently: a child with no first
// name is COUNTED but cannot be NAMED, so the greeting names fewer children than
// child_count. Zero students on prod or staging have a blank first name
// (measured 2026-09-02) and registration requires one, so this is unreachable
// today - but if it ever happens, child_count is the honest number and callers
// should prefer it over counting names in the string.
Deno.test('a nameless child is counted even though it cannot be named', () => {
  const out = groupRecipientsByAddress([
    row({ student_id: 'kid1', student_first_name: 'Ryan' }),
    row({ student_id: 'kid2', student_first_name: null }),
  ]);
  assertEquals(out[0].child_count, 2, 'both children are accounted for');
  assertEquals(out[0].student_first_name, 'Ryan', 'and the unnamed one cannot be greeted');
});
