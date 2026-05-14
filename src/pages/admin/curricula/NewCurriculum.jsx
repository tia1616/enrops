// /admin/curricula/new
// 5-step onboarding flow for a new curriculum: name → ages → session count →
// locations → upload docs. Step 6 is a placeholder for Chunk 3's extraction
// trigger.
//
// Resumable: pass ?id=<curriculum_id> to jump straight to Step 5 (upload) for
// an existing draft. The "Add curriculum docs →" CTA on the list page uses this.
//
// Multi-tenant: all writes scoped by the caller's organization_id (from
// AdminLayout's outlet context). RLS also enforces this at the DB level.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams, Link } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const STEP_COUNT = 5; // Visual progress only; Step 6 is a post-completion placeholder.

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const MAX_FILES_PER_CURRICULUM = 10;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const ALLOWED_EXT = [".pdf", ".docx", ".txt", ".md", ".xlsx"];
const DRIVE_URL_PATTERN = /^https:\/\/(docs|drive)\.google\.com\/(document|file|spreadsheets|presentation)\/d\/[\w-]+/;

const DOC_ZONES = [
  { key: "instructor_guide", label: "Instructor Guide / Lesson Plans", required: true },
  { key: "materials_list", label: "Materials List", required: false },
  { key: "student_materials", label: "Student Materials / Journals", required: false },
];

