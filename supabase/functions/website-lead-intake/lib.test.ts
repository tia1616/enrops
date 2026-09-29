// Unit tests for the parsing half of website-lead-intake.
//
// The three rows in "J2S Get Notified Submissions" as of 2026-09-29 are used as
// golden cases, because the first two of them were ALSO entered into
// marketing_recipients by hand — so the hand entry is the spec, and these
// assertions are literally "does the parser reproduce what a human decided the
// answer was".

import { assertEquals } from 'https://deno.land/std@0.177.0/testing/asserts.ts';
import {
  gradeTag,
  isTestRow,
  mapRow,
  mergeLeads,
  normaliseEmail,
  parseGradeFromText,
  parseInterests,
  parseLeadRow,
  resolvePlace,
  type LocationRow,
} from './lib.ts';

// A slice of J2S's real program_locations, including the two Ainsworth rows
// that genuinely both exist on prod.
const LOCATIONS: LocationRow[] = [
  { name: 'Ainsworth', name_aliases: [], area: 'Portland' },
  { name: 'Ainsworth Elementary School', name_aliases: [], area: 'Portland' },
  { name: 'Buckman Elementary', name_aliases: ['Buckman', 'Buckman Elementary School'], area: 'Portland' },
  { name: 'Hiteon', name_aliases: [], area: 'Beaverton' },
  { name: 'Orenco', name_aliases: [], area: 'Hillsboro' },
  { name: 'Camas P&R: Lacamas Lodge', name_aliases: ['Lacamas Lodge'], area: 'Camas' },
  { name: 'testing', name_aliases: [], area: null },
];

const HEADERS = {
  submitted: 'Submitted On',
  name: 'Your name parent or guardian',
  email: 'Email',
  place: 'Your childs school or your city',
  grade: 'Your childs grade and anything we should know',
  interests: 'What should we tell you about',
  source: 'Source',
};

