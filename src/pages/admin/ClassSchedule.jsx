// ClassSchedule — the recurring weekly class schedule surface.
//
// Why this exists: instructor scheduling + "what's happening" comms need to know
// which class meets when. J2S builds that from term-based `programs`, but a
// membership provider (e.g. a chess club) has no term/registration — just a
// weekly schedule. `class_schedule` is that membership-friendly backbone, and
// this page is where an operator loads it from a spreadsheet.
//
// Upload flow mirrors ContactsTab (the proven CSV column-map + review pattern):
//   1. pick a .csv / .xlsx  → parse client-side (SheetJS, already a dep)
//   2. column-mapping preview — auto-guess header → field, operator confirms
//   3. review the mapped rows (which will import / which get skipped + why)
//   4. choose replace vs add-to
//   5. commit → supabase.functions.invoke("import-class-schedule")
//      (server normalizes day/time, org-stamps, inserts)
//   6. success summary + refreshed list
//
// Org comes from useOutletContext — never hardcoded. Copy is tenant-neutral.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, WARN } from "./marketing/tokens.jsx";
import ClassScheduleView from "./ClassScheduleView.jsx";

const CREAM = "#FBFBFB";
const RED = "#b53737";

// Fields we can pull out of a schedule spreadsheet → columns on class_schedule.
// Only `title` + `day_of_week` are required (the server rejects rows missing
// either). Everything else is optional.
const SCHEDULE_FIELDS = [
  { key: "title", label: "Class name", required: true,
    aliases: ["title", "class", "classname", "name", "program", "session", "course", "activity", "offering"] },
  { key: "day_of_week", label: "Day", required: true,
    aliases: ["day", "dayofweek", "weekday", "days"] },
  { key: "start_time", label: "Start time",
    aliases: ["start", "starttime", "begin", "begins", "from", "time", "startsat"] },
  { key: "end_time", label: "End time",
    aliases: ["end", "endtime", "finish", "until", "to", "endsat", "stop"] },
  { key: "location_text", label: "Location",
    aliases: ["location", "place", "venue", "site", "room", "where", "address", "facility"] },
  { key: "instructor_name", label: "Instructor",
    aliases: ["instructor", "teacher", "coach", "staff", "lead", "instructorname", "teachername"] },
  { key: "instructor_email", label: "Instructor email",
    aliases: ["instructoremail", "teacheremail", "coachemail", "email", "staffemail"] },
  { key: "age_min", label: "Age/grade min",
    aliases: ["agemin", "minage", "gradmin", "grademin", "mingrade", "minimumage", "fromage"] },
  { key: "age_max", label: "Age/grade max",
    aliases: ["agemax", "maxage", "gradmax", "grademax", "maxgrade", "maximumage", "toage"] },
  { key: "capacity", label: "Capacity",
    aliases: ["capacity", "cap", "max", "maxcapacity", "seats", "spots", "size", "classsize"] },
  { key: "notes", label: "Notes",
    aliases: ["notes", "note", "description", "details", "comment", "comments", "info"] },
];

// Day recognizer — kept in lockstep with the server's normalizeDay so the client
// can show an accurate "will import" count + flag rows that will be skipped. The
// server remains the source of truth for the actual normalized value written.
const DAY_ALIASES = {
  sun: 1, sunday: 1, su: 1, mon: 1, monday: 1, mo: 1, tue: 1, tues: 1, tuesday: 1, tu: 1,
  wed: 1, weds: 1, wednesday: 1, we: 1, thu: 1, thur: 1, thurs: 1, thursday: 1, th: 1,
  fri: 1, friday: 1, fr: 1, sat: 1, saturday: 1, sa: 1,
};
function dayRecognized(v) {
  const raw = (v ?? "").toString().trim().toLowerCase().replace(/\.+$/, "");
  return !!DAY_ALIASES[raw];
}

