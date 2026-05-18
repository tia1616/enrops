// /admin/curricula/new
// Step 1 of the upload-first onboarding flow. Provider drops their curriculum
// doc (and optional class/student materials), clicks "Extract curriculum",
// we create draft DB rows + storage objects + kick off the extract edge
// function, then route to the live status page (Step 2).
//
// Multi-tenant: every row writes organization_id from the outlet-context org.
// Storage paths start with org_id so the bucket RLS allows the insert.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext, Link } from "react-router-dom";
import { supabase, API_BASE } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const ALLOWED_EXTS = ["pdf", "docx", "txt", "md", "xlsx"];
const MAX_BYTES = 25 * 1024 * 1024;

const UNLOCK_ITEMS = [
  { strong: "parent-facing registration listing", rest: " — title, ages, description, themes, what kids will do" },
  { strong: "marketing flyer", rest: " + welcome emails you can send out to families" },
  { strong: "Session recap emails", rest: " that go out to parents automatically after each class" },
  { strong: "instructor portal", rest: " with the full lesson plans, prep notes, and materials" },
  { strong: "substitute handover", rest: " so a sub can step in without scrambling" },
];

export default function CurriculumNew() {
  const navigate = useNavigate();
  const { org, user } = useOutletContext();

  const [primary, setPrimary] = useState(null);
  const [materials, setMaterials] = useState(null);
  const [journal, setJournal] = useState(null);
  const [driveUrl, setDriveUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]); // [{ zone, message }]
  const primaryRef = useRef(null);
  const materialsRef = useRef(null);
  const journalRef = useRef(null);

  function fileExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }

  function validate(file) {
    if (!file) return "No file";
    const ext = fileExt(file.name);
    if (!ALLOWED_EXTS.includes(ext)) return `We can read .pdf, .docx, .xlsx, .txt, or .md — not .${ext || "unknown"}.`;
    if (file.size > MAX_BYTES) return `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — please keep it under 25 MB.`;
    return null;
  }

  function pickFile(zone, file) {
    setErrors((prev) => prev.filter((e) => e.zone !== zone));
    if (!file) return;
    const err = validate(file);
    if (err) {
      setErrors((prev) => [...prev.filter((e) => e.zone !== zone), { zone, message: err }]);
      return;
    }
    if (zone === "primary") setPrimary(file);
    if (zone === "materials") setMaterials(file);
    if (zone === "journal") setJournal(file);
  }

  function handleDrop(zone) {
    return (e) => {
      e.preventDefault();
      e.currentTarget.removeAttribute("data-drag");
      const f = e.dataTransfer.files?.[0];
      pickFile(zone, f);
    };
  }

  async function uploadOne({ file, docType, curriculumId, organizationId }) {
    const docId = crypto.randomUUID();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${organizationId}/${curriculumId}/${docId}-${safeName}`;
    const { error: upErr } = await supabase.storage
      .from("curriculum-documents")
      .upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (upErr) throw new Error(`Couldn't upload ${file.name}: ${upErr.message}`);
    const { data: docRow, error: insErr } = await supabase
      .from("curriculum_documents")
      .insert({
        id: docId,
        curriculum_id: curriculumId,
        organization_id: organizationId,
        doc_type: docType,
        source_type: "upload",
        storage_path: path,
        original_filename: file.name,
        mime_type: file.type || null,
        extraction_status: "pending",
      })
      .select("id")
      .single();
    if (insErr || !docRow) {
      // Roll back the storage object so we don't orphan files when the DB
      // insert fails (e.g., CHECK constraint violation on doc_type).
      await supabase.storage.from("curriculum-documents").remove([path]).catch(() => {});
      throw new Error(`Couldn't save ${file.name} record: ${insErr?.message ?? "no row"}`);
    }
    return docRow.id;
  }

  async function onSubmit() {
    if (!primary || busy) return;
    setBusy(true);
    setErrors([]);
    let createdCurriculumId = null;
    try {
      if (!org?.id) throw new Error("Couldn't find your organization. Try signing out and back in.");

      // 1. Create the curriculum row (status='draft', name=filename minus ext)
      const placeholderName = primary.name.replace(/\.[^.]+$/, "").slice(0, 200);
      const { data: curRow, error: curErr } = await supabase
        .from("curricula")
        .insert({
          organization_id: org.id,
          name: placeholderName,
          status: "draft",
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      if (curErr || !curRow) throw new Error(`Couldn't create the curriculum: ${curErr?.message ?? "no row"}`);
      createdCurriculumId = curRow.id;

      // 2. Upload primary + optional secondaries. doc_type values must match
      //    the curriculum_documents_doc_type_check constraint:
      //    instructor_guide | materials_list | student_materials | other.
      const primaryDocId = await uploadOne({
        file: primary,
        docType: "instructor_guide",
        curriculumId: curRow.id,
        organizationId: org.id,
      });
      if (materials) {
        await uploadOne({ file: materials, docType: "materials_list", curriculumId: curRow.id, organizationId: org.id });
      }
      if (journal) {
        await uploadOne({ file: journal, docType: "student_materials", curriculumId: curRow.id, organizationId: org.id });
      }

      // 3. Persist optional Drive URL (not extracted in Chunk 2)
      if (driveUrl.trim()) {
        await supabase.from("curriculum_documents").insert({
          curriculum_id: curRow.id,
          organization_id: org.id,
          doc_type: "instructor_guide",
          source_type: "drive_link",
          drive_url: driveUrl.trim(),
          extraction_status: "pending",
        });
      }

      // 4. Kick off the edge function (background; returns immediately)
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sign in expired. Reload and try again.");

      const resp = await fetch(`${API_BASE}/extract-curriculum-details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ document_id: primaryDocId }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Couldn't start extraction (${resp.status}).`);
      }

      // 5. Route to Step 2
      navigate(`/admin/curricula/${curRow.id}/extracting`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErrors([{ zone: "submit", message }]);
      setBusy(false);
    }
  }

  const submitDisabled = !primary || busy;
  const primaryErr = errors.find((e) => e.zone === "primary")?.message;
  const materialsErr = errors.find((e) => e.zone === "materials")?.message;
  const journalErr = errors.find((e) => e.zone === "journal")?.message;
  const submitErr = errors.find((e) => e.zone === "submit")?.message;

  return (
    <div>
      <div style={crumbs}>
        <Link to="/admin/curricula" style={crumbLink}>Curricula</Link>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>New</span>
      </div>

      <h1 style={{ margin: 0, color: PLUM, fontSize: 26, fontWeight: 700 }}>
        Add a curriculum to your library
      </h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5 }}>
        One doc sets up the whole thing — your registration page, marketing flyer, parent emails, and instructor portal — without you re-typing a thing.
      </p>

      {/* Unlock panel */}
      <div style={unlockPanel}>
        <div style={unlockTitle}>What this one doc sets up for you</div>
        <ul style={unlockList}>
          {UNLOCK_ITEMS.map((item, i) => (
            <li key={i} style={{ margin: "2px 0" }}>
              <strong style={{ color: PLUM, fontWeight: 600 }}>{item.strong}</strong>
              {item.rest}
            </li>
          ))}
        </ul>
        <div style={unlockReassure}>
          Your doc doesn't need to be perfect — if anything's missing (like the age range), we'll ask you a couple of quick questions on the next screen.
        </div>
      </div>

      {/* Title-match warning */}
      <div style={titleWarning}>
        <strong style={{ color: PLUM }}>One thing before you upload:</strong>{" "}
        the curriculum title in your doc becomes the public name parents see — on your registration page, flyers, emails, all of it. Make sure it matches the class offering name you market. You'll get to edit on the next screen.
      </div>

      {/* Main panel */}
      <div style={panel}>
        {/* Primary drop zone */}
        <div
          ref={primaryRef}
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.setAttribute("data-drag", "1"); }}
          onDragLeave={(e) => e.currentTarget.removeAttribute("data-drag")}
          onDrop={handleDrop("primary")}
          onClick={() => !busy && document.getElementById("primary-input")?.click()}
          style={primary ? dropFilled : dropEmpty}
        >
          <input
            id="primary-input"
            type="file"
            accept=".pdf,.docx,.txt,.md,.xlsx"
            style={{ display: "none" }}
            onChange={(e) => pickFile("primary", e.target.files?.[0])}
          />
          {primary ? (
            <div style={{ display: "flex", gap: 14, alignItems: "center", width: "100%" }}>
              <div style={filePill}>
                <span style={{ color: PLUM, fontSize: 18 }}>📄</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: INK }}>{primary.name}</div>
                  <div style={{ color: MUTED, fontSize: 12 }}>{(primary.size / 1024 / 1024).toFixed(2)} MB · curriculum guide</div>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPrimary(null); }}
                disabled={busy}
                style={replaceBtn}
              >
                Replace
              </button>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 32, color: PLUM, marginBottom: 10 }}>⬆</div>
              <div style={{ fontWeight: 600, color: INK, fontSize: 16 }}>Drop your curriculum doc here</div>
              <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>or click to browse</div>
            </>
          )}
        </div>
        <div style={filetypes}>.pdf · .docx · .xlsx · .txt · .md &nbsp;·&nbsp; up to 25 MB</div>
        {primaryErr && <div style={inlineError}>{primaryErr}</div>}

        {/* Secondary zones (only when primary picked) */}
        {primary && (
          <>
            <div style={revealNote}>
              Got it. Anything else you want us to keep on file? All optional.
            </div>
            <div style={secondaryZones}>
              <SecondaryDropZone
                title="Class materials"
                hint="What the instructor brings or orders"
                file={materials}
                onPick={(f) => pickFile("materials", f)}
                onClear={() => setMaterials(null)}
                inputId="materials-input"
                refEl={materialsRef}
                onDrop={handleDrop("materials")}
                disabled={busy}
                error={materialsErr}
              />
              <SecondaryDropZone
                title="Student materials"
                hint="Worksheets or printables"
                file={journal}
                onPick={(f) => pickFile("journal", f)}
                onClear={() => setJournal(null)}
                inputId="journal-input"
                refEl={journalRef}
                onDrop={handleDrop("journal")}
                disabled={busy}
                error={journalErr}
              />
            </div>
          </>
        )}

        {/* Drive link */}
        <details style={driveSection}>
          <summary style={driveSummary}>
            <span style={{ marginRight: 8, fontSize: 11, color: PLUM }}>▸</span>
            Or link a Google Doc
          </summary>
          <div style={{ paddingTop: 14 }}>
            <input
              type="text"
              value={driveUrl}
              onChange={(e) => setDriveUrl(e.target.value)}
              placeholder="Paste a Google Doc / Drive URL"
              disabled={true}
              style={driveInput}
            />
            <div style={driveHint}>
              <strong style={{ color: INK }}>Coming soon:</strong> Drive import is the next thing we're building. For now, please upload a file.
            </div>
          </div>
        </details>

        {submitErr && <div style={{ ...inlineError, marginTop: 16 }}>{submitErr}</div>}

        <div style={ctaRow}>
          <div style={{ color: MUTED, fontSize: 13 }}>
            {primary
              ? "Takes 30–45 seconds. You'll review everything we found before it goes live."
              : "Drop a file and we'll get started."}
          </div>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            style={submitDisabled ? primaryBtnDisabled : primaryBtn}
          >
            {busy ? "Starting…" : "Extract curriculum →"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SecondaryDropZone({ title, hint, file, onPick, onClear, inputId, refEl, onDrop, disabled, error }) {
  return (
    <div>
      <div
        ref={refEl}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.setAttribute("data-drag", "1"); }}
        onDragLeave={(e) => e.currentTarget.removeAttribute("data-drag")}
        onDrop={onDrop}
        onClick={() => !disabled && document.getElementById(inputId)?.click()}
        style={file ? dropSmallFilled : dropSmall}
      >
        <input
          id={inputId}
          type="file"
          accept=".pdf,.docx,.txt,.md,.xlsx"
          style={{ display: "none" }}
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        {file ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {file.name}
              </div>
              <div style={{ color: MUTED, fontSize: 11 }}>{(file.size / 1024 / 1024).toFixed(2)} MB</div>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              disabled={disabled}
              style={{ ...replaceBtn, padding: "3px 8px", fontSize: 11 }}
            >
              Clear
            </button>
          </div>
        ) : (
          <>
            <div style={{ fontWeight: 600, color: INK, fontSize: 13 }}>
              {title} <span style={{ color: MUTED, fontWeight: 500 }}>(optional)</span>
            </div>
            <div style={{ color: MUTED, fontSize: 11, marginTop: 4 }}>{hint}</div>
          </>
        )}
      </div>
      {error && <div style={{ ...inlineError, marginTop: 8, fontSize: 12 }}>{error}</div>}
    </div>
  );
}

