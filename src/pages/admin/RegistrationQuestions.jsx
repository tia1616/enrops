// /admin/registration-questions — the registration form builder.
//
// Lets an operator choose what their registration form asks families. Two kinds
// of question, one ordered list:
//   1. STANDARD questions — platform-defined types wired to structured storage
//      (second guardian, how the child leaves, who can pick up, who must NOT be
//      released to, emergency contact, how-heard). Toggle on/off + mandatory/
//      optional + label override. Safety questions default on.
//   2. CUSTOM questions — the operator's own questions (text/dropdown/etc.),
//      e.g. "does your child have music experience?".
//
// Both are rows in `custom_reg_fields` (org-scoped). standard_key IS NOT NULL for
// standard questions, NULL for custom. Absence of a row (or is_active=false) for
// a standard question = it's OFF. The registration form (built in a later chunk)
// reads active rows via get_active_registration_fields().
//
// Multi-tenant: every query is org-scoped via `org.id`; no hardcoded tenant.
// Owner/admin can edit; staff/viewer see a read-only view (settings gate).

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { allChoices, offeredChoices, DEFAULT_OFFERED } from "../../lib/dismissal.js";
import { buildRegUrl } from "../../lib/regLinks.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const CREAM = "#FBFBFB";
const OK_GREEN = "#2f7d32";
const RED = "#a13a3a";
const AMBER = "#8a6d1a";

// The platform's standard questions. `key` = custom_reg_fields.standard_key.
// `alwaysRequired` questions can't be made optional (they're safety-critical).
// `sensitive` questions carry a privacy note. Order here = default sort order.
const STANDARD_FIELDS = [
  {
    key: "guardian_secondary",
    label: "Second parent or guardian",
    desc: "Name, email, and phone for a second guardian. The person who registers is always the first guardian.",
    defaultRequired: false,
  },
  {
    key: "dismissal_method",
    label: "How does your child leave?",
    desc: "You choose which ways of leaving families can pick from.",
    defaultRequired: true,
    alwaysRequired: true,
    // The ONLY standard question whose answers a provider chooses. Declared as
    // data rather than special-cased in the save, so a second question that
    // needs choices later follows the same path instead of growing another
    // branch. The list itself comes from src/lib/dismissal.js, so Settings can
    // never offer an answer the registration form or the database would refuse.
    answerChoices: allChoices(),
  },
  {
    key: "authorized_pickup",
    label: "Besides the parent(s) listed in registration, who else is allowed to pick up your child?",
    desc: "Extra people besides the parent/guardians (first and last name). Parents and guardians can always pick up. Asked when the child is released to an adult.",
    defaultRequired: true,
    alwaysRequired: true,
  },
  {
    key: "do_not_release",
    label: "Anyone we should NOT release your child to?",
    desc: "Optional, for custody or safety situations. Shown to you, your staff, and the child's instructors (for safe dismissal) — never to other families.",
    defaultRequired: false,
    sensitive: true,
  },
];

// Fields your registration form always asks (built in — not configurable here).
// Shown read-only so the builder reflects the whole form, not just the extras.
const ALWAYS_ON = [
  "Child's name, grade, and birth date",
  "Homeroom teacher",
  "Allergies and medical notes",
  "Emergency contact",
  "Parent / guardian name, email, and phone",
  "How did you hear about us?",
];

const STD_KEYS = STANDARD_FIELDS.map((f) => f.key);
const stdFieldKey = (key) => `std_${key}`;

// How a class reads in this page's pickers. ONE place, so the scope picker and
// the preview's class picker can't start naming the same class differently.
const programLabel = (p) =>
  `${p?.curriculum || "Class"}${p?.day_of_week ? ` (${p.day_of_week}s)` : ""}`;

// "Only on <class>" — or null when every family is asked. Said in TWO places
// (the custom-questions list and the preview's ordered list), so it lives here:
// they were drifting already, one naming the class by curriculum alone and the
// other by curriculum + day.
//
// Deny-list on purpose: ONLY the literal 'all' means every family. The live
// CHECK also allows 'enrollment_type', and the column is nullable
// (`text DEFAULT 'all'`, no NOT NULL) — while
// get_active_registration_fields() matches `applies_to = 'all' OR (applies_to =
// 'program' AND ...)`, so an 'enrollment_type' OR NULL row is dropped from the
// form entirely. Coercing either to 'all' would announce it as a question every
// family answers when in fact nobody is ever asked it, so both fall through to
// the scoped sentence. Unreachable today (this page and the quick builder only
// ever write 'all' or 'program'; 0 non-'all'/'program' and 0 NULL rows on either
// env) — which is exactly when a fail-open default goes unnoticed.
// The SAVED state of the standard section, as staged state. Extracted from
// load() because the unsaved-changes warning has to compare against exactly what
// load() would have seeded — a second copy of this logic would drift and the
// warning would either cry wolf or stay silent on a real change.
function seedStdFromRows(rows) {
  const byStd = {};
  for (const r of rows ?? []) if (r.standard_key) byStd[r.standard_key] = r;
  const seeded = {};
  for (const f of STANDARD_FIELDS) {
    const row = byStd[f.key];
    seeded[f.key] = {
      // Existing rows keep their saved state (J2S and any org that already
      // configured its form are untouched). For a brand-new org with no row,
      // the safety-critical fields (alwaysRequired: dismissal + pickup) start
      // ON so the builder shows them pre-selected; saving activates them. This
      // is what the section copy promises.
      enabled: row ? row.is_active !== false : !!f.alwaysRequired,
      required: f.alwaysRequired ? true : (row ? !!row.is_required : f.defaultRequired),
      label: row?.label ?? f.label,
      // Which answers this provider offers. Seeded THROUGH offeredChoices so
      // the builder shows exactly what the registration form will render -
      // including its fallbacks. Reading row.options.offered raw would let
      // Settings display a stale or unknown value the form silently drops,
      // and the two screens would disagree about the live configuration.
      offered: f.answerChoices
        ? offeredChoices(row?.options).map((c) => c.value)
        : null,
    };
  }
  return seeded;
}

