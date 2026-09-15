// Twin-parity guard for the gas-bonus sentence, in the spirit of
// roomLabelTwinParity.test.ts and platformFooterTwinParity.test.ts.
//
// This pair CANNOT be executed on both sides the way roomLabel's can. The Deno
// half is a function in _shared/offerCopy.ts; the browser half is a literal
// inside InstructorPortal.jsx, a React file Deno cannot import. So this is a text
// guard, and it deliberately checks the narrow thing rather than the whole
// sentence -- the two surfaces word it differently ON PURPOSE:
//
//   email  (offerCopy.ts)        "Includes a $50 distance bonus, paid with your last class."
//   portal (InstructorPortal)    "+ $50 distance bonus, paid with your last class"
//
// What must never drift is the TIMING CLAUSE. The gas bonus pays on the LAST
// class the instructor teaches for that program (v_effective_pay_lines
// .is_final_session, read by pay-instructor, live on prod 15 Sept). An instructor
// told a bare "+ $50 distance bonus" who then watches week one's pay land without
// it has been told something true in a way that misleads. If one surface says
// when and the other does not, the instructor gets the misleading half.
//
// THE SECOND HALF OF THIS FILE IS THE MORE IMPORTANT HALF. Camps must NOT carry
// this clause: a camp's gas rides its single end-of-camp payout, so "your last
// class" is the wrong mental model for a one-week camp. offerCopy.ts says so in
// a comment, and a comment is not a gate -- on 2026-09-15 I read a grep of
// offer-reminders-cron, saw its CAMP renderer still using the old wording, and
// was one edit away from "fixing" it. That cron is dual-mode: buildReminderHtml
// is camps, buildProgramReminderHtml is after-school. Only the second one is
// this sentence.
//
// If this fails: make the two after-school surfaces agree, or leave camps alone.
// Do not loosen the comparison.
import { assertEquals, assert } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import { distanceBonusNote } from '../offerCopy.ts';

// The clause, written once here. Both surfaces must contain it verbatim.
const TIMING = 'distance bonus, paid with your last class';

const read = async (rel: string) =>
  await Deno.readTextFile(new URL(rel, import.meta.url));

Deno.test('the shared email sentence carries the timing clause', () => {
  const s = distanceBonusNote('$50');
  assert(s.includes(TIMING), `expected the timing clause in: ${s}`);
  // Pinned whole, so a reword is a deliberate act and shows in the diff.
  assertEquals(s, 'Includes a $50 distance bonus, paid with your last class.');
});

Deno.test('the amount is interpolated, not hardcoded', () => {
  assert(distanceBonusNote('$25').includes('$25'));
  assert(!distanceBonusNote('$25').includes('$50'));
});

Deno.test("the instructor portal's after-school card carries the same clause", async () => {
  const portal = await read('../../../../src/pages/portal/InstructorPortal.jsx');
  assert(portal.includes(TIMING),
    'InstructorPortal.jsx no longer says when the gas bonus arrives; the email says it and the portal must too');
});

Deno.test('every AFTER-SCHOOL sender says when', async () => {
  for (const fn of ['send-afterschool-offers', 'send-afterschool-patch-offer', 'offer-reminders-cron']) {
    const src = await read(`../../${fn}/index.ts`);
    assert(src.includes('distanceBonusNote'),
      `${fn} renders a gas bonus without the shared sentence`);
  }
});

Deno.test('CAMP senders do NOT carry the after-school timing', async () => {
  // A camp's gas rides one end-of-camp payout. "Your last class" is the wrong
  // model for a one-week camp, so these keep their own wording on purpose.
  for (const fn of ['send-offers', 'send-patch-offer']) {
    const src = await read(`../../${fn}/index.ts`);
    assert(!src.includes(TIMING),
      `${fn} is a CAMP sender and must not promise "your last class"`);
    assert(!src.includes('distanceBonusNote'),
      `${fn} is a CAMP sender and must not import the after-school sentence`);
  }
});

Deno.test("the reminder cron's CAMP half is still separate from its after-school half", async () => {
  const src = await read('../../offer-reminders-cron/index.ts');
  // Both renderers must still exist and be distinct. If someone collapses them,
  // camps inherit the after-school sentence silently.
  assert(src.includes('function buildReminderHtml'), 'camp reminder renderer is gone');
  assert(src.includes('function buildProgramReminderHtml'), 'after-school reminder renderer is gone');
  // The camp renderer's own bonus line must not use the shared sentence. Slice
  // from the camp renderer to the after-school one and check only that region,
  // so the after-school half's legitimate use cannot satisfy this by accident.
  const start = src.indexOf('function buildReminderHtml');
  const end = src.indexOf('function buildProgramReminderHtml');
  assert(start > -1 && end > start, 'could not isolate the camp renderers');
  const campRegion = src.slice(start, end);
  assert(campRegion.includes('distance_bonus_cents'), 'camp renderers no longer show a bonus at all - re-check this guard');
  assert(!campRegion.includes('distanceBonusNote'),
    'the CAMP reminder renderer now uses the after-school sentence; a camp is one week, not a term');
});