function normHeader(h) {
  return (h ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Auto-map CSV headers to our fields. Longest alias that appears as a substring
// of the normalized header wins; falls back to exact equality. Mirrors ContactsTab.
function autoMapColumns(headers) {
  const map = {};
  const norm = headers.map(normHeader);
  const claimed = new Set();
  for (const def of SCHEDULE_FIELDS) {
    const aliases = [...def.aliases].sort((a, b) => b.length - a.length);
    let pickIdx = -1;
    for (const alias of aliases) {
      const a = normHeader(alias);
      const exact = norm.findIndex((h, i) => h === a && !claimed.has(headers[i]));
      if (exact !== -1) { pickIdx = exact; break; }
      const sub = norm.findIndex((h, i) => h.includes(a) && !claimed.has(headers[i]));
      if (sub !== -1) { pickIdx = sub; break; }
    }
    if (pickIdx !== -1) {
      map[def.key] = headers[pickIdx];
      claimed.add(headers[pickIdx]);
    }
  }
  return map;
}

// Tiny CSV parser — quoted fields, escaped quotes (""), CRLF/LF. Mirrors ContactsTab/Rosters.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0].map((h) => (h ?? "").toString());
  const data = rows.slice(1).filter((r) => r.some((c) => c !== ""));
  return { headers, data };
}

// Read a File into base64 (no data-URL prefix) for the extraction edge fn.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error || new Error("Could not read that file."));
    r.readAsDataURL(file);
  });
}

// Turn the confirmed column mapping into schedule-row objects for the edge fn.
function buildRows(headers, rows, mapping) {
  const idx = {};
  for (const f of SCHEDULE_FIELDS) idx[f.key] = mapping[f.key] ? headers.indexOf(mapping[f.key]) : -1;
  const at = (row, key) => (idx[key] >= 0 ? (row[idx[key]] ?? "").toString().trim() : "");
  return rows.map((row) => {
    const o = {};
    for (const f of SCHEDULE_FIELDS) o[f.key] = at(row, f.key) || null;
    return o;
  });
}

export default function ClassSchedule() {
  const { org } = useOutletContext() ?? {};
  const [count, setCount] = useState(null); // null = loading
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setCount(null);
      const { count: n } = await supabase
        .from("class_schedule")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      if (!cancelled) setCount(n ?? 0);
    })();
    return () => { cancelled = true; };
  }, [org?.id, refreshKey]);

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 32px" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>Class schedule</h1>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0 }}>
          Your weekly classes — which class meets on which day and time. Upload your
          schedule and we&apos;ll build it here. Assign coaches to each class under{" "}
          <Link to="/admin/schedule" style={{ color: BRIGHT, fontWeight: 600 }}>Instructors → Schedule</Link>;
          this also powers your &ldquo;what&apos;s happening this week&rdquo; messages.
        </p>
      </header>

      <div style={{
        display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between",
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 18, marginBottom: 18, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Classes on your schedule
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, color: INK, lineHeight: 1.1, marginTop: 2 }}>
            {count === null ? "—" : count.toLocaleString()}
          </div>
        </div>
        <button type="button" onClick={() => setUploading(true)}
          style={{ padding: "10px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
          Upload schedule →
        </button>
      </div>

      {/* Read-only here; assignment lives in Instructors → Schedule. */}
      <ClassScheduleView orgId={org?.id} assignable={false} refreshKey={refreshKey} />

      {uploading && org?.id && (
        <UploadModal
          orgId={org.id}
          onClose={() => setUploading(false)}
          onImported={() => { setUploading(false); setRefreshKey((k) => k + 1); }}
        />
      )}
    </div>
  );
}

// ─── Upload modal ───────────────────────────────────────────────────────────

