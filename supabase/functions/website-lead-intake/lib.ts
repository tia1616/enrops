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
  { field: 'school_or_city', test: (k) => k.includes('school') && k.includes('city') },
  { field: 'grade_notes', test: (k) => k.includes('grade') },
  { field: 'interests', test: (k) => k.includes('tellyou') || k.includes('interested') },
  { field: 'parent_name', test: (k) => k.includes('name') },
  { field: 'source', test: (k) => k === 'source' },
];

// Maps a row's raw header-keyed values onto our field names. First header that
// satisfies a rule wins that field; a second header matching the same rule is
// ignored rather than overwriting (Squarespace has been known to leave an empty
// duplicate column at the end of a sheet).
export function mapRow(values: Record<string, unknown>): Partial<Record<LeadField, string>> {
  const out: Partial<Record<LeadField, string>> = {};
  for (const [header, raw] of Object.entries(values)) {
    const k = normaliseHeader(header);
    if (!k) continue;
    const rule = HEADER_RULES.find((r) => r.test(k));
    if (!rule) continue;
    if (out[rule.field] !== undefined) continue;
    out[rule.field] = String(raw ?? '').trim();
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
  { tag: 'no-school-day-camps', test: (s) => /no\s*[-]?\s*school/.test(s) },
  { tag: 'after-school', test: (s) => s.includes('after') && s.includes('school') },
  { tag: 'winter-break-camps', test: (s) => s.includes('winter') },
  { tag: 'spring-break-camps', test: (s) => s.includes('spring') },
  { tag: 'summer-camps-2027', test: (s) => s.includes('summer') },
  { tag: 'birthday-parties', test: (s) => s.includes('birthday') },
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
    const rule = INTEREST_RULES.find((r) => r.test(s));
    if (rule) {
      if (!tags.includes(rule.tag)) tags.push(rule.tag);
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
// interested in robotics", "2nd grade loves building legos". parseGrade owns
// the K=0 / Pre-K=-1 vocabulary (one rule, one place); this function's only job
// is to find the token inside the sentence and hand it over.
//
// It never guesses: a sentence with no recognisable grade returns null, because
// a wrong grade tag on a first-access send is worse than no tag.
export function parseGradeFromText(raw: unknown): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // Word forms first, for the same reason parseGrade tests them first.
  const wordMatch = text.match(/\b(pre\s*[-_]?\s*k(?:indergarten)?|kindergarten|kinder|kg)\b/i);
  if (wordMatch) return parseGrade(wordMatch[1]);
  // A bare "K" only counts when it stands alone as a word — otherwise every
  // sentence containing the letter would read as Kindergarten.
  if (/(^|\s)k(\s|$|,|\.)/i.test(text)) return parseGrade('k');

  // Then a number, optionally ordinal, optionally preceded by "grade".
  // Bounded to two digits so a year ("born 2019") cannot be read as a grade.
  const numMatch = text.match(/\b(?:grade\s*)?(\d{1,2})\s*(?:st|nd|rd|th)?\b/i);
  if (numMatch) return parseGrade(numMatch[1]);

  return null;
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

// Borrowed from marketing-draft-campaign's expandSchoolNameVariants — a parent
// types "Ainsworth elementary" and the catalog says "Ainsworth". Same list, so
// the two stay readable against each other.
const SCHOOL_SUFFIX_PATTERNS: RegExp[] = [
  /\s+elementary\s+school$/i,
  /\s+elementary$/i,
  /\s+middle\s+school$/i,
  /\s+high\s+school$/i,
  /\s+school$/i,
  /\s+academy$/i,
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
      const hits = matchLocation(piece, byVariant);
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
  let city: string | null = null;
  for (const piece of leftovers) {
    const canonicalArea = areaByLower.get(piece.toLowerCase());
    if (canonicalArea) {
      city = city ?? canonicalArea;
      geoSegment = geoSegment ?? canonicalArea;
    } else {
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
  const gt = gradeTag(parseGradeFromText(f.grade_notes));

  const tags = [WEBSITE_NOTIFY_TAG, ...interests.tags];
  if (gt) tags.push(gt);

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
