// What a program's day pays at. The whole point of these is the MONEY case:
// a camp must not resolve to the after-school rate, and a weekly class must
// still resolve to exactly what it always did.

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { campNeedsSessionType, programSessionType } from '../programPay.ts';

Deno.test('a weekly class pays after_school, and does not read session_type', () => {
  assertEquals(programSessionType({ class_days: null }), 'after_school');
  assertEquals(programSessionType({}), 'after_school');
  assertEquals(programSessionType(null), 'after_school');
  assertEquals(programSessionType(undefined), 'after_school');
  // Even if a stray value is sitting on the column, a class is a class.
  assertEquals(
    programSessionType({ class_days: null, session_type: 'full_day' }),
    'after_school',
  );
});

Deno.test('an EMPTY class_days is a class, not a camp', () => {
  // The CHECK constraint permits '{}' (array_length('{}',1) is NULL and a CHECK
  // passes on NULL), and an empty array means CLASS. Reading "not null therefore
  // camp" is the bug isCampProgram exists to stop; it has been made twice.
  assertEquals(programSessionType({ class_days: [] }), 'after_school');
  assertEquals(campNeedsSessionType({ class_days: [] }), false);
});

Deno.test('a camp pays what it declared', () => {
  assertEquals(
    programSessionType({ class_days: ['monday', 'tuesday'], session_type: 'full_day' }),
    'full_day',
  );
  assertEquals(
    programSessionType({ class_days: ['monday'], session_type: 'morning' }),
    'morning',
  );
  assertEquals(
    programSessionType({ class_days: ['monday'], session_type: 'afternoon' }),
    'afternoon',
  );
  // Legal in the CHECK and priced like one, even though the builder offers it
  // on no screen.
  assertEquals(
    programSessionType({ class_days: ['monday'], session_type: 'after_school' }),
    'after_school',
  );
});

Deno.test('THE MONEY CASE: a camp that declared nothing is null, never after_school', () => {
  // $60 vs $160 a day on J2S's configured card. Four days of a full-day camp is
  // $240 instead of $640, and nothing errors on the way.
  const camp = { class_days: ['monday', 'tuesday', 'wednesday', 'thursday'] };
  assertEquals(programSessionType(camp), null);
  assertEquals(programSessionType({ ...camp, session_type: null }), null);
  assertEquals(programSessionType({ ...camp, session_type: '' }), null);
  assertEquals(programSessionType({ ...camp, session_type: '   ' }), null);
  assertEquals(campNeedsSessionType(camp), true);
});

Deno.test('a value the rate card has no cell for is null, not passed through', () => {
  // resolvePayAmount would return null for it anyway, but this row's
  // session_type is ALSO written to session_delivery_confirmations, whose CHECK
  // allows only the four. Passing it through would fail the insert instead of
  // refusing cleanly.
  assertEquals(
    programSessionType({ class_days: ['monday'], session_type: 'all_day' }),
    null,
  );
  assertEquals(
    programSessionType({ class_days: ['monday'], session_type: 'Full_Day' }),
    null,
  );
  assertEquals(programSessionType({ class_days: ['monday'], session_type: 7 }), null);
});

Deno.test('whitespace around a real value is tolerated', () => {
  assertEquals(
    programSessionType({ class_days: ['monday'], session_type: ' full_day ' }),
    'full_day',
  );
});

Deno.test('campNeedsSessionType is true ONLY for an undeclared camp', () => {
  assertEquals(campNeedsSessionType({ class_days: null }), false);
  assertEquals(campNeedsSessionType({ class_days: ['monday'], session_type: 'morning' }), false);
  assertEquals(campNeedsSessionType({ class_days: ['monday'] }), true);
  assertEquals(campNeedsSessionType({ class_days: ['monday'], session_type: 'nonsense' }), true);
});