export default function NewCurriculum() {
  const navigate = useNavigate();
  const { org } = useOutletContext();
  const [params] = useSearchParams();
  const resumeId = params.get("id");

  const [step, setStep] = useState(resumeId ? 5 : 1);
  const [curriculumId, setCurriculumId] = useState(resumeId);
  const [form, setForm] = useState({
    name: "",
    age_min: "",
    age_max: "",
    session_count: "",
    location_ids: [],
  });
  const [locations, setLocations] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showAddLocation, setShowAddLocation] = useState(false);

  // Load locations for Step 4 (and the existing curriculum if resuming).
  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      const { data: locs } = await supabase
        .from("program_locations")
        .select("id, name, district, address")
        .eq("organization_id", org.id)
        .order("name");
      if (mounted) setLocations(locs ?? []);

      if (resumeId) {
        const { data: c } = await supabase
          .from("curricula")
          .select("id, name, age_min, age_max, session_count, curriculum_to_locations(program_location_id)")
          .eq("id", resumeId)
          .maybeSingle();
        if (mounted && c) {
          setForm({
            name: c.name ?? "",
            age_min: c.age_min?.toString() ?? "",
            age_max: c.age_max?.toString() ?? "",
            session_count: c.session_count?.toString() ?? "",
            location_ids: (c.curriculum_to_locations ?? []).map((r) => r.program_location_id),
          });
        }
        const { data: docs } = await supabase
          .from("curriculum_documents")
          .select("id, doc_type, source_type, storage_path, drive_url, original_filename, mime_type")
          .eq("curriculum_id", resumeId);
        if (mounted) setDocuments(docs ?? []);
      }
    })();
    return () => { mounted = false; };
  }, [org?.id, resumeId]);

  function update(patch) {
    setForm((f) => ({ ...f, ...patch }));
  }

  async function saveCurriculumAndAdvance() {
    setSubmitting(true);
    setError("");
    try {
      const payload = {
        organization_id: org.id,
        name: form.name.trim(),
        age_min: parseInt(form.age_min, 10),
        age_max: parseInt(form.age_max, 10),
        session_count: parseInt(form.session_count, 10),
        status: "draft",
      };
      const { data: inserted, error: insErr } = await supabase
        .from("curricula")
        .insert(payload)
        .select("id")
        .single();
      if (insErr) throw new Error(insErr.message);

      const linkRows = form.location_ids.map((locId) => ({
        curriculum_id: inserted.id,
        program_location_id: locId,
        organization_id: org.id,
      }));
      if (linkRows.length > 0) {
        const { error: linkErr } = await supabase.from("curriculum_to_locations").insert(linkRows);
        if (linkErr) throw new Error(linkErr.message);
      }
      setCurriculumId(inserted.id);
      setStep(5);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadFile(file, docType) {
    if (!ALLOWED_MIME.has(file.type) && !ALLOWED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      throw new Error("We don't read scanned documents yet — upload a text-based file instead.");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error("That file is too big. Max size is 25 MB.");
    }
    if (documents.length >= MAX_FILES_PER_CURRICULUM) {
      throw new Error(`Max ${MAX_FILES_PER_CURRICULUM} files per curriculum.`);
    }
    const docId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${org.id}/${curriculumId}/${docId}-${safeName}`;

    const { error: upErr } = await supabase.storage
      .from("program-documents")
      .upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

    const { data: row, error: rowErr } = await supabase
      .from("curriculum_documents")
      .insert({
        id: docId,
        curriculum_id: curriculumId,
        organization_id: org.id,
        doc_type: docType,
        source_type: "upload",
        storage_path: path,
        original_filename: file.name,
        mime_type: file.type,
      })
      .select("id, doc_type, source_type, storage_path, drive_url, original_filename, mime_type")
      .single();
    if (rowErr) {
      await supabase.storage.from("program-documents").remove([path]).catch(() => {});
      throw new Error(`Could not save document record: ${rowErr.message}`);
    }
    setDocuments((d) => [...d, row]);
  }

  async function saveDriveLink(driveUrl, docType) {
    if (!DRIVE_URL_PATTERN.test(driveUrl.trim())) {
      throw new Error("That doesn't look like a Google Drive link.");
    }
    if (documents.length >= MAX_FILES_PER_CURRICULUM) {
      throw new Error(`Max ${MAX_FILES_PER_CURRICULUM} files per curriculum.`);
    }
    const { data: row, error: rowErr } = await supabase
      .from("curriculum_documents")
      .insert({
        curriculum_id: curriculumId,
        organization_id: org.id,
        doc_type: docType,
        source_type: "drive_link",
        drive_url: driveUrl.trim(),
      })
      .select("id, doc_type, source_type, storage_path, drive_url, original_filename, mime_type")
      .single();
    if (rowErr) throw new Error(rowErr.message);
    setDocuments((d) => [...d, row]);
  }

  async function removeDocument(doc) {
    if (doc.source_type === "upload" && doc.storage_path) {
      await supabase.storage.from("program-documents").remove([doc.storage_path]).catch(() => {});
    }
    await supabase.from("curriculum_documents").delete().eq("id", doc.id);
    setDocuments((d) => d.filter((x) => x.id !== doc.id));
  }

  function handleAddedLocation(newLoc) {
    setLocations((ls) => [...ls, newLoc].sort((a, b) => a.name.localeCompare(b.name)));
    update({ location_ids: [...form.location_ids, newLoc.id] });
    setShowAddLocation(false);
  }

  // ---- Step rendering ----
  const showProgress = step <= STEP_COUNT;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/admin/curricula" style={{ color: MUTED, fontSize: 13, textDecoration: "none" }}>← All curricula</Link>
      </div>

      {showProgress && (
        <div style={{ display: "flex", gap: 6, marginBottom: 26 }}>
          {Array.from({ length: STEP_COUNT }).map((_, i) => (
            <div key={i} style={{
              flex: 1, height: 4, borderRadius: 2,
              background: i < step ? PLUM : RULE,
            }} />
          ))}
        </div>
      )}

      {error && <div style={errorBox}>{error}</div>}

      {step === 1 && (
        <StepShell heading="What's this curriculum called?" helper="This is what parents will see when they're choosing classes.">
          <input
            type="text"
            autoFocus
            value={form.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="e.g., LEGO Game Makers"
            style={inputStyle}
          />
          <Footer
            next={() => setStep(2)}
            nextDisabled={form.name.trim().length < 2}
          />
        </StepShell>
      )}

      {step === 2 && (
        <StepShell heading="Who's it for?" helper="Approximate is fine — you can edit later.">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: MUTED }}>Ages</span>
            <input
              type="number" min="0" max="18"
              value={form.age_min}
              onChange={(e) => update({ age_min: e.target.value })}
              style={{ ...inputStyle, width: 80 }}
            />
            <span style={{ color: MUTED }}>to</span>
            <input
              type="number" min="0" max="18"
              value={form.age_max}
              onChange={(e) => update({ age_max: e.target.value })}
              style={{ ...inputStyle, width: 80 }}
            />
          </div>
          <Footer
            back={() => setStep(1)}
            next={() => setStep(3)}
            nextDisabled={!form.age_min || !form.age_max || parseInt(form.age_min, 10) > parseInt(form.age_max, 10)}
          />
        </StepShell>
      )}

      {step === 3 && (
        <StepShell heading="How many sessions does this curriculum cover?" helper="One session = one class meeting. A 6-week afterschool curriculum has 6 sessions.">
          <input
            type="number" min="1" max="60"
            value={form.session_count}
            onChange={(e) => update({ session_count: e.target.value })}
            placeholder="e.g., 8"
            style={{ ...inputStyle, width: 140 }}
          />
          <Footer
            back={() => setStep(2)}
            next={() => setStep(4)}
            nextDisabled={!form.session_count || parseInt(form.session_count, 10) < 1}
          />
        </StepShell>
      )}

      {step === 4 && (
        <StepShell heading="Where will this run?" helper="Pick all that apply. You can add more later.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            {locations.map((loc) => {
              const selected = form.location_ids.includes(loc.id);
              return (
                <label key={loc.id} style={{
                  border: `1px solid ${selected ? PLUM : RULE}`,
                  background: selected ? `${PLUM}0a` : "#fff",
                  borderRadius: 6, padding: "10px 12px", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 8, fontSize: 14,
                }}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => update({
                      location_ids: selected
                        ? form.location_ids.filter((id) => id !== loc.id)
                        : [...form.location_ids, loc.id],
                    })}
                    style={{ accentColor: PLUM }}
                  />
                  <div>
                    <div style={{ fontWeight: 500, color: INK }}>{loc.name}</div>
                    {loc.district && <div style={{ fontSize: 11, color: MUTED }}>{loc.district}</div>}
                  </div>
                </label>
              );
            })}
          </div>
          <button onClick={() => setShowAddLocation(true)} style={linkBtn}>+ Add a new location</button>

          <Footer
            back={() => setStep(3)}
            next={saveCurriculumAndAdvance}
            nextLabel={submitting ? "Saving…" : "Next"}
            nextDisabled={form.location_ids.length === 0 || submitting}
          />

          {showAddLocation && (
            <AddLocationModal
              orgId={org.id}
              onClose={() => setShowAddLocation(false)}
              onAdded={handleAddedLocation}
            />
          )}
        </StepShell>
      )}

      {step === 5 && (
        <Step5Upload
          curriculumId={curriculumId}
          documents={documents}
          onUpload={uploadFile}
          onDriveLink={saveDriveLink}
          onRemove={removeDocument}
          onExtract={() => setStep(6)}
          onSaveLater={() => navigate("/admin/curricula")}
          onBack={resumeId ? () => navigate("/admin/curricula") : () => setStep(4)}
        />
      )}

      {step === 6 && (
        <StepShell heading="Extraction in progress…" helper="(placeholder — will be built in Chunk 3)">
          <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 18, fontSize: 14, color: MUTED }}>
            In the next build phase, this is where the AI will read your uploaded documents and pull out the curriculum details for you to review.
          </div>
          <div style={{ marginTop: 16 }}>
            <Link to="/admin/curricula" style={primaryBtn}>← Back to curricula</Link>
          </div>
        </StepShell>
      )}
    </div>
  );
}

// ---- Step 5 (upload screen) ----

function Step5Upload({ curriculumId, documents, onUpload, onDriveLink, onRemove, onExtract, onSaveLater, onBack }) {
  const hasInstructorGuide = useMemo(
    () => documents.some((d) => d.doc_type === "instructor_guide"),
    [documents]
  );
  const [zoneErrors, setZoneErrors] = useState({});

  async function handleFiles(docType, files) {
    setZoneErrors((e) => ({ ...e, [docType]: "" }));
    for (const file of files) {
      try {
        await onUpload(file, docType);
      } catch (err) {
        setZoneErrors((e) => ({ ...e, [docType]: err instanceof Error ? err.message : String(err) }));
        break;
      }
    }
  }

  return (
    <StepShell heading="Upload your curriculum" helper="Drop your files in. Enrops will read them and pull out the details for you.">
      {DOC_ZONES.map((zone) => (
        <DocZone
          key={zone.key}
          zone={zone}
          docs={documents.filter((d) => d.doc_type === zone.key)}
          error={zoneErrors[zone.key]}
          onFiles={(files) => handleFiles(zone.key, files)}
          onDriveLink={(url) => onDriveLink(url, zone.key)}
          onRemove={onRemove}
        />
      ))}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22, gap: 10 }}>
        <button onClick={onBack} style={backBtn}>← Back</button>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onSaveLater} style={secondaryBtn}>Save and finish later</button>
          <button onClick={onExtract} disabled={!hasInstructorGuide} style={hasInstructorGuide ? primaryBtn : disabledBtn}>
            Extract details with AI
          </button>
        </div>
      </div>
    </StepShell>
  );
}

function DocZone({ zone, docs, error, onFiles, onDriveLink, onRemove }) {
  const [showDrive, setShowDrive] = useState(false);
  const [driveUrl, setDriveUrl] = useState("");
  const [driveError, setDriveError] = useState("");
  const [submittingDrive, setSubmittingDrive] = useState(false);

  async function submitDrive() {
    setDriveError("");
    setSubmittingDrive(true);
    try {
      await onDriveLink(driveUrl);
      setDriveUrl("");
      setShowDrive(false);
    } catch (e) {
      setDriveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmittingDrive(false);
    }
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600, color: INK, fontSize: 14 }}>{zone.label}</div>
        {zone.required && <span style={requiredBadge}>required to extract</span>}
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.setAttribute("data-drag", "1"); }}
        onDragLeave={(e) => e.currentTarget.removeAttribute("data-drag")}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.removeAttribute("data-drag");
          onFiles(Array.from(e.dataTransfer.files ?? []));
        }}
        onClick={() => document.getElementById(`zone-input-${zone.key}`)?.click()}
        style={{
          border: `2px dashed ${RULE}`, borderRadius: 6, padding: 18, background: CHALK,
          textAlign: "center", cursor: "pointer",
        }}
      >
        <input
          id={`zone-input-${zone.key}`}
          type="file"
          multiple
          accept={ALLOWED_EXT.join(",")}
          style={{ display: "none" }}
          onChange={(e) => onFiles(Array.from(e.target.files ?? []))}
        />
        <div style={{ fontSize: 13, color: INK }}>
          Drop files here or click to browse
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
          Accepted: {ALLOWED_EXT.join(" · ")}
        </div>
      </div>

      {error && <div style={{ ...inlineError, marginTop: 6 }}>{error}</div>}

      {docs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {docs.map((d) => (
            <div key={d.id} style={uploadedItem}>
              <span style={{ fontSize: 13, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {d.source_type === "drive_link" ? `🔗 ${d.drive_url}` : `📄 ${d.original_filename}`}
              </span>
              <button onClick={() => onRemove(d)} style={removeBtn} aria-label="Remove">×</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 8 }}>
        {!showDrive ? (
          <button onClick={() => setShowDrive(true)} style={linkBtn}>+ Or link a Google Doc</button>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, background: "#fafaf5", borderRadius: 6, border: `1px solid ${RULE}` }}>
            <input
              type="url"
              placeholder="https://docs.google.com/document/d/..."
              value={driveUrl}
              onChange={(e) => setDriveUrl(e.target.value)}
              style={{ ...inputStyle, fontSize: 13 }}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={submitDrive} disabled={!driveUrl || submittingDrive} style={driveUrl && !submittingDrive ? smallPrimaryBtn : disabledSmallBtn}>
                {submittingDrive ? "Saving…" : "Add link"}
              </button>
              <button onClick={() => { setShowDrive(false); setDriveUrl(""); setDriveError(""); }} style={linkBtn}>Cancel</button>
            </div>
            <div style={{ fontSize: 11, color: MUTED }}>Drive import will be enabled in the next build phase.</div>
            {driveError && <div style={inlineError}>{driveError}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Add Location modal ----

function AddLocationModal({ orgId, onClose, onAdded }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      const slug = `${slugBase}-${Date.now().toString(36)}`;
      const { data, error: insErr } = await supabase
        .from("program_locations")
        .insert({
          organization_id: orgId,
          name: name.trim(),
          slug,
          address: address.trim() || null,
        })
        .select("id, name, district, address")
        .single();
      if (insErr) throw new Error(insErr.message);
      onAdded(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#fff", borderRadius: 8, padding: 22, width: 400, maxWidth: "90vw",
      }}>
        <h3 style={{ margin: 0, color: PLUM, fontSize: 18 }}>Add a location</h3>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 4, marginBottom: 14 }}>
          Add a school or site where this curriculum can run.
        </div>
        <label style={fieldLabel}>Name</label>
        <input
          autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Forest Grove Elementary"
          style={inputStyle}
        />
        <label style={{ ...fieldLabel, marginTop: 10 }}>Address (optional)</label>
        <input
          value={address} onChange={(e) => setAddress(e.target.value)}
          placeholder="Street, City, State"
          style={inputStyle}
        />
        {error && <div style={{ ...inlineError, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={submit} disabled={!name.trim() || submitting} style={name.trim() && !submitting ? primaryBtn : disabledBtn}>
            {submitting ? "Saving…" : "Save location"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Shared UI ----

function StepShell({ heading, helper, children }) {
  return (
    <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: 26 }}>
      <h2 style={{ margin: 0, color: PLUM, fontSize: 22, fontWeight: 700 }}>{heading}</h2>
      {helper && <div style={{ color: MUTED, fontSize: 13, marginTop: 6, marginBottom: 16 }}>{helper}</div>}
      {children}
    </div>
  );
}

function Footer({ back, next, nextDisabled, nextLabel = "Next" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 22 }}>
      {back ? <button onClick={back} style={backBtn}>← Back</button> : <span />}
      <button onClick={next} disabled={nextDisabled} style={nextDisabled ? disabledBtn : primaryBtn}>{nextLabel}</button>
    </div>
  );
}

// ---- Styles ----

const inputStyle = {
  padding: "10px 12px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 15,
  color: INK,
  background: "#fff",
  width: "100%",
  boxSizing: "border-box",
};

const fieldLabel = { display: "block", fontSize: 12, color: MUTED, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 };

const primaryBtn = {
  display: "inline-block",
  padding: "9px 18px",
  background: PLUM,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
  fontFamily: "inherit",
};

const disabledBtn = { ...primaryBtn, background: "#c8c4b7", cursor: "default" };
const secondaryBtn = { ...primaryBtn, background: "transparent", color: PLUM, border: `1px solid ${PLUM}` };
const backBtn = { ...secondaryBtn, padding: "9px 14px" };
const smallPrimaryBtn = { ...primaryBtn, padding: "6px 12px", fontSize: 13 };
const disabledSmallBtn = { ...smallPrimaryBtn, background: "#c8c4b7", cursor: "default" };

const linkBtn = {
  padding: 0, background: "none", border: "none", color: PLUM,
  fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
  textDecoration: "underline",
};

const errorBox = {
  background: "#fff5f5", border: "1px solid #f0c4c4", color: "#7a1a1a",
  borderRadius: 4, padding: 10, fontSize: 13, marginBottom: 14,
};

const inlineError = { fontSize: 12, color: "#7a1a1a", padding: "4px 0" };

const uploadedItem = {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "6px 10px", background: "#fafaf5", border: `1px solid ${RULE}`,
  borderRadius: 4, marginTop: 4, fontSize: 13,
};

const removeBtn = {
  background: "none", border: "none", color: MUTED, fontSize: 20, lineHeight: 1,
  cursor: "pointer", padding: "0 4px", fontFamily: "inherit",
};

const requiredBadge = {
  background: `${GOLD}33`, color: "#7a5a00", fontSize: 10, fontWeight: 700,
  padding: "2px 6px", borderRadius: 8, textTransform: "uppercase", letterSpacing: 0.4,
};
