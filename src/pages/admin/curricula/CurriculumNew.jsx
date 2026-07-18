// /admin/curricula/new
// Step 1 of the upload-first onboarding flow. Provider drops their curriculum
// doc (and optional class/student materials), clicks "Extract curriculum",
// we create draft DB rows + storage objects + kick off the extract edge
// function, then route to the live status page (Step 2).
//
// Multi-tenant: every row writes organization_id from the outlet-context org.
// Storage paths start with org_id so the bucket RLS allows the insert.

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams, Link } from "react-router-dom";
import { supabase, API_BASE } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const LAVENDER = "#F2F0FF";                      // matches sidebar (Figma)
const INDIGO_SOFT = "rgba(88, 71, 201, 0.07)";   // soft indigo tint for highlight panels

const ALLOWED_EXTS = ["pdf", "docx", "txt", "md", "xlsx"];
const MAX_BYTES = 25 * 1024 * 1024;

const GOOGLE_OAUTH_CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

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
  const [searchParams] = useSearchParams();
  // Attach-to-existing mode: when ?attach_to=<curriculum_id> is set, we skip
  // creating a new curricula row and instead create curriculum_documents rows
  // tied to the existing curriculum. Used for backfilled drafts (no doc yet)
  // that the operator wants to populate via extraction.
  const attachToId = searchParams.get("attach_to") || "";
  const [attachTarget, setAttachTarget] = useState(null); // { id, name, organization_id } or null
  // When attaching to a curriculum that already has sessions or approved
  // fields, uploading a new doc will replace them (delete-then-reinsert in
  // the edge function). Surface a warning + confirm checkbox before submit.
  const [attachExistingWork, setAttachExistingWork] = useState(null); // { sessions, approvedFields } or null
  const [confirmedReplace, setConfirmedReplace] = useState(false);

  const [primary, setPrimary] = useState(null);
  const [materials, setMaterials] = useState(null);
  const [journal, setJournal] = useState(null);
  const [driveUrl, setDriveUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const [errors, setErrors] = useState([]); // [{ zone, message }]
  // Connection check for the Drive section. null = unchecked, false = not
  // connected (show "Connect in Settings" CTA), true = connected.
  const [driveConnected, setDriveConnected] = useState(null);
  const [driveConnectedEmail, setDriveConnectedEmail] = useState(null);
  const primaryRef = useRef(null);
  const materialsRef = useRef(null);
  const journalRef = useRef(null);

  // Load the attach target on mount (if any). If the curriculum doesn't exist
  // or belongs to a different org, show an error rather than silently dropping
  // into the new-curriculum flow.
  useEffect(() => {
    if (!attachToId || !org?.id) return;
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from("curricula")
        .select("id, name, organization_id, status")
        .eq("id", attachToId)
        .maybeSingle();
      if (!mounted) return;
      if (error || !data) {
        setErrors([{ zone: "attach", message: `Couldn't load that curriculum: ${error?.message ?? "not found"}` }]);
        return;
      }
      if (data.organization_id !== org.id) {
        setErrors([{ zone: "attach", message: "That curriculum belongs to a different organization." }]);
        return;
      }
      setAttachTarget(data);

      // Detect existing work that an attach-mode extraction will overwrite.
      const [{ count: sessCount }, { count: approvedCount }] = await Promise.all([
        supabase
          .from("curriculum_sessions")
          .select("id", { count: "exact", head: true })
          .eq("curriculum_id", data.id),
        supabase
          .from("curriculum_extracted_fields")
          .select("id", { count: "exact", head: true })
          .eq("curriculum_id", data.id)
          .eq("human_approved", true),
      ]);
      if (!mounted) return;
      if ((sessCount ?? 0) > 0 || (approvedCount ?? 0) > 0) {
        setAttachExistingWork({ sessions: sessCount ?? 0, approvedFields: approvedCount ?? 0 });
      }
    })();
    return () => { mounted = false; };
  }, [attachToId, org?.id]);

  // Check if this org has Google Drive connected. Used to gate the Drive
  // section's CTA — if not connected, we show "Connect Google Drive" inline.
  // Re-runs when the user returns from /auth/google/callback with ?google=connected
  // (the param is stripped after we react to it).
  const [driveConnectToast, setDriveConnectToast] = useState(null); // 'connected' | 'error' | null
  const [driveConnectError, setDriveConnectError] = useState(null);
  useEffect(() => {
    const googleStatus = searchParams.get("google");
    if (googleStatus === "connected") {
      setDriveConnectToast("connected");
    } else if (googleStatus === "error") {
      setDriveConnectToast("error");
      setDriveConnectError(searchParams.get("error_message") || "Connection failed");
    }
    if (googleStatus) {
      // Strip the query so refresh doesn't re-fire the toast.
      const url = new URL(window.location.href);
      url.searchParams.delete("google");
      url.searchParams.delete("error_message");
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("organization_google_tokens")
        .select("google_email")
        .eq("organization_id", org.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      setDriveConnected(!!data);
      setDriveConnectedEmail(data?.google_email ?? null);
    })();
    return () => { cancelled = true; };
  }, [org?.id, driveConnectToast]);

  // Kicks off the OAuth flow from THIS page so the user lands back here (not
  // Settings) after connecting. Same machinery as AdminSettings.startConnect
  // but stashes a `return_to` so the callback knows where to bounce.
  function startConnectFromHere() {
    if (!GOOGLE_OAUTH_CLIENT_ID) {
      setErrors([{ zone: "drive_connect", message: "Google OAuth isn't configured (missing VITE_GOOGLE_OAUTH_CLIENT_ID)." }]);
      return;
    }
    if (!org?.id) return;
    const state = crypto.randomUUID();
    const redirectUri = `${window.location.origin}/auth/google/callback`;
    sessionStorage.setItem("google_oauth_state", state);
    sessionStorage.setItem("google_oauth_org_id", org.id);
    sessionStorage.setItem("google_oauth_redirect_uri", redirectUri);
    sessionStorage.setItem("google_oauth_return_to", window.location.pathname + window.location.search);
    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ["openid", "email", GOOGLE_DRIVE_SCOPE].join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

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
    const trimmedDriveUrl = driveUrl.trim();
    const hasPrimary = !!primary;
    const hasDriveUrl = !!trimmedDriveUrl;
    if (!hasPrimary && !hasDriveUrl) return;
    if (busy) return;
    if (attachToId && !attachTarget) return; // Attach mode but target not loaded
    setBusy(true);
    setErrors([]);
    try {
      if (!org?.id) throw new Error("Couldn't find your organization. Try signing out and back in.");

      // 1. Create the curriculum row OR use the existing attach target.
      //    Attach mode skips the insert so we don't duplicate the row that the
      //    operator is uploading docs into.
      let curriculumId;
      if (attachTarget) {
        curriculumId = attachTarget.id;
      } else {
        const placeholderName = hasPrimary
          ? primary.name.replace(/\.[^.]+$/, "").slice(0, 200)
          : "New curriculum"; // Replaced by extraction-derived name in step 4
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
        curriculumId = curRow.id;
      }

      // 2. Get an auth session for the edge function calls (used by both
      //    Drive-import path and upload path below).
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sign in expired. Reload and try again.");

      // 3. Pick the "primary" doc that extraction will run on. Upload mode
      //    creates it via Storage. Drive mode goes through fetch-drive-document
      //    which fetches the doc text + creates the curriculum_documents row.
      let primaryDocId;
      if (hasPrimary) {
        primaryDocId = await uploadOne({
          file: primary,
          docType: "instructor_guide",
          curriculumId,
          organizationId: org.id,
        });
      } else {
        const resp = await fetch(`${API_BASE}/fetch-drive-document`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            curriculum_id: curriculumId,
            organization_id: org.id,
            drive_url: trimmedDriveUrl,
            doc_type: "instructor_guide",
          }),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          if (json.code === "not_connected") {
            throw new Error("Google Drive isn't connected for this organization. Go to Settings → Connections and connect it first.");
          }
          throw new Error(json.error || `Couldn't fetch the Drive document (${resp.status}).`);
        }
        primaryDocId = json.document_id;
      }

      // Optional secondary uploads. NOT gated on hasPrimary: the zones are
      // always visible now, so an operator can pick materials alongside a Drive
      // link (or with no primary at all). The curriculum row exists by this
      // point in every path, so anything picked gets attached rather than
      // silently discarded.
      if (materials) {
        await uploadOne({ file: materials, docType: "materials_list", curriculumId, organizationId: org.id });
      }
      if (journal) {
        await uploadOne({ file: journal, docType: "student_materials", curriculumId, organizationId: org.id });
      }

      // If the operator both uploaded a file AND pasted a Drive link, record
      // the Drive link as a secondary (informational) document. Extraction
      // still runs on the uploaded primary.
      if (hasPrimary && hasDriveUrl) {
        await fetch(`${API_BASE}/fetch-drive-document`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            curriculum_id: curriculumId,
            organization_id: org.id,
            drive_url: trimmedDriveUrl,
            doc_type: "other",
          }),
        }).catch(() => {});
      }

      // 4. Kick off the extraction edge function (background; returns immediately)
      const resp = await fetch(`${API_BASE}/extract-curriculum-details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          document_id: primaryDocId,
          // Attach mode keeps the operator's existing curriculum name; the doc
          // is informational. New-curriculum mode lets extraction set the name.
          preserve_name: !!attachTarget,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Couldn't start extraction (${resp.status}).`);
      }

      // 5. Route to Step 2
      navigate(`/admin/curricula/${curriculumId}/extracting`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErrors([{ zone: "submit", message }]);
      setBusy(false);
    }
  }

  // Manual entry — no document required. Creates a name-only draft and routes
  // straight to the same review/edit screen extraction lands on. The operator
  // fills in what they want (or nothing but a name) and publishes. They can
  // attach a document later from the detail page to auto-fill the rest.
  async function createManual() {
    const name = manualName.trim();
    if (!name || manualBusy) return;
    if (!org?.id) {
      setErrors([{ zone: "manual", message: "Couldn't find your organization. Try signing out and back in." }]);
      return;
    }
    setManualBusy(true);
    setErrors([]);
    try {
      const { data: curRow, error: curErr } = await supabase
        .from("curricula")
        .insert({
          organization_id: org.id,
          name,
          status: "draft",
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      if (curErr || !curRow) throw new Error(`Couldn't create it: ${curErr?.message ?? "no row"}`);
      // The materials zones are always visible, so they can be filled in on the
      // manual path too. Attach whatever was picked instead of silently
      // discarding it. Non-fatal: the offering exists either way, and the
      // review screen can add documents.
      if (materials) {
        try {
          await uploadOne({ file: materials, docType: "materials_list", curriculumId: curRow.id, organizationId: org.id });
        } catch (e) {
          console.warn("Manual create: class materials upload failed:", e instanceof Error ? e.message : String(e));
        }
      }
      if (journal) {
        try {
          await uploadOne({ file: journal, docType: "student_materials", curriculumId: curRow.id, organizationId: org.id });
        } catch (e) {
          console.warn("Manual create: student materials upload failed:", e instanceof Error ? e.message : String(e));
        }
      }
      navigate(`/admin/curricula/${curRow.id}/review`);
    } catch (e) {
      setErrors([{ zone: "manual", message: e instanceof Error ? e.message : String(e) }]);
      setManualBusy(false);
    }
  }

  const manualErr = errors.find((e) => e.zone === "manual")?.message;

  const submitDisabled =
    (!primary && !driveUrl.trim()) || busy || (attachExistingWork && !confirmedReplace);
  const primaryErr = errors.find((e) => e.zone === "primary")?.message;
  const materialsErr = errors.find((e) => e.zone === "materials")?.message;
  const journalErr = errors.find((e) => e.zone === "journal")?.message;
  const submitErr = errors.find((e) => e.zone === "submit")?.message;

  return (
    <div>
      <div style={crumbs}>
        <Link to="/admin/curricula" style={crumbLink}>Offerings</Link>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        {attachTarget ? (
          <>
            <Link to={`/admin/curricula/${attachTarget.id}/review`} style={crumbLink}>{attachTarget.name}</Link>
            <span style={{ margin: "0 8px", color: MUTED }}>›</span>
            <span>Add doc</span>
          </>
        ) : (
          <span>New</span>
        )}
      </div>

      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>
        {attachTarget ? `Add a doc to ${attachTarget.name}` : "Add an offering to your library"}
      </h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5 }}>
        {attachTarget
          ? "We'll attach this doc to the existing offering and run extraction so the fields populate automatically."
          : "One doc sets up the whole thing — your registration page, marketing flyer, parent emails, and instructor portal — without you re-typing a thing."}
      </p>

      {/* Unlock panel */}
      <div style={unlockPanel}>
        <div style={unlockTitle}>What this one doc sets up for you</div>
        <ul style={unlockList}>
          {UNLOCK_ITEMS.map((item, i) => (
            <li key={i} style={{ margin: "2px 0" }}>
              <strong style={{ color: PURPLE, fontWeight: 600 }}>{item.strong}</strong>
              {item.rest}
            </li>
          ))}
        </ul>
        <div style={unlockReassure}>
          Your doc doesn't need to be perfect — if anything's missing (like the age range), we'll ask you a couple of quick questions on the next screen.
        </div>
      </div>

      {/* Attach-mode destructive-replace warning */}
      {attachExistingWork && (
        <div style={destructiveWarning}>
          <strong style={{ color: "#7a1a1a", display: "block", marginBottom: 6 }}>Heads up — this will replace existing work</strong>
          <div style={{ color: INK, fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
            "{attachTarget?.name}" already has{" "}
            {attachExistingWork.sessions > 0 && (
              <><strong>{attachExistingWork.sessions} session{attachExistingWork.sessions === 1 ? "" : "s"}</strong></>
            )}
            {attachExistingWork.sessions > 0 && attachExistingWork.approvedFields > 0 && " and "}
            {attachExistingWork.approvedFields > 0 && (
              <><strong>{attachExistingWork.approvedFields} reviewed field{attachExistingWork.approvedFields === 1 ? "" : "s"}</strong></>
            )}
            . Uploading a doc will re-extract everything and overwrite that work. The offering name will be preserved.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: INK, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={confirmedReplace}
              onChange={(e) => setConfirmedReplace(e.target.checked)}
              style={{ width: 16, height: 16 }}
            />
            I understand. Replace it.
          </label>
        </div>
      )}

      {/* Title-match warning (only for new curriculum mode -- attach mode preserves the name) */}
      {!attachTarget && (
        <div style={titleWarning}>
          <strong style={{ color: PURPLE }}>One thing before you upload:</strong>{" "}
          the offering title in your doc becomes the public name parents see — on your registration page, flyers, emails, all of it. Make sure it matches the class offering name you market. You'll get to edit on the next screen.
        </div>
      )}

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
                <span style={{ color: PURPLE, fontSize: 18 }}>📄</span>
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
              <div style={{ fontSize: 32, color: PURPLE, marginBottom: 10 }}>⬆</div>
              <div style={{ fontWeight: 600, color: INK, fontSize: 16 }}>Drop your curriculum doc here</div>
              <div style={{ color: MUTED, fontSize: 12, marginTop: 6 }}>or click to browse</div>
            </>
          )}
        </div>
        <div style={filetypes}>.pdf · .docx · .xlsx · .txt · .md &nbsp;·&nbsp; up to 25 MB</div>
        {primaryErr && <div style={inlineError}>{primaryErr}</div>}

        {/* Privacy / ownership reassurance — shown before any doc is handed over,
            covers both the file-drop and Drive-import paths. */}
        <div style={privacyNote}>
          <span style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}>🔒</span>
          <div>
            <strong style={{ color: PURPLE, fontWeight: 600 }}>Your curriculum stays 100% yours.</strong>{" "}
            Enrops never shares your lesson plans, materials, or documents with anyone, and the
            system never trains on them or reuses them for other providers. You keep full ownership
            and privacy of everything you upload.
          </div>
        </div>

        {/* Secondary zones - always visible. Operators shouldn't have to pick a
            curriculum doc first to discover they can keep materials on file.
            They attach to whichever path is taken: extraction, or the
            "Create & fill in myself" manual path below. */}
        <>
          <div style={revealNote}>
            {primary
              ? "Got it. Anything else you want us to keep on file? All optional."
              : "Anything else you want us to keep on file? All optional."}
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

        {/* Drive link */}
        <details style={driveSection} open={driveConnected === false || (!primary && !!driveUrl)}>
          <summary style={driveSummary}>
            <span style={{ marginRight: 8, fontSize: 11, color: PURPLE }}>▸</span>
            Or import from Google Drive
          </summary>
          <div style={{ paddingTop: 14 }}>
            {driveConnectToast === "connected" && (
              <div style={successPill}>
                ✓ Google Drive connected. Paste a doc link below to import.
              </div>
            )}
            {driveConnectToast === "error" && (
              <div style={errorPill}>
                Google Drive connection failed: {driveConnectError}
              </div>
            )}

            {driveConnected === false ? (
              <div style={connectCallout}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: INK, fontSize: 14, marginBottom: 4 }}>
                    Connect Google Drive to import directly
                  </div>
                  <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
                    One-time sign-in with Google. After that, paste any Drive doc link here and we'll pull the content automatically.
                  </div>
                </div>
                <button type="button" onClick={startConnectFromHere} disabled={busy} style={connectBtn}>
                  Connect Google Drive
                </button>
              </div>
            ) : driveConnected === true ? (
              <>
                <input
                  type="text"
                  value={driveUrl}
                  onChange={(e) => setDriveUrl(e.target.value)}
                  placeholder="Paste a Google Doc / Drive URL"
                  disabled={busy}
                  style={{ ...driveInput, background: busy ? "#f5f4ec" : "#fff" }}
                />
                <div style={driveHint}>
                  Connected as <strong style={{ color: INK }}>{driveConnectedEmail}</strong>. Works with Google Docs, Slides, Sheets, PDFs, and Word files in your Drive.
                </div>
              </>
            ) : (
              <div style={driveHint}>Checking connection…</div>
            )}
            {errors.find((e) => e.zone === "drive_connect") && (
              <div style={inlineError}>{errors.find((e) => e.zone === "drive_connect").message}</div>
            )}
          </div>
        </details>

        {submitErr && <div style={{ ...inlineError, marginTop: 16 }}>{submitErr}</div>}

        <div style={ctaRow}>
          <div style={{ color: MUTED, fontSize: 13 }}>
            {primary || driveUrl.trim()
              ? "Takes 30–45 seconds. You'll review everything we found before it goes live."
              : "Drop a file or paste a Drive link to get started."}
          </div>
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            style={submitDisabled ? primaryBtnDisabled : primaryBtn}
          >
            {busy ? "Starting…" : "Extract offering →"}
          </button>
        </div>
      </div>

      {/* Manual entry — no document required (upload is optional) */}
      <div style={manualPanel}>
        <div style={{ fontWeight: 700, color: PURPLE, fontSize: 15 }}>Don't have a document yet?</div>
        <div style={{ color: MUTED, fontSize: 13, margin: "6px 0 12px", lineHeight: 1.5 }}>
          No problem — name your offering and fill in the details yourself on the next screen. You can always add a document later and we'll auto-fill the rest.
        </div>
        <div style={{ color: MUTED, fontSize: 12, margin: "0 0 12px", lineHeight: 1.5 }}>
          🔒 Anything you add stays 100% yours — Enrops never shares it and never trains on it.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createManual(); }}
            placeholder="e.g. Beginner Chess Club"
            disabled={manualBusy}
            style={{ ...driveInput, background: "#fff", flex: 1, minWidth: 240 }}
          />
          <button
            type="button"
            onClick={createManual}
            disabled={!manualName.trim() || manualBusy}
            style={(!manualName.trim() || manualBusy) ? primaryBtnDisabled : primaryBtn}
          >
            {manualBusy ? "Creating…" : "Create & fill in myself →"}
          </button>
        </div>
        {manualErr && <div style={inlineError}>{manualErr}</div>}
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
  background: INDIGO_SOFT,
  borderLeft: `3px solid ${BRIGHT}`,
  borderRadius: 10,
  padding: "16px 18px",
  margin: "0 0 18px",
};
const unlockTitle = {
  fontWeight: 700,
  color: PURPLE,
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
  borderTop: `1px dashed ${RULE}`,
  fontSize: 13,
  color: INK,
  lineHeight: 1.5,
  fontStyle: "italic",
};