function UploadModal({ orgId, onClose, onImported }) {
  const [step, setStep] = useState("pick"); // pick | parsing | extracting | mapping | committing | done
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [sourceKind, setSourceKind] = useState("csv"); // csv (spreadsheet) | doc (PDF/Word via AI)
  const [rawHeaders, setRawHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [extractedRows, setExtractedRows] = useState([]); // rows Claude pulled from a PDF/Word doc
  const [mode, setMode] = useState("replace"); // replace | append
  const [result, setResult] = useState(null);

  // Dispatch on file type: a spreadsheet is parsed + column-mapped client-side
  // (no AI); a PDF/Word/text doc goes to the extraction fn (Claude), which
  // returns rows already in our field shape — then both share the review step.
  function startParse() {
    setError("");
    if (!file) { setError("Pick a file first."); return; }
    const name = (file.name || "").toLowerCase();
    const isSpreadsheet = name.endsWith(".csv") || name.endsWith(".xlsx") || name.endsWith(".xls")
      || /spreadsheetml|ms-excel|text\/csv/.test(file.type || "");
    if (isSpreadsheet) { startSpreadsheet(name); return; }
    if (/\.(pdf|docx?|txt|md)$/.test(name)) { startExtract(); return; }
    setError("Upload a spreadsheet (CSV/Excel), a PDF, or a Word doc.");
  }

  async function startSpreadsheet(name) {
    setSourceKind("csv");
    setStep("parsing");
    try {
      const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls") || /spreadsheetml|ms-excel/.test(file.type || "");
      let headers = [];
      let data = [];
      if (isExcel) {
        const buf = await file.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) throw new Error("no-sheet");
        const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
        headers = (aoa[0] || []).map((c) => (c == null ? "" : String(c)));
        data = aoa.slice(1).map((row) => row.map((c) => (c == null ? "" : String(c)))).filter((row) => row.some((c) => c.trim() !== ""));
      } else {
        const text = await file.text();
        const parsed = parseCsv(text);
        headers = parsed.headers;
        data = parsed.data;
      }
      if (headers.length === 0 || data.length === 0) {
        setError("That file didn't have any rows we could read.");
        setStep("pick");
        return;
      }
      setRawHeaders(headers);
      setRawRows(data);
      setMapping(autoMapColumns(headers));
      setStep("mapping");
    } catch (e) {
      console.error("[ClassSchedule] parse failed", e);
      setError("Couldn't read that file. Try saving it as a CSV and uploading that.");
      setStep("pick");
    }
  }

  async function startExtract() {
    setSourceKind("doc");
    setStep("extracting");
    try {
      const file_base64 = await fileToBase64(file);
      const { data, error: fnErr } = await supabase.functions.invoke("extract-schedule-details", {
        body: { organization_id: orgId, filename: file.name, file_base64 },
      });
      if (fnErr) {
        let msg = fnErr.message ?? "We couldn't read that file.";
        try {
          const resp = fnErr?.context?.response ?? fnErr?.context;
          if (resp && typeof resp.clone === "function") {
            const text = await resp.clone().text();
            try { const p = JSON.parse(text); if (p?.error) msg = p.error; } catch { /* not JSON */ }
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      if (rows.length === 0) {
        setError("We couldn't find any classes in that document. Try a spreadsheet, or check the file.");
        setStep("pick");
        return;
      }
      setExtractedRows(rows);
      setStep("mapping");
    } catch (e) {
      console.error("[ClassSchedule] extract failed", e);
      setError(e.message ?? "We couldn't read that file.");
      setStep("pick");
    }
  }

  const built = useMemo(() => {
    if (step !== "mapping") return [];
    return sourceKind === "doc" ? extractedRows : buildRows(rawHeaders, rawRows, mapping);
  }, [step, sourceKind, extractedRows, rawHeaders, rawRows, mapping]);
  // A row imports only if it has a title AND a recognizable day (server rule).
  const importable = useMemo(
    () => built.filter((r) => (r.title ?? "").toString().trim() && dayRecognized(r.day_of_week)),
    [built],
  );

  async function commit() {
    setError("");
    if (sourceKind === "csv" && !mapping.title) { setError("Map the Class name column first."); return; }
    if (sourceKind === "csv" && !mapping.day_of_week) { setError("Map the Day column first."); return; }
    if (importable.length === 0) { setError("No rows have both a class name and a recognizable day."); return; }
    setStep("committing");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("import-class-schedule", {
        body: { organization_id: orgId, rows: built, source: sourceKind === "doc" ? "upload_doc" : "upload_csv", mode },
      });
      if (fnErr) {
        let msg = fnErr.message ?? "Import failed.";
        try {
          const resp = fnErr?.context?.response ?? fnErr?.context;
          if (resp && typeof resp.clone === "function") {
            const text = await resp.clone().text();
            try { const p = JSON.parse(text); if (p?.error) msg = p.error; } catch { /* not JSON */ }
          }
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      setResult(data ?? { inserted: 0, skipped: 0 });
      setStep("done");
    } catch (e) {
      console.error("[ClassSchedule] import failed", e);
      setError(e.message ?? "Import failed.");
      setStep("mapping");
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "4vh 16px", zIndex: 200, fontFamily: "inherit" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, maxWidth: 820, width: "100%", padding: 24, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>Upload schedule</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
              {step === "pick" && "Upload your schedule — a spreadsheet, a PDF, or a Word doc. We'll pull out your classes either way."}
              {step === "parsing" && "Reading your file…"}
              {step === "extracting" && "Reading your schedule with AI…"}
              {step === "mapping" && (sourceKind === "doc" ? "Review what we pulled from your document before saving." : "Confirm which column is which, then review before saving.")}
              {step === "committing" && "Building your schedule…"}
              {step === "done" && "Done."}
            </p>
          </div>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", lineHeight: 1 }} aria-label="Close">✕</button>
        </div>

        {error && <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {step === "pick" && (
          <div>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: INK, lineHeight: 1.55 }}>
              Send your schedule however you keep it — a <strong>spreadsheet</strong> (Google Sheets,
              Excel, CSV) reads instantly, and a <strong>PDF or Word doc</strong> works too (we read it
              with AI). At minimum we need a <strong>class name</strong> and a <strong>day</strong>;
              time, location, instructor, and ages are optional. You&apos;ll review before anything saves.
            </p>
            <label htmlFor="schedule-upload-file" style={{ display: "block", fontSize: 12.5, color: MUTED, marginBottom: 6 }}>Choose your file:</label>
            <input id="schedule-upload-file" type="file"
              accept=".csv,.xlsx,.xls,.pdf,.docx,.doc,.txt,.md,text/csv,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 13, marginBottom: 10 }} />
            {file && <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>Selected: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
              <button type="button" onClick={onClose} style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>Cancel</button>
              <button type="button" onClick={startParse} style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>Read file →</button>
            </div>
          </div>
        )}

        {(step === "parsing" || step === "committing") && (
          <div style={{ padding: "40px 0", textAlign: "center", color: MUTED, fontSize: 14 }}>
            {step === "parsing" ? "Reading your file…" : "Building your schedule…"}
          </div>
        )}

        {step === "extracting" && <ExtractingStep />}

        {step === "mapping" && (
          <MappingStep
            isDoc={sourceKind === "doc"}
            headers={rawHeaders} rows={rawRows} mapping={mapping} setMapping={setMapping}
            built={built} importable={importable} mode={mode} setMode={setMode}
            onBack={() => setStep("pick")} onCommit={commit}
          />
        )}

        {step === "done" && result && <DoneStep result={result} onClose={onImported} />}
      </div>
    </div>
  );
}

function ExtractingStep() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ padding: "36px 0", textAlign: "center" }}>
      <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 10 }}>📄→🗓️</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: INK }}>Reading your schedule with AI…</div>
      <div style={{ fontSize: 13, color: MUTED, marginTop: 6 }}>
        Pulling out your classes, days, and times. Usually about 10–20 seconds.
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
        Elapsed: <strong>{elapsed}s</strong>
      </div>
    </div>
  );
}

