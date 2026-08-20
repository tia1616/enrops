// Renders both waitlist emails so the TEXT half can be read as a family reads it.
//
// The plaintext half is written as prose in waitlistEmail.ts rather than stripped from
// the HTML, and the only way to know it stayed readable is to look at it. The HTML
// preview always looks fine; the text half is where run-together fragments hide.
//
// Run: deno run --allow-env supabase/functions/_shared/tests/waitlistEmail.render.ts

import { buildWaitlistInvite, buildWaitlistLapsed } from '../waitlistEmail.ts';

const brand = {
  org_id: 'x',
  org_name: 'Cascade Enrichment Co.',
  sender_name: 'Cascade Enrichment Co.',
  sender_email: 'hello@cascade.test',
  reply_to: 'hello@cascade.test',
  alert_email: 'alerts@cascade.test',
  tenant_alert_email: 'hello@cascade.test',
  primary_color: '#1C004F',
  page_bg_color: '#F7F5FF',
  font_family: 'Inter, sans-serif',
  logo_url: null,
} as never;

const invite = buildWaitlistInvite({
  brand,
  childFirstName: 'Wanda',
  programName: 'Game Design Studio: Make Your First Game',
  siteName: 'Maplewood Elementary',
  whenText: 'Wednesdays 3:45 PM',
  inviteUrl: 'https://enrops.com/tenant-two-test/waitlist/abc123',
  expiresAtIso: '2026-08-20T21:41:58.365Z',
  timezone: 'America/Los_Angeles',
});

// BOTH branches, because the two say materially different things and only one can be
// true for any given family. Say each out loud against the state that selects it.
const lapsedWithQueue = buildWaitlistLapsed({
  brand,
  childFirstName: 'Tomas',
  programName: 'Game Design Studio: Make Your First Game',
  siteName: 'Maplewood Elementary',
  catalogUrl: 'https://enrops.com/tenant-two-test',
  nextInLine: true,
});

const lapsedEmptyQueue = buildWaitlistLapsed({
  brand,
  childFirstName: 'Tomas',
  programName: 'Game Design Studio: Make Your First Game',
  siteName: 'Maplewood Elementary',
  catalogUrl: 'https://enrops.com/tenant-two-test',
  nextInLine: false,
});

for (
  const [label, built] of [
    ['INVITE', invite],
    ['LAPSED (someone is next)', lapsedWithQueue],
    ['LAPSED (nobody waiting - seat went back on sale)', lapsedEmptyQueue],
  ] as const
) {
  console.log(`\n========== ${label} : SUBJECT ==========`);
  console.log(built.subject);
  console.log(`\n========== ${label} : TEXT/PLAIN ==========`);
  console.log(built.text);
  const emDash = built.subject.includes('—') || built.text.includes('—') || built.html.includes('—');
  console.log(`\n[${label}] em dash anywhere: ${emDash}`);
}
