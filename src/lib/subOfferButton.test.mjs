// Every branch of the send button, asserted in the state that selects it.
// A button that says "Resend" to somebody who was never emailed, or "Send
// offer" while three people are already holding the day, tells the operator
// they are in a different situation from the one they are actually in.
import { offerButtonLabel, offerSentMessage } from './subOfferButton.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL  ${name}`); }
}
function eq(name, actual, expected) {
  ok(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

const nameOf = (id) => ({ 'i-ann': 'Ann', 'i-bo': 'Bo', 'i-cy': 'Cy' }[id] ?? '?');
const label = (over = {}) => offerButtonLabel({
  selectedIds: [], nameOf, resendCount: 0, othersPending: 0, sending: false, noDate: false, ...over,
});

// --- nothing picked, or no day chosen ---
eq('nobody ticked', label(), 'Send offer');
eq('no date yet, even with people ticked',
  label({ selectedIds: ['i-ann'], noDate: true }), 'Send offer');

// --- one person ---
eq('one person, first ask', label({ selectedIds: ['i-ann'] }), 'Send offer to Ann');
eq('one person, already emailed -> resend',
  label({ selectedIds: ['i-ann'], resendCount: 1 }), 'Resend to Ann');
eq('one person while somebody else holds the day -> ALSO',
  label({ selectedIds: ['i-ann'], othersPending: 1 }), 'Also ask Ann');
// A resend outranks "also": the act is about THIS person's existing offer.
eq('resend wins over also',
  label({ selectedIds: ['i-ann'], resendCount: 1, othersPending: 2 }), 'Resend to Ann');

// --- several people ---
eq('several people are counted, never named',
  label({ selectedIds: ['i-ann', 'i-bo'] }), 'Send offer to 2 people');
ok('several people: nobody is named',
  !label({ selectedIds: ['i-ann', 'i-bo'] }).includes('Ann'));
eq('several people while somebody else holds the day',
  label({ selectedIds: ['i-ann', 'i-bo', 'i-cy'], othersPending: 1 }), 'Also ask 3 people');

// --- REVIEW: a resend HIDING INSIDE a multi-select ---
// Found by an independent reviewer. "Is this a resend?" used to be a yes/no
// that only existed when exactly one person was ticked, so ticking Ann (emailed
// yesterday) alongside Bo and Cy read "Send offer to 3 people" — a first-ask
// sentence — and Ann got a second identical email with nothing on screen
// admitting it. The count is what makes the sentence able to be true.
eq('all of them already hold an offer',
  label({ selectedIds: ['i-ann', 'i-bo'], resendCount: 2 }), 'Resend to 2 people');
eq('SOME of them already hold an offer',
  label({ selectedIds: ['i-ann', 'i-bo', 'i-cy'], resendCount: 1 }), 'Ask 2 more, resend to 1');
ok('a mixed round never reads as a plain first ask',
  label({ selectedIds: ['i-ann', 'i-bo', 'i-cy'], resendCount: 1 }) !== 'Send offer to 3 people');
// A resend is about the people TICKED; othersPending is about everybody else,
// and must not turn a resend back into "also ask".
eq('resends outrank others-pending in the plural too',
  label({ selectedIds: ['i-ann', 'i-bo'], resendCount: 2, othersPending: 3 }), 'Resend to 2 people');

// --- in flight ---
eq('sending outranks everything', label({ selectedIds: ['i-ann'], sending: true }), 'Sending…');
eq('sending with nobody ticked', label({ sending: true }), 'Sending…');

// --- the success line reports what REALLY went ---
eq('nothing sent', offerSentMessage([]), 'Nothing was sent.');
eq('null is not a send', offerSentMessage(null), 'Nothing was sent.');
eq('one send names the address',
  offerSentMessage([{ recipient: 'ann@x.com' }]), 'Offer sent to ann@x.com.');
ok('several sends count them and say what happens next',
  offerSentMessage([{ recipient: 'a@x' }, { recipient: 'b@x' }])
    === 'Offer sent to 2 people. The first to accept gets the day.');
// The count comes from what the FUNCTION reported, not from what was ticked -
// a round can stop partway, and the operator must be told the real number.
ok('a partial round reports the people actually reached',
  offerSentMessage([{ recipient: 'a@x' }, { recipient: 'b@x' }]).startsWith('Offer sent to 2'));

console.log(`\nsubOfferButton: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
