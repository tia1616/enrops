// Pins how ONE automation send is reported to an operator.
//
// The bug these exist to stop is not a crash, it is a confident wrong number.
// `marketing_sends.status` folds delivery in (delivered / opened / clicked /
// bounced / sent / failed) while `automation_run_recipients` keeps it apart
// (status: sent | skipped_throttle | failed, delivery_status: delivered |
// bounced | NULL). So the obvious move — reuse CampaignDetail's aggregate(),
// which asks status === 'delivered' — matches NOTHING here and renders every
// automation as 100% sent and 0% delivered, with no error anywhere. That is
// bug class #30, and it already happened once on the contact timeline where
// the sibling table spelled the same idea `delivery`.
//
// The second thing pinned here: "sent" and "arrived" are different facts.
// Delivery receipts were 0% reliable in June and 100% from September, so most
// of the history is genuinely unknown. Reporting unknown as delivered would
// rebuild the exact lie this screen was built to kill.

import { classifyDelivery, summariseDelivery, DELIVERY_OUTCOMES, describeSendScope } from './deliveryIssues.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// --- the vocabulary trap, stated as an assertion ---------------------------
// A delivered automation row carries status 'sent' and delivery 'delivered'.
// Anything reading only `status` sees 'sent' and must NOT call that delivered.
eq('delivered is read from delivery_status, not status',
  classifyDelivery({ status: 'sent', delivery_status: 'delivered' }).key, 'delivered');
eq('bounced is read from delivery_status too',
  classifyDelivery({ status: 'sent', delivery_status: 'bounced' }).key, 'bounced');
eq('status alone never means delivered',
  classifyDelivery({ status: 'sent', delivery_status: null }).key, 'unconfirmed');

// The literal CampaignDetail shape. If someone ever points this table at that
// helper, these rows are what they would be feeding it.
ok("marketing_sends' own vocabulary is not silently accepted as delivered",
  classifyDelivery({ status: 'delivered' }).key === 'unconfirmed');

// --- no confirmation is not a failure, and not a success -------------------
eq('unconfirmed is its own outcome',
  classifyDelivery({ status: 'sent' }).key, 'unconfirmed');
ok('unconfirmed is not styled as an error',
  classifyDelivery({ status: 'sent' }).tone === 'muted');
ok('unconfirmed says why, so it does not read as a fault',
  /no delivery confirmation/i.test(classifyDelivery({ status: 'sent' }).detail));

// --- bounce beats the sent/unconfirmed split -------------------------------
// Ordering matters: a bounced row also has status 'sent'. If the unconfirmed
// branch ran first, a real bounce would be reported as merely unconfirmed.
ok('a bounce is never downgraded to unconfirmed',
  classifyDelivery({ status: 'sent', delivery_status: 'bounced' }).key !== 'unconfirmed');
ok('bounce detail is surfaced when present',
  classifyDelivery({ status: 'sent', delivery_status: 'bounced', bounce_detail: 'mailbox full' }).detail === 'mailbox full');

// --- failures defer to the existing shared rule ----------------------------
eq('a failed row is a failure, not a delivery state',
  classifyDelivery({ status: 'failed', error_message: 'Resend 422: invalid', attempts: 1 }).key, 'failed');
ok('a permanent failure is toned as needing a human',
  classifyDelivery({ status: 'failed', error_message: 'Resend 422: invalid', attempts: 1 }).tone === 'bad');
ok('a still-retrying failure is toned softer than a permanent one',
  classifyDelivery({ status: 'failed', error_message: 'Resend 500: oops', attempts: 1 }).tone === 'warn');

// --- throttle is deliberate, not a problem ---------------------------------
eq('a throttled row is skipped, not failed',
  classifyDelivery({ status: 'skipped_throttle' }).key, 'skipped');
ok('skipped is not styled as an error',
  classifyDelivery({ status: 'skipped_throttle' }).tone === 'muted');

// --- defensive: a row shape we have never seen ------------------------------
ok('an unknown status falls to unconfirmed rather than throwing',
  classifyDelivery({ status: 'something_new' }).key === 'unconfirmed');
