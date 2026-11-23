// Marketing on the partner portal (20261123r).
import {
  typesText, wantedAsks, askLine, fileProblemForAsk, indexMedia, mediaKey, shareName, extOfPath, mediaGaps,
} from './partnerMarketingLogic.js';
import { partnerTodo } from './partnerTodo.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}

eq('one type', typesText(['pdf']), 'PDF');
eq('two types', typesText(['jpg', 'pdf']), 'PDF or JPG');
eq('three types, display order', typesText(['png', 'pdf', 'jpg']), 'PDF, JPG or PNG');

const flyer = { item_key: 'flyer', wanted: true, file_types: ['pdf', 'jpg'], needs_logo: true, needs_accessible: true, note: '8.5x11' };
const social = { item_key: 'social_graphic', wanted: false, file_types: ['png'] };
eq('only wanted asks, in order', wantedAsks([social, flyer]).map((a) => a.item_key), ['flyer']);
eq('ask line', askLine(flyer, 'Happy Valley'), "PDF or JPG · with Happy Valley's logo · accessible (ADA)");

const file = (name, type, size = 1000) => ({ name, type, size });
eq('accepted type', fileProblemForAsk(file('f.pdf', 'application/pdf'), flyer, 'Happy Valley'), null);
eq('type the partner did not tick', fileProblemForAsk(file('f.png', 'image/png'), flyer, 'Happy Valley'), 'Happy Valley takes PDF or JPG for a flyer.');
eq('not a usable file', fileProblemForAsk(file('f.docx', 'application/msword'), flyer), 'Use a PDF, JPG or PNG.');
eq('too big', fileProblemForAsk(file('f.pdf', 'application/pdf', 11 * 1024 * 1024), flyer), 'That file is over 10 MB. Try a smaller one.');

const rows = [
  { program_id: 'p1', camp_session_id: null, item_key: 'flyer', storage_path: 'o/a.pdf' },
  { program_id: null, camp_session_id: 'c1', item_key: 'flyer', storage_path: 'o/b.jpg' },
];
const idx = indexMedia(rows);
eq('class media keyed by kind', idx.has(mediaKey('class', 'p1', 'flyer')), true);
eq('camp media keyed by kind', idx.has(mediaKey('camp', 'c1', 'flyer')), true);

eq('share name says what it is', shareName('Robotics Builders: Carnival', 'Winter 2027', 'flyer', 'pdf'), 'Robotics Builders Carnival - Winter 2027 - Flyer.pdf');
eq('share name without a term', shareName('', '', 'social_graphic', 'png'), 'Class - Social graphic.png');
eq('ext of path', extOfPath('org/abc.JPG'), 'jpg');

const classes = [
  { kind: 'class', class_id: 'p1', status: 'open' },
  { kind: 'class', class_id: 'p2', status: 'open' },
  { kind: 'class', class_id: 'p3', status: 'cancelled' },
  { kind: 'camp', class_id: 'c1', status: 'open' },
];
eq('gaps: missing on open classes only', mediaGaps(classes, [flyer, social], rows).map((g) => [g.item.key, g.count]), [['flyer', 1]]);
eq('gaps: nothing asked, nothing missing', mediaGaps(classes, [social], rows), []);

// The provider's To do list: amber, never red, one per kind, to Classes.
const s = { business: [], instructors: { columns: [] } };
const todo = partnerTodo({ s, instructors: [], orgName: 'J2S', today: '2026-11-23', mediaGaps: mediaGaps(classes, [flyer], rows), partnerName: 'Happy Valley' });
eq('to do: one amber item', todo.map((t) => [t.key, t.tone]), [['media:flyer', 'warn']]);
eq('to do: text', todo[0]?.text, 'Happy Valley asks for a flyer on each class. 1 class still needs one.');
eq('to do: goes to Classes', todo[0]?.action, { type: 'tab', tab: 'classes', label: 'Go to Classes' });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
