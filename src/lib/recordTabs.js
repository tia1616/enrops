// Pure rules for the provider-record tabs (src/pages/partner/RecordTabs.jsx).

/** Dot for a set of status chips: red if any is bad, amber if any needs a look, none otherwise. */
export function alertFor(badges) {
  const tones = (badges ?? []).map((b) => b?.tone);
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn") || tones.includes("review")) return "attention";
  return null;
}

/**
 * The short word on the Decision tab, with its dot: null when nothing is
 * recorded. Both "accepted" kinds read "Accepted" (the tab is narrow; the full
 * wording is inside the tab).
 */
export function decisionTag(decision) {
  if (!decision) return null;
  if (decision === "accepted" || decision === "accepted_alongside_own_form") return { text: "Accepted", alert: null };
  if (decision === "not_accepted") return { text: "Not accepted", alert: "bad" };
  return { text: "Withdrawn", alert: null };
}

/**
 * The tab a #name asks for, or the first tab when it names none of these.
 * `aliases` maps a section that now lives inside a grouped tab to that tab
 * (Jessica 2026-11-25: "too many tabs"; #documents -> "safety"), so every
 * link ever sent still opens the right place.
 */
export function tabFromHash(hash, ids, aliases = {}) {
  const h = String(hash ?? "").replace(/^#/, "");
  if (ids.includes(h)) return h;
  if (Object.prototype.hasOwnProperty.call(aliases, h) && ids.includes(aliases[h])) return aliases[h];
  return ids[0];
}

/** The section a #name points at inside a grouped tab, or null (it names a whole tab or nothing). */
export function sectionFromHash(hash, ids, aliases = {}) {
  const h = String(hash ?? "").replace(/^#/, "");
  return !ids.includes(h) && Object.prototype.hasOwnProperty.call(aliases, h) && ids.includes(aliases[h]) ? h : null;
}

/** Worst dot of several: "bad" beats "attention" beats none. */
export function worstAlert(...alerts) {
  if (alerts.includes("bad")) return "bad";
  if (alerts.includes("attention")) return "attention";
  return null;
}
