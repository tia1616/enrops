// Pure rules for the provider-record tabs (src/pages/partner/RecordTabs.jsx).

/** Dot for a set of status chips: red if any is bad, amber if any needs a look, none otherwise. */
export function alertFor(badges) {
  const tones = (badges ?? []).map((b) => b?.tone);
  if (tones.includes("bad")) return "bad";
  if (tones.includes("warn") || tones.includes("review")) return "attention";
  return null;
}

/** The tab a #name asks for, or the first tab when it names none of these. */
export function tabFromHash(hash, ids) {
  const h = String(hash ?? "").replace(/^#/, "");
  return ids.includes(h) ? h : ids[0];
}