function sheetRow(
  name: string, email: string, place: string, grade: string, interests: string,
): Record<string, unknown> {
  return {
    [HEADERS.submitted]: '2026-09-29',
    [HEADERS.name]: name,
    [HEADERS.email]: email,
    [HEADERS.place]: place,
    [HEADERS.grade]: grade,
    [HEADERS.interests]: interests,
    [HEADERS.source]: 'notify-page',
    synced_at: '',
  };
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

Deno.test('mapRow reads Squarespace\'s headers', () => {
  const m = mapRow(sheetRow('A B', 'a@b.com', 'Hiteon', 'K', 'Summer camps 2027'));
  assertEquals(m.parent_name, 'A B');
  assertEquals(m.email, 'a@b.com');
  assertEquals(m.school_or_city, 'Hiteon');
  assertEquals(m.grade_notes, 'K');
  assertEquals(m.interests, 'Summer camps 2027');
  assertEquals(m.synced_at, '');
});

Deno.test('mapRow tolerates an apostrophe or a capital appearing in a header', () => {
  const m = mapRow({
    "Your Child's School or Your City": 'Orenco',
    'E-Mail': 'x@y.com',
    "Your child's grade and anything we should know": '2nd',
  });
  assertEquals(m.school_or_city, 'Orenco');
  assertEquals(m.email, 'x@y.com');
  assertEquals(m.grade_notes, '2nd');
});

Deno.test('mapRow does not mistake the no-school column for the after-school one', () => {
  // "school" appears in BOTH the place column and the grade column header;
  // the place rule needs "city" too, so neither steals the other.
  const m = mapRow(sheetRow('A B', 'a@b.com', 'Beaverton', '1st grade', 'Winter break camps'));
  assertEquals(m.school_or_city, 'Beaverton');
  assertEquals(m.grade_notes, '1st grade');
});

// ---------------------------------------------------------------------------
// Email + test rows
// ---------------------------------------------------------------------------

Deno.test('normaliseEmail lowercases and rejects junk', () => {
  assertEquals(normaliseEmail('  Faizamohame@Gmail.com '), 'faizamohame@gmail.com');
  assertEquals(normaliseEmail('not-an-email'), null);
  assertEquals(normaliseEmail(''), null);
  assertEquals(normaliseEmail(null), null);
});

Deno.test('isTestRow catches the two operator tells and nothing else', () => {
  assertEquals(isTestRow('jessica+formtest@journeytosteam.com', 'Jessica'), true);
  assertEquals(isTestRow('JESSICA+FormTest@x.com', 'Jessica'), true);
  assertEquals(isTestRow('real@x.com', 'TEST Row'), true);
  assertEquals(isTestRow('real@x.com', 'test submission'), true);
  assertEquals(isTestRow('real@x.com', 'Rebecca Von Dollen'), false);
  assertEquals(isTestRow('rebecca+camp@x.com', 'Rebecca Von Dollen'), false);
});

// ---------------------------------------------------------------------------
// Interests
// ---------------------------------------------------------------------------

Deno.test('parseInterests maps every option the form offers', () => {
  const { tags, unmapped } = parseInterests(
    "After-school at my child's school, Winter break camps, No-school-day camps, Spring break camps, Summer camps 2027, Birthday parties",
  );
  assertEquals(tags, [
    'after-school',
    'winter-break-camps',
    'no-school-day-camps',
    'spring-break-camps',
    'summer-camps-2027',
    'birthday-parties',
  ]);
  assertEquals(unmapped, []);
});

Deno.test('"No-school-day camps" does not read as after-school', () => {
  assertEquals(parseInterests('No-school-day camps').tags, ['no-school-day-camps']);
  assertEquals(parseInterests('No school day camps').tags, ['no-school-day-camps']);
});

Deno.test('an option we have no rule for is reported, not silently dropped', () => {
  const { tags, unmapped } = parseInterests('Summer camps 2027, Teen robotics league');
  assertEquals(tags, ['summer-camps-2027']);
  assertEquals(unmapped, ['Teen robotics league']);
});

Deno.test('parseInterests on an empty answer yields nothing', () => {
  assertEquals(parseInterests('').tags, []);
  assertEquals(parseInterests(null).tags, []);
});

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

Deno.test('parseGradeFromText reads a grade out of a sentence', () => {
  assertEquals(parseGradeFromText('Kindergarten'), 0);
  assertEquals(parseGradeFromText('1st grader (Donovan), interested in robotics'), 1);
  assertEquals(parseGradeFromText('2nd grade loves building legos'), 2);
  assertEquals(parseGradeFromText('going into 5th'), 5);
  assertEquals(parseGradeFromText('grade 3'), 3);
  assertEquals(parseGradeFromText('Pre-K'), -1);
  assertEquals(parseGradeFromText('K, and he is shy'), 0);
});

Deno.test('parseGradeFromText refuses to guess', () => {
  assertEquals(parseGradeFromText(''), null);
  assertEquals(parseGradeFromText('loves building legos'), null);
  // A lone "k" inside a word must not read as Kindergarten.
  assertEquals(parseGradeFromText('knows a lot about rockets'), null);
});

Deno.test('gradeTag spells the tag the way the list already spells it', () => {
  assertEquals(gradeTag(0), 'grade-K');
  assertEquals(gradeTag(1), 'grade-1');
  assertEquals(gradeTag(-1), 'grade-PreK');
  assertEquals(gradeTag(null), null);
});

// ---------------------------------------------------------------------------
// School / city / area
// ---------------------------------------------------------------------------

Deno.test('a bare city resolves to city + area, no school', () => {
  assertEquals(resolvePlace('Beaverton', LOCATIONS), {
    school_name: null, city: 'Beaverton', geo_segment: 'Beaverton',
  });
});

Deno.test('"Ainsworth elementary, Portland" resolves to the school and its area', () => {
  // Both "Ainsworth" and "Ainsworth Elementary School" exist for this org and
  // both sit in Portland, so the area is unambiguous and the shorter catalog
  // name wins — which is what was entered by hand for this lead.
  assertEquals(resolvePlace('Ainsworth elementary, Portland', LOCATIONS), {
    school_name: 'Ainsworth', city: 'Portland', geo_segment: 'Portland',
  });
});

Deno.test('an alias resolves like the name it aliases', () => {
  assertEquals(resolvePlace('Lacamas Lodge', LOCATIONS), {
    school_name: 'Camas P&R: Lacamas Lodge', city: null, geo_segment: 'Camas',
  });
});

Deno.test('a place we do not operate in is kept as a city with no area', () => {
  assertEquals(resolvePlace('Salem', LOCATIONS), {
    school_name: null, city: 'Salem', geo_segment: null,
  });
});

Deno.test('a location with no area contributes no area', () => {
  assertEquals(resolvePlace('testing', LOCATIONS), {
    school_name: null, city: 'testing', geo_segment: null,
  });
});

Deno.test('a school name that spans two areas is not guessed at', () => {
  const ambiguous: LocationRow[] = [
    { name: 'Jackson', name_aliases: [], area: 'Hillsboro' },
    { name: 'Jackson', name_aliases: [], area: 'Portland' },
  ];
  assertEquals(resolvePlace('Jackson', ambiguous), {
    school_name: null, city: 'Jackson', geo_segment: null,
  });
});

Deno.test('an empty answer resolves to nothing at all', () => {
  assertEquals(resolvePlace('', LOCATIONS), {
    school_name: null, city: null, geo_segment: null,
  });
});

// ---------------------------------------------------------------------------
// Whole rows — the golden cases
// ---------------------------------------------------------------------------

Deno.test('golden: Rebecca reproduces the tags entered by hand', () => {
  const v = parseLeadRow(
    sheetRow(
      'Rebecca Von Dollen', 'wolfson.rebecca@gmail.com', 'Beaverton', 'Kindergarten',
      'Winter break camps, No-school-day camps, Summer camps 2027',
    ),
    LOCATIONS,
  );
  if (v.kind !== 'lead') throw new Error('expected a lead');
  assertEquals(v.lead.email, 'wolfson.rebecca@gmail.com');
  assertEquals(v.lead.parent_name, 'Rebecca Von Dollen');
  assertEquals(v.lead.school_name, null);
  assertEquals(v.lead.city, 'Beaverton');
  assertEquals(v.lead.geo_segment, 'Beaverton');
  assertEquals([...v.lead.tags].sort(), [
    'grade-K', 'no-school-day-camps', 'summer-camps-2027', 'website-notify', 'winter-break-camps',
  ]);
});

Deno.test('golden: Sarah reproduces the tags entered by hand', () => {
  const v = parseLeadRow(
    sheetRow(
      'Sarah Granelli', 'sarah.e.granelli@gmail.com', 'Ainsworth elementary, Portland',
      '1st grader (Donovan), interested in robotics',
      "After-school at my child's school, Winter break camps, No-school-day camps, Spring break camps, Summer camps 2027, Birthday parties",
    ),
    LOCATIONS,
  );
  if (v.kind !== 'lead') throw new Error('expected a lead');
  assertEquals(v.lead.school_name, 'Ainsworth');
  assertEquals(v.lead.geo_segment, 'Portland');
  assertEquals([...v.lead.tags].sort(), [
    'after-school', 'birthday-parties', 'grade-1', 'no-school-day-camps',
    'spring-break-camps', 'summer-camps-2027', 'website-notify', 'winter-break-camps',
  ]);
});

Deno.test('golden: Faiza', () => {
  const v = parseLeadRow(
    sheetRow('Faiza Mohamed', 'Faizamohame@gmail.com', 'Hillsboro', '2nd grade loves building legos', 'Summer camps 2027'),
    LOCATIONS,
  );
  if (v.kind !== 'lead') throw new Error('expected a lead');
  assertEquals(v.lead.email, 'faizamohame@gmail.com');
  assertEquals(v.lead.city, 'Hillsboro');
  assertEquals(v.lead.geo_segment, 'Hillsboro');
  assertEquals([...v.lead.tags].sort(), ['grade-2', 'summer-camps-2027', 'website-notify']);
});

Deno.test('a test row is skipped before anything else happens to it', () => {
  const byName = parseLeadRow(sheetRow('TEST Person', 'real.person@gmail.com', 'Beaverton', 'K', 'Summer camps 2027'), LOCATIONS);
  assertEquals(byName.kind === 'skip' && byName.reason, 'test_row');
  const byEmail = parseLeadRow(sheetRow('Jessica V', 'jessica+formtest@journeytosteam.com', 'Beaverton', 'K', ''), LOCATIONS);
  assertEquals(byEmail.kind === 'skip' && byEmail.reason, 'test_row');
});

Deno.test('a row with no usable address is skipped, not written', () => {
  const v = parseLeadRow(sheetRow('No Email', '', 'Beaverton', 'K', 'Summer camps 2027'), LOCATIONS);
  assertEquals(v.kind === 'skip' && v.reason, 'invalid_email');
});

Deno.test('two rows for one address collapse to one contact, keeping both answers', () => {
  const first = parseLeadRow(
    sheetRow('Dana Lee', 'dana@example.com', 'Beaverton', 'Kindergarten', 'Winter break camps'),
    LOCATIONS,
  );
  const second = parseLeadRow(
    sheetRow('', 'DANA@example.com', 'Hiteon', '', 'Birthday parties'),
    LOCATIONS,
  );
  if (first.kind !== 'lead' || second.kind !== 'lead') throw new Error('expected two leads');
  assertEquals(first.lead.email, second.lead.email);

  const merged = mergeLeads(first.lead, second.lead);
  assertEquals(merged.parent_name, 'Dana Lee');
  // First non-null wins per field, so the first row's city survives and the
  // second row's school fills the blank it left.
  assertEquals(merged.city, 'Beaverton');
  assertEquals(merged.school_name, 'Hiteon');
  assertEquals([...merged.tags].sort(), [
    'birthday-parties', 'grade-K', 'website-notify', 'winter-break-camps',
  ]);
});