// What the REGISTRATION FORM actually asks today, in the same shape as staged
// state. Identical to seedStdFromRows EXCEPT for `enabled`, and that one field is
// the whole point:
//
//   - seedStdFromRows pre-selects the safety questions (alwaysRequired) for an
//     org with no row, because the section promises "they start on — review them
//     and Save to add them to your form". That is a PROPOSAL, not the truth.
//   - the form asks a question only when an ACTIVE ROW EXISTS. No row = not asked.
//
// Comparing staged state against the seed would therefore report a brand-new org
// as having nothing unsaved, while its panel lists two safety questions the form
// does not ask — the same lie the drawing told, in the case that matters most
// (a provider setting up for the first time).
function savedStdTruth(rows) {
  const proposed = seedStdFromRows(rows);
  const byStd = {};
  for (const r of rows ?? []) if (r.standard_key) byStd[r.standard_key] = r;
  const truth = {};
  for (const f of STANDARD_FIELDS) {
    const row = byStd[f.key];
    truth[f.key] = { ...proposed[f.key], enabled: row ? row.is_active !== false : false };
  }
  return truth;
}

// Has the operator got standard questions this panel shows but the form does not
// ask — whether from an unsaved toggle or from never having saved the
// pre-selected defaults?
//
// `offered` is compared as a SET, not a sequence: the checkbox handler APPENDS
// (`[...offered, value]`) while the seed arrives in canonical CHOICES order, so
// unticking a choice and re-ticking it yields the same answers in a different
// order. That saves and renders identically, so calling it "unsaved changes"
// would be crying wolf — and a warning that fires when nothing changed is one
// people learn to ignore.
function stdHasUnsavedChanges(std, rows) {
  const saved = savedStdTruth(rows);
  return STANDARD_FIELDS.some((f) => {
    const a = std?.[f.key];
    const b = saved[f.key];
    if (!a) return false;           // not seeded yet; nothing staged to lose
    if (!!a.enabled !== !!b.enabled) return true;
    // Off in both: nothing about it reaches the form, so a stray label edit on a
    // question nobody is asked is not something to warn about. (saveStandard
    // does not persist a disabled question's label anyway, so warning here would
    // report a change that saving silently discards.)
    if (!a.enabled && !b.enabled) return false;
    if (!!a.required !== !!b.required) return true;
    if ((a.label ?? "") !== (b.label ?? "")) return true;
    const setA = [...new Set(a.offered ?? [])].sort().join("|");
    const setB = [...new Set(b.offered ?? [])].sort().join("|");
    return setA !== setB;
  });
}

function scopeNote(row, programs) {
  if (!row || row.applies_to === "all") return null;
  const target = (programs || []).find((p) => p.id === row.applies_to_value);
  // Neutral fallback: the class may be in another term (so absent from this
  // list) or deleted. Never render a raw id, never render blank.
  return target ? `Only on ${programLabel(target)}` : "Only on one class";
}

const FIELD_TYPES = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text (paragraph)" },
  { value: "select", label: "Dropdown (pick one)" },
  { value: "multiselect", label: "Checkboxes (pick many)" },
  { value: "checkbox", label: "Single checkbox (yes/no)" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
];
const TYPE_NEEDS_OPTIONS = new Set(["select", "multiselect"]);

// Map raw Postgres/Supabase errors to plain language (no jargon for operators).
function friendlyError(error) {
  const raw = (error && (error.message || String(error))) || "";
  const m = raw.toLowerCase();
  if (m.includes("duplicate key") || m.includes("unique")) return "You already have a question with that name — try a slightly different label.";
  if (m.includes("check constraint")) return "That value isn't allowed here.";
  if (m.includes("not authorized") || m.includes("row-level security") || m.includes("permission") || m.includes("policy")) return "You don't have permission to change this.";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("timeout")) return "Network hiccup — please try again.";
  return "Sorry, that didn't save. Please try again.";
}

