// ContactsTab — the Family Comms contact list surface.
//
// Why this exists: campaigns build their Q2 audience from `marketing_recipients`.
// A brand-new tenant has 0 rows there, so they can't send anything until they
// load their list. This tab shows the current contact count and an
// upload flow that writes into marketing_recipients via the import-contacts
// edge fn (service-role, but org-gated + org-stamped per row).
//
// Upload flow:
//   1. pick a .csv (or .xlsx) → parse client-side (SheetJS, already a dep)
//   2. column-mapping preview — auto-guess header → field, operator confirms
//   3. preview first ~10 mapped rows + valid-email count
//   4. required consent checkbox ("I have permission to email these contacts")
//   5. commit → supabase.functions.invoke("import-contacts")
//   6. show result (inserted / updated / skipped / invalid) + refresh count
//
// Org comes from useOutletContext — never hardcoded. Copy is tenant-neutral.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, WARN } from "../marketing/tokens.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";

const CREAM = "#FBFBFB";
const RED = "#b53737";

// Fields we can pull out of a contact CSV → columns on marketing_recipients.
// `email` is the only required one — nothing sends without it.
const CONTACT_FIELDS = [
  { key: "email", label: "Email", required: true,
    aliases: ["email", "emailaddress", "email_address", "e-mail", "mail", "parentemail", "guardianemail"] },
  { key: "parent_name", label: "Parent / guardian name",
    aliases: ["parentname", "guardianname", "parent", "guardian", "name", "fullname", "contactname", "familyname"] },
  { key: "phone", label: "Phone",
    aliases: ["phone", "phonenumber", "tel", "telephone", "mobile", "cell", "cellphone", "contactphone"] },
  { key: "child_first_name", label: "Child first name",
    aliases: ["childfirstname", "studentfirstname", "childfirst", "firstname", "kidfirstname", "childname"] },
  { key: "child_last_name", label: "Child last name",
    aliases: ["childlastname", "studentlastname", "childlast", "lastname", "surname"] },
  { key: "school_name", label: "School",
    aliases: ["schoolname", "school", "site", "sitename", "campus"] },
  { key: "city", label: "City",
    aliases: ["city", "town", "municipality"] },
  { key: "state", label: "State",
    aliases: ["state", "province", "region"] },
  { key: "zip", label: "ZIP / postal code",
    aliases: ["zip", "zipcode", "postalcode", "postcode", "zip_code"] },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normHeader(h) {
  return (h ?? "").toString().toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Auto-map CSV headers to our fields. Longest alias that appears as a substring
// of the normalized header wins; falls back to exact equality. Mirrors the
// deterministic mapping in the partner importer.
function autoMapColumns(headers) {
  const map = {};
  const norm = headers.map(normHeader);
  const claimed = new Set();
  for (const def of CONTACT_FIELDS) {
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

// Tiny CSV parser — handles quoted fields with embedded commas, escaped quotes
// (""), and CRLF/LF endings. Mirrors the one in Rosters.jsx. Excel files go
// through SheetJS instead (dynamic import, keeps it out of the main bundle).
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
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  if (rows.length === 0) return { headers: [], data: [] };
  const headers = rows[0].map((h) => (h ?? "").toString());
  const data = rows.slice(1).filter((r) => r.some((c) => c !== ""));
  return { headers, data };
}

// Turn the confirmed column mapping into contact objects the edge fn accepts.
function buildContacts(headers, rows, mapping) {
  const idx = {};
  for (const f of CONTACT_FIELDS) idx[f.key] = mapping[f.key] ? headers.indexOf(mapping[f.key]) : -1;
  const at = (row, key) => (idx[key] >= 0 ? (row[idx[key]] ?? "").toString().trim() : "");
  const out = [];
  for (const row of rows) {
    const email = at(row, "email");
    // Keep every row for the preview/count; the edge fn does the final
    // validity gate. We surface the valid-email count so the operator sees it.
    out.push({
      email,
      parent_name: at(row, "parent_name") || null,
      phone: at(row, "phone") || null,
      child_first_name: at(row, "child_first_name") || null,
      child_last_name: at(row, "child_last_name") || null,
      school_name: at(row, "school_name") || null,
      city: at(row, "city") || null,
      state: at(row, "state") || null,
      zip: at(row, "zip") || null,
    });
  }
  return out;
}

export default function ContactsTab() {
  const { org } = useOutletContext() ?? {};

  const [count, setCount] = useState(null); // null = loading
  const [countErr, setCountErr] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setCount(null);
      setCountErr(null);
      const { count: n, error } = await supabase
        .from("marketing_recipients")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      if (cancelled) return;
      if (error) { setCountErr(error.message); setCount(0); return; }
      setCount(n ?? 0);
    })();
    return () => { cancelled = true; };
  }, [org?.id, refreshKey]);

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 32px" }}>
      <FamilyCommsTabs active="contacts" />

      <header style={{ marginBottom: 24 }}>
        <h1 style={{ color: INK, fontSize: 26, fontWeight: 800, margin: "0 0 8px" }}>
          Contacts
        </h1>
        <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.55, margin: 0 }}>
          This is the list your campaigns send to. Upload your families&apos; email
          addresses here so you can start sending. You choose who receives each
          campaign when you build it.
        </p>
      </header>

      <div style={{
        display: "flex", gap: 16, alignItems: "center", justifyContent: "space-between",
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12,
        padding: 18, marginBottom: 18, flexWrap: "wrap",
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Contacts on your list
          </div>
          <div style={{ fontSize: 32, fontWeight: 700, color: INK, lineHeight: 1.1, marginTop: 2 }}>
            {count === null ? "—" : count.toLocaleString()}
          </div>
          {countErr && (
            <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>Couldn&apos;t load your count. Refresh and try again.</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setUploading(true)}
          style={{
            padding: "10px 16px", background: BRIGHT, color: "#fff", border: "none",
            borderRadius: 6, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
          }}
        >
          Upload contacts →
        </button>
      </div>

      {count === 0 && !countErr && (
        <div style={{ border: `1px dashed ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center", color: MUTED }}>
          <p style={{ margin: "0 0 4px", color: INK, fontWeight: 600 }}>No contacts yet</p>
          <p style={{ margin: 0, fontSize: 13 }}>
            Upload a CSV of your families to build your list — then you can send your first campaign.
          </p>
        </div>
      )}

      {uploading && org?.id && (
        <UploadModal
          orgId={org.id}
          onClose={() => setUploading(false)}
          onImported={() => {
            setUploading(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

// ─── Upload modal ───────────────────────────────────────────────────────────

function UploadModal({ orgId, onClose, onImported }) {
  const [step, setStep] = useState("pick"); // pick | parsing | mapping | committing | done
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [rawHeaders, setRawHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [consent, setConsent] = useState(false);
  const [result, setResult] = useState(null);

  async function startParse() {
    setError("");
    if (!file) { setError("Pick a file first."); return; }
    setStep("parsing");
    try {
      const name = (file.name || "").toLowerCase();
      const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls")
        || /spreadsheetml|ms-excel/.test(file.type || "");

      let headers = [];
      let data = [];
      if (isExcel) {
        // SheetJS is dynamically imported so it only loads when someone
        // actually uploads a spreadsheet (keeps it out of the main bundle).
        const buf = await file.arrayBuffer();
        const XLSX = await import("xlsx");
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) throw new Error("no-sheet");
        const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
        headers = (aoa[0] || []).map((c) => (c == null ? "" : String(c)));
        data = aoa.slice(1)
          .map((row) => row.map((c) => (c == null ? "" : String(c))))
          .filter((row) => row.some((c) => c.trim() !== ""));
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
      console.error("[ContactsTab] parse failed", e);
      setError("Couldn't read that file. Try saving it as a CSV and uploading that.");
      setStep("pick");
    }
  }

  const contacts = useMemo(
    () => (step === "mapping" ? buildContacts(rawHeaders, rawRows, mapping) : []),
    [step, rawHeaders, rawRows, mapping],
  );
  const validEmailCount = useMemo(
    () => contacts.filter((c) => EMAIL_RE.test((c.email ?? "").trim().toLowerCase())).length,
    [contacts],
  );

  async function commit() {
    setError("");
    if (!mapping.email) { setError("Map the Email column first — nothing sends without it."); return; }
    if (validEmailCount === 0) { setError("None of these rows have a valid email address."); return; }
    if (!consent) { setError("Please confirm you have permission to email these contacts."); return; }
    setStep("committing");
    try {
      // Only send rows with a usable email. The edge fn re-validates + dedupes,
      // but trimming here keeps the payload lean.
      const payload = contacts.filter((c) => EMAIL_RE.test((c.email ?? "").trim().toLowerCase()));
      const { data, error: fnErr } = await supabase.functions.invoke("import-contacts", {
        body: { organization_id: orgId, contacts: payload, source: "manual" },
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
      setResult(data ?? { inserted: 0, updated: 0, skipped: 0, invalid: 0 });
      setStep("done");
    } catch (e) {
      console.error("[ContactsTab] import failed", e);
      setError(e.message ?? "Import failed.");
      setStep("mapping");
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "4vh 16px", zIndex: 200, fontFamily: "inherit",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff", borderRadius: 12, maxWidth: 760, width: "100%",
          padding: 24, maxHeight: "92vh", overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: INK }}>Upload contacts</h2>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
              {step === "pick" && "Upload a CSV of your families. Your column names don't have to match ours — we'll figure them out."}
              {step === "parsing" && "Reading your file…"}
              {step === "mapping" && "Confirm which column is which, then review before saving."}
              {step === "committing" && "Saving to your list…"}
              {step === "done" && "Done."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 18, cursor: "pointer", lineHeight: 1 }}
            aria-label="Close"
          >✕</button>
        </div>

        {error && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {step === "pick" && (
          <div>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: INK, lineHeight: 1.55 }}>
              Add your families&apos; contact info in one go. Upload a spreadsheet from
              <strong> Google Sheets, Excel, or a CSV</strong>. At minimum we need an
              <strong> email</strong> column — everything else is optional. You&apos;ll review
              the mapping before anything saves.
            </p>
            <label
              htmlFor="contacts-upload-file"
              style={{ display: "block", fontSize: 12.5, color: MUTED, marginBottom: 6 }}
            >Choose your file:</label>
            <input
              id="contacts-upload-file"
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              style={{ fontSize: 13, marginBottom: 10 }}
            />
            {file && (
              <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                Selected: <strong>{file.name}</strong> ({Math.round(file.size / 1024)} KB)
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
              <button
                type="button"
                onClick={onClose}
                style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
              >Cancel</button>
              <button
                type="button"
                onClick={startParse}
                style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
              >Read file →</button>
            </div>
          </div>
        )}

        {step === "parsing" && (
          <div style={{ padding: "40px 0", textAlign: "center", color: MUTED, fontSize: 14 }}>
            Reading your file…
          </div>
        )}

        {step === "mapping" && (
          <MappingStep
            headers={rawHeaders}
            rows={rawRows}
            mapping={mapping}
            setMapping={setMapping}
            contacts={contacts}
            validEmailCount={validEmailCount}
            consent={consent}
            setConsent={setConsent}
            onBack={() => setStep("pick")}
            onCommit={commit}
          />
        )}

        {step === "committing" && (
          <div style={{ padding: "40px 0", textAlign: "center", color: MUTED, fontSize: 14 }}>
            Saving to your list…
          </div>
        )}

        {step === "done" && result && (
          <DoneStep result={result} onClose={onImported} />
        )}
      </div>
    </div>
  );
}

function MappingStep({ headers, rows, mapping, setMapping, contacts, validEmailCount, consent, setConsent, onBack, onCommit }) {
  const emailMapped = !!mapping.email;
  const preview = contacts.slice(0, 10);
  const canSave = emailMapped && validEmailCount > 0 && consent;

  return (
    <div>
      <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13, color: INK, lineHeight: 1.5 }}>
        Read <strong>{rows.length}</strong> row{rows.length === 1 ? "" : "s"}. Confirm which column is which —
        we guessed where we could. Only <strong>Email</strong> is required.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
        {CONTACT_FIELDS.map((def) => (
          <div key={def.key} style={{ padding: "4px 2px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 2 }}>
              {def.label}{def.required && <span style={{ color: RED, marginLeft: 3 }}>*</span>}
            </div>
            <select
              value={mapping[def.key] || ""}
              onChange={(e) => setMapping({ ...mapping, [def.key]: e.target.value || undefined })}
              style={{ width: "100%", padding: "5px 8px", border: `1px solid ${RULE}`, borderRadius: 4, fontSize: 12, fontFamily: "inherit", background: "#fff", color: INK }}
            >
              <option value="">— not in this file —</option>
              {headers.map((h, i) => <option key={i} value={h}>{h}</option>)}
            </select>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
          Preview (first {preview.length})
        </div>
        <div style={{ fontSize: 12, color: validEmailCount > 0 ? OK : WARN, fontWeight: 600 }}>
          {validEmailCount.toLocaleString()} of {contacts.length.toLocaleString()} row{contacts.length === 1 ? "" : "s"} have a valid email
        </div>
      </div>

      {!emailMapped ? (
        <div style={{ background: `${WARN}1A`, color: WARN, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 14 }}>
          Pick the column that holds email addresses to see a preview.
        </div>
      ) : (
        <div style={{ background: CREAM, padding: 10, borderRadius: 6, marginBottom: 14, maxHeight: 220, overflow: "auto" }}>
          {preview.map((c, i) => {
            const valid = EMAIL_RE.test((c.email ?? "").trim().toLowerCase());
            return (
              <div key={i} style={{ fontSize: 12, color: INK, padding: "4px 0", borderBottom: i < preview.length - 1 ? `1px dashed ${RULE}` : "none" }}>
                <strong style={{ color: valid ? INK : RED }}>{c.email || "(no email)"}</strong>
                {!valid && <span style={{ color: RED, fontSize: 11 }}> · will be skipped</span>}
                {c.parent_name && <span style={{ color: MUTED }}> · {c.parent_name}</span>}
                {c.school_name && <span style={{ color: MUTED }}> · {c.school_name}</span>}
              </div>
            );
          })}
        </div>
      )}

      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, background: `${PURPLE}06`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 12, marginBottom: 14, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span style={{ fontSize: 13, color: INK, lineHeight: 1.5 }}>
          I have permission to email these contacts.
        </span>
      </label>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}
        >← Back</button>
        <button
          type="button"
          onClick={onCommit}
          disabled={!canSave}
          style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.5 }}
        >Add {validEmailCount.toLocaleString()} contact{validEmailCount === 1 ? "" : "s"}</button>
      </div>
    </div>
  );
}

function DoneStep({ result, onClose }) {
  const inserted = result.inserted ?? 0;
  const updated = result.updated ?? 0;
  const invalid = result.invalid ?? 0;
  return (
    <div>
      <div style={{ textAlign: "center", padding: "8px 0 14px" }}>
        <div style={{ fontSize: 40, lineHeight: 1 }}>🎉</div>
        <h3 style={{ margin: "8px 0 2px", fontSize: 18, fontWeight: 800, color: PURPLE }}>Your list is updated.</h3>
        <p style={{ margin: 0, fontSize: 13, color: MUTED }}>
          {inserted} new contact{inserted === 1 ? "" : "s"} added
          {updated > 0 && ` · ${updated} updated`}
          {invalid > 0 && ` · ${invalid} skipped (no valid email)`}
        </p>
      </div>

      <div style={{ marginTop: 8, background: `${PURPLE}0A`, border: `1px solid ${PURPLE}22`, borderRadius: 8, padding: 14 }}>
        <p style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 700, color: PURPLE }}>What this unlocks</p>
        <p style={{ margin: 0, fontSize: 13, color: INK, lineHeight: 1.6 }}>
          Your contacts are on your list now, so you can <strong>build a campaign</strong> and
          reach these families. You&apos;ll pick who receives each campaign when you set it up.
        </p>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ padding: "8px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}
        >Done</button>
      </div>
    </div>
  );
}
