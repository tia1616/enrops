// Partner portal "Emails sent" (20261119b): the words.
import { readFileSync } from 'node:fs';
import { reminderText, sentLine } from './partnerEmails.js';

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.error(`FAIL  ${name} (got ${JSON.stringify(actual)})`); }
}

const LABEL = { insurance: 'Insurance certificate', agreement: 'Agreement' };
const doc = { subject_type: 'document', doc_type: 'insurance', about: 'Certificate of insurance', expires_on: '2027-01-17', tier: 30, sent_at: '2026-12-18T15:30:00Z', recipients: 2 };

eq('document before expiry', reminderText(doc, LABEL), 'Insurance certificate "Certificate of insurance" expires Jan 17, 2027');
eq('document on the day', reminderText({ ...doc, tier: 0 }, LABEL), 'Insurance certificate "Certificate of insurance" expired Jan 17, 2027');
eq('document with no title', reminderText({ ...doc, about: '' }, LABEL), 'Insurance certificate expires Jan 17, 2027');
eq('unknown doc type', reminderText({ ...doc, doc_type: 'other' }, LABEL), 'Document "Certificate of insurance" expires Jan 17, 2027');
eq('background check renews', reminderText({ subject_type: 'background_check', about: 'Riley Davis', expires_on: '2026-12-15', tier: 14 }, LABEL), "Riley Davis's background check renews Dec 15, 2026");
eq('background check expired', reminderText({ subject_type: 'background_check', about: 'Riley Davis', expires_on: '2026-12-15', tier: 0 }, LABEL), "Riley Davis's background check expired Dec 15, 2026");

eq('sent line, people', sentLine(doc, 'Journey to STEAM'), 'Sent Dec 18, 2026 to 2 people at Journey to STEAM');
eq('sent line, one person', sentLine({ ...doc, recipients: 1 }, 'Journey to STEAM'), 'Sent Dec 18, 2026 to 1 person at Journey to STEAM');
eq('sent line, no count', sentLine({ ...doc, recipients: 0 }), 'Sent Dec 18, 2026');

// The database decides visibility; pin the rules it must keep.
{
  const sql = readFileSync(new URL('../../supabase/migrations/20261119b_partner_portal_emails_sent.sql', import.meta.url), 'utf8');
  eq('only documents shared with this partner', sql.includes('(d.partner_id is null or d.partner_id = p_partner_id)'), true);
  eq('instructor reminders need sharing consent', sql.includes('i.partner_sharing_agreed_at is not null'), true);
  eq('instructor reminders need a class or camp at this login\'s sites', (sql.match(/pl\.partner_id = p_partner_id and \(v_sites is null or pl\.id = any\(v_sites\)\)/g) || []).length, 2);
  eq('same gate as classes', sql.includes('private.partner_portal_scope(p_partner_id)'), true);
  const returns = sql.slice(sql.indexOf('returns table('), sql.indexOf('language plpgsql'));
  eq('recipients are a count, not addresses', returns.includes('recipients integer') && !/email|address/i.test(returns), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
