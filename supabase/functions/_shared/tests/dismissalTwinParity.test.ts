// Twin-parity guard for the dismissal line, built like rosterOrderTwinParity:
// src/lib/dismissal.js is plain ESM with no imports, so Deno executes BOTH
// copies over the same inputs and the outputs must be identical.
//
// Why the pair exists: the instructor portal, the admin roster and its CSV read
// the web copy; the rosters emailed to schools (2026-10-22) read the Deno copy.
// If they disagree, a school's PDF names a child's dismissal differently from
// the screen the instructor checks it against.
//
// If this fails: make the two files agree. Do not loosen the comparison.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { dismissalLabel as edgeLabel, dismissalSummary as edgeSummary, needsAftercareProvider as edgeNeeds } from '../rosterArrivalDismissal.ts';

const WEB = new URL('../../../../src/lib/dismissal.js', import.meta.url);
const web = await import(WEB.href);

const METHODS: unknown[] = [
  'released_to_authorized_adult', 'walks_or_bikes_home', 'bus', 'aftercare', 'other',
  null, undefined, '', 'some_future_value',
];
const PROVIDERS: unknown[] = ['Champions', '  Champions  ', '', '   ', null, undefined];

Deno.test('dismissal labels match the web copy for every value', () => {
  for (const m of METHODS) assertEquals(edgeLabel(m), web.dismissalLabel(m), `label for ${String(m)}`);
});

Deno.test('aftercare-provider rule matches the web copy', () => {
  for (const m of METHODS) assertEquals(edgeNeeds(m), web.needsAftercareProvider(m), `needs provider for ${String(m)}`);
});

Deno.test('the roster line matches the web copy for every method and provider', () => {
  for (const m of METHODS) {
    for (const p of PROVIDERS) {
      const input = { dismissal_method: m, aftercare_provider: p };
      assertEquals(edgeSummary(input), web.dismissalSummary(input), `summary for ${String(m)} / ${JSON.stringify(p)}`);
    }
  }
});

Deno.test('neither copy prints an em dash (enrops copy rule)', () => {
  const line = edgeSummary({ dismissal_method: 'aftercare', aftercare_provider: 'Champions' }) ?? '';
  assertEquals(line.includes('—'), false, line);
});