export default function RegistrationQuestions() {
  const { org, orgMember } = useOutletContext() ?? {};
  // Same test the rest of the admin uses for the reduced nav
  // (instructor_pay_model === "enrops_platform"). These providers have no
  // instructor portal, so copy that promises one describes a screen they cannot
  // reach - it reads as a missing feature rather than a feature they don't need.
  const hasInstructorPortal = org?.instructor_pay_model !== "enrops_platform";
  const canEdit = useMemo(() => ["owner", "admin"].includes(orgMember?.role), [orgMember]);

  const [rows, setRows] = useState(null);          // all custom_reg_fields rows for the org
  const [loading, setLoading] = useState(true);
  // Programs a question can be scoped to, so a one-day workshop isn't forced to
  // ask full-season questions. Current term only: scoping to a class families
  // can no longer register for would just be noise in the picker.
  // The preview panel reads the same list to open the real form on a class a
  // family could actually reach (see FormPreview).
  //
  // null = NOT LOADED YET, [] = loaded and this org has none. The preview has to
  // tell those apart: this query is deliberately not awaited (it must never block
  // the questions from rendering), so an initial `[]` would render the
  // loaded-and-empty copy -- "No classes yet ... Add one" -- to an org with 32
  // open classes until the promise landed.
  const [programs, setPrograms] = useState(null);
  const [toast, setToast] = useState(null);        // { kind, message }

  // Staged state for the standard section (saved together).
  const [std, setStd] = useState({});              // { key: {enabled, required, label} }
  const [savingStd, setSavingStd] = useState(false);
  const [savedStd, setSavedStd] = useState(false);

  const loadReq = useRef(0);

  async function load() {
    if (!org?.id) return;
    const myReq = ++loadReq.current;   // supersede any in-flight load (e.g. fast org switch)
    setLoading(true);
    // Back to "not loaded" for the new org. The staleness guard below only stops
    // an OUT-OF-ORDER write; without this reset the previous org's classes stay
    // on screen for the whole query on EVERY org switch, and the preview builds
    // buildRegUrl(newOrg.slug, oldOrgProgramId) — a link the public wizard
    // cannot resolve — the common path, not the rare one.
    setPrograms(null);
    const { data, error } = await supabase
      .from("custom_reg_fields")
      .select("id, field_key, label, field_type, options, is_required, applies_to, applies_to_value, sort_order, help_text, is_active, standard_key")
      .eq("organization_id", org.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (myReq !== loadReq.current) return;   // a newer load started; drop this stale result
    if (error) {
      setToast({ kind: "error", message: "Couldn't load your questions. Please refresh and try again." });
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(data ?? []);
    // Best-effort: if this fails the scope picker just offers "Every program".
    // It must never block the questions themselves from rendering.
    supabase
      .from("programs")
      // status + runs_own_registration are for the PREVIEW link, not the scope
      // picker: the picker deliberately still offers drafts (you configure a
      // question before the class goes live), but the preview can only open a
      // class a family could actually reach.
      .select("id, curriculum, day_of_week, status, runs_own_registration")
      .eq("organization_id", org.id)
      .eq("term", org.active_registration_term || "")
      .order("curriculum")
      .then(({ data: progs }) => {
        // Same staleness guard the questions query gets above. Without it, a
        // fast org switch (A -> B) where A's slower response lands last leaves
        // org A's classes on screen under org B: the preview would then build
        // buildRegUrl(B.slug, A_program_id), a link whose program the public
        // wizard cannot find, so the family-facing form opens with nothing
        // selected. Harmless when this list only fed a dropdown; it is a
        // clickable link target now.
        if (myReq !== loadReq.current) return;
        setPrograms(progs ?? []);
      });
    // Seed the staged standard state from existing rows (or defaults).
    setStd(seedStdFromRows(data));
    setSavedStd(false);
    setLoading(false);
  }

  useEffect(() => {
    load();   // load() self-supersedes via loadReq, so no stale result can win
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  // --- standard section handlers ---
  function editStd(key, patch) {
    setSavedStd(false);
    setStd((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function saveStandard() {
    if (!org?.id || !canEdit) return;
    setSavingStd(true);
    setToast(null);
    try {
      const byStd = {};
      for (const r of rows ?? []) if (r.standard_key) byStd[r.standard_key] = r;
      for (let i = 0; i < STANDARD_FIELDS.length; i++) {
        const f = STANDARD_FIELDS[i];
        const s = std[f.key];
        const existing = byStd[f.key];
        const label = (s.label || "").trim() || f.label;
        const required = f.alwaysRequired ? true : !!s.required;
        if (s.enabled) {
          // Upsert on the deterministic std_<key> field_key so a stale `rows`
          // snapshot (e.g. a concurrent admin session already created the row)
          // updates instead of hitting the unique constraint.
          const { error } = await supabase.from("custom_reg_fields").upsert({
            organization_id: org.id,
            standard_key: f.key,
            field_key: stdFieldKey(f.key),
            label,
            field_type: "standard",
            is_required: required,
            is_active: true,
            applies_to: "all",
            sort_order: i,
            // Only for questions that HAVE answer choices. Sending options:null
            // for the others would overwrite anything a future feature stores
            // there; omitting the key leaves the column untouched on conflict.
            //
            // Falls back rather than saving an empty list: a required question
            // with no answers is a checkout nobody can complete. The UI blocks
            // unticking the last one, and this is the same rule enforced where
            // it is actually written.
            ...(f.answerChoices
              ? { options: { offered: (s.offered?.length ? s.offered : DEFAULT_OFFERED) } }
              : {}),
          }, { onConflict: "organization_id,field_key" });
          if (error) throw error;
        } else if (existing && existing.is_active !== false) {
          // Turn off but keep the config (label/required) for next time.
          const { error } = await supabase
            .from("custom_reg_fields")
            .update({ is_active: false })
            .eq("id", existing.id);
          if (error) throw error;
        }
      }
      await load();
      setSavedStd(true);
    } catch (e) {
      setToast({ kind: "error", message: friendlyError(e) });
    } finally {
      setSavingStd(false);
    }
  }

  // Unsaved standard-question changes. NOT `!savedStd`: that is also the state
  // before anybody has touched anything, so it would warn on every page load.
  // Derived from the actual values, so toggling something back to how it was
  // stops the warning.
  const stdDirty = useMemo(() => stdHasUnsavedChanges(std, rows), [std, rows]);

  // --- custom section handlers (immediate writes) ---
  const customRows = useMemo(
    () => (rows ?? []).filter((r) => !r.standard_key),
    [rows],
  );

  async function saveCustom(draft) {
    // draft: { id?, label, field_type, options[], is_required, help_text, is_active }
    if (!org?.id || !canEdit) return { error: "Not allowed" };
    const optionsClean = TYPE_NEEDS_OPTIONS.has(draft.field_type)
      ? [...new Set((draft.options || []).map((o) => o.trim()).filter(Boolean))]   // trim, drop empties, dedup
      : null;
    if (TYPE_NEEDS_OPTIONS.has(draft.field_type) && (!optionsClean || optionsClean.length === 0)) {
      return { error: "Add at least one option for a dropdown question." };
    }
    const label = (draft.label || "").trim();
    if (!label) return { error: "Give the question a label." };

    // Scope: "" = ask on every program (the default, and what every existing row
    // is). A program id limits the question to that one class.
    // applies_to_value is text, so the id is stored as text.
    const scopeProgramId = (draft.applies_to_program_id || "").trim();
    const scopeCols = scopeProgramId
      ? { applies_to: "program", applies_to_value: scopeProgramId }
      : { applies_to: "all", applies_to_value: null };

    if (draft.id) {
      const { error } = await supabase
        .from("custom_reg_fields")
        .update({
          label,
          field_type: draft.field_type,
          options: optionsClean,
          is_required: !!draft.is_required,
          help_text: (draft.help_text || "").trim() || null,
          is_active: draft.is_active !== false,
          ...scopeCols,
        })
        .eq("id", draft.id);
      if (error) return { error: friendlyError(error) };
    } else {
      // Unique field_key per org; derive from label + a random suffix (UUID
      // fragment for enough entropy that same-label questions don't collide).
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "question";
      const rand = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
      const field_key = `${base}_${rand}`;
      // Append after existing custom questions (their band is 101+).
      const maxSort = (rows ?? []).filter((r) => !r.standard_key).reduce((m, r) => Math.max(m, r.sort_order ?? 0), 100);
      const { error } = await supabase.from("custom_reg_fields").insert({
        organization_id: org.id,
        standard_key: null,
        field_key,
        label,
        field_type: draft.field_type,
        options: optionsClean,
        is_required: !!draft.is_required,
        help_text: (draft.help_text || "").trim() || null,
        is_active: draft.is_active !== false,
        ...scopeCols,
        sort_order: maxSort + 1,
      });
      if (error) return { error: friendlyError(error) };
    }
    await load();
    return {};
  }

  async function deleteCustom(id) {
    if (!org?.id || !canEdit) return;
    const { error } = await supabase.from("custom_reg_fields").delete().eq("id", id).eq("organization_id", org.id);
    if (error) { setToast({ kind: "error", message: friendlyError(error) }); return; }
    await load();
  }

  async function moveCustom(id, dir) {
    if (!org?.id || !canEdit) return;
    const idx = customRows.findIndex((r) => r.id === id);
    if (idx < 0 || !customRows[idx + dir]) return;   // at an end
    // Build the new full order and write it atomically (one RPC, one transaction)
    // so a partial failure can't leave two rows sharing a sort_order.
    const next = [...customRows];
    [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
    const { error } = await supabase.rpc("reorder_registration_fields", {
      p_org_id: org.id,
      p_ordered_ids: next.map((r) => r.id),
    });
    if (error) { setToast({ kind: "error", message: friendlyError(error) }); return; }
    await load();
  }

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Link to="/admin/settings" style={{ fontSize: 13, color: BRIGHT, textDecoration: "none" }}>← Settings</Link>
      </div>
      {/* The right column is a hard 300px, which on a 375px phone left the page
          column ~35px wide. It mattered less when that column was a decorative
          drawing; it holds the "open my form" button now, so it has to stack.
          Done with a data attribute + media query because every style on this
          page is an inline prop, which a normal rule can't override (same
          pattern AdminLayout uses for the sidebar). Preview goes FIRST when
          stacked: on a phone the action is the reason to be here, and burying
          it under the whole builder is how it stays undiscovered. */}
      <style>{`
        @media (max-width: 900px) {
          [data-regq-grid] { grid-template-columns: 1fr !important; }
          [data-regq-grid] > aside { position: static !important; order: -1; }
        }
      `}</style>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Registration questions</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5, maxWidth: 640 }}>
        Choose what your registration form asks families. Turn the standard questions on or off, and add your own.
        Asking for pickup and release details up front saves you chasing them down later.
      </p>

      {toast && (
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
          padding: "10px 14px", borderRadius: 8, marginBottom: 18, fontSize: 13,
          background: toast.kind === "success" ? "#f0f8f0" : "#fff5f5",
          border: `1px solid ${toast.kind === "success" ? "#bfd9bf" : "#f0c4c4"}`,
          color: toast.kind === "success" ? OK_GREEN : RED,
        }}>
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 18, color: "inherit", lineHeight: 1 }}>×</button>
        </div>
      )}

      {!canEdit && !loading && (
        <div style={{ fontSize: 13, color: MUTED, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 14px", marginBottom: 18 }}>
          You're viewing these settings. Only an owner or admin can change them.
        </div>
      )}

      {loading || rows === null ? (
        <div style={{ color: MUTED, fontSize: 14 }}>Loading…</div>
      ) : (
        <div data-regq-grid style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 26, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 26, minWidth: 0 }}>
            {/* Always on the form (read-only) */}
            <section style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 12, padding: "16px 20px" }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK }}>Always on your form</h2>
              <p style={{ margin: "3px 0 10px", fontSize: 13, color: MUTED }}>These are built in and always asked.</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {ALWAYS_ON.map((f) => (
                  <span key={f} style={{ fontSize: 12, color: INK, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 999, padding: "4px 11px" }}>{f}</span>
                ))}
              </div>
            </section>

            {/* Standard questions */}
            <section style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "20px 22px" }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Optional standard questions</h2>
              <p style={{ margin: "3px 0 14px", fontSize: 13, color: MUTED }}>
                The questions most programs ask. The safety questions (dismissal and pickup) start on — review them and Save to add them to your form.
              </p>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {STANDARD_FIELDS.map((f, i) => (
                  <StandardRow
                    key={f.key}
                    field={f}
                    state={std[f.key]}
                    canEdit={canEdit}
                    first={i === 0}
                    hasInstructorPortal={hasInstructorPortal}
                    onChange={(patch) => editStd(f.key, patch)}
                  />
                ))}
              </div>
              {canEdit && (
                <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={saveStandard}
                    disabled={savingStd || savedStd}
                    style={{
                      padding: "9px 18px", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
                      fontFamily: "inherit", cursor: savingStd || savedStd ? "default" : "pointer",
                      background: savedStd ? OK_GREEN : BRIGHT, color: "#fff", opacity: savingStd ? 0.7 : 1,
                    }}
                  >
                    {savingStd ? "Saving…" : savedStd ? "Saved ✓" : "Save standard questions"}
                  </button>
                </div>
              )}
            </section>

            {/* Custom questions. Coerced to an array: this section's scope
                picker only needs "which classes can I choose", so a not-yet-
                loaded list is the same as an empty one to it. The preview gets
                the raw value because it MUST tell loading from empty. */}
            <CustomSection
              customRows={customRows}
              programs={programs ?? []}
              canEdit={canEdit}
              onSave={saveCustom}
              onDelete={deleteCustom}
              onMove={moveCustom}
            />
          </div>

          {/* Preview = the real form, opened in a new tab */}
          <FormPreview
            std={std}
            customRows={customRows}
            programs={programs}
            orgSlug={org?.slug}
            stdDirty={stdDirty}
            canEdit={canEdit}
            savingStd={savingStd}
            savedStd={savedStd}
            onSaveStandard={saveStandard}
          />
        </div>
      )}
    </div>
  );
}

