// /admin/curricula/:id/review
//
// Chunk 3 of the curriculum onboarding flow. Replaces the read-only placeholder.
// One-screen review: Ennie banner (flags fields she's unsure about) above a full
// editable surface of every extracted curricula + curriculum_sessions field.
// Save-as-draft keeps status='extracted'; Publish flips to 'published' after a
// two-step modal (confirm name → optionally link existing program runs).
//
// Multi-tenant: org from outlet context, every query/insert filters by
// organization_id. No J2S hardcoding.
//
// Memory pointers: feedback_one_place_to_edit, project_enrops_curricula_upstream,
// feedback_enrops_principles, project_enrops_platform_vision (Ennie = Director).

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { supabase, API_BASE } from "../../../lib/supabase.js";
import { CAPABILITY_ICONS as SHARED_CAPABILITY_ICONS, deriveOrgStatesForCurriculum as sharedDeriveStates, isCapabilityUnlocked as sharedIsUnlocked, CapabilityDetailModal } from "./capabilityHelpers.jsx";
import Chevron from "../../../components/Chevron.jsx";
import Ennie from "../../../components/Ennie.jsx";
import { getPermissions } from "../../../lib/permissions.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const PLUM_SOFT = "rgba(105, 29, 57, 0.08)";
const VIOLET = "#8C88FF";
const GOLD_SOFT = "rgba(207, 177, 47, 0.13)";
const GOLD_BORDER = "rgba(207, 177, 47, 0.55)";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

// Per Jessica's J2S baseline: ~10 hours saved per curriculum (registration
// listing + per-session parent portal entries + recap email skill lists +
// instructor prep docs + structured data for scheduling).
const TIME_SAVED_HOURS = 10;

// Fields Ennie flags when the value is null/empty AND the field is in this list.
// Low-confidence extracted fields are flagged regardless of list membership.
const FLAG_IF_NULL = new Set([
  "age_range", "grade_range", "class_size", "format",
  "session_types_supported", "short_description",
  "prerequisites", "mid_term_skills", "final_recap_skills", "final_showcase",
]);

// Fields that make an offering genuinely usable downstream (registration page,
// instructor matching, parent emails). Powers the completeness meter in the
// Ennie banner so an operator can see how close to "ready" they are. Advisory
// only — never a publish gate (only a name is required to publish).
const PROGRESS_FIELDS = [
  "short_description", "format", "class_size", "age_grade",
  "session_types_supported", "skills_overall",
];
function curriculumFieldFilled(curriculum, key) {
  const has = (v) => !(v == null || v === "" || (Array.isArray(v) && v.length === 0));
  switch (key) {
    case "class_size":
      return has(curriculum.class_size_min) || has(curriculum.class_size_max);
    case "age_grade":
      return has(curriculum.age_range_min) || has(curriculum.age_range_max)
        || has(curriculum.grade_min) || has(curriculum.grade_max);
    default:
      return has(curriculum[key]);
  }
}

const FORMAT_OPTIONS = [
  { value: "summer_camp", label: "Summer camp" },
  { value: "afterschool", label: "Afterschool" },
  { value: "other", label: "Other" },
];

const CATEGORY_OPTIONS = [
  { value: "lego", label: "LEGO" },
  { value: "coding", label: "Coding" },
  { value: "robotics", label: "Robotics" },
];

// Document sections in the offering's panel. Grouping keeps the curriculum
// source separate from supporting materials, so it's obvious at a glance what
// drives extraction vs what's just kept on file. Anything with an unrecognised
// doc_type falls into "Other" rather than disappearing.
const DOC_GROUPS = [
  { key: "instructor_guide", label: "Curriculum doc" },
  { key: "materials_list", label: "Class materials" },
  { key: "student_materials", label: "Student materials" },
  { key: "other", label: "Other" },
];
const DOC_GROUP_KEYS = new Set(DOC_GROUPS.map((g) => g.key));
function docGroupKey(docType) {
  return DOC_GROUP_KEYS.has(docType) ? docType : "other";
}

// Grade dropdown options. Grade 0 is Kindergarten and shows as "K" everywhere
// else in the app (Home, CurriculaList, AfterschoolSchedule, roster, register).
// Stored value stays the integer (0 for K) so downstream readers are unchanged.
const GRADE_OPTIONS = [
  { value: "0", label: "K" },
  ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
];

// Best-guess curriculum family from its title, so the admin usually just confirms.
function guessCategory(name) {
  const n = (name || "").toLowerCase();
  if (/robot|mbot|spike|ev3|wedo/.test(n)) return "robotics";
  if (/\blego\b|brick|duplo/.test(n)) return "lego";
  if (/cod|minecraft|scratch|python|roblox|game design|game maker|program/.test(n)) return "coding";
  return "";
}

const SESSION_TYPE_OPTIONS = [
  { value: "full_day", label: "Full-day camp" },
  { value: "half_day_am", label: "Half-day AM camp" },
  { value: "half_day_pm", label: "Half-day PM camp" },
  { value: "afterschool", label: "Afterschool" },
];

// Word-overlap fuzzy match. Threshold tuned for J2S program names — names with
// 2 of 3 significant words in common surface as a suggestion.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "with", "for", "to",
  "camp", "program", "class", "lab", "club", "course", "&",
]);

function normalizeForMatch(s) {
  if (!s) return [];
  return s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w));
}

function matchScore(a, b) {
  const aw = new Set(normalizeForMatch(a));
  const bw = new Set(normalizeForMatch(b));
  if (aw.size === 0 || bw.size === 0) return 0;
  let overlap = 0;
  for (const w of aw) if (bw.has(w)) overlap++;
  return overlap / Math.max(aw.size, bw.size);
}

// Human-readable session_type for the match + link modals. The schedule's
// raw values are "afternoon" / "morning" / "full_day" / etc. (J2S-shaped);
// the label distinguishes half-day from full-day so the operator doesn't
// bundle them under the same curriculum.
function sessionTypeLabel(sessionType) {
  switch (sessionType) {
    case "afternoon": return "half-day PM camp";
    case "morning": return "half-day AM camp";
    case "full_day": return "full-day camp";
    case "half_day_am": return "half-day AM camp";
    case "half_day_pm": return "half-day PM camp";
    default: return "camp session";
  }
}

// Short day-type label for the new group label format (no "camp" suffix —
// the prefix already says "Camp ·").
function dayTypeLabel(sessionType) {
  switch (sessionType) {
    case "afternoon":
    case "half_day_pm": return "half-day PM";
    case "morning":
    case "half_day_am": return "half-day AM";
    case "full_day": return "full-day";
    default: return "";
  }
}

// Renders the muted suffix for a match/link row.
// Examples:
//   Afterschool · 6 sessions
//   Camp · half-day PM · 4 sessions
//   Camp · full-day · 1 session
function formatGroupLabel(m) {
  const word = m.runCount === 1 ? "session" : "sessions";
  if (m.source === "camp_sessions") {
    const day = dayTypeLabel(m.sessionType);
    return day
      ? `Camp · ${day} · ${m.runCount} ${word}`
      : `Camp · ${m.runCount} ${word}`;
  }
  return `Afterschool · ${m.runCount} ${word}`;
}

// Top-level field-name in curriculum_extracted_fields → which curricula column
// (or pair of columns) it maps to. Used to read confidence + decide flags.
function isFieldFlagged({ curriculum, fieldName, extractedRow }) {
  if (extractedRow && !extractedRow.human_approved) {
    if (extractedRow.confidence != null && extractedRow.confidence < 0.7) return true;
  }
  if (extractedRow?.human_approved) return false;

  // Null-check by field
  const empty = (v) => v == null || (Array.isArray(v) && v.length === 0) || v === "";
  switch (fieldName) {
    case "age_range":
      return empty(curriculum.age_range_min) && empty(curriculum.age_range_max)
        && empty(curriculum.grade_min) && empty(curriculum.grade_max);
    case "class_size":
      return empty(curriculum.class_size_min) && empty(curriculum.class_size_max);
    case "format": return empty(curriculum.format);
    case "session_types_supported": return empty(curriculum.session_types_supported);
    case "short_description": return empty(curriculum.short_description);
    case "prerequisites": return empty(curriculum.prerequisites);
    case "mid_term_skills": return empty(curriculum.mid_term_skills);
    case "final_recap_skills": return empty(curriculum.final_recap_skills);
    case "final_showcase": return empty(curriculum.final_showcase);
    default: return false;
  }
}

function computeFlagCount(curriculum, extractedByName) {
  let n = 0;
  for (const fieldName of FLAG_IF_NULL) {
    const row = extractedByName[fieldName];
    if (isFieldFlagged({ curriculum, fieldName, extractedRow: row })) n++;
  }
  // Also count any low-confidence extracted fields not already in FLAG_IF_NULL
  for (const [name, row] of Object.entries(extractedByName)) {
    if (FLAG_IF_NULL.has(name)) continue;
    if (row && !row.human_approved && row.confidence != null && row.confidence < 0.7) n++;
  }
  return n;
}

