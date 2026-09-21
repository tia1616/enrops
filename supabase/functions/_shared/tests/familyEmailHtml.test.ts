// The HTML half of a family message, pinned against the defect that produced it.
//
// THE DEFECT, measured on prod 2026-09-21: Message families posted only a `text`
// body to Resend, so 230 of The Ukulele Project's 405 emails in eight days went
// out with literal `**` around the words meant to be bold, and 15 sends carried
// `[words](url)` link notation - including a class safety notice that gave 29
// families the portal sign-in link as `[enrops.com/...](http://enrops.com/...)`.
//
// So the assertions below are not "does it render nicely". They are:
//   - the HTML half exists at all, and carries the formatting
//   - the PLAIN half is derived FROM the HTML, never from the operator's raw
//     text - the raw text is what holds the asterisks, and a plain half taken
//     from it would ship the exact same defect to every plain-text reader
//   - a link survives into the plain half with its destination intact
//   - a family's own name cannot break the HTML it is inserted into
//   - the shell's <title> never leaks into the plain half
//   - a caller that sends no HTML gets the old text-only email, unchanged

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { sendFamilyEmails, substitute } from '../familyNotify.ts';
import {
  FAMILY_TEST_NOTICE,
  familyMessageFooterLine,
  htmlToPlainText,
  renderFamilyMessageHtml,
} from '../familyEmailHtml.ts';

const R = (over: Record<string, unknown> = {}) => ({
  parent_id: 'p1',
  name: 'Rosemary Field',
  email: 'rosemary@example.com',
  student_first_name: 'Ada',
  ...over,
});

