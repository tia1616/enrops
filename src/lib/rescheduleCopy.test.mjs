// rescheduleCopy - every string "Reschedule a session" can send, checked
// against Jessica's three standing rules: never "cancel", no em dash in an
// email, and the right sentence for each case (a make-up promises a new last
// day; no make-up never does).
import {
  longDate, shortDate,
  familyRescheduledDraft, familyBackOnDraft,
  instructorRescheduledDraft, instructorBackOnDraft,
} from './rescheduleCopy.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`FAIL  ${name}`); }
}

const EM_DASH = String.fromCharCode(0x2014);
const base = { date: '2026-10-19', lastDate: '2026-11-16', nextDate: '2026-10-26', previousLastDate: '2026-11-09' };
const inst = { firstName: 'Liberty', className: 'LEGO Brickopolis', school: 'Westridge', senderName: 'Journey to STEAM' };

const all = [
  ['family makeup', familyRescheduledDraft({ ...base, makeup: true })],
  ['family no makeup', familyRescheduledDraft({ ...base, makeup: false })],
  ['family no makeup credited', familyRescheduledDraft({ ...base, makeup: false, credited: true })],
  ['family back on makeup', familyBackOnDraft({ ...base, makeup: true })],
  ['family back on', familyBackOnDraft({ ...base, makeup: false })],
  ['instructor makeup', instructorRescheduledDraft({ ...inst, ...base, makeup: true })],
  ['instructor no makeup', instructorRescheduledDraft({ ...inst, ...base, makeup: false })],
  ['instructor back on makeup', instructorBackOnDraft({ ...inst, ...base, makeup: true })],
  ['instructor back on', instructorBackOnDraft({ ...inst, ...base, makeup: false })],
];

for (const [name, d] of all) {
  const text = `${d.subject} ${d.bodyHtml ?? ''} ${d.bodyText ?? ''}`;
  ok(`${name}: never says cancel`, !/cancel/i.test(text));
  ok(`${name}: no em dash`, !text.includes(EM_DASH));
  ok(`${name}: no leftover undefined/null`, !/undefined|null/.test(text));
  ok(`${name}: names the day`, text.includes('Monday, October 19') || text.includes('Oct 19'));
}

{
  const mk = familyRescheduledDraft({ ...base, makeup: true });
  const nm = familyRescheduledDraft({ ...base, makeup: false });
  ok('make-up tells families the new last day', mk.bodyHtml.includes('Monday, November 16'));
  ok('no make-up never promises a make-up', !/make-up/i.test(nm.bodyHtml));
  ok('no make-up says when class picks back up', nm.bodyHtml.includes('Monday, October 26'));
  ok('no credit, no credit sentence', !/credit/i.test(nm.bodyHtml));
  ok('credited families are told about the credit', /credit to your account/.test(familyRescheduledDraft({ ...base, makeup: false, credited: true }).bodyHtml));
  ok('families draft uses the server merge fields', mk.bodyHtml.includes('{{parent_first_name}}') && mk.bodyHtml.includes('{{program_location}}'));
}

{
  const back = familyBackOnDraft({ ...base, makeup: true });
  ok('back on after a make-up names the original last day', back.bodyHtml.includes('Monday, November 9'));
  ok('back on without a make-up says nothing about a last day', !/last day/.test(familyBackOnDraft({ ...base, makeup: false }).bodyHtml));
}

{
  const t = instructorRescheduledDraft({ ...inst, ...base, makeup: false });
  ok('instructor no make-up gives the next class', t.bodyText.includes('Your next class is Monday, October 26'));
  ok('instructor subject leads with the short date', t.subject.startsWith('Schedule change for Oct 19'));
  ok('instructor subject adds no colon of its own', (t.subject.match(/:/g) ?? []).length === (inst.className.match(/:/g) ?? []).length);
  const noSchool = instructorRescheduledDraft({ ...inst, school: '', ...base, makeup: true });
  ok('no school name leaves no dangling "at"', !/ at :| at  /.test(noSchool.subject) && !noSchool.bodyText.includes(' at  '));
}

ok('longDate does not slide a day west of Greenwich', longDate('2026-10-19') === 'Monday, October 19');
ok('shortDate', shortDate('2026-10-19') === 'Oct 19');
ok('longDate on junk returns it unchanged', longDate('nope') === 'nope');

console.log(`\nrescheduleCopy: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
