// website-lead-intake — pure parsing half.
//
// Everything in this file is a pure function of its inputs so it can be tested
// without a database. index.ts does the auth, the reads and the writes; this
// file decides what a sheet row MEANS.
//
// The sheet is a Squarespace "Get Notified" form export. Squarespace appends
// rows directly to the sheet, so the column headers are Squarespace's and we do
// not control them. We therefore match headers by a normalised keyword rather
// than by exact string — a header that gains punctuation or a capital must not
// silently turn every lead into a blank row. When the EMAIL column cannot be
// found at all we fail the whole batch loudly (index.ts), because a batch that
// imports nothing looks exactly like a batch with nothing to import.

import { parseGrade } from '../_shared/parseGrade.ts';

// ---------------------------------------------------------------------------
// Header resolution
// ---------------------------------------------------------------------------

export type LeadField =
  | 'submitted_on'
  | 'parent_name'
  | 'email'
  | 'school_or_city'
  | 'grade_notes'
  | 'interests'
  | 'source'
  | 'synced_at';

// Lowercase, strip everything that is not a letter or digit. "Your child's
// school or your city" and "Your childs school or your city" both collapse to
// the same key, which is the point — the apostrophe is Squarespace's to change.
export function normaliseHeader(h: unknown): string {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ordered on purpose. `synced_at` is tested before anything else because it is
// the one column WE add; the rest are tested from most to least specific so a
// header containing two keywords lands on the narrower rule.
const HEADER_RULES: Array<{ field: LeadField; test: (k: string) => boolean }> = [
  { field: 'synced_at', test: (k) => k === 'syncedat' },
  { field: 'email', test: (k) => k.includes('email') },
  { field: 'submitted_on', test: (k) => k.includes('submitted') },
  // Deliberately EITHER word, not both. Requiring both made this the only
  // two-keyword rule in the table, so an edit to the question that dropped
  // "or your city" would have matched no rule at all and silently thrown the
  // answer away — every lead filed with no school and no area, with nothing
  // anywhere saying so. "grade" is excluded because the grade question is the
  // only other one that could ever carry the word "school".
  { field: 'school_or_city', test: (k) => (k.includes('school') || k.includes('city')) && !k.includes('grade') },
  { field: 'grade_notes', test: (k) => k.includes('grade') },
  { field: 'interests', test: (k) => k.includes('tellyou') || k.includes('interested') },
  // "child" excluded so that adding a "Your child's name" question to the form
  // cannot land the CHILD's name in parent_name just because it sorts first.
  { field: 'parent_name', test: (k) => k.includes('name') && !k.includes('child') },
  { field: 'source', test: (k) => k === 'source' },
];

// Fields that ACCUMULATE across every column matching their rule, instead of
// taking the first and ignoring the rest.
//
// The form asks about interest twice, on two different axes — "What should we
// tell you about" (when: after-school, winter break, birthdays) and a second
// question about what the child is into (which subject: LEGO, robotics…). Both
// produce tags, and first-column-wins would have thrown one whole question
// away: the operator adds the question, the answers arrive, and nothing at all
// happens. Joined with a comma because that is already the separator the parser
// splits options on.
const MULTI_COLUMN_FIELDS = new Set<LeadField>(['interests']);

// Maps a row's raw header-keyed values onto our field names. For single-value
// fields the first header that satisfies a rule wins and a second matching
// header is ignored rather than overwriting (Squarespace has been known to
// leave an empty duplicate column at the end of a sheet).
export function mapRow(values: Record<string, unknown>): Partial<Record<LeadField, string>> {
  const out: Partial<Record<LeadField, string>> = {};
  for (const [header, raw] of Object.entries(values)) {
    const k = normaliseHeader(header);
    if (!k) continue;
    const rule = HEADER_RULES.find((r) => r.test(k));
    if (!rule) continue;
    const value = String(raw ?? '').trim();
    const existing = out[rule.field];
    if (existing === undefined) {
      out[rule.field] = value;
      continue;
    }
    if (!MULTI_COLUMN_FIELDS.has(rule.field)) continue;
    if (!value) continue;
    out[rule.field] = existing ? `${existing}, ${value}` : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

// Same shape check import-contacts uses. Deliberately not RFC-perfect: the job
// is to drop rows with no usable address, not to adjudicate exotic ones.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseEmail(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || !EMAIL_RE.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Test rows
// ---------------------------------------------------------------------------

// Two tells, both operator-chosen so they can seed a test submission without
// it reaching a real list:
//   * a plus-tag containing "formtest"  (jessica+formtest@…)
//   * a name that starts with "TEST"
//
// The name rule is a prefix match on purpose, so "TEST", "Test row" and
// "TESTING 123" are all caught. The cost is that a real guardian whose given
// name begins with the letters t-e-s-t would be dropped; no such name is in the
// list today and the sheet keeps the row either way, so the trade is worth it.
export function isTestRow(email: string | null, parentName: string | null): boolean {
  if (email && email.toLowerCase().includes('+formtest')) return true;
  if (parentName && /^\s*test/i.test(parentName)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Interests → tags
// ---------------------------------------------------------------------------

// The form's multi-select arrives as one comma-joined string, e.g.
//   "After-school at my child's school, Winter break camps, Summer camps 2027"
//
// ORDER MATTERS. "No-school-day camps" contains the word "school", so the
// no-school rule has to be tested before anything that keys on "school"; and
// the after-school rule requires the word "after" so it cannot steal it.
const INTEREST_RULES: Array<{ tag: string; test: (s: string) => boolean }> = [
  // WHEN / WHAT KIND — "What should we tell you about".
  { tag: 'no-school-day-camps', test: (s) => /no\s*[-]?\s*school/.test(s) },
  { tag: 'after-school', test: (s) => s.includes('after') && s.includes('school') },
  { tag: 'winter-break-camps', test: (s) => s.includes('winter') },
  { tag: 'spring-break-camps', test: (s) => s.includes('spring') },
  { tag: 'summer-camps-2027', test: (s) => s.includes('summer') },
  { tag: 'birthday-parties', test: (s) => s.includes('birthday') },

  // WHICH SUBJECT — a second question on the form, asking what the child is
  // into. A different axis from the six above: "Winter break camps" is a WHEN,
  // "Robotics" is a WHAT, and a family can want both. Matched on a keyword
  // rather than the exact option text so the wording can be edited on the form
  // without silently dropping the answer.
  //
  // The four map onto what J2S actually runs: LEGO Architects / Inventors Lab /
  // Brickopolis / Toy Designers; Intro to Robotics / Robotics Explorers /
  // Builders / mBot2; Minecraft Makers; and Super Mario, Pokémon and Creative
  // Coders. Generic enough for another tenant's catalog to use the same slugs.
  { tag: 'lego', test: (s) => s.includes('lego') },
  { tag: 'robotics', test: (s) => s.includes('robot') || s.includes('mbot') },
  { tag: 'minecraft', test: (s) => s.includes('minecraft') },
  { tag: 'game-design', test: (s) => s.includes('game') || s.includes('coding') || s.includes('mario') || s.includes('pok') },
];

// Every tag this form can produce, so a caller can offer them as a target list
// without waiting for a submission to exist. Kept next to the rules that emit
// them so the two cannot drift.
export const INTEREST_TAGS: readonly string[] = INTEREST_RULES.map((r) => r.tag);

// The tag every row from this form carries. "All website_notify" is a send to
// this one tag.
export const WEBSITE_NOTIFY_TAG = 'website-notify';

export interface InterestParse {
  tags: string[];
  // Pieces we could not map. Returned rather than dropped: the day Squarespace
  // adds a seventh checkbox, this is how we find out — a silently ignored
  // option would look exactly like nobody ticking it.
  unmapped: string[];
}

export function parseInterests(raw: unknown): InterestParse {
  const tags: string[] = [];
  const unmapped: string[] = [];
  const text = String(raw ?? '').trim();
  if (!text) return { tags, unmapped };

  for (const piece of text.split(/[,;\n]+/)) {
    const p = piece.trim();
    if (!p) continue;
    const s = p.toLowerCase();
    // EVERY rule a piece satisfies, not just the first. The real form joins its
    // checkboxes with commas so one piece is normally one option — but a person
    // typing "After school and no school days" into one line means both, and
    // taking only the first match would drop half their answer with no trace
    // (it is not "unmapped" either, because a rule DID match). The rules are
    // written narrowly enough that a genuine single option still yields one tag.
    const hits = INTEREST_RULES.filter((r) => r.test(s));
    if (hits.length > 0) {
      for (const rule of hits) if (!tags.includes(rule.tag)) tags.push(rule.tag);
    } else {
      unmapped.push(p);
    }
  }
  return { tags, unmapped };
}

// ---------------------------------------------------------------------------
// Grade → tag
// ---------------------------------------------------------------------------

// The grade column is free text — "Kindergarten", "1st grader (Donovan),
// interested in robotics", "2nd grade loves building legos", "twins, K and 2".
// parseGrade owns the K=0 / Pre-K=-1 vocabulary (one rule, one place); this
// function's only job is to find the grades inside the sentence and hand each
// one over.
//
// IT RETURNS EVERY GRADE IT FINDS, not the first. A family with two children
// writes "PreK and 3rd", and tagging only the PreK would quietly make that
// family invisible to a third-grade send — a miss nobody would ever notice,
// because the contact looks perfectly well-formed.
//
// It still never guesses: a sentence with no recognisable grade returns [],
// because a wrong grade tag on a first-access send is worse than no tag.
export function parseGradesFromText(raw: unknown): number[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const found: number[] = [];
  const add = (g: number | null) => {
    if (g !== null && !found.includes(g)) found.push(g);
  };

  // Word forms first, for the same reason parseGrade tests them first.
  for (const m of text.matchAll(/\b(pre\s*[-_]?\s*k(?:indergarten)?|kindergarten|kinder|kg)\b/gi)) {
    add(parseGrade(m[1]));
  }
  // A bare "K" only counts when it stands alone as a word — otherwise every
  // sentence containing the letter would read as Kindergarten.
  if (/(^|[\s,(])k([\s,.)]|$)/i.test(text)) add(parseGrade('k'));

  // Then the numbers. A NUMBER ALONE IS NOT A GRADE: "grade 3, room 12" must
  // not tag a twelfth-grader. A digit counts only when the text says it is a
  // grade — an ordinal suffix ("5th"), the word grade before it ("grade 3") —
  // or when it is the only number in the answer, which is the "5" case.
  const numMatches = [...text.matchAll(/\b(?:(grade|grader|grades)\s*)?(\d{1,2})\s*(st|nd|rd|th)?\b/gi)];
  const soleNumber = numMatches.length === 1;
  for (const m of numMatches) {
    const qualified = Boolean(m[1]) || Boolean(m[3]) || soleNumber;
    if (qualified) add(parseGrade(m[2]));
  }

  return found;
}

// -1 → grade-PreK, 0 → grade-K, n → grade-n. Matches the tags already applied
// by hand to the first two leads ("grade-K", "grade-1").
export function gradeTag(grade: number | null): string | null {
  if (grade === null) return null;
  if (grade === -1) return 'grade-PreK';
  if (grade === 0) return 'grade-K';
  return `grade-${grade}`;
}

// ---------------------------------------------------------------------------
// School / city → school_name + city + geo_segment
// ---------------------------------------------------------------------------

export interface LocationRow {
  name: string;
  name_aliases: string[] | null;
  area: string | null;
}

export interface PlaceResolution {
  school_name: string | null;
  city: string | null;
  geo_segment: string | null;
}

// A parent types "Ainsworth elementary" and the catalog says "Ainsworth".
//
// THIS IS A COPY of marketing-draft-campaign's SCHOOL_SUFFIX_PATTERNS, kept
// character-for-character in step with it on purpose: that function decides who
// a school-targeted CAMPAIGN reaches, this one decides what school_name a lead
// is filed under, and if the two lists disagree a lead can be filed under a
// name the campaign will not look for. The first draft of this file had six of
// its eleven patterns and claimed to be "the same list" — a location called
// "Lincoln Charter School" would have been found by the campaign and missed
// here. They live in separate edge functions (separate deploy units), so this
// is a copy rather than a shared import; if you change one, change both.
const SCHOOL_SUFFIX_PATTERNS: RegExp[] = [
  /\s+elementary\s+school$/i,
  /\s+elementary$/i,
  /\s+middle\s+school$/i,
  /\s+middle$/i,
  /\s+high\s+school$/i,
  /\s+charter\s+school$/i,
  /\s+charter$/i,
  /\s+magnet\s+school$/i,
  /\s+magnet$/i,
  /\s+academy$/i,
  /\s+school$/i,
];

function variants(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  const out = new Set<string>([trimmed.toLowerCase()]);
  for (const re of SCHOOL_SUFFIX_PATTERNS) {
    const stripped = trimmed.replace(re, '').trim();
    if (stripped && stripped.toLowerCase() !== trimmed.toLowerCase()) out.add(stripped.toLowerCase());
  }
  return [...out];
}

// Resolve the one free-text "your child's school or your city" answer.
//
// The answer is often BOTH, comma-separated ("Ainsworth elementary, Portland"),
// so each comma-separated piece is tried as a school first and whatever is left
// over is treated as the city.
//
// geo_segment comes from program_locations.area — the same source the
// registration trigger (auto_add_registrant_to_marketing_list) uses, so a lead
// and a registrant land in the same area bucket and one area filter finds both.
// When the answer names no school we still resolve geo_segment if the text IS
// an area we operate in, which is how "Beaverton" becomes both city and area.
//
// AMBIGUITY FAILS TO CITY, NOT TO A GUESS: if a name matches locations sitting
// in two different areas we record no school and no area, because a wrong area
// silently mis-targets a send.
export function resolvePlace(raw: unknown, locations: LocationRow[]): PlaceResolution {
  const text = String(raw ?? '').trim();
  if (!text) return { school_name: null, city: null, geo_segment: null };

  // name/alias variant -> the locations it can mean.
  const byVariant = new Map<string, LocationRow[]>();
  const areaByLower = new Map<string, string>();
  for (const loc of locations) {
    const names = [loc.name, ...(loc.name_aliases ?? [])].filter((n): n is string => !!n && !!n.trim());
    for (const n of names) {
      for (const v of variants(n)) {
        const list = byVariant.get(v) ?? [];
        list.push(loc);
        byVariant.set(v, list);
      }
    }
    const area = (loc.area ?? '').trim();
    if (area) areaByLower.set(area.toLowerCase(), area);
  }

  const pieces = text.split(',').map((p) => p.trim()).filter(Boolean);

  let schoolName: string | null = null;
  let geoSegment: string | null = null;
  const leftovers: string[] = [];

  for (const piece of pieces) {
    if (schoolName === null) {
      const hits = matchLocation(piece, byVariant) ?? matchLocationInSentence(piece, byVariant);
      if (hits) {
        const areas = new Set(hits.map((h) => (h.area ?? '').trim()).filter(Boolean));
        if (areas.size === 1) {
          // Prefer the shortest catalog name among the matches so
          // "Ainsworth elementary" records as "Ainsworth" rather than
          // "Ainsworth Elementary School" — both exist for this org.
          schoolName = [...hits].map((h) => h.name).sort((a, b) => a.length - b.length)[0];
          geoSegment = [...areas][0];
        }
        // areas.size !== 1 -> genuinely ambiguous. Fall through: this piece
        // becomes a leftover and the row keeps no school and no area.
        if (schoolName !== null) continue;
      }
    }
    leftovers.push(piece);
  }

  // Whatever was not the school is the city. If it names an area we operate in
  // and we have no area yet, it also sets geo_segment.
  //
  // A PARAGRAPH HAS NO CITY IN IT. Judging each comma-piece on its own is not
  // enough — "honestly we have not picked a school yet, still deciding" ends in
  // a two-word fragment that passes every per-piece test and lands "still
  // deciding" in the city column. So the whole answer is judged too: past a
  // handful of words it is prose, and prose yields no city. Recognised areas
  // are exempt, because those are matched against the catalog rather than
  // guessed at.
  const wholeAnswerIsProse = text.split(/\s+/).length > 6;
  let city: string | null = null;
  for (const piece of leftovers) {
    const canonicalArea = areaByLower.get(piece.toLowerCase());
    if (canonicalArea) {
      city = city ?? canonicalArea;
      geoSegment = geoSegment ?? canonicalArea;
    } else if (!wholeAnswerIsProse && looksLikeAPlaceName(piece)) {
      city = city ?? piece;
    }
  }

  return { school_name: schoolName, city, geo_segment: geoSegment };
}

// Collect the locations matched by EVERY variant of what the parent typed, not
// just the first variant that hits. "Ainsworth elementary" strips to
// "ainsworth", and this org has both an "Ainsworth" row and an "Ainsworth
// Elementary School" row: stopping at the first hit would pick whichever
// spelling happened to match first, so the caller could not see that the two
// are the same place in the same area.
// Placeholders and prose are NOT cities. Without this, "N/A" and "we live in
// Portland but go to Buckman" both land verbatim in the city column, which then
// shows up as a city on the operator's contact list and in any city-shaped
// export. A city is short: if the leftover reads like a sentence or like a
// shrug, record nothing rather than record rubbish.
const CITY_PLACEHOLDERS = new Set([
  'n/a', 'na', 'none', 'none yet', 'no', 'nope', 'unknown', 'tbd', 'not sure',
  'not applicable', '-', '--', '?', 'x', 'idk',
]);
// A shrug with a clause tacked on is still a shrug: "none yet - preschool",
// "not sure yet", "no school yet". Matched on the OPENING word so the tail does
// not rescue it.
const CITY_NEGATION_OPENERS = /^(n\/?a|none|no|not|unknown|tbd|idk|nothing|undecided)\b/i;

function looksLikeAPlaceName(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (CITY_PLACEHOLDERS.has(t.toLowerCase())) return false;
  if (CITY_NEGATION_OPENERS.test(t)) return false;
  // A real city name is at most a few words ("Lake Oswego", "Oregon City",
  // "Forest Grove"). Anything longer is the parent telling us a story.
  if (t.split(/\s+/).length > 4) return false;
  // Must contain a letter — "12", "???" are not places.
  return /[a-z]/i.test(t);
}

// Exact match: every variant of what the parent typed, against every variant of
// every catalog name.
function matchLocation(piece: string, byVariant: Map<string, LocationRow[]>): LocationRow[] | null {
  const hits: LocationRow[] = [];
  const seen = new Set<LocationRow>();
  for (const v of variants(piece)) {
    for (const loc of byVariant.get(v) ?? []) {
      if (seen.has(loc)) continue;
      seen.add(loc);
      hits.push(loc);
    }
  }
  return hits.length > 0 ? hits : null;
}

// LAST RESORT: the parent answered in a sentence. "we live in Portland but go
// to Buckman" is one comma-less piece, so the exact matcher above tests the
// whole sentence, misses, and the school is lost — and because nothing stores
// the sentence, it is lost from enrops entirely, not just from this field.
//
// So when the exact pass finds nothing, look for a catalog name INSIDE the
// text. Two constraints keep this from inventing matches: the name has to
// appear on whole-word boundaries (so "OES" cannot be found inside "shoes"),
// and resolvePlace still refuses the result unless every location it matched
// sits in ONE area. Only ever reached after an exact match has failed.
function matchLocationInSentence(piece: string, byVariant: Map<string, LocationRow[]>): LocationRow[] | null {
  const haystack = ` ${piece.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  if (haystack.trim().split(/\s+/).length < 2) return null; // not a sentence
  const hits: LocationRow[] = [];
  const seen = new Set<LocationRow>();
  for (const [variant, locs] of byVariant) {
    const needle = ` ${variant.replace(/[^a-z0-9]+/g, ' ').trim()} `;
    if (needle.trim() === '' || !haystack.includes(needle)) continue;
    for (const loc of locs) {
      if (seen.has(loc)) continue;
      seen.add(loc);
      hits.push(loc);
    }
  }
  return hits.length > 0 ? hits : null;
}

// ---------------------------------------------------------------------------
// One row -> the contact we want
// ---------------------------------------------------------------------------

export interface ParsedLead {
  email: string;
  parent_name: string | null;
  school_name: string | null;
  city: string | null;
  geo_segment: string | null;
  tags: string[];
  unmapped_interests: string[];
}

export type RowVerdict =
  | { kind: 'lead'; lead: ParsedLead }
  | { kind: 'skip'; reason: 'test_row' | 'invalid_email' };

export function parseLeadRow(
  values: Record<string, unknown>,
  locations: LocationRow[],
): RowVerdict {
  const f = mapRow(values);
  const email = normaliseEmail(f.email);
  const parentName = (f.parent_name ?? '').trim() || null;

  // Test check runs on the RAW email text too, so a test row whose address is
  // malformed still reports as a test row rather than as bad data.
  if (isTestRow(email ?? String(f.email ?? ''), parentName)) {
    return { kind: 'skip', reason: 'test_row' };
  }
  if (!email) return { kind: 'skip', reason: 'invalid_email' };

  const place = resolvePlace(f.school_or_city, locations);
  const interests = parseInterests(f.interests);

  const tags = [WEBSITE_NOTIFY_TAG, ...interests.tags];
  for (const g of parseGradesFromText(f.grade_notes)) {
    const gt = gradeTag(g);
    if (gt) tags.push(gt);
  }

  return {
    kind: 'lead',
    lead: {
      email,
      parent_name: parentName,
      school_name: place.school_name,
      city: place.city,
      geo_segment: place.geo_segment,
      tags: [...new Set(tags)],
      unmapped_interests: interests.unmapped,
    },
  };
}

// Two sheet rows can carry the same address (a family submits twice). Collapse
// them into ONE contact before touching the database: first non-null wins per
// field, tags union. Last-wins would quietly discard the more complete of two
// answers, and two inserts would collide on the unique index.
export function mergeLeads(a: ParsedLead, b: ParsedLead): ParsedLead {
  return {
    email: a.email,
    parent_name: a.parent_name ?? b.parent_name,
    school_name: a.school_name ?? b.school_name,
    city: a.city ?? b.city,
    geo_segment: a.geo_segment ?? b.geo_segment,
    tags: [...new Set([...a.tags, ...b.tags])],
    unmapped_interests: [...new Set([...a.unmapped_interests, ...b.unmapped_interests])],
  };
}
