// Shared helper for org-scoped term lists + labels.
//
// One source of truth for "which terms does this org have, and which one
// should we default to?" Backed by the org_terms(p_org) RPC, which returns
// rows sorted chronologically with exactly one is_default=true (the term
// that's in-progress today, else the next starting, else the most-recent
// past). Surfaces that show a term dropdown should preselect that default
// instead of hardcoding a term code.
//
// Multi-tenant: always pass the caller's org id; never hardcode a tenant.

import { supabase } from "./supabase.js";

// fetchOrgTerms(orgId) -> { terms, defaultTerm }
//   terms       — the full row array from org_terms (or [] on error/empty)
//   defaultTerm — the `term` string of the is_default row (or null if none)
export async function fetchOrgTerms(orgId) {
  if (!orgId) return { terms: [], defaultTerm: null };
  const { data, error } = await supabase.rpc("org_terms", { p_org: orgId });
  if (error || !Array.isArray(data)) {
    return { terms: [], defaultTerm: null };
  }
  const defaultRow = data.find((r) => r?.is_default === true);
  return { terms: data, defaultTerm: defaultRow?.term ?? null };
}

const SEASON_LABELS = { FA: "Fall", WI: "Winter", SP: "Spring", SU: "Summer" };

const TERM_RE = /^(FA|WI|SP|SU)(\d{2})$/;

// formatTermLabel("FA26") -> "Fall 2026". Codes that don't match the
// SEASON+2-digit-year pattern come back unchanged.
export function formatTermLabel(term) {
  if (typeof term !== "string") return term;
  const m = TERM_RE.exec(term.trim());
  if (!m) return term;
  return `${SEASON_LABELS[m[1]]} 20${m[2]}`;
}

// termSeasonName("WI27") -> "Winter". null when the code isn't a term code.
// Use this instead of hardcoding a season word next to a term-driven value.
export function termSeasonName(term) {
  if (typeof term !== "string") return null;
  const m = TERM_RE.exec(term.trim());
  return m ? SEASON_LABELS[m[1]] : null;
}

// The Winter + Spring terms that complete the school year a given Fall term
// opens: "FA26" -> { winter: "WI27", spring: "SP27" }.
//
// Returns null for any non-Fall term, which is the point: a full-school-year
// bundle only exists relative to a Fall. Callers use null as "no bundle here"
// rather than pairing a Winter term with itself. Mirrors the school-year rule
// in term_to_school_year() (SQL) and termToSchoolYearJs() — FA{yy} spans
// 20{yy}-20{yy+1}, so its Winter/Spring carry the following year's number.
export function schoolYearTermsForFall(fallTerm) {
  if (typeof fallTerm !== "string") return null;
  const m = /^FA(\d{2})$/.exec(fallTerm.trim());
  if (!m) return null;
  const yy = String((Number(m[1]) + 1) % 100).padStart(2, "0");
  return { winter: `WI${yy}`, spring: `SP${yy}` };
}
