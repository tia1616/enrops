import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  PLATFORM_FOOTER_TEXT,
  platformFooterUrl,
  renderPlatformFooterHtml,
  renderPlatformFooterText,
  surfaceForAutomation,
} from '../platformFooter.ts';

// The copy is pinned deliberately. src/components/PlatformFooterLine.jsx holds
// the same string for the web surfaces and cannot import from here (Vite vs
// Deno bundle roots), so this test is what catches a one-sided reword.
// If this fails because the copy legitimately changed, update BOTH files.
Deno.test('the line matches the approved copy exactly', () => {
  assertEquals(
    PLATFORM_FOOTER_TEXT,
    'Run kids enrichment programs? enrops is free for businesses',
  );
});

Deno.test('enrops stays lowercase', () => {
  assertEquals(PLATFORM_FOOTER_TEXT.includes('Enrops'), false);
});

Deno.test('surface keys resolve to the checklist src values', () => {
  assertEquals(platformFooterUrl('receipt'), 'https://getenrops.com?src=receipt');
  assertEquals(platformFooterUrl('parentPortal'), 'https://getenrops.com?src=parent-portal');
  assertEquals(platformFooterUrl('partnerRecap'), 'https://getenrops.com?src=partner-recap');
});

// Instructors are deliberately out of scope: the checklist scopes the line to
// parents and school partners.
Deno.test('instructor automations render no line', () => {
  assertEquals(surfaceForAutomation('sub_offer', 'instructors'), null);
  assertEquals(surfaceForAutomation('availability_survey', 'instructors'), null);
  assertEquals(renderPlatformFooterHtml(null), '');
  assertEquals(renderPlatformFooterText(null), '');
});

// Regression: no_school_day is stored with a families-level audience but also
// sends a tailored instructor copy. Keying off the audience column alone put
// the acquisition line in front of instructors.
Deno.test('the instructor half of a two-audience automation gets no line', () => {
  assertEquals(surfaceForAutomation('no_school_day', 'families', 'instructor'), null);
  // ...while the family half of the SAME automation still gets it.
  assertEquals(surfaceForAutomation('no_school_day', 'families', 'parent'), 'schedule');
  // Absent role must not change existing behaviour.
  assertEquals(surfaceForAutomation('no_school_day', 'families'), 'schedule');
});

Deno.test('family and partner automations map to the right surface', () => {
  assertEquals(surfaceForAutomation('welcome_camp', 'families'), 'welcome');
  assertEquals(surfaceForAutomation('welcome_afterschool', 'families'), 'welcome');
  assertEquals(surfaceForAutomation('thank_you', 'families'), 'welcome');
  assertEquals(surfaceForAutomation('no_school_day', 'families'), 'schedule');
  assertEquals(surfaceForAutomation('check_in', 'families'), 'reminder');
  assertEquals(surfaceForAutomation('partner_roster', 'partners'), 'partnerRecap');
});

Deno.test('rendered html carries the line, the arrow and the src', () => {
  const html = renderPlatformFooterHtml('welcome');
  assertEquals(html.includes('src=welcome'), true);
  assertEquals(html.includes('enrops is free for businesses'), true);
  assertEquals(html.includes('&rarr;'), true);
  // One line only - no badge graphic, no second sentence.
  assertEquals(html.includes('<img'), false);
});