function fakeResend() {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const impl = ((_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      json: () => Promise.resolve({ id: 're_1' }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const send = (over: Record<string, unknown>) => {
  const { impl, calls } = fakeResend();
  return sendFamilyEmails({
    recipients: [R()],
    subject: 'A change to class',
    bodyText: '',
    from: 'Uke <hi@uke.test>',
    apiKey: 'k',
    fetchImpl: impl,
    ...over,
  }).then(() => calls[0].body);
};

Deno.test('THE DEFECT: bold reaches the reader as bold, and as clean words in plain text', async () => {
  const body = await send({
    bodyHtml: '<p>We <strong>WILL</strong> have class this week.</p>',
    orgName: 'The Ukulele Project',
  });
  assertStringIncludes(String(body.html), '<strong>WILL</strong>');
  // The half that shipped the asterisks for eight days.
  assertEquals(String(body.text).includes('**'), false, 'no markdown markers survive');
  assertStringIncludes(String(body.text), 'We WILL have class this week.');
});

Deno.test('a link keeps its destination in the plain-text half', async () => {
  const body = await send({
    bodyHtml: '<p>Sign in at <a href="https://enrops.com/uke/login">your portal</a>.</p>',
    orgName: 'The Ukulele Project',
  });
  assertStringIncludes(String(body.html), 'href="https://enrops.com/uke/login"');
  // Words AND address: stripping tags without this leaves "your portal" and
  // silently deletes where it pointed - worse than the notation it replaced.
  assertStringIncludes(String(body.text), 'your portal (https://enrops.com/uke/login)');
});

Deno.test('a link whose words ARE the address is not printed twice', () => {
  assertEquals(
    htmlToPlainText('<a href="https://uke.test">https://uke.test</a>'),
    'https://uke.test',
  );
});

Deno.test("a family called 'Tom & Kate' cannot break the HTML it lands in", async () => {
  // NOTE the shape of the name: familyVars takes the parent's FIRST WORD, so a
  // space-separated "Tom & Kate" would render as "Tom" and prove nothing. The
  // first draft of this test did exactly that and passed while asserting
  // something it never reached.
  const body = await send({
    recipients: [R({ name: 'Tom&Kate Field', student_first_name: '<script>x</script>' })],
    bodyHtml: '<p>Hi {{parent_first_name}}, about {{student_first_name}}.</p>',
    orgName: 'Uke',
  });
  const html = String(body.html);
  assertStringIncludes(html, 'Hi Tom&amp;Kate');
  assertEquals(html.includes('<script>'), false, 'a name can never open a tag');
  assertStringIncludes(html, '&lt;script&gt;');
  // The plain half decodes the entities back to what was actually typed.
  assertStringIncludes(String(body.text), 'about <script>x</script>.');
});

Deno.test('the shell title never leaks into the plain-text half', async () => {
  const body = await send({
    bodyHtml: '<p>Class is on.</p>',
    orgName: 'The Ukulele Project',
    programName: 'Richmond Ukulele Club',
  });
  // <title>The Ukulele Project</title> sits in <head>. A tag-stripper run over
  // the whole document would paste it at the top of every plain-text email.
  assertEquals(String(body.text).startsWith('Class is on.'), true, String(body.text).slice(0, 60));
  assertStringIncludes(String(body.text), 'Sent by The Ukulele Project about Richmond Ukulele Club.');
});

Deno.test('a test says so in BOTH halves, not only the subject', async () => {
  const body = await send({ bodyHtml: '<p>Hello.</p>', orgName: 'Uke', isTest: true });
  assertStringIncludes(String(body.html), FAMILY_TEST_NOTICE);
  assertStringIncludes(String(body.text), FAMILY_TEST_NOTICE);
});

Deno.test('NO HTML means the old text-only email, byte for byte', async () => {
  const body = await send({ bodyText: 'Hi {parent_first_name}, plain as ever.' });
  assertEquals(body.html, undefined, 'no html key at all');
  assertEquals(body.text, 'Hi Rosemary, plain as ever.');
});

Deno.test('an empty or whitespace bodyHtml is not HTML', async () => {
  const body = await send({ bodyHtml: '   ', bodyText: 'Plain.' });
  assertEquals(body.html, undefined);
  assertEquals(body.text, 'Plain.');
});

Deno.test('BOTH token spellings substitute, and a double brace leaves no stray brace', () => {
  const vars = { parent_first_name: 'Jo', program_name: 'Uke Club' };
  assertEquals(substitute('Hi {{parent_first_name}}!', vars), 'Hi Jo!');
  assertEquals(substitute('Hi {parent_first_name}!', vars), 'Hi Jo!');
  assertEquals(
    substitute('{{parent_first_name}} / {program_name}', vars),
    'Jo / Uke Club',
  );
  // An unknown token still survives to the reader in EITHER spelling, so a typo
  // is visible rather than silently blanked.
  assertEquals(substitute('{{nope}} {alsoNope}', vars), '{{nope}} {alsoNope}');
});

Deno.test('escaping happens on the VALUE, never on the template', () => {
  const html = substitute(
    '<p>Hi {{parent_first_name}}</p>',
    { parent_first_name: 'A & B' },
    { escape: (v) => v.replace(/&/g, '&amp;') },
  );
  // The <p> we authored is still live markup; the name is text.
  assertEquals(html, '<p>Hi A &amp; B</p>');
});

Deno.test('the footer is omitted rather than half-written when we know nothing', () => {
  assertEquals(familyMessageFooterLine({ orgName: '', programName: 'X' }), '');
  assertEquals(
    familyMessageFooterLine({ orgName: 'Uke' }),
    'Sent by Uke. Reply to this email to reach them.',
  );
});

Deno.test('a list survives into plain text as a list', () => {
  assertEquals(
    htmlToPlainText('<ul><li>Bring a ukulele</li><li>Bring a friend</li></ul>'),
    '- Bring a ukulele\n- Bring a friend',
  );
});

Deno.test('the shell is a whole document with a mobile viewport', () => {
  const html = renderFamilyMessageHtml('<p>x</p>', { orgName: 'Uke' });
  assertStringIncludes(html, '<!doctype html>');
  assertStringIncludes(html, 'width=device-width');
  assertStringIncludes(html, '<p>x</p>');
});
