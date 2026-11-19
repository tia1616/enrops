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

/** The tab a #name asks for, or the first tab when it names none of these. */
export function tabFromHash(hash, ids) {
  const h = String(hash ?? "").replace(/^#/, "");
  return ids.includes(h) ? h : ids[0];
}
