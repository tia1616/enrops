// The server half of the early-bird deadline, pinned to the SAME moments as the
// browser half in src/lib/earlyBirdDeadline.test.mjs.
//
// These two implementations decide the same thing in two languages: this one sets
// the amount Stripe charges, the other sets the price on screen. The case list is
// deliberately identical, value for value, so a change to one that is not made to
// the other turns one of these suites red.
//
// What they are pinning: the deadline day belongs to the BUSINESS, to its last
// moment, in its own timezone. It used to end at 23:59:59 UTC, which is 3:59:59pm
// Pacific in November — so a parent buying on the last evening was charged full
// price while the business's own website still advertised the discount.

import { assert } from 'jsr:@std/assert';
import { isEarlyBirdActive } from '../promoPricing.ts';

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const PHX = 'America/Phoenix';
const DL = '2026-11-02';
const at = (iso: string) => new Date(iso);

Deno.test('the eight hours the UTC cutoff was losing', () => {
  assert(isEarlyBirdActive(DL, at('2026-11-03T07:00:00Z'), LA), '11pm Pacific counts');
  assert(isEarlyBirdActive(DL, at('2026-11-03T07:59:59Z'), LA), '11:59:59pm Pacific counts');
  assert(!isEarlyBirdActive(DL, at('2026-11-03T08:00:00Z'), LA), 'midnight Pacific does not');
  // Where the old gate died. If this fails, the UTC cutoff is back.
  assert(isEarlyBirdActive(DL, at('2026-11-03T00:01:00Z'), LA), '4:01pm Pacific counts');
});

Deno.test('ordinary days either side', () => {
  assert(isEarlyBirdActive(DL, at('2026-11-01T12:00:00Z'), LA));
  assert(isEarlyBirdActive(DL, at('2026-10-26T12:00:00Z'), LA));
  assert(!isEarlyBirdActive(DL, at('2026-11-09T12:00:00Z'), LA));
});

Deno.test('the zone is the BUSINESS, not a constant', () => {
  assert(isEarlyBirdActive(DL, at('2026-11-03T04:30:00Z'), NY), 'Eastern 11:30pm counts');
  assert(!isEarlyBirdActive(DL, at('2026-11-03T05:30:00Z'), NY), 'Eastern 12:30am does not');
  assert(isEarlyBirdActive(DL, at('2026-11-03T06:30:00Z'), PHX), 'Phoenix 11:30pm counts');
  assert(!isEarlyBirdActive(DL, at('2026-11-03T07:30:00Z'), PHX), 'Phoenix 12:30am does not');
  // One instant, two answers. An Eastern business's early bird is over while a
  // Pacific one's is still running, which is the whole point of reading the zone.
  const instant = at('2026-11-03T05:30:00Z');
  assert(!isEarlyBirdActive(DL, instant, NY) && isEarlyBirdActive(DL, instant, LA));
});

Deno.test('daylight saving, both directions', () => {
  // Clocks go BACK 2026-11-01: a 25-hour day.
  assert(isEarlyBirdActive('2026-11-01', at('2026-11-02T07:30:00Z'), LA));
  assert(!isEarlyBirdActive('2026-11-01', at('2026-11-02T08:00:00Z'), LA));
  // Clocks go FORWARD 2026-03-08: a 23-hour day. A deadline the day before ends
  // at 08:00Z (still PST); one ON that day ends at 07:00Z (now PDT). Reading the
  // offset once, at the wrong instant, gets that hour wrong.
  assert(isEarlyBirdActive('2026-03-07', at('2026-03-08T07:30:00Z'), LA));
  assert(!isEarlyBirdActive('2026-03-07', at('2026-03-08T08:00:00Z'), LA));
  assert(isEarlyBirdActive('2026-03-08', at('2026-03-09T06:59:00Z'), LA));
  assert(!isEarlyBirdActive('2026-03-08', at('2026-03-09T07:00:00Z'), LA));
});

Deno.test('month and year boundaries roll over', () => {
  assert(isEarlyBirdActive('2026-01-31', at('2026-02-01T07:30:00Z'), LA));
  assert(!isEarlyBirdActive('2026-01-31', at('2026-02-01T08:30:00Z'), LA));
  assert(isEarlyBirdActive('2026-12-31', at('2027-01-01T07:30:00Z'), LA));
  assert(!isEarlyBirdActive('2026-12-31', at('2027-01-01T08:30:00Z'), LA));
});

Deno.test('nothing to gate', () => {
  assert(!isEarlyBirdActive(null, at('2026-10-01T00:00:00Z'), LA));
  assert(!isEarlyBirdActive('', at('2026-10-01T00:00:00Z'), LA));
  assert(!isEarlyBirdActive('not-a-date', at('2026-10-01T00:00:00Z'), LA));
  assert(isEarlyBirdActive('2026-11-02T00:00:00Z', at('2026-11-03T07:00:00Z'), LA));
});

Deno.test('the default zone does not move anyone silently', () => {
  // A caller not yet handed an organisation keeps the old UTC behaviour, so
  // wiring this through stays a deliberate act per call site.
  assert(isEarlyBirdActive(DL, at('2026-11-02T23:59:00Z')));
  assert(!isEarlyBirdActive(DL, at('2026-11-03T00:00:01Z')));
});
