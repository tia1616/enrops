// Pins the confirm sentences shown beside the button on the move and refund panels.
// Every case is a state the drawer can actually be in; the 10/21 misfires (Micah Cho
// for Sahir Wanchoo; a refund of money meant to be kept) are why the class and the
// money must both be in the sentence.

import { rosterClassLabel, refundConfirmSentence, moveConfirmSentence, seatLabel } from './rosterActions.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}\n        got    ${a}\n        wanted ${e}`); }
}

// Class labels
eq('class: weekly, lowercase day stored', rosterClassLabel({ curriculum: 'Robotics', day_of_week: 'tuesday', site: 'Hallinan' }), 'Tuesday Robotics at Hallinan');
eq('class: no site', rosterClassLabel({ curriculum: 'Robotics', day_of_week: 'Monday' }), 'Monday Robotics');
eq('camp: day is NOT its first day', rosterClassLabel({ curriculum: 'Winter Camp', day_of_week: 'monday', class_days: ['monday', 'tuesday'], site: 'Parks' }), 'Winter Camp at Parks');
eq('empty class_days is a CLASS, keeps its day', rosterClassLabel({ curriculum: 'Art', day_of_week: 'friday', class_days: [] }), 'Friday Art');
eq('no name', rosterClassLabel({}), 'this class');

const cls = 'Tuesday Robotics at Hallinan';
// Refund drawer
eq('withdraw without refund', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'withdraw_no_refund' }),
  'Take Micah Cho out of Tuesday Robotics at Hallinan. No money goes back to the family.');
eq('refund + withdraw', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'refund', amountCents: 24000, withdraw: true }),
  'Refund $240.00 to the family\'s card and take Micah Cho out of Tuesday Robotics at Hallinan.');
eq('refund + keep', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'refund', amountCents: 5000, withdraw: false }),
  'Refund $50.00 to the family\'s card for Tuesday Robotics at Hallinan. Micah Cho keeps their spot.');
eq('refund with no seat choice yet says nothing', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'refund', amountCents: 5000, withdraw: null }), '');
eq('credit always withdraws', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'credit', amountCents: 24000, withdraw: true }),
  'Take Micah Cho out of Tuesday Robotics at Hallinan and give the family $240.00 of credit. No money leaves your Stripe balance.');
eq('credit return + keep', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'credit_return', amountCents: 9000, withdraw: false }),
  'Put $90.00 back on the family\'s credit for Tuesday Robotics at Hallinan. Micah Cho keeps their spot.');

eq('credit return with no seat choice yet says nothing', refundConfirmSentence({ studentName: 'Micah Cho', classLabel: cls, mode: 'credit_return', amountCents: 9000, withdraw: null }), '');

// Move
eq('move, same price', moveConfirmSentence({ studentName: 'Evan Stone', fromLabel: 'Monday Super Mario at Jackson', toLabel: 'Tuesday Minecraft at Jackson', paidCents: 29900, toPriceCents: 29900 }),
  'Move Evan Stone from Monday Super Mario at Jackson to Tuesday Minecraft at Jackson. No money moves.');
// The 10/19 Venter move: paid $285, new class $299.
eq('move, price differs (Venter)', moveConfirmSentence({ studentName: 'Brianna Venter', fromLabel: 'Monday LEGO at Forest Hills', toLabel: 'Wednesday Super Mario at Forest Hills', paidCents: 28500, toPriceCents: 29900 }),
  'Move Brianna Venter from Monday LEGO at Forest Hills to Wednesday Super Mario at Forest Hills. No money moves: they paid $285.00 and the new class is $299.00.');
eq('move, unknown price says no comparison', moveConfirmSentence({ studentName: 'A', fromLabel: 'X', toLabel: 'Y', paidCents: 100, toPriceCents: null }), 'Move A from X to Y. No money moves.');
eq('move, paid $0 vs price is compared', moveConfirmSentence({ studentName: 'A', fromLabel: 'X', toLabel: 'Y', paidCents: 0, toPriceCents: 29900 }), 'Move A from X to Y. No money moves: they paid $0.00 and the new class is $299.00.');

// Seats
eq('seats: left', seatLabel({ max_capacity: 14, seats_taken: 11, is_full: false }), '3 spots left');
eq('seats: one', seatLabel({ max_capacity: 14, seats_taken: 13, is_full: false }), '1 spot left');
eq('seats: full', seatLabel({ max_capacity: 14, seats_taken: 14, is_full: true }), 'Full (14 of 14)');
eq('seats: over', seatLabel({ max_capacity: 14, seats_taken: 15, is_full: true }), 'Full (15 of 14)');
eq('seats: uncapped', seatLabel({ max_capacity: null, seats_taken: 3 }), '');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
