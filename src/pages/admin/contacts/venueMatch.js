// venueMatch.js — shared client-side matching used by the "Needs linking"
// reconciliation section. Mirrors the suffix-stripping logic in the
// import-partners-write edge function (normName / normSchoolName) so the UI
// proposes the same matches the importer would, keeping one source of truth
// for "which partner owns this venue".
//
// This is PROPOSAL ONLY. Nothing here writes — the operator confirms every
// link in the UI. Ambiguous or weak matches are surfaced, never auto-applied.

export function normName(s) {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const SUFFIXES = [
  'elementary school', 'middle school', 'high school', 'charter school',
  'summer camp',
  'elementary', 'academy', 'school', 'church',
  'sun', 'k 8', 'k 12', 'k8', 'k12', 'pre k', 'prek',
];

// Strip well-known suffix words so "Ainsworth Elementary" (partner) lines up
// with "Ainsworth" (venue). Conservative: only strip the known list; if
// stripping empties the string, fall back to the plain normalized name.
export function normSchoolName(s) {
  let n = normName(s);
  if (!n) return n;
  let changed = true;
  while (changed) {
    changed = false;
    for (const sfx of SUFFIXES) {
      if (n === sfx) break;
      if (n.endsWith(' ' + sfx)) {
        n = n.slice(0, -sfx.length - 1).trim();
        changed = true;
        break;
      }
    }
  }
  return n || normName(s);
}

// Score a single (venue, partner) pair. Returns a confidence tier so the UI
// can pre-select strong matches and merely suggest weak ones.
//   'exact'  — normalized names identical
//   'strong' — suffix-stripped names identical (+ bonus if area agrees)
//   'weak'   — one name contains the other's stem (needs a human look)
//   null     — no relationship
export function scorePair(venue, partner) {
  const vn = normName(venue.name);
  const pn = normName(partner.partner_name);
  if (!vn || !pn) return null;
  if (vn === pn) return 'exact';

  const vs = normSchoolName(venue.name);
  const ps = normSchoolName(partner.partner_name);
  if (vs && vs === ps) return 'strong';

  // Weak: stems overlap as whole-word prefixes (avoids "art" matching "arthur").
  if (vs && ps && (vs.startsWith(ps + ' ') || ps.startsWith(vs + ' '))) return 'weak';
  return null;
}

const TIER_RANK = { exact: 3, strong: 2, weak: 1 };

// For one orphan venue, rank all partners and return candidates best-first.
// areaMatch is surfaced (not used to gate) so the operator sees why we picked.
export function proposeMatches(venue, partners) {
  const out = [];
  for (const p of partners) {
    const tier = scorePair(venue, p);
    if (!tier) continue;
    const areaMatch =
      !!venue.area && !!p.location_area &&
      venue.area.trim().toLowerCase() === p.location_area.trim().toLowerCase();
    out.push({ partner: p, tier, areaMatch });
  }
  out.sort((a, b) => {
    if (TIER_RANK[b.tier] !== TIER_RANK[a.tier]) return TIER_RANK[b.tier] - TIER_RANK[a.tier];
    if (a.areaMatch !== b.areaMatch) return a.areaMatch ? -1 : 1;
    return a.partner.partner_name.localeCompare(b.partner.partner_name);
  });
  return out;
}

// A venue is "confidently matched" when there is exactly one strong/exact
// candidate (so the UI can pre-select it). Multiple strong candidates, or
// only-weak candidates, require an explicit operator choice.
export function bestConfident(candidates) {
  const strong = candidates.filter((c) => c.tier === 'exact' || c.tier === 'strong');
  if (strong.length === 1) return strong[0];
  return null;
}