export default function CurriculumReview() {
  const { id: curriculumId } = useParams();
  const { org, user, orgMember } = useOutletContext();
  // Document add/replace/delete is owner/admin only in the DB, so the controls
  // are hidden for staff/viewer rather than shown and failing on RLS.
  const canManageDocs = getPermissions(orgMember?.role).canManageCurriculumDocs;
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [curriculum, setCurriculum] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [extractedByName, setExtractedByName] = useState({}); // field_name → row
  const [docs, setDocs] = useState([]);
  const [savingField, setSavingField] = useState(null); // for the saved-tick
  const [openSessionIds, setOpenSessionIds] = useState(new Set());
  const [ageOrGrade, setAgeOrGrade] = useState("ages");

  const [publishOpen, setPublishOpen] = useState(false);
  const [publishStep, setPublishStep] = useState(1);
  const [nameDraft, setNameDraft] = useState("");
  const [programMatches, setProgramMatches] = useState([]);
  const [selectedMatchKeys, setSelectedMatchKeys] = useState(new Set());
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [linkedProgramCount, setLinkedProgramCount] = useState(0);
  const [linkedCampSessionCount, setLinkedCampSessionCount] = useState(0);
  // Programs / camp_sessions already linked to this curriculum BEFORE this
  // publish session — surfaced in step 2 ("8 already linked") so the operator
  // isn't misled when the match suggestions come back empty, and added to the
  // celebration screen totals so they reflect truth instead of only new links.
  const [preLinkedProgramCount, setPreLinkedProgramCount] = useState(0);
  const [preLinkedCampSessionCount, setPreLinkedCampSessionCount] = useState(0);
  // The actual already-linked rows (not just their count) so step 2 can LIST
  // which programs/camps this offering is attached to instead of only a tally.
  const [preLinkedPrograms, setPreLinkedPrograms] = useState([]);
  const [preLinkedCampSessions, setPreLinkedCampSessions] = useState([]);

  // Polish with Ennie: when set, the modal opens for this field
  const [polishConfig, setPolishConfig] = useState(null);
  // Chunk 3.5: capability_definitions (14 rows, global) + Ennie's Phase 2
  // recommendation for the just-published curriculum (fetched after publish).
  const [capabilities, setCapabilities] = useState([]);
  const [ennieRecommendation, setEnnieRecommendation] = useState(null);
  // Link-existing-programs modal: opens from the celebration screen's
  // link_existing recommendation CTA, or from the published-curriculum CTA bar.
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  // Replace-source-doc modal: lets the operator upload an edited version of
  // the curriculum doc to re-run extraction without losing the curriculum_id
  // (so linked programs + camp_sessions stay attached).
  const [replaceDocOpen, setReplaceDocOpen] = useState(false);
  // Add-a-document modal (materials / handouts), and the inline "really delete
  // this file?" confirm. Deleting removes the storage object + row, so it is
  // never a single click.
  const [addDocOpen, setAddDocOpen] = useState(false);
  const [docPendingDelete, setDocPendingDelete] = useState(null); // doc id
  const [docDeleting, setDocDeleting] = useState(false);
  const [docError, setDocError] = useState("");
  // Capability detail modal: opens when the operator clicks any celebration
  // tile (also used by CurriculaList for the strip icons via the same shared
  // component).
  const [capabilityModalConfig, setCapabilityModalConfig] = useState(null);
  // Global save state — drives the tri-state CTA-bar copy
  // values: "idle" | "saving" | "saved" | "error"
  const [saveState, setSaveState] = useState("idle");
  const savedFlashTimer = useRef(null);

  // Debounce timers per field-name. Each entry is { timer, run } so a pending
  // edit can be committed (see flushPendingSaves) rather than lost.
  const debounceTimers = useRef(new Map());

  // On unmount (route change / "Back to library" mid-type), commit any pending
  // debounced write instead of letting its timer fire after this component is
  // gone. Each entry's `run` captured its own field value + patch at schedule
  // time, so this writes the last value the user typed. setState inside those
  // writes lands after unmount and is a harmless no-op; the DB write is the point.
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const p of timers.values()) {
        clearTimeout(p.timer);
        try { p.run(); } catch { /* best-effort flush on unmount */ }
      }
      timers.clear();
    };
  }, []);

  // Initial load
  useEffect(() => {
    if (!curriculumId || !org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setLoadError("");
      const [
        { data: curRow, error: curErr },
        { data: sessRows },
        { data: extRows },
        { data: docRows },
        { data: capRows },
      ] = await Promise.all([
        supabase.from("curricula").select("*").eq("id", curriculumId).maybeSingle(),
        supabase.from("curriculum_sessions").select("*").eq("curriculum_id", curriculumId).order("session_number"),
        supabase.from("curriculum_extracted_fields").select("*").eq("curriculum_id", curriculumId),
        supabase.from("curriculum_documents").select("id, original_filename, doc_type, storage_path, uploaded_at").eq("curriculum_id", curriculumId).order("uploaded_at"),
        supabase.from("capability_definitions").select("slug, display_name, category, short_description, why_it_matters, stat_text, stat_source, required_states, required_states_human, icon_name, display_order").eq("is_available", true).order("display_order"),
      ]);
      if (!mounted) return;
      if (curErr || !curRow) {
        setLoadError(curErr?.message || "Offering not found.");
        setLoading(false);
        return;
      }
      setCurriculum(curRow);
      setNameDraft(curRow.name || "");
      setSessions(sessRows ?? []);
      setCapabilities(capRows ?? []);
      const byName = {};
      for (const r of extRows ?? []) byName[r.field_name] = r;
      setExtractedByName(byName);
      setDocs(docRows ?? []);
      setOpenSessionIds(new Set((sessRows ?? []).slice(0, 1).map((s) => s.id)));
      // Default age-vs-grade based on what's populated
      const hasAge = curRow.age_range_min != null || curRow.age_range_max != null;
      const hasGrade = curRow.grade_min != null || curRow.grade_max != null;
      setAgeOrGrade(hasGrade && !hasAge ? "grades" : "ages");
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [curriculumId, org?.id]);

  // Auto-fill mid_term_skills once if empty: rank skills by how many first-half
  // sessions they appear in (frequency = "this is core to the curriculum"),
  // keep the top 6. Runs after initial load only; operator edits stay.
  const midTermAutoFillTried = useRef(false);
  useEffect(() => {
    if (midTermAutoFillTried.current) return;
    if (!curriculum || sessions.length === 0) return;
    const existing = curriculum.mid_term_skills ?? [];
    if (existing.length > 0) { midTermAutoFillTried.current = true; return; }
    const midpoint = Math.ceil(sessions.length / 2);
    const counts = new Map();
    sessions
      .filter((s) => s.session_number <= midpoint)
      .forEach((s) => {
        const seen = new Set();
        for (const skill of s.skills_practiced ?? []) {
          if (seen.has(skill)) continue;
          seen.add(skill);
          counts.set(skill, (counts.get(skill) ?? 0) + 1);
        }
      });
    const ranked = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([skill]) => skill);
    midTermAutoFillTried.current = true;
    if (ranked.length === 0) return;
    saveTopFieldDebounced("mid_term_skills", { mid_term_skills: ranked }, ranked, true);
  }, [curriculum?.id, sessions]);

  // Auto-fill final_recap_skills once if empty: rank by frequency across ALL
  // sessions (not just first half), keep top 6. skills_overall stays full and
  // rich for the registration page + marketing surfaces.
  const finalRecapAutoFillTried = useRef(false);
  useEffect(() => {
    if (finalRecapAutoFillTried.current) return;
    if (!curriculum || sessions.length === 0) return;
    const existing = curriculum.final_recap_skills ?? [];
    if (existing.length > 0) { finalRecapAutoFillTried.current = true; return; }
    const counts = new Map();
    sessions.forEach((s) => {
      const seen = new Set();
      for (const skill of s.skills_practiced ?? []) {
        if (seen.has(skill)) continue;
        seen.add(skill);
        counts.set(skill, (counts.get(skill) ?? 0) + 1);
      }
    });
    const ranked = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([skill]) => skill);
    finalRecapAutoFillTried.current = true;
    if (ranked.length === 0) return;
    saveTopFieldDebounced("final_recap_skills", { final_recap_skills: ranked }, ranked, true);
  }, [curriculum?.id, sessions]);

  const flagCount = useMemo(
    () => (curriculum ? computeFlagCount(curriculum, extractedByName) : 0),
    [curriculum, extractedByName],
  );
  // How many key downstream-usable fields are filled — drives the banner's
  // completeness meter so a half-finished offering shows visible "X of N left"
  // progress instead of the operator wandering off unsure how much remains.
  const progress = useMemo(() => {
    if (!curriculum) return { filled: 0, total: PROGRESS_FIELDS.length };
    let filled = 0;
    for (const k of PROGRESS_FIELDS) if (curriculumFieldFilled(curriculum, k)) filled++;
    return { filled, total: PROGRESS_FIELDS.length };
  }, [curriculum]);
  // Manual-entry offerings have no document and no AI-extracted fields, so the
  // "here's what I found / flagged" framing doesn't apply — show a fill-it-in
  // prompt instead.
  const isManualEntry = useMemo(
    () => docs.length === 0 && Object.keys(extractedByName).length === 0,
    [docs, extractedByName],
  );
  // "Replace source doc" only makes sense when there IS a source doc to
  // replace. On an empty panel (or one holding only materials) the operator
  // wants Add, so Replace is hidden rather than offered as a dead control.
  const hasSourceDoc = useMemo(
    () => docs.some((d) => d.doc_type === "instructor_guide"),
    [docs],
  );
  // True only when AI extraction actually authored content - i.e. some field
  // carries a value the model produced (extracted_value), not just a value the
  // operator typed (human_edited_value). "Has a document" is NOT a valid proxy:
  // materials can be attached to a hand-typed offering, and crediting hours
  // saved for work the operator did themselves would be a lie.
  const aiAuthored = useMemo(
    () => Object.values(extractedByName).some((r) => r?.extracted_value != null),
    [extractedByName],
  );

  function flashSaved(fieldName) {
    setSavingField(fieldName);
    setTimeout(() => setSavingField((cur) => (cur === fieldName ? null : cur)), 1100);
  }

  // Drives the tri-state CTA-bar copy. Auto-resets back to "idle" after a short
  // window so the bar doesn't sit on "Saved" forever once the operator moves on.
  function markSaveState(next) {
    setSaveState(next);
    if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current);
    if (next === "saved" || next === "error") {
      const ms = next === "error" ? 4000 : 2000;
      savedFlashTimer.current = setTimeout(() => setSaveState("idle"), ms);
    }
  }

  // Write a top-level field both to curricula and to curriculum_extracted_fields.
  // For null-from-extraction fields (e.g. class_size on existing rows) the
  // extracted_fields row may not exist yet — upsert by (curriculum_id, field_name).
  async function persistTopField(fieldName, columnPatch, extractedValue) {
    if (!curriculum || !org?.id) return;
    markSaveState("saving");
    // 1. patch curricula
    const { error: curErr } = await supabase
      .from("curricula")
      .update(columnPatch)
      .eq("id", curriculum.id);
    if (curErr) {
      console.error("save curricula failed", fieldName, curErr);
      markSaveState("error");
      return;
    }
    // 2. upsert extracted_fields
    const existing = extractedByName[fieldName];
    const payload = {
      curriculum_id: curriculum.id,
      organization_id: org.id,
      field_name: fieldName,
      human_edited_value: extractedValue ?? null,
      human_approved: true,
      human_approved_by: user?.id ?? null,
    };
    if (existing) {
      const { data: updated, error: upErr } = await supabase
        .from("curriculum_extracted_fields")
        .update(payload)
        .eq("id", existing.id)
        .select()
        .maybeSingle();
      if (!upErr && updated) {
        setExtractedByName((m) => ({ ...m, [fieldName]: updated }));
      }
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from("curriculum_extracted_fields")
        .insert({ ...payload, extracted_value: null, confidence: null })
        .select()
        .maybeSingle();
      if (!insErr && inserted) {
        setExtractedByName((m) => ({ ...m, [fieldName]: inserted }));
      }
    }
    setCurriculum((c) => ({ ...c, ...columnPatch }));
    flashSaved(fieldName);
    markSaveState("saved");
  }

  // Debounced version for text inputs. Immediate variant for chips / selects.
  // Each pending entry stores both its timer AND a `run` that performs the write,
  // so flushPendingSaves() can commit an in-flight edit instead of the timer
  // firing after unmount (write with no confirmation) or being cancelled on
  // navigation (edit silently dropped).
  function saveTopFieldDebounced(fieldName, columnPatch, extractedValue, immediate = false) {
    // Optimistic local update so the UI reflects typing
    setCurriculum((c) => ({ ...c, ...columnPatch }));
    const timers = debounceTimers.current;
    const existing = timers.get(fieldName);
    if (existing) clearTimeout(existing.timer);
    const run = () => persistTopField(fieldName, columnPatch, extractedValue);
    if (immediate) {
      timers.delete(fieldName);
      run();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(fieldName);
      run();
    }, 800);
    timers.set(fieldName, { timer, run });
  }

  // Curriculum family (lego/coding/robotics) — a plain column, not a doc-extracted field.
  async function saveCategory(value) {
    if (!curriculum) return;
    setCurriculum((c) => ({ ...c, category: value || null }));
    markSaveState("saving");
    const { error } = await supabase.from("curricula").update({ category: value || null }).eq("id", curriculum.id);
    if (error) { console.error("save category failed", error); markSaveState("error"); return; }
    flashSaved("category");
    markSaveState("saved");
  }

  async function saveSessionField(sessionId, columnPatch, immediate = false) {
    setSessions((rows) => rows.map((r) => (r.id === sessionId ? { ...r, ...columnPatch } : r)));
    const key = `session-${sessionId}-${Object.keys(columnPatch)[0]}`;
    const timers = debounceTimers.current;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing.timer);
    const run = async () => {
      // Drop our own entry first so a concurrent flush() doesn't run us twice.
      timers.delete(key);
      markSaveState("saving");
      const { error } = await supabase
        .from("curriculum_sessions")
        .update(columnPatch)
        .eq("id", sessionId);
      if (error) {
        console.error("save session failed", error);
        markSaveState("error");
      } else {
        flashSaved(key);
        markSaveState("saved");
      }
    };
    if (immediate) { run(); return; }
    const timer = setTimeout(run, 800);
    timers.set(key, { timer, run });
  }

  // Commit every pending debounced write NOW. The 800ms timers were previously
  // just cancelled on Save-as-draft / Publish (dropping a just-typed edit) and
  // left to fire after unmount on navigation (writing with no confirmation).
  // Flushing runs the captured write for each and awaits them, so an in-flight
  // edit is never lost. Best-effort: a single failing write never blocks the rest.
  async function flushPendingSaves() {
    const timers = debounceTimers.current;
    const pending = Array.from(timers.values());
    timers.clear();
    await Promise.all(pending.map((p) => {
      clearTimeout(p.timer);
      try { return Promise.resolve(p.run()); } catch { return Promise.resolve(); }
    }));
  }

  // Polish with Ennie: open the modal pre-loaded with the right field's context.
  // For curriculum-level skill rollups, the onAccept replaces the field via
  // the same debounced save path. For per-session skills_practiced, it routes
  // through saveSessionField.
  function openPolishForTopField(fieldName, current, targetCount = 6) {
    setPolishConfig({
      field: fieldName,
      sessionId: undefined,
      current,
      targetCount,
      onAccept: (polished) =>
        saveTopFieldDebounced(fieldName, { [fieldName]: polished }, polished, true),
    });
  }

  function openPolishForSession(sessionId, current) {
    setPolishConfig({
      field: "skills_practiced",
      sessionId,
      current,
      targetCount: 4,
      onAccept: (polished) =>
        saveSessionField(sessionId, { skills_practiced: polished }, true),
    });
  }

  // Description polish: free-text rewrite using the same polish-skills edge
  // function (which branches on field === "short_description"). onAccept saves
  // back through the usual debounced path.
  function openPolishForDescription(current) {
    setPolishConfig({
      field: "short_description",
      sessionId: undefined,
      current,
      targetCount: 1,
      onAccept: (polished) =>
        saveTopFieldDebounced("short_description", { short_description: polished }, polished, true),
    });
  }

  function toggleSession(id) {
    setOpenSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function jumpToFirstFlag() {
    const el = document.querySelector("[data-flagged='true']");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function openDocLink(storagePath, filename) {
    if (!storagePath) return;
    const { data, error } = await supabase.storage
      .from("curriculum-documents")
      .createSignedUrl(storagePath, 60 * 60);
    if (error || !data?.signedUrl) {
      alert("Could not open that document.");
      return;
    }
    const ext = (filename || storagePath).split(".").pop()?.toLowerCase();
    const useViewer = ext && ["docx","doc","xlsx","xls","pptx","ppt","txt","md"].includes(ext);
    const url = useViewer
      ? `https://docs.google.com/gview?url=${encodeURIComponent(data.signedUrl)}&embedded=true`
      : data.signedUrl;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Delete a single document: storage object first (best-effort - an orphaned
  // row is worse than an orphaned file), then the row. Extracted fields are
  // intentionally left alone; removing the file it came from doesn't unmake the
  // details the operator already reviewed.
  async function deleteDoc(doc) {
    if (!doc?.id || docDeleting) return;
    setDocDeleting(true);
    setDocError("");
    // Row FIRST. If it fails we have changed nothing and can surface a clean
    // error. Removing the storage object first would leave a row pointing at a
    // missing file, so "Open" would break on a delete we just reported failed.
    const { error } = await supabase.from("curriculum_documents").delete().eq("id", doc.id);
    if (error) {
      // Never swallow this - the operator's next decision depends on whether
      // the file is actually gone.
      console.error("delete doc failed", error);
      setDocDeleting(false);
      setDocError(`Couldn't delete ${doc.original_filename || "that file"}. Please try again.`);
      return;
    }
    // Row is gone, so a failed cleanup only orphans an invisible file.
    if (doc.storage_path) {
      const { error: stErr } = await supabase.storage.from("curriculum-documents").remove([doc.storage_path]);
      if (stErr) console.warn("Row deleted but storage cleanup failed (orphaned file):", stErr.message);
    }
    setDocDeleting(false);
    setDocs((ds) => ds.filter((d) => d.id !== doc.id));
    setDocPendingDelete(null);
  }

  async function saveAsDraft() {
    if (!curriculum) return;
    // Commit any pending debounced edit before we leave (was: cancelled here,
    // which silently dropped a field the operator typed right before clicking).
    await flushPendingSaves();
    // "extracted" means AI actually pulled these details out of a document, so
    // key off that directly rather than "a doc exists". Merely having a file
    // isn't enough (one can be attached with extraction skipped), and losing the
    // file later doesn't unmake an extraction that did happen. A hand-typed
    // offering stays a Draft until published; the offerings list already gives
    // doc-less drafts an "Edit details" + "Upload doc" pair of CTAs.
    const nextStatus = aiAuthored ? "extracted" : "draft";
    await supabase.from("curricula").update({ status: nextStatus }).eq("id", curriculum.id);
    navigate("/admin/curricula");
  }

  function startPublish() {
    setPublishError("");
    setPublishStep(1);
    setNameDraft(curriculum?.name || "");
    setPublishOpen(true);
  }

  async function advanceToStep2() {
    setPublishError("");
    if (!nameDraft.trim()) {
      setPublishError("A name is required before publishing.");
      return;
    }
    // Fuzzy-match against BOTH:
    //   - programs.curriculum (afterschool: FA, WI, SP)
    //   - camp_sessions.curriculum_name (summer camps)
    // Either side where curriculum_id IS NULL is a candidate to link.
    // Also count rows ALREADY linked to this curriculum so step 2 + the
    // celebration screen can reflect that linkage (e.g., when the operator
    // attaches a doc to a backfilled draft that's already linked to camps).
    const [
      { data: progRows },
      { data: campRows },
      { data: alreadyProgRows },
      { data: alreadyCampRows },
    ] = await Promise.all([
      supabase
        .from("programs")
        .select("id, curriculum, term")
        .eq("organization_id", org.id)
        .is("curriculum_id", null),
      supabase
        .from("camp_sessions")
        .select("id, curriculum_name, session_type")
        .eq("organization_id", org.id)
        .is("curriculum_id", null),
      // Fetch the ROWS (not just a count) so step 2 can list exactly which
      // program runs this offering is already linked to.
      supabase
        .from("programs")
        .select("id, term, day_of_week, first_session_date, status, program_locations ( name )")
        .eq("organization_id", org.id)
        .eq("curriculum_id", curriculum.id)
        .order("term", { ascending: true })
        .order("first_session_date", { ascending: true, nullsFirst: false }),
      supabase
        .from("camp_sessions")
        .select("id, location_name, week_num, session_type, starts_on")
        .eq("organization_id", org.id)
        .eq("curriculum_id", curriculum.id)
        .order("starts_on", { ascending: true, nullsFirst: false }),
    ]);
    setPreLinkedProgramCount(alreadyProgRows?.length ?? 0);
    setPreLinkedCampSessionCount(alreadyCampRows?.length ?? 0);
    setPreLinkedPrograms(alreadyProgRows ?? []);
    setPreLinkedCampSessions(alreadyCampRows ?? []);

    // Group by name within each source so the operator picks a clean "this match"
    // rather than dozens of individual rows.
    const groups = new Map(); // key = `${source}::${name}` → { source, name, ids: [], runCount }
    for (const p of progRows ?? []) {
      const name = p.curriculum || "";
      const key = `programs::${name}`;
      if (!groups.has(key)) groups.set(key, { source: "programs", name, ids: [], runCount: 0, key });
      const g = groups.get(key);
      g.ids.push(p.id);
      g.runCount += 1;
    }
    for (const c of campRows ?? []) {
      const name = c.curriculum_name || "";
      // Camp_sessions: group by name AND session_type so half-day (afternoon /
      // morning) and full_day sessions don't bundle together. They're typically
      // different curricula even when scheduled under the same brand name.
      const sessionType = c.session_type || "unknown";
      const key = `camp_sessions::${name}::${sessionType}`;
      if (!groups.has(key)) groups.set(key, { source: "camp_sessions", name, sessionType, ids: [], runCount: 0, key });
      const g = groups.get(key);
      g.ids.push(c.id);
      g.runCount += 1;
    }

    const matches = [];
    for (const g of groups.values()) {
      const score = matchScore(nameDraft, g.name);
      if (score >= 0.5) matches.push({ ...g, score });
    }
    matches.sort((a, b) => b.score - a.score);
    setProgramMatches(matches);
    setSelectedMatchKeys(new Set(matches.map((m) => m.key)));
    setPublishStep(2);
  }

  async function doPublish() {
    if (!curriculum) return;
    setPublishing(true);
    setPublishError("");
    try {
      // 1. commit any pending debounced edit, then save final name
      await flushPendingSaves();
      const finalName = nameDraft.trim();
      if (finalName !== curriculum.name) {
        await supabase.from("curricula").update({ name: finalName }).eq("id", curriculum.id);
        setCurriculum((c) => ({ ...c, name: finalName }));
      }
      // 2. publish
      const { error: pubErr } = await supabase
        .from("curricula")
        .update({ status: "published" })
        .eq("id", curriculum.id);
      if (pubErr) throw pubErr;
      // 3. link selected matches — write curriculum_id to the right table
      //    based on each match's source (programs vs camp_sessions).
      const programIdsToLink = [];
      const campSessionIdsToLink = [];
      for (const m of programMatches) {
        if (!selectedMatchKeys.has(m.key)) continue;
        if (m.source === "programs") programIdsToLink.push(...m.ids);
        else if (m.source === "camp_sessions") campSessionIdsToLink.push(...m.ids);
      }
      if (programIdsToLink.length > 0) {
        const { error: linkErr } = await supabase
          .from("programs")
          .update({ curriculum_id: curriculum.id })
          .in("id", programIdsToLink);
        if (linkErr) console.error("link programs failed", linkErr);
      }
      if (campSessionIdsToLink.length > 0) {
        const { error: linkCampErr } = await supabase
          .from("camp_sessions")
          .update({ curriculum_id: curriculum.id })
          .in("id", campSessionIdsToLink);
        if (linkCampErr) console.error("link camp_sessions failed", linkCampErr);
      }
      // True totals = newly linked this publish session + previously linked.
      setLinkedProgramCount(programIdsToLink.length + preLinkedProgramCount);
      setLinkedCampSessionCount(campSessionIdsToLink.length + preLinkedCampSessionCount);

      // Log the time-saved event so the sidebar tally + future analytics see
      // this work. Dynamic estimate: 1.5 hours per session, floor 10 hours.
      // Per project_enrops_time_saved memory: "saved you N+ hours" framing.
      // Only credit time saved when AI extraction actually did the authoring.
      // A manual entry (no doc, no extracted fields) was typed by the operator,
      // so claiming "saved you N hours" at publish would be false. Downstream
      // surfaces (flyer/recap/registration) log their own savings when used.
      if (aiAuthored) {
        const sessionCount = sessions.length || 5;
        const hoursSaved = Math.max(10, Math.ceil(sessionCount * 1.5));
        const { error: tsErr } = await supabase.from("time_saved_events").insert({
          organization_id: org.id,
          action_type: "curriculum_published",
          action_label: `Published "${finalName}"`,
          hours_saved: hoursSaved,
          related_entity_type: "curriculum",
          related_entity_id: curriculum.id,
          created_by: user?.id ?? null,
        });
        if (tsErr) console.warn("time_saved_events insert failed (non-fatal):", tsErr.message);
      }

      // Phase 2 recommendation: ask ennie-recommend what the next clear action
      // is. Non-fatal -- the celebration screen has a static fallback CTA.
      try {
        const { data: recData, error: recErr } = await supabase.functions.invoke("ennie-recommend", {
          body: { curriculum_id: curriculum.id },
        });
        if (!recErr && recData) setEnnieRecommendation(recData);
      } catch (e) {
        console.warn("ennie-recommend failed (using fallback):", e instanceof Error ? e.message : String(e));
      }
      setPublishing(false);
      setPublishStep(3); // celebration
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e));
      setPublishing(false);
    }
  }

  if (loading) return <div style={{ color: MUTED, padding: 24 }}>Loading…</div>;
  if (loadError) return <div style={errorBox}>{loadError}</div>;

  return (
    <div style={{ paddingBottom: 80 }}>
      <div style={crumbs}>
        <Link to="/admin/curricula" style={crumbLink}>Offerings</Link>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>{curriculum.name}</span>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>Review</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 4 }}>
        <div>
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>{curriculum.name}</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", maxWidth: 720 }}>
            We pulled out the structure. Look it over, edit anything, then publish so it's ready to schedule into a term.
          </p>
        </div>
        <StatusPill status={curriculum.status} />
      </div>

      <div style={layout}>
        {/* LEFT: source docs */}
        <div style={docsPanel}>
          <div style={panelLabel}>Documents</div>
          {docs.length === 0 && (
            <div style={{ color: MUTED, fontSize: 13 }}>No documents on file.</div>
          )}
          {DOC_GROUPS.map((g) => {
            const items = docs.filter((d) => docGroupKey(d.doc_type) === g.key);
            if (items.length === 0) return null;
            return (
              <div key={g.key} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                  {g.label}
                </div>
                {items.map((d, idx) => (
            <div key={d.id} style={{ ...docRow, borderTop: idx === 0 ? 0 : `1px solid ${RULE}`, paddingTop: idx === 0 ? 0 : 10, flexWrap: "wrap" }}>
              <span style={{ color: PURPLE, flexShrink: 0 }}>📄</span>
              <div style={{ flex: 1, fontSize: 13, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                {d.original_filename || "(unnamed)"}
              </div>
              <button
                onClick={() => openDocLink(d.storage_path, d.original_filename)}
                style={openLinkBtn}
              >Open</button>
              {canManageDocs && (
                <button
                  type="button"
                  title={`Delete ${d.original_filename || "this file"}`}
                  aria-label={`Delete ${d.original_filename || "this file"}`}
                  onClick={() => { setDocError(""); setDocPendingDelete(d.id); }}
                  style={{ background: "none", border: "none", color: MUTED, cursor: "pointer", fontSize: 13, padding: "2px 4px", lineHeight: 1 }}
                >🗑</button>
              )}
              {canManageDocs && docPendingDelete === d.id && (
                <div style={{ flexBasis: "100%", marginTop: 6, background: "#fff5f5", border: "1px solid #f0c4c4", borderRadius: 4, padding: "8px 10px" }}>
                  <div style={{ fontSize: 12, color: INK, lineHeight: 1.4, marginBottom: 6 }}>
                    Delete this file? This can't be undone. Your curriculum details stay as they are.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => deleteDoc(d)}
                      disabled={docDeleting}
                      style={{ background: "#a13a3a", color: "#fff", border: "none", borderRadius: 4, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: docDeleting ? "default" : "pointer", opacity: docDeleting ? 0.6 : 1, fontFamily: "inherit" }}
                    >{docDeleting ? "Deleting…" : "Delete"}</button>
                    <button
                      type="button"
                      onClick={() => setDocPendingDelete(null)}
                      disabled={docDeleting}
                      style={{ background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 4, padding: "4px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                    >Cancel</button>
                  </div>
                </div>
              )}
            </div>
                ))}
              </div>
            );
          })}
          {docError && (
            <div style={{ marginTop: 10, color: "#a13a3a", fontSize: 12, lineHeight: 1.4 }}>{docError}</div>
          )}
          {canManageDocs && (
          <button
            type="button"
            onClick={() => setAddDocOpen(true)}
            style={{
              marginTop: 14,
              width: "100%",
              padding: "8px 12px",
              background: "transparent",
              border: `1px dashed ${PURPLE}66`,
              borderRadius: 6,
              color: PURPLE,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            + Add document
          </button>
          )}
          {canManageDocs && hasSourceDoc && (
          <button
            type="button"
            onClick={() => setReplaceDocOpen(true)}
            style={{
              marginTop: 8,
              width: "100%",
              padding: "8px 12px",
              background: "transparent",
              border: `1px dashed ${PURPLE}66`,
              borderRadius: 6,
              color: PURPLE,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            ↻ Replace source doc
          </button>
          )}
        </div>

        {/* RIGHT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <EnnieBanner flagCount={flagCount} onJump={jumpToFirstFlag} manual={isManualEntry} progress={progress} />

          <section style={card}>
            <div style={sectionHead}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>The full offering</h3>
              <span style={{ color: MUTED, fontSize: 12 }}>Edits save as you go</span>
            </div>
            <p style={sectionBlurb}>
              Everything below feeds your registration page, marketing emails, instructor portal, and parent recaps. Fields with a gold ring are ones Ennie wasn't fully sure about — worth a glance.
            </p>

            <FieldText
              label="Offering name"
              value={curriculum.name ?? ""}
              onChange={(v) => saveTopFieldDebounced("name", { name: v }, v)}
              saved={savingField === "name"}
            />

            <FieldTextarea
              label="Short description"
              help="This is what parents see on your registration page. Lead with what kids do and make."
              value={curriculum.short_description ?? ""}
              onChange={(v) => saveTopFieldDebounced("short_description", { short_description: v }, v)}
              flagged={isFieldFlagged({ curriculum, fieldName: "short_description", extractedRow: extractedByName.short_description })}
              saved={savingField === "short_description"}
              onPolish={(current) => openPolishForDescription(current)}
            />

            <div style={row2}>
              <AgeGradeField
                ageOrGrade={ageOrGrade}
                setAgeOrGrade={setAgeOrGrade}
                curriculum={curriculum}
                flagged={isFieldFlagged({ curriculum, fieldName: "age_range", extractedRow: extractedByName.age_range })}
                onSave={(patch, exVal, immediate) => saveTopFieldDebounced("age_range", patch, exVal, immediate)}
                saved={savingField === "age_range"}
              />

              <FieldSelect
                label="Format"
                value={curriculum.format ?? ""}
                options={FORMAT_OPTIONS}
                placeholder="Pick a format"
                onChange={(v) => saveTopFieldDebounced("format", { format: v || null }, v, true)}
                flagged={isFieldFlagged({ curriculum, fieldName: "format", extractedRow: extractedByName.format })}
                saved={savingField === "format"}
              />

              <div style={fieldWrap}>
                <FieldLabel>Family<SavedTick on={savingField === "category"} /></FieldLabel>
                <select value={curriculum.category ?? ""} onChange={(e) => saveCategory(e.target.value)} style={textInput}>
                  <option value="">Pick a family</option>
                  {CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {!curriculum.category && guessCategory(curriculum.name) && (
                  <button
                    type="button"
                    onClick={() => saveCategory(guessCategory(curriculum.name))}
                    style={{ marginTop: 6, background: "none", border: "none", color: "#3a7c3a", fontSize: 12, cursor: "pointer", padding: 0, fontFamily: "inherit", textAlign: "left" }}
                  >
                    Suggested: {CATEGORY_OPTIONS.find((o) => o.value === guessCategory(curriculum.name))?.label} — tap to use
                  </button>
                )}
                <div style={fieldHelp}>Matches instructors who enjoy this family (LEGO / Coding / Robotics).</div>
              </div>
            </div>

            <div style={row2}>
              <FieldNumber
                label="Sessions"
                inlineHelp="change requires re-uploading"
                value={curriculum.session_count ?? ""}
                disabled
              />

              <ClassSizeField
                curriculum={curriculum}
                flagged={isFieldFlagged({ curriculum, fieldName: "class_size", extractedRow: extractedByName.class_size })}
                onSave={(patch, exVal) => saveTopFieldDebounced("class_size", patch, exVal)}
                saved={savingField === "class_size"}
              />
            </div>

            <FieldText
              label="Prerequisites"
              inlineHelp="optional"
              help="What parents should know before signing up."
              placeholder="e.g. Beginner OK · should be comfortable reading"
              value={curriculum.prerequisites ?? ""}
              onChange={(v) => saveTopFieldDebounced("prerequisites", { prerequisites: v || null }, v)}
              flagged={isFieldFlagged({ curriculum, fieldName: "prerequisites", extractedRow: extractedByName.prerequisites })}
              saved={savingField === "prerequisites"}
            />

            <SessionTypesField
              value={curriculum.session_types_supported ?? []}
              onChange={(arr) => saveTopFieldDebounced("session_types_supported", { session_types_supported: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "session_types_supported", extractedRow: extractedByName.session_types_supported })}
              saved={savingField === "session_types_supported"}
            />

            <FieldChips
              label="Themes"
              help="Pop-culture or topical themes parents recognize."
              value={curriculum.themes ?? []}
              onChange={(arr) => saveTopFieldDebounced("themes", { themes: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "themes", extractedRow: extractedByName.themes })}
              saved={savingField === "themes"}
            />

            <FieldTextarea
              label="Narrative arc"
              inlineHelp="optional"
              help="If there's a story or theme running across all sessions, it lives here."
              value={curriculum.narrative_arc ?? ""}
              onChange={(v) => saveTopFieldDebounced("narrative_arc", { narrative_arc: v || null }, v)}
              flagged={isFieldFlagged({ curriculum, fieldName: "narrative_arc", extractedRow: extractedByName.narrative_arc })}
              saved={savingField === "narrative_arc"}
            />

            <FieldChips
              label="Skills overall"
              help="Plain-language. Used in parent-facing surfaces + the final recap email."
              value={curriculum.skills_overall ?? []}
              onChange={(arr) => saveTopFieldDebounced("skills_overall", { skills_overall: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "skills_overall", extractedRow: extractedByName.skills_overall })}
              saved={savingField === "skills_overall"}
              onPolish={(current) => openPolishForTopField("skills_overall", current, 6)}
            />

            <FieldChips
              label="Mid-term recap skills"
              inlineHelp="auto-filled · top 6"
              help="The 6 skills most practiced across the first half of sessions. Featured in the mid-program parent email."
              value={curriculum.mid_term_skills ?? []}
              onChange={(arr) => saveTopFieldDebounced("mid_term_skills", { mid_term_skills: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "mid_term_skills", extractedRow: extractedByName.mid_term_skills })}
              saved={savingField === "mid_term_skills"}
              onPolish={(current) => openPolishForTopField("mid_term_skills", current, 6)}
            />

            <FieldChips
              label="Final recap skills"
              inlineHelp="auto-filled · top 6"
              help="The 6 skills most practiced across the whole offering. Featured in the final recap parent email at term end."
              value={curriculum.final_recap_skills ?? []}
              onChange={(arr) => saveTopFieldDebounced("final_recap_skills", { final_recap_skills: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "final_recap_skills", extractedRow: extractedByName.final_recap_skills })}
              saved={savingField === "final_recap_skills"}
              onPolish={(current) => openPolishForTopField("final_recap_skills", current, 6)}
            />

            <FieldTextarea
              label="Final showcase"
              inlineHelp="optional"
              help="If the offering ends with a capstone, performance, or family event. Powers the pre-launch reminder email."
              value={curriculum.final_showcase ?? ""}
              onChange={(v) => saveTopFieldDebounced("final_showcase", { final_showcase: v || null }, v)}
              flagged={isFieldFlagged({ curriculum, fieldName: "final_showcase", extractedRow: extractedByName.final_showcase })}
              saved={savingField === "final_showcase"}
            />

            <FieldChips
              label="Materials"
              value={curriculum.materials ?? []}
              onChange={(arr) => saveTopFieldDebounced("materials", { materials: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "materials", extractedRow: extractedByName.materials })}
              saved={savingField === "materials"}
            />
          </section>

          <section style={card}>
            <div style={sectionHead}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>Sessions</h3>
              <span style={{ color: MUTED, fontSize: 12 }}>{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
            </div>
            <p style={sectionBlurb}>
              Each session has a recap that appears in the <strong>parent portal</strong> after class. By default we email parents a mid-term and final recap only — email cadence is configurable later. Use <code style={inlineCode}>{`{photos}`}</code> where the instructor's photos slot in.
            </p>

            {sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                open={openSessionIds.has(s.id)}
                onToggle={() => toggleSession(s.id)}
                onSave={(patch, immediate) => saveSessionField(s.id, patch, immediate)}
                savingField={savingField}
                onPolishSkills={openPolishForSession}
              />
            ))}
          </section>

          {/* Sticky CTA bar */}
          <div style={ctaBar}>
            <SaveStateLabel state={saveState} />
            <div style={{ display: "flex", gap: 10 }}>
              <Link to="/admin/curricula" style={tertiaryBtn}>← Back to library</Link>
              {curriculum.status === "published" ? (
                <button onClick={() => setLinkModalOpen(true)} style={secondaryBtn}>Manage program links</button>
              ) : (
                <>
                  <button onClick={saveAsDraft} style={secondaryBtn}>Save as draft</button>
                  <button onClick={startPublish} style={primaryBtn}>Publish offering →</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {publishOpen && (
        <PublishModal
          step={publishStep}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          programMatches={programMatches}
          selectedMatchKeys={selectedMatchKeys}
          setSelectedMatchKeys={setSelectedMatchKeys}
          publishing={publishing}
          error={publishError}
          onCancel={() => setPublishOpen(false)}
          onContinue={advanceToStep2}
          onPublish={doPublish}
          curriculum={curriculum}
          sessionCount={sessions.length}
          manual={isManualEntry}
          linkedProgramCount={linkedProgramCount}
          linkedCampSessionCount={linkedCampSessionCount}
          preLinkedProgramCount={preLinkedProgramCount}
          preLinkedCampSessionCount={preLinkedCampSessionCount}
          preLinkedPrograms={preLinkedPrograms}
          preLinkedCampSessions={preLinkedCampSessions}
          capabilities={capabilities}
          recommendation={ennieRecommendation}
          onDone={() => navigate("/admin/curricula")}
          onRecommendationCta={(to) => navigate(to)}
          onLinkExisting={() => {
            setPublishOpen(false);
            setLinkModalOpen(true);
          }}
          onCapabilityClick={(cap, unlocked) => setCapabilityModalConfig({ capability: cap, unlocked })}
        />
      )}

      {capabilityModalConfig && (
        <CapabilityDetailModal
          capability={capabilityModalConfig.capability}
          unlocked={capabilityModalConfig.unlocked}
          onClose={() => setCapabilityModalConfig(null)}
        />
      )}

      {polishConfig && (
        <PolishModal
          curriculumId={curriculum?.id}
          config={polishConfig}
          onClose={() => setPolishConfig(null)}
        />
      )}

      {addDocOpen && curriculum && (
        <DocUploadModal
          mode="add"
          curriculumId={curriculum.id}
          curriculumName={curriculum.name}
          organizationId={org.id}
          onClose={() => setAddDocOpen(false)}
          onAdded={(newDoc) => {
            setDocs((ds) => [...ds, newDoc]);
            setAddDocOpen(false);
          }}
          onStarted={() => {
            setAddDocOpen(false);
            navigate(`/admin/curricula/${curriculum.id}/extracting`);
          }}
        />
      )}

      {replaceDocOpen && curriculum && (
        <DocUploadModal
          mode="replace"
          curriculumId={curriculum.id}
          curriculumName={curriculum.name}
          organizationId={org.id}
          onClose={() => setReplaceDocOpen(false)}
          onAdded={(newDoc) => {
            // Replaced the file without re-extracting: the old source row is
            // gone, so swap the panel to just the new one plus any materials.
            setDocs((ds) => [...ds.filter((d) => d.doc_type !== "instructor_guide"), newDoc]);
            setReplaceDocOpen(false);
          }}
          onStarted={(docId) => {
            setReplaceDocOpen(false);
            navigate(`/admin/curricula/${curriculum.id}/extracting`);
          }}
        />
      )}

      {linkModalOpen && curriculum && (
        <LinkExistingModal
          curriculumId={curriculum.id}
          curriculumName={curriculum.name}
          organizationId={org.id}
          userId={user?.id}
          onClose={() => setLinkModalOpen(false)}
          onSaved={() => {
            // After saving, refresh linked counts so the capability strip on
            // the next library visit reflects the new linkage. The CurriculaList
            // re-queries on org change which doesn't trigger here, but the
            // operator will see the new state on their next navigation.
            setLinkModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SaveStateLabel({ state }) {
  if (state === "saving") {
    return <div style={{ color: MUTED, fontSize: 13 }}>Saving…</div>;
  }
  if (state === "saved") {
    return <div style={{ color: "#4e914e", fontSize: 13, fontWeight: 600 }}>✓ Saved</div>;
  }
  if (state === "error") {
    return <div style={{ color: "#a13a3a", fontSize: 13, fontWeight: 600 }}>Couldn't save — try again</div>;
  }
  return <div style={{ color: MUTED, fontSize: 13 }}>All edits are saved.</div>;
}

// --- Subcomponents ---


function ProgressMeter({ progress }) {
  if (!progress || !progress.total) return null;
  const { filled, total } = progress;
  const done = filled >= total;
  const pct = Math.round((filled / total) * 100);
  return (
    <div style={{ marginTop: 10, maxWidth: 460 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: done ? "#3a7c3a" : PURPLE }}>
          {done ? "All key details filled ✓" : `${filled} of ${total} key details filled`}
        </span>
        {!done && <span style={{ fontSize: 11, color: MUTED }}>{total - filled} to go</span>}
      </div>
      <div style={{ height: 6, borderRadius: 4, background: "#ece9f7", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: done ? "#3a7c3a" : BRIGHT, transition: "width 0.3s ease" }} />
      </div>
    </div>
  );
}

function EnnieBanner({ flagCount, onJump, manual, progress }) {
  const calm = flagCount === 0;
  if (manual) {
    return (
      <section style={ennieBannerCalm}>
        <Ennie state="idle" calm framed={false} size={52} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: INK, fontSize: 14 }}>
            Ennie <span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your helper</span>
          </div>
          <div style={{ fontSize: 14, color: INK, marginTop: 2, lineHeight: 1.45 }}>
            Fill in as much or as little as you like, then publish. Want it done for you? Add a document anytime and I'll auto-fill the rest.
          </div>
          <ProgressMeter progress={progress} />
        </div>
      </section>
    );
  }
  return (
    <section style={calm ? ennieBannerCalm : ennieBanner}>
      <Ennie state="idle" calm={calm} framed={false} size={52} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: calm ? INK : PURPLE, fontSize: 14 }}>
          Ennie <span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your helper</span>
        </div>
        <div style={{ fontSize: 14, color: INK, marginTop: 2, lineHeight: 1.45 }}>
          {calm
            ? <>All caught up. ✓ Ready to publish whenever you are.</>
            : <>I flagged <strong style={{ color: PURPLE }}>{flagCount} field{flagCount === 1 ? "" : "s"}</strong> below worth a look — they're outlined in gold. Edit any of them to clear the flag.</>}
        </div>
        <ProgressMeter progress={progress} />
      </div>
      {!calm && (
        <button onClick={onJump} style={ennieActionBtn}>Jump to first ↓</button>
      )}
    </section>
  );
}

function StatusPill({ status }) {
  const map = {
    draft: { bg: "#f7f6ef", color: MUTED, label: "Draft" },
    extracted: { bg: GOLD_SOFT, color: "#7a5a00", label: "Extracted" },
    published: { bg: PLUM_SOFT, color: PURPLE, label: "Published" },
  };
  const s = map[status] ?? map.draft;
  return (
    <span style={{
      background: s.bg, color: s.color, fontSize: 11, fontWeight: 600,
      padding: "4px 10px", borderRadius: 12, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap", flexShrink: 0,
    }}>{s.label}</span>
  );
}

function FieldLabel({ children, inlineHelp, flagged }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: INK, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>
      <span>{children}{inlineHelp && <span style={{ color: MUTED, fontWeight: 500, textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>— {inlineHelp}</span>}</span>
      {flagged && <FlagBadge />}
    </div>
  );
}

function FlagBadge() {
  return (
    <span title="Double-check this one — Ennie wasn't fully sure." style={flagBadge}>◆ Ennie flagged</span>
  );
}

function SavedTick({ on }) {
  return <span style={{ marginLeft: 6, fontSize: 12, color: BRIGHT, opacity: on ? 1 : 0, transition: "opacity 0.2s" }}>✓</span>;
}

function FieldText({ label, inlineHelp, help, value, onChange, flagged, saved, placeholder, ...rest }) {
  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <FieldLabel inlineHelp={inlineHelp} flagged={flagged}>{label}<SavedTick on={saved} /></FieldLabel>
      {help && <div style={fieldHelp}>{help}</div>}
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...textInput, ...(flagged ? lowConf : {}) }}
        {...rest}
      />
    </div>
  );
}

function FieldNumber({ label, inlineHelp, value, ...rest }) {
  return (
    <div style={fieldWrap}>
      <FieldLabel inlineHelp={inlineHelp}>{label}</FieldLabel>
      <input type="number" value={value} style={{ ...textInput, maxWidth: 120, background: "#f7f6ef", color: MUTED }} {...rest} />
    </div>
  );
}

function FieldTextarea({ label, inlineHelp, help, value, onChange, flagged, saved, placeholder, onPolish }) {
  const canPolish = typeof onPolish === "function" && typeof value === "string" && value.trim().length > 0;
  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <FieldLabel inlineHelp={inlineHelp} flagged={flagged}>{label}<SavedTick on={saved} /></FieldLabel>
        {onPolish && (
          <button
            type="button"
            onClick={() => canPolish && onPolish(value)}
            disabled={!canPolish}
            title={canPolish ? "Ask Ennie to rewrite this into parent-impressive copy" : "Add text first"}
            style={{
              background: canPolish ? GOLD_SOFT : "transparent",
              border: `1px solid ${canPolish ? GOLD_BORDER : RULE}`,
              color: canPolish ? "#7a5a00" : MUTED,
              borderRadius: 12,
              fontSize: 11,
              fontWeight: 600,
              padding: "3px 9px",
              cursor: canPolish ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
            }}
          >
            ✨ Polish with Ennie
          </button>
        )}
      </div>
      {help && <div style={fieldHelp}>{help}</div>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...textInput, minHeight: 80, lineHeight: 1.5, resize: "vertical", ...(flagged ? lowConf : {}) }}
      />
    </div>
  );
}

function FieldSelect({ label, value, options, placeholder, onChange, flagged, saved }) {
  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <FieldLabel flagged={flagged}>{label}<SavedTick on={saved} /></FieldLabel>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...textInput, ...(flagged ? lowConf : {}) }}>
        <option value="">{placeholder ?? "Pick one"}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function AgeGradeField({ ageOrGrade, setAgeOrGrade, curriculum, flagged, onSave, saved }) {
  const isAges = ageOrGrade === "ages";
  const minVal = isAges ? (curriculum.age_range_min ?? "") : (curriculum.grade_min ?? "");
  const maxVal = isAges ? (curriculum.age_range_max ?? "") : (curriculum.grade_max ?? "");

  function updateMin(raw) {
    const v = raw === "" ? null : Number(raw);
    if (isAges) {
      const patch = { age_range_min: v, age_range_max: curriculum.age_range_max };
      onSave(patch, { min: v, max: curriculum.age_range_max });
    } else {
      // Grades use a dropdown — a discrete choice, so save immediately (like the
      // Format select) rather than waiting out the text-input 800ms debounce.
      onSave({ grade_min: v, grade_max: curriculum.grade_max }, { min: v, max: curriculum.grade_max }, true);
    }
  }
  function updateMax(raw) {
    const v = raw === "" ? null : Number(raw);
    if (isAges) {
      onSave({ age_range_min: curriculum.age_range_min, age_range_max: v }, { min: curriculum.age_range_min, max: v });
    } else {
      onSave({ grade_min: curriculum.grade_min, grade_max: v }, { min: curriculum.grade_min, max: v }, true);
    }
  }
  function flipMode(next) {
    setAgeOrGrade(next);
  }

  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <FieldLabel flagged={flagged}>Age / grade range<SavedTick on={saved} /></FieldLabel>
      <div style={ageGradeToggle}>
        <button onClick={() => flipMode("ages")} style={isAges ? ageGradeBtnActive : ageGradeBtn}>Ages</button>
        <button onClick={() => flipMode("grades")} style={!isAges ? ageGradeBtnActive : ageGradeBtn}>Grades</button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 260 }}>
        {isAges ? (
          <>
            <input
              type="number"
              value={minVal}
              onChange={(e) => updateMin(e.target.value)}
              style={{ ...textInput, maxWidth: 90, ...(flagged ? lowConf : {}) }}
            />
            <span style={{ color: MUTED }}>to</span>
            <input
              type="number"
              value={maxVal}
              onChange={(e) => updateMax(e.target.value)}
              style={{ ...textInput, maxWidth: 90, ...(flagged ? lowConf : {}) }}
            />
          </>
        ) : (
          <>
            <select
              value={minVal === "" ? "" : String(minVal)}
              onChange={(e) => updateMin(e.target.value)}
              style={{ ...textInput, maxWidth: 90, ...(flagged ? lowConf : {}) }}
            >
              <option value="">—</option>
              {GRADE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span style={{ color: MUTED }}>to</span>
            <select
              value={maxVal === "" ? "" : String(maxVal)}
              onChange={(e) => updateMax(e.target.value)}
              style={{ ...textInput, maxWidth: 90, ...(flagged ? lowConf : {}) }}
            >
              <option value="">—</option>
              {GRADE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </>
        )}
      </div>
    </div>
  );
}

function ClassSizeField({ curriculum, flagged, onSave, saved }) {
  function updateMin(raw) {
    const v = raw === "" ? null : Number(raw);
    onSave({ class_size_min: v, class_size_max: curriculum.class_size_max }, { min: v, max: curriculum.class_size_max });
  }
  function updateMax(raw) {
    const v = raw === "" ? null : Number(raw);
    onSave({ class_size_min: curriculum.class_size_min, class_size_max: v }, { min: curriculum.class_size_min, max: v });
  }
  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <FieldLabel flagged={flagged}>Class size<SavedTick on={saved} /></FieldLabel>
      <div style={fieldHelp}>Drives waitlist + cancel-by logic. Usually 4–20 for camps, 5–14 for afterschool.</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 280 }}>
        <input
          type="number"
          value={curriculum.class_size_min ?? ""}
          onChange={(e) => updateMin(e.target.value)}
          placeholder="min"
          style={{ ...textInput, maxWidth: 90, ...(flagged ? lowConf : {}) }}
        />
        <span style={{ color: MUTED }}>to</span>
        <input
          type="number"
          value={curriculum.class_size_max ?? ""}
          onChange={(e) => updateMax(e.target.value)}
          placeholder="max"
          style={{ ...textInput, maxWidth: 90, ...(flagged ? lowConf : {}) }}
        />
        <span style={{ color: MUTED, fontSize: 13 }}>students</span>
      </div>
    </div>
  );
}

function SessionTypesField({ value, onChange, flagged, saved }) {
  function toggle(opt) {
    const next = value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt];
    onChange(next);
  }
  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <FieldLabel flagged={flagged}>Session types supported<SavedTick on={saved} /></FieldLabel>
      <div style={fieldHelp}>Which formats can this run as?</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {SESSION_TYPE_OPTIONS.map((o) => {
          const on = value.includes(o.value);
          return (
            <button key={o.value} onClick={() => toggle(o.value)} style={on ? pillOn : pillOff}>
              {on && "✓ "}{o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FieldChips({ label, inlineHelp, help, value, onChange, flagged, saved, onPolish }) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v) return;
    if (value.includes(v)) { setDraft(""); return; }
    onChange([...value, v]);
    setDraft("");
  }
  function remove(idx) {
    const next = value.slice(); next.splice(idx, 1); onChange(next);
  }
  const canPolish = typeof onPolish === "function" && Array.isArray(value) && value.length > 0;
  return (
    <div data-flagged={flagged ? "true" : undefined} style={fieldWrap}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <FieldLabel inlineHelp={inlineHelp} flagged={flagged}>{label}<SavedTick on={saved} /></FieldLabel>
        {onPolish && (
          <button
            type="button"
            onClick={() => canPolish && onPolish(value)}
            disabled={!canPolish}
            title={canPolish ? "Ask Ennie to re-rank and rewrite these as parent-impressive concepts" : "Add at least one skill first"}
            style={{
              background: canPolish ? GOLD_SOFT : "transparent",
              border: `1px solid ${canPolish ? GOLD_BORDER : RULE}`,
              color: canPolish ? "#7a5a00" : MUTED,
              borderRadius: 12,
              fontSize: 11,
              fontWeight: 600,
              padding: "3px 9px",
              cursor: canPolish ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
            }}
          >
            ✨ Polish with Ennie
          </button>
        )}
      </div>
      {help && <div style={fieldHelp}>{help}</div>}
      <div style={{ ...chipsBox, ...(flagged ? lowConf : {}) }}>
        {value.map((chip, i) => (
          <span key={`${chip}-${i}`} style={chipStyle}>
            {chip} <span onClick={() => remove(i)} style={{ color: "#997800", cursor: "pointer", fontWeight: 700 }}>×</span>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder="add + enter"
          style={{ flex: 1, minWidth: 100, border: "none", outline: "none", fontFamily: "inherit", fontSize: 13, padding: "4px 0", background: "transparent" }}
        />
      </div>
    </div>
  );
}

function SessionRow({ session, open, onToggle, onSave, savingField, onPolishSkills }) {
  return (
    <div style={{ borderTop: `1px solid ${RULE}` }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0", cursor: "pointer", userSelect: "none" }}>
        <span style={{ width: 26, height: 26, borderRadius: "50%", background: PLUM_SOFT, color: PURPLE, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{session.session_number}</span>
        <span style={{ flex: 1, fontWeight: 600, color: INK, fontSize: 14 }}>{session.title || "(untitled)"}</span>
        <Chevron open={open} color={MUTED} />
      </div>
      {open && (
        <div style={{ padding: "0 0 18px 36px" }}>
          <FieldText
            label="Title"
            value={session.title ?? ""}
            onChange={(v) => onSave({ title: v })}
            saved={savingField === `session-${session.id}-title`}
          />
          <FieldTextarea
            label="Description"
            value={session.description ?? ""}
            onChange={(v) => onSave({ description: v })}
            saved={savingField === `session-${session.id}-description`}
          />
          <FieldChips
            label="Skills practiced"
            value={session.skills_practiced ?? []}
            onChange={(arr) => onSave({ skills_practiced: arr }, true)}
            saved={savingField === `session-${session.id}-skills_practiced`}
            onPolish={onPolishSkills ? (current) => onPolishSkills(session.id, current) : undefined}
          />
          <FieldChips
            label="Materials this session"
            value={session.materials_session ?? []}
            onChange={(arr) => onSave({ materials_session: arr }, true)}
            saved={savingField === `session-${session.id}-materials_session`}
          />
          <FieldTextarea
            label="Recap template"
            help="Shown in the parent portal after this session runs. Also used in the mid-term and final recap emails."
            value={session.recap_template ?? ""}
            onChange={(v) => onSave({ recap_template: v })}
            saved={savingField === `session-${session.id}-recap_template`}
          />
          <FieldText
            label="Parent engagement question"
            value={session.parent_engagement_question ?? ""}
            onChange={(v) => onSave({ parent_engagement_question: v })}
            saved={savingField === `session-${session.id}-parent_engagement_question`}
          />
        </div>
      )}
    </div>
  );
}

function PolishModal({ curriculumId, config, onClose }) {
  const { field, sessionId, current, targetCount, onAccept } = config;
  // Text mode is used for free-text fields like short_description; list mode
  // for chip/skill arrays. They share the polish-skills edge function but
  // render different UI for current vs polished.
  const mode = field === "short_description" ? "text" : "list";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [polishedList, setPolishedList] = useState([]); // list mode
  const [polishedText, setPolishedText] = useState("");  // text mode

  function fetchPolish() {
    setLoading(true);
    setError("");
    (async () => {
      try {
        const { data, error: invokeErr } = await supabase.functions.invoke("polish-skills", {
          body: {
            curriculum_id: curriculumId,
            field,
            current,
            session_id: sessionId,
            target_count: targetCount,
          },
        });
        if (invokeErr) {
          let msg = invokeErr.message || "Polish failed.";
          try {
            const ctx = invokeErr.context;
            if (ctx && typeof ctx.json === "function") {
              const body = await ctx.json();
              if (body?.error) msg = body.error;
            }
          } catch { /* keep msg */ }
          setError(msg);
          setLoading(false);
          return;
        }
        const polished = data?.polished;
        if (mode === "text") {
          // Backend may return either a string or a 1-element array for text mode.
          const txt = typeof polished === "string"
            ? polished
            : Array.isArray(polished) && typeof polished[0] === "string"
              ? polished[0]
              : "";
          setPolishedText(txt);
        } else {
          setPolishedList(Array.isArray(polished) ? polished : []);
        }
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
  }

  useEffect(() => {
    fetchPolish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateListItem(idx, v) {
    setPolishedList((arr) => arr.map((s, i) => (i === idx ? v : s)));
  }
  function removeListItem(idx) {
    setPolishedList((arr) => arr.filter((_, i) => i !== idx));
  }
  function addListItem() {
    setPolishedList((arr) => [...arr, ""]);
  }
  function accept() {
    if (mode === "text") {
      onAccept(polishedText);
    } else {
      onAccept(polishedList.map((s) => s.trim()).filter((s) => s.length > 0));
    }
    onClose();
  }

  const acceptDisabled = mode === "text"
    ? polishedText.trim().length === 0
    : polishedList.filter((s) => s.trim().length > 0).length === 0;

  const currentText = mode === "text"
    ? (typeof current === "string" ? current : Array.isArray(current) ? current[0] ?? "" : "")
    : "";

  const heading = mode === "text" ? "Polish this description" : "Polish these skills";
  const blurb = mode === "text"
    ? "Rewrite to lead with what kids do + make, drop jargon, and read parent-impressive. Edit anything before accepting."
    : `Rewrite + re-rank into the top ${targetCount} parent-impressive concepts. Edit each line before accepting.`;
  const loadingCopy = mode === "text"
    ? "Asking Ennie to polish this description…"
    : `Asking Ennie to polish these ${current.length} skill${current.length === 1 ? "" : "s"}…`;

  return (
    <div style={modalBack} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <Ennie state="idle" framed={false} size={62} />
          <div>
            <div style={{ fontWeight: 700, color: PURPLE, fontSize: 15 }}>
              Ennie<span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your helper</span>
            </div>
          </div>
        </div>

        <h3 style={{ margin: "0 0 6px", color: INK, fontSize: 20, fontWeight: 700 }}>{heading}</h3>
        <p style={{ color: MUTED, fontSize: 13, margin: "0 0 18px", lineHeight: 1.45 }}>{blurb}</p>

        {loading && (
          <div style={{ padding: "30px 0", color: MUTED, fontSize: 13, textAlign: "center" }}>{loadingCopy}</div>
        )}

        {!loading && error && (
          <>
            <div style={errorBox}>{error}</div>
            <div style={modalActions}>
              <button onClick={onClose} style={tertiaryBtn}>Cancel</button>
              <button onClick={fetchPolish} style={primaryBtn}>Try again</button>
            </div>
          </>
        )}

        {!loading && !error && mode === "text" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Your current text</div>
                <div style={{ background: "#f6f4ec", border: `1px solid ${RULE}`, borderRadius: 6, padding: 10, fontSize: 13, lineHeight: 1.5, color: MUTED, minHeight: 110, whiteSpace: "pre-wrap" }}>
                  {currentText || <em style={{ color: "#bbb" }}>(empty)</em>}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#7a5a00", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>✨ Polished by Ennie</div>
                <textarea
                  value={polishedText}
                  onChange={(e) => setPolishedText(e.target.value)}
                  style={{ width: "100%", minHeight: 110, border: `1px solid ${GOLD_BORDER}`, background: GOLD_SOFT, borderRadius: 6, padding: 10, fontSize: 13, lineHeight: 1.5, color: INK, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
                />
              </div>
            </div>
            <div style={modalActions}>
              <button onClick={onClose} style={tertiaryBtn}>Keep my text</button>
              <button
                onClick={accept}
                disabled={acceptDisabled}
                style={{ ...primaryBtn, opacity: acceptDisabled ? 0.5 : 1, cursor: acceptDisabled ? "not-allowed" : "pointer" }}
              >
                Use Ennie's polish →
              </button>
            </div>
          </>
        )}

        {!loading && !error && mode === "list" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Your current list</div>
                <div style={{ ...chipsBox, opacity: 0.65, background: "#f6f4ec" }}>
                  {(Array.isArray(current) ? current : []).map((c, i) => (
                    <span key={`cur-${i}`} style={{ ...chipStyle, background: "#ece8dc" }}>{c}</span>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#7a5a00", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>✨ Polished by Ennie</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, background: GOLD_SOFT, border: `1px solid ${GOLD_BORDER}`, borderRadius: 6, padding: 8 }}>
                  {polishedList.map((c, i) => (
                    <div key={`pol-${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="text"
                        value={c}
                        onChange={(e) => updateListItem(i, e.target.value)}
                        style={{ flex: 1, border: `1px solid ${RULE}`, borderRadius: 4, padding: "5px 8px", fontSize: 13, fontFamily: "inherit", background: PANEL, color: INK }}
                      />
                      <button
                        type="button"
                        onClick={() => removeListItem(i)}
                        title="Remove this one"
                        style={{ background: "transparent", border: "none", color: "#997800", fontSize: 16, fontWeight: 700, cursor: "pointer", padding: "0 6px" }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addListItem}
                    style={{ alignSelf: "flex-start", background: "transparent", border: "none", color: PURPLE, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "4px 0", marginTop: 2 }}
                  >
                    + Add another
                  </button>
                </div>
              </div>
            </div>
            <div style={modalActions}>
              <button onClick={onClose} style={tertiaryBtn}>Keep my list</button>
              <button
                onClick={accept}
                disabled={acceptDisabled}
                style={{ ...primaryBtn, opacity: acceptDisabled ? 0.5 : 1, cursor: acceptDisabled ? "not-allowed" : "pointer" }}
              >
                Use Ennie's polish →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Upload modal for a curriculum's documents. Two modes:
//   replace - swap the SOURCE doc (removes the old instructor_guide)
//   add     - attach an extra material (materials_list); nothing is removed
// In BOTH modes the operator explicitly chooses whether to run AI extraction.
// Extraction is the only thing that rewrites sessions/extracted fields, so
// "just attach it" is always safe - a tiny doc tweak never forces a re-extract.
// Either way the curriculum row (and its linked programs/camps) stays attached.
function DocUploadModal({ mode = "replace", curriculumId, curriculumName, organizationId, onClose, onStarted, onAdded }) {
  const isAdd = mode === "add";
  const [file, setFile] = useState(null);
  // Which section the added file lands in. Replace mode always targets the
  // curriculum source, so the picker is add-only.
  const [addDocType, setAddDocType] = useState("materials_list");
  // Default matches intent: replacing the source usually means re-extracting;
  // adding a material usually doesn't. Either can be changed before uploading.
  const [runExtraction, setRunExtraction] = useState(!isAdd);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ALLOWED_EXTS = ["pdf", "docx", "txt", "md", "xlsx"];
  const MAX_BYTES = 25 * 1024 * 1024;

  function fileExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function pickFile(f) {
    setError("");
    if (!f) { setFile(null); return; }
    const ext = fileExt(f.name);
    if (!ALLOWED_EXTS.includes(ext)) {
      setError(`We can read .pdf, .docx, .xlsx, .txt, or .md — not .${ext || "unknown"}.`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB — please keep it under 25 MB.`);
      return;
    }
    setFile(f);
  }

  // Extraction is the only step that overwrites existing fields, so the
  // "I understand" confirm is required only when it is actually going to run.
  const needsConfirm = runExtraction;
  const canSubmit = !!file && (!needsConfirm || confirmed) && !busy;

  async function doUpload() {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      // 1. Upload to storage at the curriculum's existing path prefix.
      const docId = crypto.randomUUID();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${organizationId}/${curriculumId}/${docId}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from("curriculum-documents")
        .upload(path, file, { upsert: false, contentType: file.type || undefined });
      if (upErr) throw new Error(`Couldn't upload ${file.name}: ${upErr.message}`);

      // 2. Insert curriculum_documents row tied to the existing curriculum.
      const { data: docRow, error: insErr } = await supabase
        .from("curriculum_documents")
        .insert({
          id: docId,
          curriculum_id: curriculumId,
          organization_id: organizationId,
          doc_type: isAdd ? addDocType : "instructor_guide",
          source_type: "upload",
          storage_path: path,
          original_filename: file.name,
          mime_type: file.type || null,
          // 'complete' when we are not extracting: nothing is queued for this
          // doc. Safe against the extraction dedup lookup, which also requires
          // a file_hash + extraction_result that a non-extracted doc never has.
          extraction_status: runExtraction ? "pending" : "complete",
        })
        .select("id")
        .single();
      if (insErr || !docRow) {
        await supabase.storage.from("curriculum-documents").remove([path]).catch(() => {});
        throw new Error(`Couldn't save ${file.name} record: ${insErr?.message ?? "no row"}`);
      }

      // 2b. REPLACE mode only: remove the OLD instructor_guide docs, since the
      //     source is being swapped. ADD mode is an append, so nothing is
      //     removed. Other doc_types (materials_list, student_materials) always
      //     stay. Failures here are non-fatal: we warn but don't block.
      if (!isAdd) {
        const { data: oldDocs } = await supabase
          .from("curriculum_documents")
          .select("id, storage_path")
          .eq("curriculum_id", curriculumId)
          .eq("doc_type", "instructor_guide")
          .neq("id", docRow.id);
        if (oldDocs && oldDocs.length > 0) {
          const oldPaths = oldDocs.map((d) => d.storage_path).filter(Boolean);
          if (oldPaths.length > 0) {
            const { error: stErr } = await supabase.storage.from("curriculum-documents").remove(oldPaths);
            if (stErr) console.warn("Couldn't clean old doc storage (continuing):", stErr.message);
          }
          const { error: delErr } = await supabase
            .from("curriculum_documents")
            .delete()
            .in("id", oldDocs.map((d) => d.id));
          if (delErr) console.warn("Couldn't delete old doc rows (continuing):", delErr.message);
        }
      }

      // 2c. Operator chose NOT to re-extract: the file is attached and their
      //     existing details are untouched. Hand the new row back so the panel
      //     updates in place instead of bouncing to the extraction screen.
      if (!runExtraction) {
        // Clear busy before handing off: the parent normally closes us here,
        // but if it doesn't, the operator sees an honest idle modal rather than
        // a permanent "Uploading..." over an upload that already finished.
        setBusy(false);
        onAdded?.({
          id: docRow.id,
          original_filename: file.name,
          doc_type: isAdd ? addDocType : "instructor_guide",
          storage_path: path,
          uploaded_at: new Date().toISOString(),
        });
        return;
      }

      // 3. Kick off extract-curriculum-details with preserve_name=true so the
      //    curriculum's existing name (and links) aren't overwritten.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sign in expired. Reload and try again.");
      const resp = await fetch(`${API_BASE}/extract-curriculum-details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ document_id: docRow.id, preserve_name: true }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Couldn't start extraction (${resp.status}).`);
      }
      onStarted?.(docRow.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div style={modalBack} onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div style={{ ...modal, maxWidth: 540 }}>
        <h3 style={{ margin: "0 0 6px", color: INK, fontSize: 20, fontWeight: 700 }}>
          {isAdd ? `Add a document to ${curriculumName}` : `Replace the source doc for ${curriculumName}`}
        </h3>
        <p style={{ color: MUTED, fontSize: 13, margin: "0 0 16px", lineHeight: 1.45 }}>
          {isAdd
            ? "Attach a materials list, student handout, or any supporting file."
            : "Upload an edited version of your curriculum doc."}
          {" "}You choose below whether it should update your curriculum details.
          The offering name and any programs / camps already linked to it stay attached.
        </p>

        <label style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 20,
          border: `2px dashed ${file ? PURPLE : RULE}`,
          borderRadius: 8,
          background: file ? PLUM_SOFT : "#fafaf3",
          cursor: "pointer",
          marginBottom: 14,
        }}>
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.xlsx"
            onChange={(e) => pickFile(e.target.files?.[0])}
            style={{ display: "none" }}
          />
          {file ? (
            <>
              <div style={{ fontSize: 24 }}>📄</div>
              <div style={{ fontWeight: 600, color: INK, fontSize: 14 }}>{file.name}</div>
              <div style={{ color: MUTED, fontSize: 12 }}>{(file.size / 1024 / 1024).toFixed(2)} MB · click to replace</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 24, color: MUTED }}>⬆</div>
              <div style={{ fontWeight: 600, color: INK, fontSize: 14 }}>Pick a file</div>
              <div style={{ color: MUTED, fontSize: 12 }}>.pdf, .docx, .xlsx, .txt, .md · up to 25 MB</div>
            </>
          )}
        </label>

        {/* Which section it lands in. Add-only: replacing always targets the
            curriculum source doc. */}
        {isAdd && (
          <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, padding: "12px 14px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 }}>
              What kind of document is it?
            </div>
            {[
              { value: "materials_list", label: "Class materials", hint: "What the instructor brings or orders" },
              { value: "student_materials", label: "Student materials", hint: "Worksheets or printables" },
              { value: "other", label: "Other", hint: "Anything else to keep on file" },
            ].map((o) => (
              <label key={o.value} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 6 }}>
                <input
                  type="radio"
                  name="doc-kind-choice"
                  checked={addDocType === o.value}
                  onChange={() => setAddDocType(o.value)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
                  <strong>{o.label}</strong>{" "}
                  <span style={{ color: MUTED }}>{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}

        {/* Explicit extraction choice. A tiny doc tweak or a supporting file
            should never be forced through a full re-extract. */}
        <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.4 }}>
            What should we do with it?
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 8 }}>
            <input
              type="radio"
              name="doc-extraction-choice"
              checked={runExtraction}
              onChange={() => setRunExtraction(true)}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
              <strong>Update my curriculum details from this file.</strong>{" "}
              <span style={{ color: MUTED }}>Re-runs extraction and rewrites the fields below.</span>
            </span>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
            <input
              type="radio"
              name="doc-extraction-choice"
              checked={!runExtraction}
              onChange={() => setRunExtraction(false)}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
              <strong>Just attach the file.</strong>{" "}
              <span style={{ color: MUTED }}>Your curriculum details stay exactly as they are.</span>
            </span>
          </label>
        </div>

        {/* Only extraction overwrites existing work, so this warning + confirm
            appear only when the operator picked that option. */}
        {needsConfirm && (
          <div style={{
            background: "#fff5f5",
            border: "1px solid #f0c4c4",
            borderLeft: "3px solid #a13a3a",
            borderRadius: 4,
            padding: "12px 14px",
            marginBottom: 14,
          }}>
            <strong style={{ color: "#7a1a1a", display: "block", marginBottom: 6 }}>Heads up — this overwrites your edits</strong>
            <div style={{ color: INK, fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
              All current sessions, recap templates, skill lists, and extracted fields will be replaced with whatever the new doc produces. Linked programs / camps + the offering name stay.
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: INK, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              I understand. Update my details.
            </label>
          </div>
        )}

        {error && <div style={{ ...errorBox, marginBottom: 12 }}>{error}</div>}

        <div style={modalActions}>
          <button onClick={onClose} style={tertiaryBtn} disabled={busy}>Cancel</button>
          <button
            onClick={doUpload}
            disabled={!canSubmit}
            style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? "pointer" : "not-allowed" }}
          >
            {busy
              ? (runExtraction ? "Starting…" : "Uploading…")
              : runExtraction
                ? (isAdd ? "Add and update details →" : "Replace and re-extract →")
                : (isAdd ? "Attach document" : "Replace file")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Modal to manually link unlinked programs + camp_sessions to a published
// curriculum. Entry points:
//   - Celebration screen "Link existing programs ->" CTA (link_existing variant)
//   - CTA bar "Link existing programs" button on published curricula
// Loads every unlinked row in the org, groups by source + name, scores each
// group against the curriculum name, pre-selects high-confidence matches,
// lets the operator pick the rest manually. Save -> bulk UPDATE curriculum_id.
function LinkExistingModal({ curriculumId, curriculumName, organizationId, userId, onClose, onSaved }) {
  const [loading, setLoading] = useState(true);
  // matches now mixes ALREADY-linked groups (linked: true, pre-checked) and
  // UNLINKED candidates (linked: false, match-scored, strong matches pre-checked).
  const [matches, setMatches] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  // Snapshot of which group keys started out as linked. Used at save time to
  // diff against the operator's selection: untick a linked group -> unlink.
  const [initialLinkedKeys, setInitialLinkedKeys] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError("");
      const [
        { data: progRowsUnlinked },
        { data: campRowsUnlinked },
        { data: progRowsLinked },
        { data: campRowsLinked },
      ] = await Promise.all([
        supabase
          .from("programs")
          .select("id, curriculum, term")
          .eq("organization_id", organizationId)
          .is("curriculum_id", null),
        supabase
          .from("camp_sessions")
          .select("id, curriculum_name, session_type")
          .eq("organization_id", organizationId)
          .is("curriculum_id", null),
        supabase
          .from("programs")
          .select("id, curriculum, term")
          .eq("organization_id", organizationId)
          .eq("curriculum_id", curriculumId),
        supabase
          .from("camp_sessions")
          .select("id, curriculum_name, session_type")
          .eq("organization_id", organizationId)
          .eq("curriculum_id", curriculumId),
      ]);
      if (!mounted) return;
      const groups = new Map();
      const addProgram = (p, linked) => {
        const name = (p.curriculum || "").trim();
        if (!name) return;
        const key = `programs::${linked ? "linked" : "unlinked"}::${name}`;
        if (!groups.has(key)) groups.set(key, { source: "programs", name, ids: [], runCount: 0, key, linked });
        const g = groups.get(key);
        g.ids.push(p.id);
        g.runCount += 1;
      };
      const addCamp = (c, linked) => {
        const name = (c.curriculum_name || "").trim();
        if (!name) return;
        // Camp_sessions: group by name AND session_type so half-day (afternoon /
        // morning) and full_day sessions don't bundle together.
        const sessionType = c.session_type || "unknown";
        const key = `camp_sessions::${linked ? "linked" : "unlinked"}::${name}::${sessionType}`;
        if (!groups.has(key)) groups.set(key, { source: "camp_sessions", name, sessionType, ids: [], runCount: 0, key, linked });
        const g = groups.get(key);
        g.ids.push(c.id);
        g.runCount += 1;
      };
      for (const p of progRowsLinked ?? []) addProgram(p, true);
      for (const p of progRowsUnlinked ?? []) addProgram(p, false);
      for (const c of campRowsLinked ?? []) addCamp(c, true);
      for (const c of campRowsUnlinked ?? []) addCamp(c, false);

      const allGroups = [];
      const linkedKeys = new Set();
      for (const g of groups.values()) {
        allGroups.push({ ...g, score: g.linked ? 1 : matchScore(curriculumName, g.name) });
        if (g.linked) linkedKeys.add(g.key);
      }
      // Sort: linked rows first (within source group, alphabetical), then
      // unlinked sorted by score descending.
      allGroups.sort((a, b) => {
        if (a.linked !== b.linked) return a.linked ? -1 : 1;
        if (a.linked) return a.name.localeCompare(b.name);
        return b.score - a.score || a.name.localeCompare(b.name);
      });
      setMatches(allGroups);
      setInitialLinkedKeys(linkedKeys);
      // Pre-select: all linked groups (so they stay linked unless unticked) +
      // strong matches among unlinked.
      setSelectedKeys(new Set(allGroups.filter((m) => m.linked || m.score >= 0.5).map((m) => m.key)));
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [curriculumId, organizationId, curriculumName]);

  function toggleKey(key) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function doSave() {
    setSaving(true);
    setError("");
    // Diff selectedKeys against initialLinkedKeys to compute four buckets:
    //   linkProgramIds  -- unlinked program rows ticked  -> set curriculum_id
    //   linkCampIds     -- unlinked camp rows ticked     -> set curriculum_id
    //   unlinkProgramIds-- previously-linked program rows unticked -> NULL
    //   unlinkCampIds   -- previously-linked camp rows unticked    -> NULL
    const linkProgramIds = [];
    const linkCampIds = [];
    const unlinkProgramIds = [];
    const unlinkCampIds = [];
    for (const m of matches) {
      const isSelected = selectedKeys.has(m.key);
      const wasLinked = initialLinkedKeys.has(m.key);
      if (isSelected && !wasLinked) {
        if (m.source === "programs") linkProgramIds.push(...m.ids);
        else linkCampIds.push(...m.ids);
      } else if (!isSelected && wasLinked) {
        if (m.source === "programs") unlinkProgramIds.push(...m.ids);
        else unlinkCampIds.push(...m.ids);
      }
    }
    const totalChanges = linkProgramIds.length + linkCampIds.length + unlinkProgramIds.length + unlinkCampIds.length;
    if (totalChanges === 0) {
      // Save with no changes is a no-op -- just close. The operator pressed
      // Save deliberately; don't force them to remember which rows they
      // touched.
      onClose();
      return;
    }
    try {
      if (linkProgramIds.length > 0) {
        const { error: err } = await supabase
          .from("programs")
          .update({ curriculum_id: curriculumId })
          .in("id", linkProgramIds);
        if (err) throw err;
      }
      if (linkCampIds.length > 0) {
        const { error: err } = await supabase
          .from("camp_sessions")
          .update({ curriculum_id: curriculumId, updated_at: new Date().toISOString() })
          .in("id", linkCampIds);
        if (err) throw err;
      }
      if (unlinkProgramIds.length > 0) {
        const { error: err } = await supabase
          .from("programs")
          .update({ curriculum_id: null })
          .in("id", unlinkProgramIds);
        if (err) throw err;
      }
      if (unlinkCampIds.length > 0) {
        const { error: err } = await supabase
          .from("camp_sessions")
          .update({ curriculum_id: null, updated_at: new Date().toISOString() })
          .in("id", unlinkCampIds);
        if (err) throw err;
      }
      // Log time-saved only when we LINKED something new; pure-unlink edits
      // don't add Director value worth pilling. Flat 0.5 hr per save when
      // any new linkage happened.
      const linkedRows = linkProgramIds.length + linkCampIds.length;
      if (linkedRows > 0) {
        const linkLabel = linkedRows === 1
          ? `Linked 1 row to "${curriculumName}"`
          : `Linked ${linkedRows} rows to "${curriculumName}"`;
        const { error: tsErr } = await supabase.from("time_saved_events").insert({
          organization_id: organizationId,
          action_type: "curriculum_linked",
          action_label: linkLabel,
          hours_saved: 0.5,
          related_entity_type: "curriculum",
          related_entity_id: curriculumId,
          created_by: userId ?? null,
        });
        if (tsErr) console.warn("time_saved_events insert failed (non-fatal):", tsErr.message);
      }

      onSaved?.({
        linkedPrograms: linkProgramIds.length,
        linkedCampSessions: linkCampIds.length,
        unlinkedPrograms: unlinkProgramIds.length,
        unlinkedCampSessions: unlinkCampIds.length,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  // Top-level split: rows currently part of this curriculum vs everything
  // else. The operator opens this modal to manage what's IN the curriculum;
  // the linked/unlinked distinction is the first thing they want to see.
  const linkedRows = matches.filter((m) => m.linked);
  const unlinkedRows = matches.filter((m) => !m.linked);

  // Pending change count drives the Save-button label. The button stays
  // clickable in both states so "No changes" just closes.
  let pendingChangeCount = 0;
  for (const m of matches) {
    const selected = selectedKeys.has(m.key);
    const was = initialLinkedKeys.has(m.key);
    if (selected !== was) pendingChangeCount++;
  }

  function MatchRow({ m }) {
    return (
      <label
        title={m.linked
          ? "Already part of this offering. Untick to remove."
          : "Tick to add to this offering."}
        style={{
          display: "flex", alignItems: "flex-start", gap: 8,
          padding: "8px 10px", fontSize: 13, cursor: "pointer",
          borderBottom: `1px solid ${RULE}`,
          background: m.linked ? "rgba(105, 29, 57, 0.05)" : "transparent",
          borderLeft: m.linked ? `3px solid ${PURPLE}` : "3px solid transparent",
        }}
      >
        <input
          type="checkbox"
          checked={selectedKeys.has(m.key)}
          onChange={() => toggleKey(m.key)}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: INK }}>{m.name}</div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 2 }}>
            {formatGroupLabel(m)}
          </div>
        </div>
      </label>
    );
  }

  return (
    <div style={modalBack} onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div style={{ ...modal, maxWidth: 640 }}>
        <div style={{ marginBottom: 14 }}>
          <h3 style={{ margin: "0 0 4px", color: INK, fontSize: 20, fontWeight: 700 }}>
            Programs and camps for {curriculumName}
          </h3>
          <p style={{ color: MUTED, fontSize: 13, margin: 0, lineHeight: 1.45 }}>
            Tick the ones that belong to this offering. Rows in plum are already part of it — untick to remove.
          </p>
        </div>

        {loading && (
          <div style={{ padding: "30px 0", color: MUTED, fontSize: 13, textAlign: "center" }}>
            Loading…
          </div>
        )}

        {!loading && matches.length === 0 && (
          <div style={{ background: "#f6f4ec", border: `1px solid ${RULE}`, borderRadius: 6, padding: 14, fontSize: 13, color: MUTED }}>
            Nothing scheduled yet. Once you schedule programs or camps, they'll show up here to tick.
          </div>
        )}

        {!loading && matches.length > 0 && (
          <>
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, padding: "0 0 6px", borderBottom: `1px solid ${GOLD_BORDER}`, marginBottom: 4 }}>
                Linked programs ({linkedRows.reduce((s, m) => s + m.runCount, 0)})
              </div>
              {linkedRows.length === 0 ? (
                <div style={{ color: MUTED, fontSize: 12, fontStyle: "italic", padding: "10px 4px" }}>
                  Nothing linked yet — tick anything below to add it.
                </div>
              ) : (
                linkedRows.map((m) => <MatchRow key={m.key} m={m} />)
              )}
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, padding: "0 0 6px", borderBottom: `1px solid ${GOLD_BORDER}`, marginBottom: 4 }}>
                Unlinked programs ({unlinkedRows.reduce((s, m) => s + m.runCount, 0)})
              </div>
              {unlinkedRows.length === 0 ? (
                <div style={{ color: MUTED, fontSize: 12, fontStyle: "italic", padding: "10px 4px" }}>
                  Everything in your schedule is already part of an offering.
                </div>
              ) : (
                unlinkedRows.map((m) => <MatchRow key={m.key} m={m} />)
              )}
            </div>
          </>
        )}

        {error && <div style={{ ...errorBox, marginTop: 12 }}>{error}</div>}

        <div style={modalActions}>
          <button
            onClick={doSave}
            disabled={saving}
            style={{ ...primaryBtn, opacity: saving ? 0.5 : 1, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving
              ? "Saving…"
              : pendingChangeCount === 0
                ? "No changes"
                : `Save ${pendingChangeCount} change${pendingChangeCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-exported from the shared helpers module so the rest of this file's
// celebration tile code reads the same as before.
const CAPABILITY_ICONS = SHARED_CAPABILITY_ICONS;
const deriveOrgStatesForCurriculum = sharedDeriveStates;
const isCapabilityUnlocked = sharedIsUnlocked;

function PublishModal({
  step, nameDraft, setNameDraft, programMatches, selectedMatchKeys, setSelectedMatchKeys,
  publishing, error, onCancel, onContinue, onPublish,
  curriculum, sessionCount, linkedProgramCount, linkedCampSessionCount,
  preLinkedProgramCount = 0, preLinkedCampSessionCount = 0,
  preLinkedPrograms = [], preLinkedCampSessions = [],
  capabilities = [], recommendation = null, onDone, onRecommendationCta, onLinkExisting,
  onCapabilityClick, manual = false,
}) {
  function toggleMatch(key) {
    setSelectedMatchKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const hasMatches = programMatches.length > 0;
  const totalPreLinked = (preLinkedProgramCount || 0) + (preLinkedCampSessionCount || 0);
  // The already-linked list is expanded by default so the operator can see at a
  // glance WHICH runs an edit will flow to, not just a count.
  const [linkedListOpen, setLinkedListOpen] = useState(true);
  const hasPreLinkedRows = preLinkedPrograms.length > 0 || preLinkedCampSessions.length > 0;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtLinkedDate(s) {
    if (!s) return null;
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  function programLinkMeta(p) {
    const date = fmtLinkedDate(p.first_session_date);
    return [p.term, p.day_of_week, date && `starts ${date}`, p.status && p.status !== "open" ? p.status : null]
      .filter(Boolean).join(" · ");
  }
  function campLinkMeta(c) {
    const date = fmtLinkedDate(c.starts_on);
    return [c.session_type, c.week_num ? `Week ${c.week_num}` : null, date && `starts ${date}`]
      .filter(Boolean).join(" · ");
  }
  function preLinkedSummary() {
    const parts = [];
    if (preLinkedCampSessionCount > 0) parts.push(`${preLinkedCampSessionCount} camp session${preLinkedCampSessionCount === 1 ? "" : "s"}`);
    if (preLinkedProgramCount > 0) parts.push(`${preLinkedProgramCount} program run${preLinkedProgramCount === 1 ? "" : "s"}`);
    return parts.join(" + ");
  }
  const totalLinked = (linkedProgramCount || 0) + (linkedCampSessionCount || 0);
  function linkedSummary() {
    const parts = [];
    if (linkedCampSessionCount > 0) parts.push(`${linkedCampSessionCount} camp session${linkedCampSessionCount === 1 ? "" : "s"}`);
    if (linkedProgramCount > 0) parts.push(`${linkedProgramCount} program run${linkedProgramCount === 1 ? "" : "s"}`);
    return parts.join(" + ");
  }
  const isCelebration = step === 3;
  return (
    <div
      style={modalBack}
      onClick={(e) => {
        if (e.target !== e.currentTarget || publishing) return;
        if (isCelebration) onDone(); else onCancel();
      }}
    >
      <div style={isCelebration ? celebrationModal : modal}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <Ennie state={isCelebration ? "celebrate" : "idle"} framed={false} size={isCelebration ? 104 : 62} />
          <div>
            <div style={{ fontWeight: 700, color: PURPLE, fontSize: isCelebration ? 16 : 15 }}>
              Ennie<span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your helper</span>
            </div>
            {isCelebration && (
              <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>Nice work — here's what you just unlocked.</div>
            )}
          </div>
        </div>

        {step === 1 && (
          <>
            <h3 style={{ margin: "0 0 6px", color: INK, fontSize: 20, fontWeight: 700 }}>Confirm the name</h3>
            <p style={{ color: MUTED, fontSize: 13, margin: "0 0 14px", lineHeight: 1.45 }}>
              This becomes the public name on your registration page, flyers, emails — everywhere parents see it. Read right?
            </p>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              style={{ ...textInput, width: "100%" }}
              autoFocus
            />
            {error && <div style={{ ...errorBox, marginTop: 12 }}>{error}</div>}
            <div style={modalActions}>
              <button onClick={onCancel} style={tertiaryBtn}>Cancel</button>
              <button onClick={onContinue} style={primaryBtn}>Continue →</button>
            </div>
          </>
        )}

        {isCelebration && (() => {
          // Dynamic time-saved: 1.5 hours per session, floor 10 hours (per
          // project_enrops_time_saved memory). Matches the value written to
          // time_saved_events on publish so the sidebar tally agrees.
          const hoursSaved = Math.max(10, Math.ceil((sessionCount || 5) * 1.5));
          // Build the 8-tile capability strip. linkedCount is the operator's
          // total scheduled instances for this curriculum (existing + newly
          // linked), so the program_scheduled state lights up if anything's
          // linked.
          const linkedCount = totalLinked;
          const satisfiedStates = deriveOrgStatesForCurriculum(curriculum, linkedCount);
          const tiles = capabilities.slice(0, 8).map((cap) => ({
            ...cap,
            unlocked: isCapabilityUnlocked(cap, satisfiedStates),
            glyph: CAPABILITY_ICONS[cap.icon_name] ?? "•",
          }));
          return (
            <>
              <h3 style={{ margin: "0 0 6px", color: PURPLE, fontSize: 22, fontWeight: 700 }}>
                {curriculum?.name} is live.
              </h3>
              <p style={{ color: INK, fontSize: 14, margin: "0 0 18px", lineHeight: 1.5 }}>
                {totalLinked > 0
                  ? `Linked to ${linkedSummary()}. Here's what just unlocked.`
                  : "Here's what just unlocked."}
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                {tiles.map((t) => (
                  <button
                    key={t.slug}
                    type="button"
                    onClick={() => onCapabilityClick?.(t, t.unlocked)}
                    title={t.unlocked
                      ? `${t.display_name} — unlocked (click for details)`
                      : `${t.display_name} — ${t.required_states_human || "locked"} (click for details)`}
                    style={{
                      background: PANEL,
                      border: `1px solid ${RULE}`,
                      borderLeft: t.unlocked
                        ? "3px solid #4e914e"
                        : `3px solid ${RULE}`,
                      borderRadius: 6,
                      padding: "9px 11px",
                      display: "flex",
                      gap: 9,
                      alignItems: "flex-start",
                      opacity: t.unlocked ? 1 : 0.78,
                      cursor: "pointer",
                      textAlign: "left",
                      width: "100%",
                      fontFamily: "inherit",
                    }}
                  >
                    <div style={{
                      flexShrink: 0,
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      background: t.unlocked ? "rgba(78, 145, 78, 0.12)" : "#f3f0e6",
                      color: t.unlocked ? "#2d5a2d" : MUTED,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 13,
                      marginTop: 1,
                    }}>
                      {t.unlocked ? "✓" : t.glyph}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, color: t.unlocked ? INK : MUTED, fontSize: 12, lineHeight: 1.3 }}>
                        {t.display_name}
                      </div>
                      <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.35, marginTop: 1 }}>
                        {t.unlocked
                          ? t.short_description
                          : t.required_states_human || "Locked"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <div style={timeSavedPill}>
                {manual
                  ? <>✓ <strong style={{ marginLeft: 6, marginRight: 4 }}>Live and reusable</strong> — this now powers your registration page, emails, and instructor portal.</>
                  : <>⏱ <strong style={{ marginLeft: 6, marginRight: 4 }}>Saved you {hoursSaved}+ hours</strong> of setup work for this offering.</>}
              </div>

              {recommendation && (
                <div style={{
                  background: PLUM_SOFT,
                  border: `1px solid ${PURPLE}33`,
                  borderRadius: 8,
                  padding: 14,
                  marginTop: 14,
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}>
                  <Ennie state="idle" framed={false} size={56} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>
                      <strong style={{ color: PURPLE }}>Ennie's recommendation</strong>
                    </div>
                    <div style={{ fontWeight: 700, color: INK, fontSize: 15, lineHeight: 1.35, marginBottom: 4 }}>
                      {recommendation.headline}
                    </div>
                    <div style={{ color: INK, fontSize: 13, lineHeight: 1.45 }}>
                      {recommendation.body}
                    </div>
                  </div>
                </div>
              )}

              <div style={{ ...modalActions, justifyContent: "flex-end", gap: 10 }}>
                <button onClick={onDone} style={tertiaryBtn}>Back to library</button>
                {recommendation?.primary_cta && (
                  <button
                    onClick={() => {
                      // link_existing variant opens an in-place modal instead
                      // of navigating away; everything else routes via URL.
                      if (recommendation.variant === "link_existing") {
                        onLinkExisting?.();
                      } else {
                        onRecommendationCta?.(recommendation.primary_cta_to);
                      }
                    }}
                    style={primaryBtn}
                  >
                    {recommendation.variant === "link_existing" ? "Manage program links →" : recommendation.primary_cta}
                  </button>
                )}
                {!recommendation?.primary_cta && (
                  <button onClick={onDone} style={primaryBtn}>Back to library →</button>
                )}
              </div>
            </>
          );
        })()}

        {step === 2 && (
          <>
            <h3 style={{ margin: "0 0 6px", color: INK, fontSize: 20, fontWeight: 700 }}>
              {hasMatches ? "Link your existing programs?" : "Ready to publish."}
            </h3>
            <p style={{ color: MUTED, fontSize: 13, margin: "0 0 14px", lineHeight: 1.45 }}>
              {hasMatches
                ? <>Looks like this might be the offering behind {programMatches.length === 1 ? "an" : "some"} existing scheduled program{programMatches.length === 1 ? "" : "s"}. Linking lets the schedule know about its lesson plan.</>
                : totalPreLinked > 0
                  ? <>This offering is already linked to {preLinkedSummary()} — no new matches to suggest. Publish to confirm.</>
                  : <>No matching scheduled programs found — that's fine. We'll publish it to your library and you can schedule it from there.</>}
            </p>
            {totalPreLinked > 0 && (
              <div style={{ background: GOLD_SOFT, border: `1px solid ${GOLD_BORDER}`, borderRadius: 6, padding: "10px 12px", marginBottom: 14, fontSize: 13, color: INK }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div><strong style={{ color: "#7a5a00" }}>Already linked:</strong> {preLinkedSummary()}</div>
                  {hasPreLinkedRows && (
                    <button
                      type="button"
                      onClick={() => setLinkedListOpen((o) => !o)}
                      style={{ background: "none", border: "none", color: PURPLE, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}
                    >
                      {linkedListOpen ? "Hide" : "Show"}
                    </button>
                  )}
                </div>
                {hasPreLinkedRows && linkedListOpen && (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${GOLD_BORDER}`, maxHeight: 200, overflowY: "auto" }}>
                    {preLinkedCampSessions.length > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#7a5a00", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Summer camps</div>
                    )}
                    {preLinkedCampSessions.map((c) => (
                      <div key={c.id} style={{ padding: "3px 0", lineHeight: 1.35 }}>
                        <strong>{c.location_name || "Unspecified location"}</strong>
                        {campLinkMeta(c) && <span style={{ color: MUTED, marginLeft: 6 }}>· {campLinkMeta(c)}</span>}
                      </div>
                    ))}
                    {preLinkedPrograms.length > 0 && (
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#7a5a00", textTransform: "uppercase", letterSpacing: 0.5, margin: `${preLinkedCampSessions.length > 0 ? 8 : 0}px 0 4px` }}>Afterschool programs</div>
                    )}
                    {preLinkedPrograms.map((p) => (
                      <div key={p.id} style={{ padding: "3px 0", lineHeight: 1.35 }}>
                        <strong>{p.program_locations?.name || "Unspecified location"}</strong>
                        {programLinkMeta(p) && <span style={{ color: MUTED, marginLeft: 6 }}>· {programLinkMeta(p)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {hasMatches && (() => {
              // Group matches by source so the operator can see at a glance
              // whether the suggestion is for summer camps or afterschool
              // programs. The kindLabel text alone was too easy to miss.
              // Camp groups also separate by session_type so half-day and
              // full-day camps aren't bundled into one suggestion.
              const campMatches = programMatches.filter((m) => m.source === "camp_sessions");
              const programMatchesAfter = programMatches.filter((m) => m.source === "programs");
              const renderGroup = (label, group) => group.length === 0 ? null : (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, padding: "0 0 6px", borderBottom: `1px solid ${GOLD_BORDER}`, marginBottom: 6 }}>
                    {label}
                  </div>
                  {group.map((m) => (
                    <label key={m.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={selectedMatchKeys.has(m.key)}
                        onChange={() => toggleMatch(m.key)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <strong>{m.name}</strong>
                        <span style={{ color: MUTED, marginLeft: 6 }}>· {formatGroupLabel(m)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              );
              return (
                <div style={matchBox}>
                  {renderGroup("Summer camps", campMatches)}
                  {renderGroup("Afterschool programs", programMatchesAfter)}
                </div>
              );
            })()}
            {error && <div style={{ ...errorBox, marginTop: 12 }}>{error}</div>}
            <div style={modalActions}>
              <button onClick={onCancel} style={tertiaryBtn} disabled={publishing}>Cancel</button>
              <button onClick={onPublish} style={publishing ? primaryBtnDisabled : primaryBtn} disabled={publishing}>
                {publishing ? "Publishing…" : "Publish →"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UnlockItem({ title, body }) {
  return (
    <li style={unlockItemRow}>
      <span style={unlockCheck}>✓</span>
      <div>
        <div style={{ fontWeight: 700, color: INK, fontSize: 14 }}>{title}</div>
        <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.45, marginTop: 2 }}>{body}</div>
      </div>
    </li>
  );
}


// --- styles ---

const crumbs = { fontSize: 13, color: MUTED, marginBottom: 8 };
const crumbLink = { color: MUTED, textDecoration: "none" };

const layout = {
  display: "grid",
  gridTemplateColumns: "280px 1fr",
  gap: 22,
};

const docsPanel = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: 16,
  position: "sticky",
  top: 20,
  alignSelf: "start",
};

const panelLabel = {
  fontSize: 12,
  fontWeight: 700,
  color: MUTED,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 12,
};

const docRow = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 0",
  fontSize: 13,
};

const openLinkBtn = {
  background: "transparent",
  border: "none",
  color: PURPLE,
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

const ennieBanner = {
  background: PANEL,
  border: `1px solid ${GOLD_BORDER}`,
  borderLeft: `4px solid ${BRIGHT}`,
  borderRadius: 12,
  padding: "16px 20px",
  display: "flex",
  alignItems: "center",
  gap: 14,
  position: "sticky",
  top: 16,
  zIndex: 5,
  boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
};
const ennieBannerCalm = { ...ennieBanner, borderColor: RULE, borderLeftColor: RULE, background: "#fafaf3" };

const ennieActionBtn = {
  background: BRIGHT, color: "#fff", border: "none", borderRadius: 5,
  padding: "8px 14px", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0,
};

const card = { background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 22 };
const sectionHead = { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 };
const sectionBlurb = { color: MUTED, fontSize: 13, margin: "0 0 18px", lineHeight: 1.5 };
const inlineCode = { background: "#f5f3eb", padding: "1px 6px", borderRadius: 3, fontSize: 12 };

const fieldWrap = { marginBottom: 16 };
const fieldHelp = { fontSize: 12, color: MUTED, marginBottom: 6, lineHeight: 1.4 };
const textInput = {
  fontFamily: "inherit", fontSize: 14, padding: "9px 12px",
  border: `1px solid ${RULE}`, borderRadius: 6, background: "#fff", color: INK, width: "100%",
  boxSizing: "border-box",
};
const lowConf = {
  borderColor: GOLD_BORDER,
  boxShadow: `0 0 0 3px ${GOLD_SOFT}`,
};

const flagBadge = {
  display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700,
  color: "#7a5a00", background: GOLD_SOFT, border: `1px solid ${GOLD_BORDER}`,
  padding: "2px 7px", borderRadius: 10, textTransform: "none", letterSpacing: 0, marginLeft: 8,
};

const row2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };

const ageGradeToggle = {
  display: "inline-flex", background: "#f7f6ef", border: `1px solid ${RULE}`,
  borderRadius: 5, padding: 3, marginBottom: 8,
};
const ageGradeBtn = {
  background: "transparent", border: "none", padding: "5px 10px",
  fontFamily: "inherit", fontSize: 12, color: MUTED, borderRadius: 3, cursor: "pointer", fontWeight: 600,
};
const ageGradeBtnActive = { ...ageGradeBtn, background: "#fff", color: PURPLE, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" };

const pillOn = {
  padding: "6px 12px", background: PLUM_SOFT, border: `1px solid ${PURPLE}`,
  borderRadius: 18, fontSize: 13, color: PURPLE, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
};
const pillOff = {
  padding: "6px 12px", background: "#fff", border: `1px solid ${RULE}`,
  borderRadius: 18, fontSize: 13, color: INK, cursor: "pointer", fontFamily: "inherit", fontWeight: 500,
};

const chipsBox = {
  display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px",
  border: `1px solid ${RULE}`, borderRadius: 6, background: "#fff", minHeight: 40,
};
const chipStyle = {
  background: GOLD_SOFT, color: "#6b4a00", padding: "4px 8px 4px 10px",
  borderRadius: 14, fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6,
};

const ctaBar = {
  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
  padding: "16px 20px", background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8,
  position: "sticky", bottom: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.04)",
};

const primaryBtn = {
  padding: "10px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6,
  fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const primaryBtnDisabled = { ...primaryBtn, background: "#c8c4b7", cursor: "not-allowed" };
const secondaryBtn = {
  padding: "10px 18px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6,
  fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const tertiaryBtn = {
  padding: "10px 12px", background: "transparent", color: MUTED, border: "none",
  fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};

const modalBack = {
  position: "fixed", inset: 0, background: "rgba(26,26,26,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 24,
};
const modal = {
  background: "#fff", borderRadius: 10, maxWidth: 540, width: "100%",
  padding: "26px 28px", boxShadow: "0 10px 32px rgba(0,0,0,0.15)",
  maxHeight: "90vh", overflowY: "auto",
};
const celebrationModal = {
  ...modal,
  maxWidth: 600,
  padding: "30px 32px 26px",
};
const modalActions = { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 };
const matchBox = {
  background: GOLD_SOFT, border: `1px solid ${GOLD_BORDER}`, borderRadius: 6,
  padding: "10px 14px",
};
const unlockList = {
  listStyle: "none", padding: 0, margin: "0 0 18px",
  display: "flex", flexDirection: "column", gap: 12,
};
const unlockItemRow = {
  display: "flex", gap: 12, alignItems: "flex-start",
};
const unlockCheck = {
  flexShrink: 0, width: 22, height: 22, borderRadius: "50%",
  background: PLUM_SOFT, color: PURPLE, display: "flex",
  alignItems: "center", justifyContent: "center", fontWeight: 700,
  fontSize: 13, marginTop: 1,
};
const timeSavedPill = {
  background: "rgba(78, 145, 78, 0.12)",
  border: "1px solid rgba(78, 145, 78, 0.35)",
  color: "#2d5a2d",
  borderRadius: 8,
  padding: "11px 14px",
  fontSize: 13.5,
  lineHeight: 1.4,
  display: "flex",
  alignItems: "center",
};

const errorBox = {
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  padding: 12,
  fontSize: 13,
};