function StandardRow({ field, state, canEdit, first, hasInstructorPortal = true, onChange }) {
  if (!state) return null;
  return (
    <div style={{ padding: "14px 0", borderTop: first ? "none" : `1px solid ${RULE}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
            {field.label}
            {field.sensitive && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: AMBER, background: "#fbf3dc", border: "1px solid #ecdca6", borderRadius: 4, padding: "1px 6px", textTransform: "uppercase", letterSpacing: 0.4 }}>
                Sensitive
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.5, maxWidth: 460 }}>{field.desc}</div>
        </div>
        <Toggle on={!!state.enabled} locked={!canEdit} onClick={() => onChange({ enabled: !state.enabled })} />
      </div>

      {state.enabled && (
        <>
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
          {/* mandatory / optional */}
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: field.alwaysRequired ? MUTED : INK }}>
            <input
              type="checkbox"
              checked={field.alwaysRequired ? true : !!state.required}
              disabled={!canEdit || field.alwaysRequired}
              onChange={(e) => onChange({ required: e.target.checked })}
            />
            Required
            {field.alwaysRequired && <span style={{ color: MUTED }}>(always)</span>}
          </label>
          {/* label override */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, flex: 1, minWidth: 220 }}>
            <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap" }}>Label shown:</span>
            <input
              type="text"
              value={state.label}
              disabled={!canEdit}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder={field.label}
              style={{ flex: 1, minWidth: 0, fontFamily: "inherit", fontSize: 13, color: INK, border: `1px solid ${RULE}`, borderRadius: 6, padding: "6px 9px", background: canEdit ? "#fff" : CREAM }}
            />
          </span>
        </div>
        {/* WHICH ANSWERS FAMILIES CAN PICK. Only the dismissal question has these
            today. Rendered from the shared list, so Settings cannot offer an answer
            the registration form would not show or the database would reject.

            Unticking the last one is blocked rather than allowed-then-corrected: a
            required question with no answers is a checkout nobody can finish, and
            finding that out from a stuck parent is the wrong way to learn it. */}
        {field.answerChoices && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
              Ways a family can say their child leaves:
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {field.answerChoices.map((c) => {
                const on = (state.offered || []).includes(c.value);
                const isLast = on && (state.offered || []).length === 1;
                return (
                  <label
                    key={c.value}
                    title={isLast ? "Keep at least one way to leave" : undefined}
                    style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: isLast ? MUTED : INK }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!canEdit || isLast}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...(state.offered || []), c.value]
                          : (state.offered || []).filter((v) => v !== c.value);
                        onChange({ offered: next });
                      }}
                    />
                    {c.parent}
                  </label>
                );
              })}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: MUTED, lineHeight: 1.5, maxWidth: 460 }}>
              Turning on <strong>Goes to aftercare</strong> also asks the family which
              program, and that name shows on your rosters
              {hasInstructorPortal ? <> and your instructors&rsquo; dismissal list</> : null}.
            </div>
          </div>
        )}
        {/* Safety coupling: these questions feed the dismissal tooling. Named
            differently for providers on the reduced nav - they have no instructor
            portal, so "your instructors won't see the dismissal step" points at a
            screen that does not exist for them. */}
        {field.alwaysRequired && (
          <div style={{ marginTop: 8, fontSize: 12, color: MUTED, lineHeight: 1.5, maxWidth: 460, fontStyle: "italic" }}>
            {hasInstructorPortal
              ? "Powers your instructors' dismissal check-off and Class Reports. Turn it off and families won't be asked at registration, and instructors won't see the dismissal step."
              /* Class Reports is filtered out of the reduced nav too
                 (AdminLayout shapeNavForOrg drops /admin/class-reports), so it
                 must not be named here either. Class rosters DO survive. */
              : "Powers the dismissal details on your class rosters. Turn it off and families won't be asked at registration, and dismissal won't appear on your rosters."}
          </div>
        )}
        </>
      )}
    </div>
  );
}

function CustomSection({ customRows, canEdit, programs = [], onSave, onDelete, onMove }) {
  const [editing, setEditing] = useState(null);   // draft being edited/added, or null
  const [pendingDelete, setPendingDelete] = useState(null);

  return (
    <section style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: "20px 22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: INK }}>Your own questions</h2>
        {canEdit && !editing && (
          <button type="button" onClick={() => setEditing(blankDraft())} style={smallPrimary}>+ Add question</button>
        )}
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: MUTED }}>
        Anything specific to your programs — e.g. "Does your child have music experience?"
      </p>

      {customRows.length === 0 && !editing && (
        <div style={{ fontSize: 13, color: MUTED, background: CREAM, border: `1px dashed ${RULE}`, borderRadius: 8, padding: "14px 16px" }}>
          No custom questions yet. {canEdit ? "Add one to ask families something specific to your programs." : ""}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {customRows.map((r, i) => (
          <div key={r.id} style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: "12px 14px", background: r.is_active === false ? CREAM : "#fff" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>
                  {r.label}
                  {r.is_required && <span style={{ color: RED, marginLeft: 4 }}>*</span>}
                  {r.is_active === false && <span style={{ marginLeft: 8, fontSize: 11, color: MUTED }}>(hidden)</span>}
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {FIELD_TYPES.find((t) => t.value === r.field_type)?.label || r.field_type}
                  {Array.isArray(r.options) && r.options.length > 0 && ` · ${r.options.length} option${r.options.length === 1 ? "" : "s"}`}
                </div>
                {/* Honest state: a question limited to one class must SAY so, or
                    this list reads as "every family is asked all of these".
                    Wording + fallback come from scopeNote so this and the
                    preview's list cannot disagree. */}
                {scopeNote(r, programs) && (
                  <div style={{ fontSize: 11, color: BRIGHT, fontWeight: 600, marginTop: 3 }}>
                    {scopeNote(r, programs)}
                  </div>
                )}
              </div>
              {canEdit && (
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  <IconBtn label="Move up" disabled={i === 0} onClick={() => onMove(r.id, -1)}>↑</IconBtn>
                  <IconBtn label="Move down" disabled={i === customRows.length - 1} onClick={() => onMove(r.id, 1)}>↓</IconBtn>
                  <button
                    type="button"
                    onClick={() => setEditing({
                      ...r,
                      options: Array.isArray(r.options) ? r.options : [],
                      // Re-hydrate the scope picker from the stored columns, or
                      // editing a program-scoped question would silently reset it
                      // to "Every program" on save.
                      //
                      // KNOWN GAP, deliberately not fixed here: this covers
                      // 'program' only, while the live CHECK also allows
                      // 'enrollment_type'. Such a row would seed "" here and
                      // saveCustom() would then write applies_to='all' — silently
                      // widening a scoped question to every family. Unreachable
                      // today: nothing writes that value (this editor and the
                      // quick builder only write 'all' or 'program') and there are
                      // 0 such rows on staging or prod. scopeNote() already treats
                      // any non-'all' scope as scoped, so the LABEL is honest even
                      // if this seed is not. Fixing it properly means deciding how
                      // enrollment-type scoping should look, which is a feature.
                      applies_to_program_id: r.applies_to === "program" ? (r.applies_to_value || "") : "",
                    })}
                    style={linkBtn}
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => setPendingDelete(r)} style={{ ...linkBtn, color: RED }}>Delete</button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <CustomEditor
          draft={editing}
          programs={programs}
          onCancel={() => setEditing(null)}
          onSubmit={async (draft) => {
            const { error } = await onSave(draft);
            if (error) return error;
            setEditing(null);
            return null;
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmBar
          message={`Delete "${pendingDelete.label}"? Families won't be asked this anymore.`}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => { await onDelete(pendingDelete.id); setPendingDelete(null); }}
        />
      )}
    </section>
  );
}

