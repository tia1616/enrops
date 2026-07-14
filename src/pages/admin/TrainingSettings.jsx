// /admin/training — set whether instructors must watch training video(s) during
// onboarding, and manage the video library + comprehension quizzes.
//
// Two permission tiers (mirrors the DB):
//   - The ON/OFF toggle writes organizations.training_config and requires
//     owner/admin (canManageSettings), same as Background checks. On flip it
//     calls reconcile-onboarding-gate so in-flight instructors re-gate.
//   - The library (instructor_training_videos) is managed by owner/admin/STAFF
//     (canEdit) — staff can upload and edit videos, they just can't flip the
//     org-level requirement.
//
// Video files live in the private `training-videos` bucket at {org_id}/{uuid}.ext
// (org-folder RLS). Instructors never read the bucket directly — the wizard gets
// a signed URL from the get-training-video-url edge fn (built in a later chunk).
//
// No tenant strings here — every provider manages their own org's copy.

import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { usePermissions } from "../../lib/permissions.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";
const RED = "#a13a3a";

const MAX_BYTES = 1024 * 1024 * 1024;          // 1 GB — matches the bucket cap
const ALLOWED = ["video/mp4", "video/webm"];   // web-safe formats only

function fmtDuration(sec) {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
}

// Read a video file's duration (seconds) from its metadata, client-side.
function readDuration(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      // Fallback: some containers never fire loadedmetadata OR error — don't let
      // the upload spinner hang. Resolve with null duration after 15s.
      const to = setTimeout(() => { URL.revokeObjectURL(url); resolve(null); }, 15000);
      v.onloadedmetadata = () => {
        clearTimeout(to);
        const d = Number.isFinite(v.duration) ? v.duration : null;
        URL.revokeObjectURL(url);
        resolve(d);
      };
      v.onerror = () => { clearTimeout(to); URL.revokeObjectURL(url); resolve(null); };
      v.src = url;
    } catch {
      resolve(null);
    }
  });
}

const blankQuestion = () => ({ q: "", options: ["", ""], correct_index: 0 });

