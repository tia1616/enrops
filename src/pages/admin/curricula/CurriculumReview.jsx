// /admin/curricula/:id/review
//
// Chunk 3 of the curriculum onboarding flow. Replaces the read-only placeholder.
// One-screen review: Dora banner (flags fields she's unsure about) above a full
// editable surface of every extracted curricula + curriculum_sessions field.
// Save-as-draft keeps status='extracted'; Publish flips to 'published' after a
// two-step modal (confirm name → optionally link existing program runs).
//
// Multi-tenant: org from outlet context, every query/insert filters by
// organization_id. No J2S hardcoding.
//
// Memory pointers: feedback_one_place_to_edit, project_enrops_curricula_upstream,
// feedback_enrops_principles, project_enrops_platform_vision (Dora = Director).

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const PLUM_SOFT = "rgba(105, 29, 57, 0.08)";
const GOLD = "#CFB12F";
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

// Fields Dora flags when the value is null/empty AND the field is in this list.
// Low-confidence extracted fields are flagged regardless of list membership.
const FLAG_IF_NULL = new Set([
  "age_range", "grade_range", "class_size", "format",
  "session_types_supported", "short_description",
  "prerequisites", "mid_term_skills", "final_recap_skills", "final_showcase",
]);

const FORMAT_OPTIONS = [
  { value: "summer_camp", label: "Summer camp" },
  { value: "afterschool", label: "Afterschool" },
  { value: "other", label: "Other" },
];

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
  const { org, user } = useOutletContext();
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

  // Polish with Dora: when set, the modal opens for this field
  const [polishConfig, setPolishConfig] = useState(null);
  // Chunk 3.5: capability_definitions (14 rows, global) + Dora's Phase 2
  // recommendation for the just-published curriculum (fetched after publish).
  const [capabilities, setCapabilities] = useState([]);
  const [doraRecommendation, setDoraRecommendation] = useState(null);
  // Global save state — drives the tri-state CTA-bar copy
  // values: "idle" | "saving" | "saved" | "error"
  const [saveState, setSaveState] = useState("idle");
  const savedFlashTimer = useRef(null);

  // Debounce timers per field-name
  const debounceTimers = useRef(new Map());

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
        setLoadError(curErr?.message || "Curriculum not found.");
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
  function saveTopFieldDebounced(fieldName, columnPatch, extractedValue, immediate = false) {
    // Optimistic local update so the UI reflects typing
    setCurriculum((c) => ({ ...c, ...columnPatch }));
    const timers = debounceTimers.current;
    if (timers.has(fieldName)) clearTimeout(timers.get(fieldName));
    if (immediate) {
      persistTopField(fieldName, columnPatch, extractedValue);
      return;
    }
    const t = setTimeout(() => {
      persistTopField(fieldName, columnPatch, extractedValue);
      timers.delete(fieldName);
    }, 800);
    timers.set(fieldName, t);
  }

  async function saveSessionField(sessionId, columnPatch, immediate = false) {
    setSessions((rows) => rows.map((r) => (r.id === sessionId ? { ...r, ...columnPatch } : r)));
    const key = `session-${sessionId}-${Object.keys(columnPatch)[0]}`;
    const timers = debounceTimers.current;
    if (timers.has(key)) clearTimeout(timers.get(key));
    const run = async () => {
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
      timers.delete(key);
    };
    if (immediate) { run(); return; }
    timers.set(key, setTimeout(run, 800));
  }

  // Polish with Dora: open the modal pre-loaded with the right field's context.
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

  async function openDocLink(storagePath) {
    if (!storagePath) return;
    const { data, error } = await supabase.storage
      .from("curriculum-documents")
      .createSignedUrl(storagePath, 60 * 60);
    if (error || !data?.signedUrl) {
      alert("Could not open that document.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function saveAsDraft() {
    if (!curriculum) return;
    // Flush any pending debounced writes
    for (const [, t] of debounceTimers.current) clearTimeout(t);
    debounceTimers.current.clear();
    await supabase.from("curricula").update({ status: "extracted" }).eq("id", curriculum.id);
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
      { count: alreadyProgCount },
      { count: alreadyCampCount },
    ] = await Promise.all([
      supabase
        .from("programs")
        .select("id, curriculum, term")
        .eq("organization_id", org.id)
        .is("curriculum_id", null),
      supabase
        .from("camp_sessions")
        .select("id, curriculum_name")
        .eq("organization_id", org.id)
        .is("curriculum_id", null),
      supabase
        .from("programs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .eq("curriculum_id", curriculum.id),
      supabase
        .from("camp_sessions")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id)
        .eq("curriculum_id", curriculum.id),
    ]);
    setPreLinkedProgramCount(alreadyProgCount ?? 0);
    setPreLinkedCampSessionCount(alreadyCampCount ?? 0);

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
      const key = `camp_sessions::${name}`;
      if (!groups.has(key)) groups.set(key, { source: "camp_sessions", name, ids: [], runCount: 0, key });
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
      // 1. flush debounce, save final name
      for (const [, t] of debounceTimers.current) clearTimeout(t);
      debounceTimers.current.clear();
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

      // Phase 2 recommendation: ask dora-recommend what the next clear action
      // is. Non-fatal -- the celebration screen has a static fallback CTA.
      try {
        const { data: recData, error: recErr } = await supabase.functions.invoke("dora-recommend", {
          body: { curriculum_id: curriculum.id },
        });
        if (!recErr && recData) setDoraRecommendation(recData);
      } catch (e) {
        console.warn("dora-recommend failed (using fallback):", e instanceof Error ? e.message : String(e));
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
        <Link to="/admin/curricula" style={crumbLink}>Curricula</Link>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>{curriculum.name}</span>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>Review</span>
      </div>

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 4 }}>
        <div>
          <h1 style={{ margin: 0, color: PLUM, fontSize: 26, fontWeight: 700 }}>{curriculum.name}</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", maxWidth: 720 }}>
            We pulled out the structure. Look it over, edit anything, then publish so it's ready to schedule into a term.
          </p>
        </div>
        <StatusPill status={curriculum.status} />
      </div>

      <div style={layout}>
        {/* LEFT: source docs */}
        <div style={docsPanel}>
          <div style={panelLabel}>Source documents</div>
          {docs.length === 0 && (
            <div style={{ color: MUTED, fontSize: 13 }}>No source docs on file.</div>
          )}
          {docs.map((d, idx) => (
            <div key={d.id} style={{ ...docRow, borderTop: idx === 0 ? 0 : `1px solid ${RULE}`, paddingTop: idx === 0 ? 0 : 10 }}>
              <span style={{ color: PLUM, flexShrink: 0 }}>📄</span>
              <div style={{ flex: 1, fontSize: 13, minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}>
                {d.original_filename || "(unnamed)"}<br />
                <span style={{ color: MUTED, fontSize: 11 }}>{prettyDocType(d.doc_type)}</span>
              </div>
              <button
                onClick={() => openDocLink(d.storage_path)}
                style={openLinkBtn}
              >Open</button>
            </div>
          ))}
        </div>

        {/* RIGHT */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <DoraBanner flagCount={flagCount} onJump={jumpToFirstFlag} />

          <section style={card}>
            <div style={sectionHead}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>The full curriculum</h3>
              <span style={{ color: MUTED, fontSize: 12 }}>Edits save as you go</span>
            </div>
            <p style={sectionBlurb}>
              Everything below feeds your registration page, marketing emails, instructor portal, and parent recaps. Fields with a gold ring are ones Dora wasn't fully sure about — worth a glance.
            </p>

            <FieldText
              label="Curriculum name"
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
                onSave={(patch, exVal) => saveTopFieldDebounced("age_range", patch, exVal)}
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
              help="The 6 skills most practiced across the whole curriculum. Featured in the final recap parent email at term end."
              value={curriculum.final_recap_skills ?? []}
              onChange={(arr) => saveTopFieldDebounced("final_recap_skills", { final_recap_skills: arr }, arr, true)}
              flagged={isFieldFlagged({ curriculum, fieldName: "final_recap_skills", extractedRow: extractedByName.final_recap_skills })}
              saved={savingField === "final_recap_skills"}
              onPolish={(current) => openPolishForTopField("final_recap_skills", current, 6)}
            />

            <FieldTextarea
              label="Final showcase"
              inlineHelp="optional"
              help="If the curriculum ends with a capstone, performance, or family event. Powers the pre-launch reminder email."
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
              <button onClick={saveAsDraft} style={secondaryBtn}>Save as draft</button>
              <button onClick={startPublish} style={primaryBtn}>Publish curriculum →</button>
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
          linkedProgramCount={linkedProgramCount}
          linkedCampSessionCount={linkedCampSessionCount}
          preLinkedProgramCount={preLinkedProgramCount}
          preLinkedCampSessionCount={preLinkedCampSessionCount}
          capabilities={capabilities}
          recommendation={doraRecommendation}
          onDone={() => navigate("/admin/curricula")}
          onRecommendationCta={(to) => navigate(to)}
        />
      )}

      {polishConfig && (
        <PolishModal
          curriculumId={curriculum?.id}
          config={polishConfig}
          onClose={() => setPolishConfig(null)}
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

function DoraAvatar({ size = 38, calm = false }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", overflow: "hidden",
      background: "#fafaf3", flexShrink: 0,
      border: `1px solid ${calm ? RULE : GOLD_BORDER}`,
    }}>
      <img
        src="/dora-full.jpg"
        alt="Dora"
        style={{
          width: "100%", height: "100%",
          objectFit: "cover", objectPosition: "center 18%",
          display: "block",
          filter: calm ? "grayscale(0.65)" : "none",
          opacity: calm ? 0.75 : 1,
        }}
      />
    </div>
  );
}

