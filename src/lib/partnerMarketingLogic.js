// Marketing on the partner portal (20261123r): what a partner asks for per
// class (a flyer, a social graphic), the provider's files against those asks,
// and the partner's logo. Pure, so it is tested without Supabase.
//
// Never part of compliance: nothing here feeds providerSummary, the
// requirements count, the Decision or any red status.

import { storedExtension } from "./providerDocumentLogic.js";

export const MARKETING_ITEMS = [
  { key: "flyer", label: "Flyer", lower: "a flyer" },
  { key: "social_graphic", label: "Social graphic", lower: "a social graphic" },
];
export const FILE_TYPES = [
  { key: "pdf", label: "PDF" },
  { key: "jpg", label: "JPG" },
  { key: "png", label: "PNG" },
];

// What "accessible (ADA)" asks of a flyer, in a line a provider can act on.
export const ACCESSIBLE_HINT =
  "Real text, not a picture of text; strong contrast; 12 pt or larger; alt text on images.";

export const itemOf = (key) => MARKETING_ITEMS.find((i) => i.key === key) ?? { key, label: key, lower: key };

/** "PDF or JPG", "PDF, JPG or PNG". */
export function typesText(types) {
  const labels = FILE_TYPES.filter((t) => (types || []).includes(t.key)).map((t) => t.label);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** The asks a partner has switched on, in display order. */
export function wantedAsks(asks) {
  const on = new Map((asks || []).filter((a) => a.wanted).map((a) => [a.item_key, a]));
  return MARKETING_ITEMS.filter((i) => on.has(i.key)).map((i) => on.get(i.key));
}

/** One line saying what the partner wants for this item. */
export function askLine(ask, partnerName = "the partner") {
  if (!ask) return "";
  return [
    typesText(ask.file_types),
    ask.needs_logo ? `with ${partnerName}'s logo` : null,
    ask.needs_accessible ? "accessible (ADA)" : null,
  ].filter(Boolean).join(" · ");
}

/** A reason this file can't be used for this ask, or null when it fits. */
export function fileProblemForAsk(file, ask, partnerName = "The partner") {
  if (!file) return null;
  const ext = storedExtension(file);
  if (!ext) return "Use a PDF, JPG or PNG.";
  if (!(ask?.file_types || []).includes(ext)) {
    return `${partnerName} takes ${typesText(ask?.file_types)} for ${itemOf(ask?.item_key).lower}.`;
  }
  if (file.size > 10 * 1024 * 1024) return "That file is over 10 MB. Try a smaller one.";
  return null;
}

export const mediaKey = (kind, classId, itemKey) => `${kind}:${classId}:${itemKey}`;

/** class_media rows -> Map of mediaKey -> row. */
export function indexMedia(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const kind = r.program_id ? "class" : "camp";
    m.set(mediaKey(kind, r.program_id ?? r.camp_session_id, r.item_key), r);
  }
  return m;
}

/** "Robotics Builders - Winter 2027 - Flyer.pdf": a name that says what it is when forwarded. */
export function shareName(classTitle, termLabel, itemKey, ext) {
  const clean = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = [clean(classTitle) || "Class", clean(termLabel), itemOf(itemKey).label].filter(Boolean);
  return `${parts.join(" - ")}.${ext || "pdf"}`;
}

/** The extension a stored path ends in. */
export function extOfPath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * What the partner asked for that isn't on a class yet, per item: [{ item, count }].
 * Cancelled classes don't count.
 */
export function mediaGaps(classes, asks, media) {
  const idx = media instanceof Map ? media : indexMedia(media);
  return wantedAsks(asks).map((a) => ({
    item: itemOf(a.item_key),
    count: (classes || []).filter((c) => c.status !== "cancelled" && !idx.has(mediaKey(c.kind, c.class_id, a.item_key))).length,
  })).filter((g) => g.count > 0);
}