function MappingStep({ isDoc, headers, rows, mapping, setMapping, built, importable, mode, setMode, onBack, onCommit }) {
  const titleMapped = !!mapping.title;
  const dayMapped = !!mapping.day_of_week;
  const ready = isDoc ? built.length > 0 : (titleMapped && dayMapped);
  const preview = built.slice(0, 12);
  const mappedFields = isDoc
    ? SCHEDULE_FIELDS.filter((f) => built.some((r) => (r[f.key] ?? "") !== ""))
    : SCHEDULE_FIELDS.filter((f) => mapping[f.key]);
  const canSave = ready && importable.length > 0;

  return (
    <div>
      {isDoc ? (
        <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, lineHeight: 1.5 }}>
          We pulled <strong>{built.length}</strong> class{built.length === 1 ? "" : "es"} from your document.
          Give it a quick look — AI can miss or mis-read things. We&apos;ll tidy up day &amp; time
          formatting when you save.
        </div>
      ) : (
        <>
          <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, lineHeight: 1.5 }}>
            Read <strong>{rows.length}</strong> row{rows.length === 1 ? "" : "s"}. Confirm which column is which —
            we guessed where we could. <strong>Class name</strong> and <strong>Day</strong> are required; we&apos;ll
            tidy up day &amp; time formatting when you save.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {SCHEDULE_FIELDS.map((def) => (
              <div key={def.key} style={{ padding: "4px 2px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 2 }}>
                  {def.label}{def.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
                </div>
                <select value={mapping[def.key] || ""} onChange={(e) => setMapping({ ...mapping, [def.key]: e.target.value || undefined })}
                  style={{ width: "100%", padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit", background: "#fff", color: INK }}>
                  <option value="">— not in this file —</option>
                  {headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>Preview (first {preview.length})</div>
        <div style={{ fontSize: 12, color: importable.length > 0 ? OK : WARN, fontWeight: 600 }}>
          {importable.length.toLocaleString()} of {built.length.toLocaleString()} row{built.length === 1 ? "" : "s"} will import
        </div>
      </div>

      {!ready ? (
        <div style={{ background: `${WARN}1A`, color: WARN, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 6 }}>
          Map <strong>Class name</strong> and <strong>Day</strong> to see a preview.
        </div>
      ) : (
        <>
          <div style={{ border: `1px solid ${RULE}`, borderRadius: 6, marginBottom: 6, maxHeight: 280, overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  {mappedFields.map((f) => (
                    <th key={f.key} style={{ position: "sticky", top: 0, background: CREAM, textAlign: "left", padding: "6px 10px", color: MUTED, fontWeight: 700, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap", borderBottom: `1px solid ${RULE}` }}>
                      {f.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, i) => {
                  const willImport = (r.title ?? "").toString().trim() && dayRecognized(r.day_of_week);
                  return (
                    <tr key={i} style={{ background: willImport ? "#fff" : `${RED}0D` }}>
                      {mappedFields.map((f) => {
                        const val = r[f.key] ?? "";
                        const badDay = f.key === "day_of_week" && val && !dayRecognized(val);
                        return (
                          <td key={f.key} style={{ padding: "6px 10px", borderBottom: `1px solid ${RULE}`, whiteSpace: "nowrap", color: INK, verticalAlign: "top" }}>
                            {f.key === "title" ? (
                              <span><strong>{val || "(no name)"}</strong>{!val && <span style={{ color: RED, fontSize: 11 }}> · skipped</span>}</span>
                            ) : badDay ? (
                              <span style={{ color: RED }}>{val} · unreadable</span>
                            ) : (
                              val || <span style={{ color: MUTED }}>—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ margin: "0 0 14px", fontSize: 11.5, color: MUTED }}>
            Showing the first {preview.length} of {built.length.toLocaleString()} row{built.length === 1 ? "" : "s"}. Rows without a class name or a readable day are skipped — <strong>{importable.length.toLocaleString()}</strong> will import.
          </p>
        </>
      )}

      <div style={{ background: `${PURPLE}06`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: INK, marginBottom: 6 }}>When I save this…</div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6, cursor: "pointer", fontSize: 13, color: INK }}>
          <input type="radio" name="import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} style={{ marginTop: 2 }} />
          <span><strong>Replace</strong> my uploaded schedule with this file <span style={{ color: MUTED }}>(recommended — use when this is your updated schedule)</span></span>
        </label>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontSize: 13, color: INK }}>
          <input type="radio" name="import-mode" checked={mode === "append"} onChange={() => setMode("append")} style={{ marginTop: 2 }} />
          <span><strong>Add</strong> these classes to what&apos;s already there</span>
        </label>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button type="button" onClick={onBack} style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>← Back</button>
        <button type="button" onClick={onCommit} disabled={!canSave}
          style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.5 }}>
          {mode === "replace" ? "Replace with" : "Add"} {importable.length.toLocaleString()} class{importable.length === 1 ? "" : "es"}
        </button>
      </div>
    </div>
  );
}

function DoneStep({ result, onClose }) {
  const inserted = result.inserted ?? 0;
  const skipped = result.skipped ?? 0;
  return (
    <div>
      <div style={{ textAlign: "center", padding: "8px 0 14px" }}>
        <div style={{ fontSize: 40, lineHeight: 1 }}>🗓️</div>
        <h3 style={{ margin: "8px 0 2px", fontSize: 18, fontWeight: 800, color: PURPLE }}>Your schedule is built.</h3>
        <p style={{ margin: 0, fontSize: 13, color: MUTED }}>
          {inserted} class{inserted === 1 ? "" : "es"} added
          {skipped > 0 && ` · ${skipped} skipped (no name or unreadable day)`}
        </p>
      </div>
      <div style={{ marginTop: 8, background: `${PURPLE}0A`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 14 }}>
        <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: PURPLE }}>What this unlocks</p>
        <p style={{ margin: 0, fontSize: 13, color: INK, lineHeight: 1.6 }}>
          Your weekly classes are in one place now — the backbone for assigning instructors
          and for &ldquo;what&apos;s happening this week&rdquo; messages to families.
        </p>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" onClick={onClose} style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>Done</button>
      </div>
    </div>
  );
}