function blankDraft() {
  // applies_to_program_id: "" = ask on every program (the default).
  return { id: null, label: "", field_type: "text", options: [], is_required: false, help_text: "", is_active: true, applies_to_program_id: "" };
}

function CustomEditor({ draft, programs = [], onCancel, onSubmit }) {
  const [d, setD] = useState(draft);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const needsOptions = TYPE_NEEDS_OPTIONS.has(d.field_type);

  async function submit() {
    setBusy(true);
    setErr(null);
    const error = await onSubmit(d);
    if (error) { setErr(error); setBusy(false); }
    // on success the parent unmounts this editor
  }

  return (
    <div style={{ marginTop: 14, border: `1px solid ${BRIGHT}`, borderRadius: 10, padding: 16, background: "#faf9ff" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE, marginBottom: 12 }}>{d.id ? "Edit question" : "New question"}</div>

      <label style={fieldLabel}>Question label</label>
      <input type="text" value={d.label} autoFocus onChange={(e) => setD({ ...d, label: e.target.value })}
        placeholder="e.g. Does your child have music experience?" style={textInput} />

      <label style={{ ...fieldLabel, marginTop: 12 }}>Answer type</label>
      <select value={d.field_type} onChange={(e) => setD({ ...d, field_type: e.target.value })} style={textInput}>
        {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>

      {needsOptions && (
        <>
          <label style={{ ...fieldLabel, marginTop: 12 }}>Options (one per line)</label>
          <textarea
            rows={4}
            value={(d.options || []).join("\n")}
            onChange={(e) => setD({ ...d, options: e.target.value.split("\n") })}
            placeholder={"None\nA little\nA lot"}
            style={{ ...textInput, resize: "vertical" }}
          />
        </>
      )}

      <label style={{ ...fieldLabel, marginTop: 12 }}>Helper text <span style={{ fontWeight: 400, color: MUTED }}>(optional)</span></label>
      <input type="text" value={d.help_text || ""} onChange={(e) => setD({ ...d, help_text: e.target.value })}
        placeholder="A short hint shown under the question" style={textInput} />

      {/* Scope. Defaults to every program so nothing changes for questions
          already in use. Picking one class stops a one-day workshop inheriting
          questions that only make sense for a full season. */}
      <label style={{ ...fieldLabel, marginTop: 12 }}>Ask this on</label>
      <select
        value={d.applies_to_program_id || ""}
        onChange={(e) => setD({ ...d, applies_to_program_id: e.target.value })}
        style={textInput}
      >
        <option value="">Every program</option>
        {programs.map((p) => (
          <option key={p.id} value={p.id}>{programLabel(p)}</option>
        ))}
      </select>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        {d.applies_to_program_id
          ? "Only families registering for that class will see this question."
          : programs.length === 0
          ? "Add a program to be able to ask a question on just one class."
          : "Every family sees this question. Pick a class to ask it only there."}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, marginTop: 12 }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: INK }}>
          <input type="checkbox" checked={!!d.is_required} onChange={(e) => setD({ ...d, is_required: e.target.checked })} />
          Required
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13, color: INK }}>
          <input type="checkbox" checked={d.is_active !== false} onChange={(e) => setD({ ...d, is_active: e.target.checked })} />
          Show on the form <span style={{ color: MUTED }}>(uncheck to hide without deleting)</span>
        </label>
      </div>

      {err && <div style={{ fontSize: 13, color: RED, marginTop: 10 }}>{err}</div>}

      <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 10 }}>
        <button type="button" onClick={onCancel} style={ghostBtn}>Cancel</button>
        <button type="button" onClick={submit} disabled={busy} style={{ ...smallPrimary, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Saving…" : d.id ? "Save question" : "Add question"}
        </button>
      </div>
    </div>
  );
}