function DoraBanner({ flagCount, onJump }) {
  const calm = flagCount === 0;
  return (
    <section style={calm ? doraBannerCalm : doraBanner}>
      <DoraAvatar calm={calm} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: calm ? INK : PLUM, fontSize: 14 }}>
          Dora <span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your Director</span>
        </div>
        <div style={{ fontSize: 14, color: INK, marginTop: 2, lineHeight: 1.45 }}>
          {calm
            ? <>All caught up. ✓ Ready to publish whenever you are.</>
            : <>I flagged <strong style={{ color: PLUM }}>{flagCount} field{flagCount === 1 ? "" : "s"}</strong> below worth a look — they're outlined in gold. Edit any of them to clear the flag.</>}
        </div>
      </div>
      {!calm && (
        <button onClick={onJump} style={doraActionBtn}>Jump to first ↓</button>
      )}
    </section>
  );
}

function StatusPill({ status }) {
  const map = {
    draft: { bg: "#f7f6ef", color: MUTED, label: "Draft" },
    extracted: { bg: GOLD_SOFT, color: "#7a5a00", label: "Extracted" },
    published: { bg: PLUM_SOFT, color: PLUM, label: "Published" },
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
    <span title="Double-check this one — Dora wasn't fully sure." style={flagBadge}>◆ Dora flagged</span>
  );
}