ok('null row does not throw', classifyDelivery(null).key === 'unconfirmed');

// --- the summary must always add up ----------------------------------------
const rows = [
  { status: 'sent', delivery_status: 'delivered' },
  { status: 'sent', delivery_status: 'delivered' },
  { status: 'sent', delivery_status: 'bounced' },
  { status: 'sent', delivery_status: null },
  { status: 'sent' },
  { status: 'failed', error_message: 'Resend 422: bad', attempts: 1 },
  { status: 'skipped_throttle' },
];
const s = summariseDelivery(rows);
eq('delivered counted', s.delivered, 2);
eq('bounced counted', s.bounced, 1);
eq('unconfirmed counted', s.unconfirmed, 2);
eq('failed counted', s.failed, 1);
eq('skipped counted', s.skipped, 1);
eq('total matches the input', s.total, rows.length);
ok('every row lands in exactly one bucket',
  s.delivered + s.bounced + s.unconfirmed + s.failed + s.skipped === s.total);
ok('delivered can never exceed total', s.delivered <= s.total);
eq('empty input is zero, not a crash', summariseDelivery([]).total, 0);
eq('null input is zero, not a crash', summariseDelivery(null).total, 0);

// --- the bucket list and the classifier cannot drift apart ------------------
ok('every outcome the classifier can return is a declared outcome',
  [
    { status: 'sent', delivery_status: 'delivered' },
    { status: 'sent', delivery_status: 'bounced' },
    { status: 'sent' },
    { status: 'failed', attempts: 9 },
    { status: 'skipped_throttle' },
  ].every((r) => DELIVERY_OUTCOMES.includes(classifyDelivery(r).key)));
ok('the summary has a counter for every declared outcome',
  DELIVERY_OUTCOMES.every((k) => k in summariseDelivery([])));


// --- how much of the history is on screen --------------------------------
// The pills count only the loaded page. On prod J2S's "Welcome - camp" has 393
// recipient rows against a 200-row page, so silence here would read as "393
// sends, 12 bounced" when the 12 is out of 200.
ok('a truncated list says so, with both numbers',
  describeSendScope(200, 393).text === 'Showing the most recent 200 of 393 sends. The counts above describe these 200, not all 393.');
ok('truncation is flagged, not just worded', describeSendScope(200, 393).truncated === true);
ok('the truncated sentence scopes the COUNTS, not just the list',
  /counts above describe these 200/.test(describeSendScope(200, 393).text));

ok('a complete list makes no truncation claim', describeSendScope(12, 12).truncated === false);
eq('a complete list is just the count', describeSendScope(12, 12).text, '12 sends');
eq('one send is singular', describeSendScope(1, 1).text, '1 send');
eq('no sends reads as zero, not as truncated', describeSendScope(0, 0).text, '0 sends');

// A failed count must never be read as "that is all of them" NOR as truncation.
ok('an unknown total never claims truncation', describeSendScope(200, null).truncated === false);
eq('an unknown total falls back to what is on screen', describeSendScope(200, null).text, '200 sends');

// A failed count plus a list that came back exactly full: the cap is the likely
// reason it stopped, so "200 sends" would be a completeness claim we cannot back.
ok('a full page with no total admits there may be more',
  describeSendScope(200, null, 200).truncated === true);
ok('and says why it cannot give a number',
  /could not get a total/.test(describeSendScope(200, null, 200).text));
ok('a short page with no total is not called truncated',
  describeSendScope(7, null, 200).truncated === false);
eq('a short page with no total is just the count', describeSendScope(7, null, 200).text, '7 sends');
ok('a known total still wins over the page-cap guess',
  describeSendScope(200, 200, 200).truncated === false);
ok('an undefined total is treated as unknown', describeSendScope(5, undefined).truncated === false);

// Defensive: a count that is somehow BEHIND the list (a row deleted between the
// two queries) must not produce "showing 200 of 199".
ok('a total smaller than the list never claims truncation',
  describeSendScope(200, 199).truncated === false);
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
