// wufooTransform — turn a Wufoo form ENTRY into the contact shape that
// import-contacts already accepts, so the Wufoo sync feeds the same hardened
// upsert path (dedup, tag-union, org-stamp) instead of a second write path.
//
// Config-driven: the caller passes a field MAPPING built from the org's own
// Wufoo /fields.json (enrops target -> wufoo field id). NOTHING about any one
// tenant's form is hardcoded here. Modeled to cover Shoreview Chess's form
// (Membership Options, Student Name, USCF ID, Student Birth Date, Parent/Guardian
// Name, Primary + Emergency Phone, Email, Initials, Special Instructions), but
// works for any Wufoo form via the mapping.
//
// Wufoo entry shape: a flat object keyed by field id, e.g.
//   { "EntryId": "42", "Field1": "vip", "Field3": "Aiden", "Field4": "Bell",
//     "Field8": "mom@x.com", "DateCreated": "2026-07-02 10:00:00" }
// Wufoo "Name" fields expose their parts as separate ids (First/Last), so name
// mappings take a first id + a last id.

export interface WufooFieldMapping {
  email: string; // required — nothing imports without it
  parent_first?: string;
  parent_last?: string;
  parent_full?: string; // if the form uses a single name field instead of first/last
  child_first?: string;
  child_last?: string;
  phone?: string;
  // Fields whose VALUE becomes a tag (e.g. Membership Options -> "All-Inclusive $120").
  tag_fields?: string[];
  // Static tags applied to every synced contact (e.g. "wufoo", or a form label).
  static_tags?: string[];
}

export interface TransformedContact {
  email: string;
  parent_name: string | null;
  phone: string | null;
  child_first_name: string | null;
  child_last_name: string | null;
  tags: string[];
}

const clean = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

function joinName(...parts: string[]): string | null {
  const s = parts.filter((p) => p).join(" ").trim();
  return s === "" ? null : s;
}

// Split a possibly-multi-value cell (Wufoo checkbox groups can concatenate) into
// clean tag tokens, matching the importer's splitTags behavior.
function toTags(raw: string): string[] {
  if (!raw) return [];
  return raw.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

export function wufooEntryToContact(
  entry: Record<string, unknown>,
  mapping: WufooFieldMapping,
): TransformedContact {
  const get = (fieldId: string | undefined): string => (fieldId ? clean(entry[fieldId]) : "");

  const parent_name = mapping.parent_full
    ? (clean(entry[mapping.parent_full]) || null)
    : joinName(get(mapping.parent_first), get(mapping.parent_last));

  const tags = new Set<string>();
  for (const fid of mapping.tag_fields ?? []) {
    for (const t of toTags(get(fid))) tags.add(t);
  }
  for (const t of mapping.static_tags ?? []) {
    const trimmed = clean(t);
    if (trimmed) tags.add(trimmed);
  }

  return {
    email: get(mapping.email).toLowerCase(),
    parent_name,
    phone: get(mapping.phone) || null,
    child_first_name: get(mapping.child_first) || null,
    child_last_name: get(mapping.child_last) || null,
    tags: [...tags],
  };
}

// Map a page of Wufoo entries -> contacts, dropping rows with no usable email
// (the importer re-validates, but trimming here keeps the payload lean and the
// caller's count honest).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function wufooEntriesToContacts(
  entries: Record<string, unknown>[],
  mapping: WufooFieldMapping,
): TransformedContact[] {
  const out: TransformedContact[] = [];
  for (const e of entries ?? []) {
    const c = wufooEntryToContact(e, mapping);
    if (EMAIL_RE.test(c.email)) out.push(c);
  }
  return out;
}