// --- styles ---

const crumbs = { fontSize: 13, color: MUTED, marginBottom: 8 };
const crumbLink = { color: MUTED, textDecoration: "none" };

const unlockPanel = {
  background: "rgba(207, 177, 47, 0.10)",
  borderLeft: `3px solid ${GOLD}`,
  borderRadius: 4,
  padding: "16px 18px",
  margin: "0 0 18px",
};
const unlockTitle = {
  fontWeight: 700,
  color: PLUM,
  fontSize: 13,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 8,
};
const unlockList = {
  margin: 0,
  paddingLeft: 18,
  lineHeight: 1.6,
  fontSize: 13.5,
  color: INK,
};
const unlockReassure = {
  marginTop: 10,
  paddingTop: 10,
  borderTop: "1px dashed rgba(207, 177, 47, 0.4)",
  fontSize: 13,
  color: INK,
  lineHeight: 1.5,
  fontStyle: "italic",
};

const titleWarning = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderLeft: `3px solid ${PLUM}`,
  borderRadius: 4,
  padding: "12px 14px",
  margin: "0 0 22px",
  fontSize: 13,
  lineHeight: 1.5,
  color: INK,
};

const panel = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: 22,
};

const dropBase = {
  border: `2px dashed ${RULE}`,
  borderRadius: 8,
  textAlign: "center",
  background: CHALK,
  cursor: "pointer",
  transition: "border-color 0.15s, background 0.15s",
};
const dropEmpty = { ...dropBase, padding: "44px 24px" };
const dropFilled = {
  ...dropBase,
  background: "#faf8f0",
  borderStyle: "solid",
  borderColor: GOLD,
  padding: 22,
  textAlign: "left",
  cursor: "default",
  display: "flex",
  alignItems: "center",
};

