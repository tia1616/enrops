// The waiting-list invite must not tell a family something we cannot know.
//
// A class that frees two seats now invites TWO families on the same tick
// (waitlist_offer_next skips anyone already holding an offer), so the second family to
// be invited is NOT at the top of the queue and is NOT being offered it first. And on a
// one-family list there is no next family to pass a lapsed place to - it goes back on
// general sale. The invite used to assert both of those things flatly.
//
// These are guardrails against the copy coming back, and they check the PLAINTEXT half
// as well as the HTML: the text body is a separate string built from separate lines, so
// a fix applied only to the markup would ship a lie to every plaintext client.

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { buildWaitlistInvite } from '../waitlistEmail.ts';

const brand = {
  org_id: 'x',
  org_name: 'Cascade Enrichment Co.',
  sender_name: 'Cascade Enrichment Co.',
  sender_email: 'hello@cascade.test',
  reply_to: 'hello@cascade.test',
  alert_email: 'alerts@cascade.test',
  tenant_alert_email: 'hello@cascade.test',
  primary_color: '#1C004F',
  page_bg_color: '#F7F5FF',
  font_family: 'Inter, sans-serif',
  logo_url: null,
} as never;

function invite() {
  return buildWaitlistInvite({
    brand,
    childFirstName: 'Wanda',
    programName: 'Game Design Studio',
    siteName: 'Maplewood Elementary',
    whenText: 'Wednesdays 3:45 PM',
    inviteUrl: 'https://enrops.com/cascade/waitlist/abc123',
    expiresAtIso: '2026-08-27T23:12:00.000Z',
    timezone: 'America/Los_Angeles',
  });
}

/** Every rendered half a family can actually read. */
function halves(): Array<[string, string]> {
  const built = invite();
  return [['html', built.html], ['text', built.text], ['subject', built.subject]];
}

Deno.test('waitlist invite claims no queue position (two families can be invited at once)', () => {
  for (const [half, body] of halves()) {
    const lower = body.toLowerCase();
    assertEquals(lower.includes('top of the waitlist'), false, `${half} claims they are top of the waitlist`);
    assertEquals(lower.includes('offering it to you first'), false, `${half} claims they were offered it first`);
    assertEquals(lower.includes('next in line'), false, `${half} claims a queue position`);
  }
});

Deno.test('waitlist invite does not promise a lapsed place goes to a next family', () => {
  for (const [half, body] of halves()) {
    const lower = body.toLowerCase();
    // False whenever this family is the only one waiting, which is the common case on a
    // short list: the place goes back into general registration, not to anybody.
    assertEquals(lower.includes('to the next family'), false, `${half} promises the place to a next family`);
    assertEquals(lower.includes('next family on the list'), false, `${half} promises the place to a next family`);
  }
});

Deno.test('waitlist invite still says the place is held, and until when, in BOTH halves', () => {
  const built = invite();
  for (const [half, body] of [['html', built.html], ['text', built.text]] as Array<[string, string]>) {
    // The hold is the reassurance that replaced "you are top of the list", so losing it
    // would leave the invite with no reason to act at all.
    assertStringIncludes(body, 'held for Wanda', `${half} no longer says the place is held for them`);
    // The deadline is the whole email. Local time, zone named - never a bare ISO stamp.
    assertStringIncludes(body, 'August 27', `${half} lost the deadline date`);
    assertStringIncludes(body, 'PDT', `${half} lost the timezone on the deadline`);
    assertEquals(body.includes('2026-08-27T23:12'), false, `${half} leaked a raw ISO deadline`);
  }
});

Deno.test('waitlist invite says what happens after the deadline without naming a recipient', () => {
  const built = invite();
  for (const [half, body] of [['html', built.html], ['text', built.text]] as Array<[string, string]>) {
    assertStringIncludes(body, 'released', `${half} does not say the place is released after the deadline`);
    assertStringIncludes(body, 'general registration', `${half} does not say where the place goes`);
  }
});
