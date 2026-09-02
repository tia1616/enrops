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