export default function TrainingSettings() {
  const { org, user } = useOutletContext();
  const perm = usePermissions();
  const canAdmin = perm.canManageSettings; // toggle
  const canEdit = perm.canEdit;            // library

  const [enabled, setEnabled] = useState(false);
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);

  const [videos, setVideos] = useState([]);
  const [roster, setRoster] = useState(null); // { rows: [{id,name,complete,doneCount,total,latest}], requiredCount } | null
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [editor, setEditor] = useState(null); // { id?, title, description, is_required, quiz[], bucket_object_path, external_url, duration_seconds, _file }
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 3500); }

  async function loadVideos() {
    const { data, error: e } = await supabase
      .from("instructor_training_videos")
      .select("id, title, description, bucket_object_path, external_url, duration_seconds, version, is_required, active, sort_order, quiz")
      .eq("organization_id", org.id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (e) { setError(e.message); return; }
    setVideos(data ?? []);
    await loadRoster();
  }

  // Who's completed training: per active instructor, how many of the currently
  // required videos they've passed (watched + quiz_passed), and when they finished.
  // Org-scoped; any org member can read completions + instructors via RLS.
  async function loadRoster() {
    const { data: reqVids } = await supabase
      .from("instructor_training_videos")
      .select("id").eq("organization_id", org.id).eq("active", true).eq("is_required", true);
    const requiredIds = (reqVids ?? []).map((v) => v.id);

    const { data: instrs } = await supabase
      .from("instructors")
      .select("id, first_name, last_name, preferred_name")
      .eq("organization_id", org.id).eq("is_active", true)
      .order("last_name", { ascending: true });

    const { data: comps } = await supabase
      .from("instructor_training_completions")
      .select("instructor_id, training_video_id, watched_completed_at, quiz_passed")
      .eq("organization_id", org.id);

    const passedByInstr = new Map();
    const latestByInstr = new Map();
    for (const c of comps ?? []) {
      if (!c.watched_completed_at || !c.quiz_passed) continue;
      if (!passedByInstr.has(c.instructor_id)) passedByInstr.set(c.instructor_id, new Set());
      passedByInstr.get(c.instructor_id).add(c.training_video_id);
      const prev = latestByInstr.get(c.instructor_id);
      if (!prev || c.watched_completed_at > prev) latestByInstr.set(c.instructor_id, c.watched_completed_at);
    }

    const rows = (instrs ?? []).map((i) => {
      const passed = passedByInstr.get(i.id) ?? new Set();
      const doneCount = requiredIds.filter((id) => passed.has(id)).length;
      const complete = requiredIds.length > 0 && doneCount === requiredIds.length;
      return {
        id: i.id,
        name: `${i.preferred_name || i.first_name || ""} ${i.last_name || ""}`.trim() || "(unnamed)",
        complete, doneCount, total: requiredIds.length,
        latest: complete ? latestByInstr.get(i.id) : null,
      };
    });
    setRoster({ rows, requiredCount: requiredIds.length });
  }

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("organizations").select("training_config").eq("id", org.id).maybeSingle();
      if (cancelled) return;
      const on = data?.training_config?.enabled === true;
      setEnabled(on); setSavedEnabled(on);
      await loadVideos();
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Guard against navigating away mid-upload (a partial upload is lost).
  useEffect(() => {
    if (!uploading) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [uploading]);

  const activeRequiredCount = videos.filter((v) => v.active && v.is_required).length;

  async function saveToggle(next) {
    if (!canAdmin) return;
    setSavingToggle(true); setError("");
    try {
      const { error: e } = await supabase
        .from("organizations")
        .update({ training_config: { enabled: next } })
        .eq("id", org.id);
      if (e) throw e;
      setEnabled(next); setSavedEnabled(next);
      // Flipping the requirement changes who the onboarding gate lets through,
      // but the gate only re-runs from the wizard/webhooks. Re-run it now for the
      // org's in-flight instructors so the change takes effect immediately.
      // Non-fatal: the config is saved regardless.
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (token) {
          await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/reconcile-onboarding-gate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ organization_id: org.id }),
          });
        }
      } catch (_e) { /* config saved; gate reconciles on next natural run */ }
      flash(next ? "Training turned on." : "Training turned off.");
    } catch (e) {
      setError(e.message ?? "Couldn't save.");
      setEnabled(savedEnabled); // revert the toggle on failure
    } finally {
      setSavingToggle(false);
    }
  }

  function openNew() { setEditor({ title: "", description: "", is_required: true, quiz: [], bucket_object_path: null, external_url: null, duration_seconds: null, _file: null }); }
  function openEdit(v) {
    setEditor({
      id: v.id, title: v.title ?? "", description: v.description ?? "",
      is_required: v.is_required, quiz: Array.isArray(v.quiz) ? v.quiz : [],
      bucket_object_path: v.bucket_object_path, external_url: v.external_url,
      duration_seconds: v.duration_seconds, _file: null,
    });
  }
  function closeEditor() { setEditor(null); if (fileRef.current) fileRef.current.value = ""; }

  async function onPickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    if (!ALLOWED.includes(file.type)) {
      setError("That file type isn't supported. Please upload an MP4 (or WebM) video.");
      if (fileRef.current) fileRef.current.value = ""; return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That file is ${fmtSize(file.size)}. The limit is 1 GB — please compress it (1080p is plenty) and try again.`);
      if (fileRef.current) fileRef.current.value = ""; return;
    }
    setUploading(true);
    try {
      const duration = await readDuration(file);
      const ext = file.type === "video/webm" ? "webm" : "mp4";
      const path = `${org.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("training-videos")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      setEditor((ed) => ed && ({ ...ed, bucket_object_path: path, duration_seconds: duration, _file: { name: file.name, size: file.size } }));
      flash("Video uploaded.");
    } catch (e) {
      setError(e.message ?? "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function validateQuiz(quiz) {
    for (const [i, q] of quiz.entries()) {
      if (!q.q.trim()) return `Question ${i + 1} needs text.`;
      const opts = q.options.map((o) => o.trim()).filter(Boolean);
      if (opts.length < 2) return `Question ${i + 1} needs at least two answer choices.`;
      if (q.correct_index == null || !q.options[q.correct_index]?.trim()) return `Question ${i + 1} needs a correct answer marked.`;
    }
    return null;
  }

  async function saveVideo() {
    if (!editor) return;
    setError("");
    if (!editor.title.trim()) { setError("Give the video a title."); return; }
    if (!editor.bucket_object_path && !editor.external_url) { setError("Upload a video file first."); return; }
    // A required video must have a readable length — completion is measured against
    // it. If the browser couldn't read the duration, don't let it gate onboarding.
    if (editor.is_required && !editor.duration_seconds) {
      setError("We couldn't read this video's length, so it can't be a required video yet. Re-export it as an MP4 and upload again, or mark it optional.");
      return;
    }
    // Trim quiz to complete questions; validate what remains.
    const quiz = (editor.quiz ?? []).filter((q) => q.q.trim() || q.options.some((o) => o.trim()));
    const quizErr = validateQuiz(quiz);
    if (quizErr) { setError(quizErr); return; }

    setSaving(true);
    try {
      const payload = {
        organization_id: org.id,
        title: editor.title.trim(),
        description: editor.description.trim() || null,
        bucket_object_path: editor.bucket_object_path,
        external_url: editor.external_url,
        duration_seconds: editor.duration_seconds,
        is_required: editor.is_required,
        quiz: quiz.length ? quiz : null,
      };
      if (editor.id) {
        const { error: e } = await supabase.from("instructor_training_videos")
          .update({ ...payload, updated_at: new Date().toISOString() }).eq("id", editor.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from("instructor_training_videos")
          .insert({ ...payload, sort_order: videos.length, created_by: user?.id ?? null });
        if (e) throw e;
      }
      await loadVideos();
      closeEditor();
      flash("Saved.");
    } catch (e) {
      setError(e.message ?? "Couldn't save the video.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(v) {
    const { error: e } = await supabase.from("instructor_training_videos")
      .update({ active: !v.active, updated_at: new Date().toISOString() }).eq("id", v.id);
    if (e) { setError(e.message); return; }
    await loadVideos();
    flash(v.active ? "Video hidden from onboarding." : "Video is live in onboarding.");
  }

  async function deleteVideo(v) {
    if (!window.confirm(`Delete "${v.title}"? Instructors who already completed it keep their record, but it won't be shown again.`)) return;
    const { error: e } = await supabase.from("instructor_training_videos").delete().eq("id", v.id);
    if (e) { setError(e.message); return; }
    // Best-effort: remove the file too (orphan cleanup). Completion rows cascade.
    if (v.bucket_object_path) {
      try { await supabase.storage.from("training-videos").remove([v.bucket_object_path]); } catch (_e) { /* orphan tolerated */ }
    }
    await loadVideos();
    flash("Video deleted.");
  }

  if (loading) return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Training videos</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.5, maxWidth: 600 }}>
        Require new instructors to watch training video(s) during onboarding — no skipping ahead, no speeding up —
        and optionally answer a comprehension question or two. Until they finish, they can't be assigned work.
      </p>

      {error && <div style={{ marginTop: 16, padding: "10px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}
      {toast && <div style={{ marginTop: 16, padding: "10px 12px", background: GREEN_BG, border: "1px solid #bbf7d0", borderRadius: 8, color: GREEN_INK, fontSize: 13 }}>{toast}</div>}

      {/* Requirement toggle (owner/admin) */}
      <div style={{ marginTop: 20, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <label style={lbl}>Require training in onboarding</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button type="button" disabled={!canAdmin || savingToggle} onClick={() => saveToggle(true)} style={segBtn(enabled, !canAdmin || savingToggle)}>On — required</button>
          <button type="button" disabled={!canAdmin || savingToggle} onClick={() => saveToggle(false)} style={segBtn(!enabled, !canAdmin || savingToggle)}>Off</button>
        </div>
        <div style={hint}>
          {!canAdmin
            ? "Only owners and admins can turn the training requirement on or off. You can still add and edit videos below."
            : enabled
              ? (activeRequiredCount === 0
                  ? "Training is on, but you haven't added a required video yet — onboarding won't wait on anything until you do. Add one below."
                  : `Instructors must complete ${activeRequiredCount} required video${activeRequiredCount === 1 ? "" : "s"} before they can be assigned work.`)
              : "Training is off — instructors skip this step. You can turn it back on anytime."}
        </div>
      </div>

      {/* Library (owner/admin/staff) */}
      <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5 }}>Your videos</div>
          {canEdit && !editor && <button type="button" onClick={openNew} style={primaryBtn(false)}>+ Add video</button>}
        </div>

        {videos.length === 0 && !editor && (
          <div style={{ ...hint, marginTop: 12 }}>No videos yet.{canEdit ? " Add one to get started." : ""}</div>
        )}

        {videos.length > 0 && (
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {videos.map((v) => (
              <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1px solid ${RULE}`, borderRadius: 10, background: v.active ? "#fff" : "#faf9f7" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: INK, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{v.title}</span>
                    {v.is_required ? <span style={badge(BRIGHT)}>Required</span> : <span style={badge(MUTED)}>Optional</span>}
                    {!v.active && <span style={badge(MUTED)}>Hidden</span>}
                    {Array.isArray(v.quiz) && v.quiz.length > 0 && <span style={badge("#0891b2")}>{v.quiz.length} question{v.quiz.length === 1 ? "" : "s"}</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>
                    {fmtDuration(v.duration_seconds) || "video"}{v.description ? ` · ${v.description}` : ""}
                  </div>
                </div>
                {canEdit && (
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button type="button" onClick={() => openEdit(v)} style={miniBtn}>Edit</button>
                    <button type="button" onClick={() => toggleActive(v)} style={miniBtn}>{v.active ? "Hide" : "Show"}</button>
                    <button type="button" onClick={() => deleteVideo(v)} style={{ ...miniBtn, color: RED, borderColor: "#e7c4c4" }}>Delete</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {editor && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${RULE}`, paddingTop: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: PURPLE, marginBottom: 12 }}>{editor.id ? "Edit video" : "New video"}</div>

            <label style={lbl}>Title</label>
            <input type="text" value={editor.title} onChange={(e) => setEditor({ ...editor, title: e.target.value })} placeholder="e.g. Welcome & safety basics" style={input} />

            <label style={{ ...lbl, marginTop: 16 }}>Short description <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span></label>
            <input type="text" value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} placeholder="One line about what this covers" style={input} />

            <label style={{ ...lbl, marginTop: 16 }}>Video file</label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <input ref={fileRef} type="file" accept="video/mp4,video/webm" onChange={onPickFile} disabled={uploading} style={{ fontSize: 13 }} />
              {uploading && <span style={{ fontSize: 13, color: BRIGHT }}>Uploading… please keep this tab open.</span>}
              {!uploading && editor.bucket_object_path && (
                <span style={{ fontSize: 13, color: GREEN_INK }}>✓ Video ready{editor.duration_seconds ? ` · ${fmtDuration(editor.duration_seconds)}` : ""}</span>
              )}
            </div>
            <div style={hint}>MP4 (recommended) or WebM, up to 1 GB. A 1080p export keeps files small and plays everywhere.</div>

            {/* Required toggle */}
            <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <input id="req" type="checkbox" checked={editor.is_required} onChange={(e) => setEditor({ ...editor, is_required: e.target.checked })} />
              <label htmlFor="req" style={{ fontSize: 13.5, color: INK }}>Required — instructors must complete this to finish onboarding</label>
            </div>

            {/* Quiz builder */}
            <div style={{ marginTop: 20, borderTop: `1px dashed ${RULE}`, paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: PURPLE }}>Comprehension questions <span style={{ color: MUTED, fontWeight: 400 }}>(optional)</span></div>
              <div style={{ ...hint, marginTop: 2, marginBottom: 12 }}>Asked after they finish watching. They must get every question right to pass; they can retry.</div>

              {(editor.quiz ?? []).map((q, qi) => (
                <div key={qi} style={{ border: `1px solid ${RULE}`, borderRadius: 10, padding: 14, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <label style={{ ...lbl, marginBottom: 6 }}>Question {qi + 1}</label>
                    <button type="button" onClick={() => setEditor({ ...editor, quiz: editor.quiz.filter((_, i) => i !== qi) })} style={{ ...miniBtn, color: RED, borderColor: "#e7c4c4" }}>Remove</button>
                  </div>
                  <input type="text" value={q.q} onChange={(e) => { const quiz = [...editor.quiz]; quiz[qi] = { ...q, q: e.target.value }; setEditor({ ...editor, quiz }); }} placeholder="What should they know?" style={input} />
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {q.options.map((opt, oi) => (
                      <div key={oi} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input type="radio" name={`correct-${qi}`} checked={q.correct_index === oi} onChange={() => { const quiz = [...editor.quiz]; quiz[qi] = { ...q, correct_index: oi }; setEditor({ ...editor, quiz }); }} title="Mark correct answer" />
                        <input type="text" value={opt} onChange={(e) => { const quiz = [...editor.quiz]; const options = [...q.options]; options[oi] = e.target.value; quiz[qi] = { ...q, options }; setEditor({ ...editor, quiz }); }} placeholder={`Answer ${oi + 1}`} style={{ ...input, flex: 1 }} />
                        {q.options.length > 2 && (
                          <button type="button" onClick={() => { const quiz = [...editor.quiz]; const options = q.options.filter((_, i) => i !== oi); const ci = q.correct_index >= options.length ? 0 : q.correct_index; quiz[qi] = { ...q, options, correct_index: ci }; setEditor({ ...editor, quiz }); }} style={{ ...miniBtn, color: RED, borderColor: "#e7c4c4" }}>×</button>
                        )}
                      </div>
                    ))}
                  </div>
                  {q.options.length < 4 && (
                    <button type="button" onClick={() => { const quiz = [...editor.quiz]; quiz[qi] = { ...q, options: [...q.options, ""] }; setEditor({ ...editor, quiz }); }} style={{ ...miniBtn, marginTop: 8 }}>+ Add answer</button>
                  )}
                  <div style={{ ...hint, marginTop: 6 }}>Select the radio next to the correct answer.</div>
                </div>
              ))}

              <button type="button" onClick={() => setEditor({ ...editor, quiz: [...(editor.quiz ?? []), blankQuestion()] })} style={miniBtn}>+ Add question</button>
            </div>

            {/* Inline error next to the action, so it's visible where the user is working
                (the top-of-page banner is below the fold once the editor is open). */}
            {error && <div style={{ marginTop: 16, padding: "9px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#991b1b", fontSize: 13 }}>{error}</div>}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button type="button" onClick={closeEditor} disabled={saving || uploading} style={secondaryBtn(saving || uploading)}>Cancel</button>
              <button type="button" onClick={saveVideo} disabled={saving || uploading} style={primaryBtn(saving || uploading)}>{saving ? "Saving…" : "Save video"}</button>
            </div>
          </div>
        )}
      </div>

      {/* Who's completed training — the provider's audit surface. Shown when there's
          at least one required video (i.e. when the gate is actually live). */}
      {canEdit && roster && roster.requiredCount > 0 && (
        <div style={{ marginTop: 16, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5 }}>Who's completed training</div>
          <div style={{ ...hint, marginTop: 4 }}>Across your {roster.requiredCount} required video{roster.requiredCount === 1 ? "" : "s"}. Instructors can't be assigned work until they're complete.</div>
          {roster.rows.length === 0 ? (
            <div style={{ ...hint, marginTop: 12 }}>No active instructors yet.</div>
          ) : (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
              {roster.rows.map((r) => (
                <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", border: `1px solid ${RULE}`, borderRadius: 10 }}>
                  <span style={{ fontSize: 14, color: INK }}>{r.name}</span>
                  {r.complete ? (
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: GREEN_INK, whiteSpace: "nowrap" }}>✓ Complete{r.latest ? ` · ${fmtDate(r.latest)}` : ""}</span>
                  ) : (
                    <span style={{ fontSize: 12.5, color: MUTED, whiteSpace: "nowrap" }}>{r.doneCount} of {r.total} done</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const lbl = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const hint = { fontSize: 12.5, color: MUTED, marginTop: 6, lineHeight: 1.5 };
const input = { width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`, borderRadius: 8, fontSize: 14, color: INK, background: "#fff", fontFamily: "inherit", boxSizing: "border-box" };
function segBtn(active, disabled) { return { padding: "7px 14px", background: active ? "#f0e3e8" : "#fff", color: active ? PURPLE : INK, border: `1.5px solid ${active ? BRIGHT : RULE}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }; }
function primaryBtn(disabled) { return { padding: "9px 18px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
function secondaryBtn(disabled) { return { padding: "9px 16px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }; }
const miniBtn = { padding: "5px 10px", background: "#fff", color: INK, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" };
function badge(color) { return { fontSize: 10.5, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "1px 7px", textTransform: "uppercase", letterSpacing: 0.3, whiteSpace: "nowrap" }; }
