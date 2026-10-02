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
  parseGradesFromText,
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
  { name: 'Lake Grove Elementary', name_aliases: ['Lake Grove'], area: 'Lake Oswego' },
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

Deno.test('a left-hand "Email Opt-In" column is what first-match-wins binds', () => {
  // This is NOT the behaviour we want, it is the behaviour we have: mapRow takes
  // the first header containing "email", and a sheet whose columns are iterated
  // with Opt-In first binds the wrong one. index.ts is what catches it, by
  // requiring that at least one row's email cell contains an "@" before it will
  // write or let anything be marked synced. This test pins the shape that guard
  // is written against - if mapRow ever starts preferring an exact "email"
  // header, this fails and the guard's rationale needs rereading.
  const m = mapRow({
    'Email Opt-In': 'Yes',
    'Email': 'real@example.com',
    'Your name parent or guardian': 'A B',
  });
  assertEquals(m.email, 'Yes');
  assertEquals(m.email?.includes('@'), false);
});

Deno.test('the place question survives losing "or your city" from its wording', () => {
  // The headers are Squarespace's, not ours. When this rule required BOTH
  // "school" and "city", an edit to the question dropped the answer on the
  // floor with no signal at all - every lead filed with no school, no area.
  const m = mapRow({
    "Your child's school": 'Orenco',
    'Email': 'a@b.com',
    'Your childs grade and anything we should know': '1st grade',
  });
  assertEquals(m.school_or_city, 'Orenco');
  assertEquals(m.grade_notes, '1st grade');
});

Deno.test('a second interest question is read as well, not instead', () => {
  // The form asks twice on two axes: WHEN they want to hear from us, and WHAT
  // the child is into. First-column-wins would have silently thrown one whole
  // question away - answers arriving, nothing happening.
  const m = mapRow({
    'Email': 'a@b.com',
    'What should we tell you about': 'Winter break camps',
    'What is your child most interested in?': 'LEGO building, Robotics',
  });
  assertEquals(m.interests, 'Winter break camps, LEGO building, Robotics');
});

Deno.test('the second question still maps if its wording is changed', () => {
  // The operator owns this question's text. Several plausible rewordings must
  // all still land, because one that does not reads as nobody answering.
  for (const header of [
    'What is your child most interested in?',
    'What are your child&apos;s interests?',
    'Which topics is your child into?',
    'Favourite subjects',
  ]) {
    const m = mapRow({ 'Email': 'a@b.com', [header]: 'Robotics' });
    assertEquals(m.interests, 'Robotics', `header did not map: ${header}`);
  }
});

Deno.test('the subject tags come out of that second question', () => {
  const { tags, unmapped } = parseInterests(
    'Winter break camps, LEGO building, Robotics, Minecraft, Video game design',
  );
  assertEquals(tags, [
    'winter-break-camps', 'lego', 'robotics', 'minecraft', 'game-design',
  ]);
  assertEquals(unmapped, []);
});

Deno.test('the subject rules leave the six original options alone', () => {
  // Added after the subject rules went in: if one of them matched an existing
  // option, every past lead's tags would change meaning.
  const { tags } = parseInterests(
    "After-school at my child's school, Winter break camps, No-school-day camps, Spring break camps, Summer camps 2027, Birthday parties",
  );
  assertEquals(tags.filter((t) => ['lego', 'robotics', 'minecraft', 'game-design'].includes(t)), []);
});

Deno.test('a child-name column does not become the parent name', () => {
  const m = mapRow({
    "Your child's name": 'Donovan',
    'Your name parent or guardian': 'Sarah Granelli',
    'Email': 'a@b.com',
  });
  assertEquals(m.parent_name, 'Sarah Granelli');
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
  const { tags, unmapped } = parseInterests('Summer camps 2027, Chess club');
  assertEquals(tags, ['summer-camps-2027']);
  assertEquals(unmapped, ['Chess club']);
});

Deno.test('an option naming a subject we DO run is tagged, not reported as unknown', () => {
  // "Teen robotics league" was the unmapped example here until the subject
  // rules went in. It is a robotics interest, so it now gets the tag - which is
  // the point of matching on a keyword rather than on the exact option text.
  const { tags, unmapped } = parseInterests('Teen robotics league');
  assertEquals(tags, ['robotics']);
  assertEquals(unmapped, []);
});

Deno.test('parseInterests on an empty answer yields nothing', () => {
  assertEquals(parseInterests('').tags, []);
  assertEquals(parseInterests(null).tags, []);
});

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

Deno.test('parseGradesFromText reads a grade out of a sentence', () => {
  assertEquals(parseGradesFromText('Kindergarten'), [0]);
  assertEquals(parseGradesFromText('1st grader (Donovan), interested in robotics'), [1]);
  assertEquals(parseGradesFromText('2nd grade loves building legos'), [2]);
  assertEquals(parseGradesFromText('going into 5th'), [5]);
  assertEquals(parseGradesFromText('grade 3'), [3]);
  assertEquals(parseGradesFromText('Pre-K'), [-1]);
  assertEquals(parseGradesFromText('K, and he is shy'), [0]);
});

Deno.test('a family with two children keeps BOTH grades', () => {
  // The whole point: tagging only the first grade makes the family invisible
  // to a send aimed at the second child's year, and nothing would ever show it.
  assertEquals(parseGradesFromText('twins, K and 2'), [0, 2]);
  assertEquals(parseGradesFromText('PreK and 3rd'), [-1, 3]);
  assertEquals(parseGradesFromText('3rd and 5th'), [3, 5]);
});

Deno.test('a number that is not a grade is not read as one', () => {
  // "room 12" would otherwise tag a twelfth-grader onto a third-grader's family.
  assertEquals(parseGradesFromText('grade 3, room 12'), [3]);
  // A bare number with nothing else IS the grade - that is the "5" case.
  assertEquals(parseGradesFromText('5'), [5]);
});

Deno.test('parseGradesFromText refuses to guess', () => {
  assertEquals(parseGradesFromText(''), []);
  assertEquals(parseGradesFromText('loves building legos'), []);
  // A lone "k" inside a word must not read as Kindergarten.
  assertEquals(parseGradesFromText('knows a lot about rockets'), []);
  // A birth year is not a grade.
  assertEquals(parseGradesFromText('born 2019'), []);
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

Deno.test('a school named inside a sentence is still found', () => {
  // One comma-less piece, so the exact matcher tests the whole sentence and
  // misses. Nothing stores the sentence, so without this the school is gone
  // from enrops entirely - not just from this field.
  assertEquals(resolvePlace('we live in Portland but go to Buckman', LOCATIONS), {
    school_name: 'Buckman Elementary', city: null, geo_segment: 'Portland',
  });
});

Deno.test('a shrug is not a city', () => {
  // These used to land verbatim in the city column and show up on the contact
  // list as if they were places.
  assertEquals(resolvePlace('N/A', LOCATIONS), {
    school_name: null, city: null, geo_segment: null,
  });
  assertEquals(resolvePlace('none yet - preschool', LOCATIONS).city, null);
  assertEquals(
    resolvePlace('honestly we have not picked a school yet, still deciding', LOCATIONS).city,
    null,
  );
});

Deno.test('a real two-word city still counts as a city', () => {
  assertEquals(resolvePlace('Lake Oswego', LOCATIONS).city, 'Lake Oswego');
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