const filePill = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  background: "#fff",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  flex: 1,
};

const replaceBtn = {
  marginLeft: "auto",
  fontSize: 12,
  color: PLUM,
  background: "transparent",
  border: `1px solid ${PLUM}`,
  borderRadius: 5,
  padding: "5px 10px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
};

const filetypes = { textAlign: "center", color: MUTED, fontSize: 12, marginTop: 10 };

const revealNote = {
  background: "rgba(207, 177, 47, 0.15)",
  borderLeft: `3px solid ${GOLD}`,
  padding: "10px 14px",
  borderRadius: 4,
  fontSize: 13,
  color: "#5c4400",
  marginTop: 16,
};

const secondaryZones = {
  marginTop: 14,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};
const dropSmall = { ...dropBase, padding: 18 };
const dropSmallFilled = {
  ...dropBase,
  background: "#faf8f0",
  borderStyle: "solid",
  borderColor: GOLD,
  padding: 14,
  textAlign: "left",
  cursor: "default",
};

const driveSection = {
  marginTop: 20,
  borderTop: `1px solid ${RULE}`,
  paddingTop: 16,
};
const driveSummary = {
  cursor: "pointer",
  color: PLUM,
  fontWeight: 600,
  fontSize: 14,
  listStyle: "none",
  userSelect: "none",
};
const driveInput = {
  width: "100%",
  padding: "10px 12px",
  border: `1px solid ${RULE}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 14,
  color: INK,
  background: "#f5f4ec",
};
const driveHint = { fontSize: 12, color: MUTED, marginTop: 8 };

const ctaRow = {
  marginTop: 24,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  paddingTop: 18,
  borderTop: `1px solid ${RULE}`,
};

const primaryBtn = {
  padding: "11px 20px",
  background: PLUM,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
const primaryBtnDisabled = { ...primaryBtn, background: "#c8c4b7", cursor: "not-allowed" };

const inlineError = {
  marginTop: 10,
  padding: "8px 12px",
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  fontSize: 13,
};