const titleWarning = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderLeft: `3px solid ${PURPLE}`,
  borderRadius: 4,
  padding: "12px 14px",
  margin: "0 0 22px",
  fontSize: 13,
  lineHeight: 1.5,
  color: INK,
};

const destructiveWarning = {
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  borderLeft: "3px solid #a13a3a",
  borderRadius: 4,
  padding: "12px 14px",
  margin: "0 0 22px",
};

const panel = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 12,
  padding: 22,
};
const manualPanel = { ...panel, marginTop: 16 };

const dropBase = {
  border: `2px dashed ${RULE}`,
  borderRadius: 8,
  textAlign: "center",
  background: CREAM,
  cursor: "pointer",
  transition: "border-color 0.15s, background 0.15s",
};
const dropEmpty = { ...dropBase, padding: "44px 24px" };
const dropFilled = {
  ...dropBase,
  background: LAVENDER,
  borderStyle: "solid",
  borderColor: BRIGHT,
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
  color: PURPLE,
  background: "transparent",
  border: `1px solid ${PURPLE}`,
  borderRadius: 5,
  padding: "5px 10px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontWeight: 600,
};

const filetypes = { textAlign: "center", color: MUTED, fontSize: 12, marginTop: 10 };

const privacyNote = {
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  marginTop: 16,
  padding: "12px 14px",
  background: LAVENDER,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  fontSize: 13,
  lineHeight: 1.5,
  color: INK,
};

const revealNote = {
  background: INDIGO_SOFT,
  borderLeft: `3px solid ${BRIGHT}`,
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 13,
  color: INK,
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
  background: LAVENDER,
  borderStyle: "solid",
  borderColor: BRIGHT,
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
  color: PURPLE,
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
const connectCallout = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 16px",
  background: INDIGO_SOFT,
  border: `1px solid ${RULE}`,
  borderLeft: `3px solid ${BRIGHT}`,
  borderRadius: 6,
};
const connectBtn = {
  padding: "9px 14px",
  background: BRIGHT,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};
const successPill = {
  padding: "8px 12px",
  background: "#f0f8f0",
  border: "1px solid #bfd9bf",
  color: "#2f7d32",
  borderRadius: 4,
  fontSize: 13,
  marginBottom: 12,
};
const errorPill = {
  padding: "8px 12px",
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  fontSize: 13,
  marginBottom: 12,
};

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
  background: BRIGHT,
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
