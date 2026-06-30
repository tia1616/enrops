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

// formatTermLabel("FA26") -> "Fall 2026". Codes that don't match the
// SEASON+2-digit-year pattern come back unchanged.
export function formatTermLabel(term) {
  if (typeof term !== "string") return term;
  const m = /^(FA|WI|SP|SU)(\d{2})$/.exec(term.trim());
  if (!m) return term;
  return `${SEASON_LABELS[m[1]]} 20${m[2]}`;
}