function SavedTick({ on }) {
  return <span style={{ marginLeft: 6, fontSize: 12, color: GOLD, opacity: on ? 1 : 0, transition: "opacity 0.2s" }}>✓</span>;
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
            title={canPolish ? "Ask Dora to rewrite this into parent-impressive copy" : "Add text first"}
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
            ✨ Polish with Dora
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
      onSave({ grade_min: v, grade_max: curriculum.grade_max }, { min: v, max: curriculum.grade_max });
    }
  }
  function updateMax(raw) {
    const v = raw === "" ? null : Number(raw);
    if (isAges) {
      onSave({ age_range_min: curriculum.age_range_min, age_range_max: v }, { min: curriculum.age_range_min, max: v });
    } else {
      onSave({ grade_min: curriculum.grade_min, grade_max: v }, { min: curriculum.grade_min, max: v });
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
            title={canPolish ? "Ask Dora to re-rank and rewrite these as parent-impressive concepts" : "Add at least one skill first"}
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
            ✨ Polish with Dora
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
        <span style={{ width: 26, height: 26, borderRadius: "50%", background: PLUM_SOFT, color: PLUM, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{session.session_number}</span>
        <span style={{ flex: 1, fontWeight: 600, color: INK, fontSize: 14 }}>{session.title || "(untitled)"}</span>
        <span style={{ color: MUTED, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▶</span>
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
    ? "Asking Dora to polish this description…"
    : `Asking Dora to polish these ${current.length} skill${current.length === 1 ? "" : "s"}…`;

  return (
    <div style={modalBack} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modal}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <DoraAvatar size={54} />
          <div>
            <div style={{ fontWeight: 700, color: PLUM, fontSize: 15 }}>
              Dora<span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your Director</span>
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
                <div style={{ fontSize: 11, fontWeight: 600, color: "#7a5a00", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>✨ Polished by Dora</div>
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
                Use Dora's polish →
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
                <div style={{ fontSize: 11, fontWeight: 600, color: "#7a5a00", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>✨ Polished by Dora</div>
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
                    style={{ alignSelf: "flex-start", background: "transparent", border: "none", color: PLUM, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: "4px 0", marginTop: 2 }}
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
                Use Dora's polish →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Chunk 3.5: shared icon map for capability tiles + strip. Lucide icons are
// the production target; emojis are the v1 placeholder.
const CAPABILITY_ICONS = {
  "file-text": "📝",
  "printer": "🖨",
  "book-open": "📚",
  "mail": "✉",
  "calendar": "📅",
  "clipboard-check": "🎟",
  "mail-check": "📩",
  "send": "📬",
  "user": "👤",
  "user-check": "🧑",
  "tag": "🏷",
  "repeat": "🔁",
  "users": "👥",
  "inbox": "📥",
};

function deriveOrgStatesForCurriculum(curriculum, linkedCount) {
  const states = new Set();
  if (curriculum?.status === "published") states.add("curriculum_published");
  if ((linkedCount ?? 0) > 0) states.add("program_scheduled");
  return states;
}

function isCapabilityUnlocked(capability, satisfiedStates) {
  if (!Array.isArray(capability.required_states) || capability.required_states.length === 0) return true;
  for (const req of capability.required_states) if (!satisfiedStates.has(req)) return false;
  return true;
}

function PublishModal({
  step, nameDraft, setNameDraft, programMatches, selectedMatchKeys, setSelectedMatchKeys,
  publishing, error, onCancel, onContinue, onPublish,
  curriculum, sessionCount, linkedProgramCount, linkedCampSessionCount,
  preLinkedProgramCount = 0, preLinkedCampSessionCount = 0,
  capabilities = [], recommendation = null, onDone, onRecommendationCta,
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
          <DoraAvatar size={isCelebration ? 72 : 54} />
          <div>
            <div style={{ fontWeight: 700, color: PLUM, fontSize: isCelebration ? 16 : 15 }}>
              Dora<span style={{ color: MUTED, fontWeight: 500, fontSize: 12, marginLeft: 6 }}>your Director</span>
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
              <h3 style={{ margin: "0 0 6px", color: PLUM, fontSize: 22, fontWeight: 700 }}>
                {curriculum?.name} is live.
              </h3>
              <p style={{ color: INK, fontSize: 14, margin: "0 0 18px", lineHeight: 1.5 }}>
                {totalLinked > 0
                  ? `Linked to ${linkedSummary()}. Here's what just unlocked.`
                  : "Here's what just unlocked."}
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                {tiles.map((t) => (
                  <div
                    key={t.slug}
                    title={t.unlocked
                      ? `${t.display_name} — unlocked`
                      : `${t.display_name} — ${t.required_states_human || "locked"}`}
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
                  </div>
                ))}
              </div>

              <div style={timeSavedPill}>
                ⏱ <strong style={{ marginLeft: 6, marginRight: 4 }}>Saved you {hoursSaved}+ hours</strong> of setup work for this curriculum.
              </div>

              {recommendation && (
                <div style={{
                  background: PLUM_SOFT,
                  border: `1px solid ${PLUM}33`,
                  borderRadius: 8,
                  padding: 14,
                  marginTop: 14,
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}>
                  <DoraAvatar size={48} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>
                      <strong style={{ color: PLUM }}>Dora's recommendation</strong>
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
                    onClick={() => onRecommendationCta?.(recommendation.primary_cta_to)}
                    style={primaryBtn}
                  >
                    {recommendation.primary_cta}
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
                ? <>Looks like this might be the curriculum behind {programMatches.length === 1 ? "an" : "some"} existing scheduled program{programMatches.length === 1 ? "" : "s"}. Linking lets the schedule know about its lesson plan.</>
                : totalPreLinked > 0
                  ? <>This curriculum is already linked to {preLinkedSummary()} — no new matches to suggest. Publish to confirm.</>
                  : <>No matching scheduled programs found — that's fine. We'll publish it to your library and you can schedule it from there.</>}
            </p>
            {totalPreLinked > 0 && (
              <div style={{ background: GOLD_SOFT, border: `1px solid ${GOLD_BORDER}`, borderRadius: 6, padding: "10px 12px", marginBottom: 14, fontSize: 13, color: INK }}>
                <strong style={{ color: "#7a5a00" }}>Already linked:</strong> {preLinkedSummary()}
              </div>
            )}
            {hasMatches && (
              <div style={matchBox}>
                {programMatches.map((m) => {
                  const kindLabel = m.source === "camp_sessions" ? "camp session" : "program run";
                  return (
                    <label key={m.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 0", fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={selectedMatchKeys.has(m.key)}
                        onChange={() => toggleMatch(m.key)}
                        style={{ marginTop: 3 }}
                      />
                      <span>
                        <strong>{m.name}</strong>
                        <span style={{ color: MUTED, marginLeft: 6 }}>· {m.runCount} {kindLabel}{m.runCount === 1 ? "" : "s"}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
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

function prettyDocType(t) {
  switch (t) {
    case "instructor_guide": return "curriculum guide";
    case "materials_list": return "materials list";
    case "student_materials": return "student materials";
    default: return t || "";
  }
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
  color: PLUM,
  fontFamily: "inherit",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  padding: 0,
  flexShrink: 0,
};

const doraBanner = {
  background: PANEL,
  border: `1px solid ${GOLD_BORDER}`,
  borderLeft: `4px solid ${GOLD}`,
  borderRadius: 8,
  padding: "16px 20px",
  display: "flex",
  alignItems: "center",
  gap: 14,
  position: "sticky",
  top: 16,
  zIndex: 5,
  boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
};
const doraBannerCalm = { ...doraBanner, borderColor: RULE, borderLeftColor: RULE, background: "#fafaf3" };

const doraActionBtn = {
  background: PLUM, color: "#fff", border: "none", borderRadius: 5,
  padding: "8px 14px", fontFamily: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", flexShrink: 0,
};

const card = { background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 22 };
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
const ageGradeBtnActive = { ...ageGradeBtn, background: "#fff", color: PLUM, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" };

const pillOn = {
  padding: "6px 12px", background: PLUM_SOFT, border: `1px solid ${PLUM}`,
  borderRadius: 18, fontSize: 13, color: PLUM, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
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
  padding: "10px 18px", background: PLUM, color: "#fff", border: "none", borderRadius: 6,
  fontFamily: "inherit", fontSize: 14, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
const primaryBtnDisabled = { ...primaryBtn, background: "#c8c4b7", cursor: "not-allowed" };
const secondaryBtn = {
  padding: "10px 18px", background: "transparent", color: PLUM, border: `1px solid ${PLUM}`, borderRadius: 6,
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
  background: PLUM_SOFT, color: PLUM, display: "flex",
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