function ConfirmBar({ message, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#fff5f5", border: "1px solid #f0c4c4", borderRadius: 8, padding: "10px 14px" }}>
      <span style={{ fontSize: 13, color: INK }}>{message}</span>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button type="button" onClick={onCancel} style={ghostBtn}>Keep it</button>
        <button type="button" disabled={busy} onClick={async () => { setBusy(true); await onConfirm(); }} style={{ ...smallPrimary, background: RED, opacity: busy ? 0.7 : 1 }}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

// The preview IS the real form.
//
// This panel used to hand-draw an approximation of every input. It drifted the
// moment a question type or a dismissal choice changed, it never showed the
// built-in questions at all, and it flattened a multi-step wizard into one
// column - so it misrepresented exactly what an operator opens a preview to
// judge. Nobody in the market hand-draws this: either the builder IS the form
// (Jotform, Typeform) or Preview opens the real thing (Google Forms' eye icon,
// SurveyMonkey's test mode, Stripe's payment links). Registration pages are
// already public, so opening the real form is a link and nothing more: no new
// code path, and it cannot drift.
//
// A form only exists for a class families can reach, so the link is gated the
// same way ShareProgram gates a share link: published (status "open"), in the
// term the public catalog serves (the query above filters to it), and not
// partner-run (those register on the partner's own site, so we have no form to
// show). With nothing published there is no URL, and the panel says why instead
// of handing over a link that bounces straight back to the catalog.
function FormPreview({ std, customRows, programs, orgSlug, stdDirty, canEdit, savingStd, savedStd, onSaveStandard }) {
  // Derived, not seeded: programs arrive after the first render, so setting a
  // default once would leave the picker stuck on "" after the load resolved.
  const [pickedId, setPickedId] = useState("");

  const openable = useMemo(
    () => (programs || []).filter((p) => p.status === "open" && !p.runs_own_registration),
    [programs],
  );
  const picked = openable.find((p) => p.id === pickedId) || openable[0] || null;
  const url = orgSlug && picked ? buildRegUrl(orgSlug, picked.id) : "";

  // Why there's nothing to open, honestly. `status` allows draft/open/closed/
  // cancelled (live CHECK), and a partner-run class is published but registers
  // on the PARTNER's site — so "none of your classes are published" would state
  // the wrong cause for three of those five cases. Only claim the shared truth:
  // nothing is open to families. Partner-run gets its own sentence because
  // there is no action to take.
  const allPartnerRun = (programs || []).length > 0 && (programs || []).every((p) => p.runs_own_registration);

  // null = the class list has not landed yet (the parent does not await it). Say
  // nothing rather than picking an empty-state sentence: every one of them names
  // a cause and offers an action, and all of them are wrong for an org whose
  // classes simply have not arrived.
  const stillLoading = programs === null;

  // The questions in the order families meet them: enabled standard, then active
  // custom. Labels only - what an input LOOKS like is the real form's job now.
  const items = [];
  for (const f of STANDARD_FIELDS) {
    const s = std[f.key];
    if (s?.enabled) items.push({ key: f.key, label: (s.label || "").trim() || f.label, required: f.alwaysRequired || !!s.required });
  }
  for (const r of customRows) {
    if (r.is_active === false) continue;
    // A question scoped to one class is NOT asked of everyone, so say so. The
    // old list showed every question unconditionally, which is the same kind of
    // lie the drawing was. Same sentence as the editable list above (scopeNote).
    items.push({
      key: r.id,
      label: r.label,
      required: !!r.is_required,
      scope: scopeNote(r, programs),
    });
  }

  return (
    <aside style={{ position: "sticky", top: 12, background: CREAM, border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>Preview</div>

      {/* The form reads SAVED rows, so unsaved standard-question changes make
          this panel and the real form disagree. Say so where the operator is
          looking, and put the Save here too: the section's own Save button sits
          at the bottom of the left column, which on a phone (where this panel
          now renders FIRST) is below the entire builder.

          Deliberately the SAME action, not a second one: same handler, same
          label, same busy state, so the two cannot diverge or disagree about
          what saving means. Jessica's rule is one entry point per action; this
          is one action reachable from where its consequence is described.

          Placed ABOVE the button because it qualifies the button. */}
      {stdDirty && (
        <div style={{ background: "#FBF1DC", border: "1px solid #E0C88A", borderRadius: 8, padding: "9px 11px", marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: INK, lineHeight: 1.45 }}>
            <strong style={{ fontWeight: 600 }}>You have unsaved changes.</strong>{" "}
            Your form asks the questions you've saved, so what you change here won't
            show up until you save it.
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={onSaveStandard}
              disabled={savingStd}
              style={{
                marginTop: 8, width: "100%", minHeight: 36, padding: "7px 12px",
                background: "transparent", color: AMBER, border: "1px solid #E0C88A",
                borderRadius: 6, fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                cursor: savingStd ? "default" : "pointer", opacity: savingStd ? 0.7 : 1,
              }}
            >
              {savingStd ? "Saving…" : "Save standard questions"}
            </button>
          )}
        </div>
      )}

      {/* The save's confirmation, and it lives OUTSIDE the block above on
          purpose. A successful save clears stdDirty, which unmounts that block
          and the button inside it — so a confirmation rendered in there would be
          destroyed by the very thing it reports. Measured on staging at 1280x720:
          the section's own "Saved" sits 924px below the panel's button, more than
          a full viewport, so the disappearing block was the only signal and
          "vanished" reads the same as "reverted my toggle".
          Keyed on savedStd (set only after the write resolves) AND !stdDirty, so
          it cannot claim saved while something is still pending.

          The wording makes no claim ABOUT THE LIST below it: an operator who
          turns every standard question off and saves gets "No extra questions
          turned on yet." in that list, and "your form now asks these questions"
          would be pointing at nothing. Both safety questions CAN be switched off
          (alwaysRequired governs required, not enabled), so that state is
          reachable. "Up to date" is true in every state a save can leave. */}
      {savedStd && !stdDirty && (
        <div style={{ fontSize: 12, color: OK_GREEN, fontWeight: 600, marginBottom: 10 }}>
          Saved ✓ Your form is up to date.
        </div>
      )}

      {url ? (
        <>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
            Click through your real registration form the way a family does.
          </div>
          {openable.length > 1 && (
            <>
              <label htmlFor="preview-class" style={{ ...fieldLabel, fontSize: 11 }}>Which class</label>
              <select
                id="preview-class"
                value={picked.id}
                onChange={(e) => setPickedId(e.target.value)}
                style={{ ...textInput, fontSize: 12, marginBottom: 10 }}
              >
                {openable.map((p) => (
                  <option key={p.id} value={p.id}>{programLabel(p)}</option>
                ))}
              </select>
            </>
          )}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            // minHeight 44: this is the primary action on a phone, and
            // smallPrimary's padding alone rendered a 38px-tall target (proven
            // on staging at 375px). 44 is the floor for a thumb.
            style={{ ...smallPrimary, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 44, textDecoration: "none", padding: "9px 14px" }}
          >
            Open my registration form ↗
          </a>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
            Opens in a new tab. This is your live form, so look around but don't finish a payment.
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.55 }}>
          {stillLoading ? (
            "Finding the classes families can register for…"
          ) : openable.length > 0 ? (
            "We couldn't build your form's link. Please refresh and try again."
          ) : programs.length === 0 ? (
            <>
              {/* `programs` is already filtered to the term families register
                  for, so "no classes" here does NOT mean the provider has none
                  at all - they may have a past term full of them. Say which
                  term is missing a class rather than implying they've never
                  built one. */}
              No classes yet in the term families are registering for.{" "}
              <Link to="/admin/programs" style={{ color: BRIGHT, fontWeight: 600, textDecoration: "none" }}>Add one</Link>{" "}
              and you can open the form here exactly as a family sees it.
            </>
          ) : allPartnerRun ? (
            "Your families register on your partner's site, so there's no form of ours to preview."
          ) : (
            <>
              Nothing to open yet — none of your classes are open to families right now.{" "}
              <Link to="/admin/programs" style={{ color: BRIGHT, fontWeight: 600, textDecoration: "none" }}>Open one for registration</Link>{" "}
              and this opens your real form.
            </>
          )}
        </div>
      )}

      <div style={{ borderTop: `1px solid ${RULE}`, marginTop: 14, paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8 }}>Your questions, in order</div>
        {items.length === 0 ? (
          <div style={{ fontSize: 12, color: MUTED }}>No extra questions turned on yet.</div>
        ) : (
          <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7 }}>
            {items.map((it) => (
              <li key={it.key} style={{ fontSize: 12, color: INK, lineHeight: 1.45 }}>
                {it.label}{it.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
                {it.scope && <div style={{ fontSize: 11, color: MUTED }}>{it.scope}</div>}
              </li>
            ))}
          </ol>
        )}
        <div style={{ fontSize: 11, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
          Your form also asks everything under "Always on your form" above.
        </div>
      </div>
    </aside>
  );
}

function Toggle({ on, locked, onClick }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} disabled={locked}
      onClick={locked ? undefined : onClick}
      title={locked ? "" : on ? "On — click to turn off" : "Off — click to turn on"}
      style={{
        flexShrink: 0, width: 44, height: 26, borderRadius: 999, border: "none", position: "relative",
        cursor: locked ? "default" : "pointer", background: on ? BRIGHT : "#cfcbc0", opacity: locked ? 0.55 : 1,
        transition: "background 120ms", padding: 0,
      }}
    >
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 120ms", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
    </button>
  );
}

function IconBtn({ children, label, disabled, onClick }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{ width: 26, height: 26, borderRadius: 6, border: `1px solid ${RULE}`, background: "#fff", color: disabled ? "#cfcbc0" : INK, cursor: disabled ? "default" : "pointer", fontSize: 13, lineHeight: 1, padding: 0 }}>
      {children}
    </button>
  );
}

const smallPrimary = { padding: "8px 14px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" };
const ghostBtn = { padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const linkBtn = { background: "none", border: "none", color: BRIGHT, fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "2px 4px" };
const fieldLabel = { display: "block", fontSize: 12, fontWeight: 600, color: INK, marginBottom: 5 };
const textInput = { width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 13, color: INK, border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 10px", background: "#fff" };
