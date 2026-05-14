// /admin/dev/extraction-test
// Dogfooding surface for the extract-program-details edge function.
// Drop a curriculum doc, watch live status, see the JSON, run again to compare.
//
// Platform-admin only — AdminLayout already gates on org_members; we add a
// second platform_admins check here so other accepted org members can't reach
// this dev tool.

import { useEffect, useRef, useState } from "react";
import { supabase, API_BASE } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const PROMPT_VERSION_OPTIONS = ["v1"];

export default function ExtractionTest() {
  const [adminCheck, setAdminCheck] = useState("loading"); // loading | denied | ok
  const [file, setFile] = useState(null);
  const [promptVersion, setPromptVersion] = useState("v1");
  const [running, setRunning] = useState(false);
  const [statusMessages, setStatusMessages] = useState([]);
  const [result, setResult] = useState(null); // { extracted, raw, parse_error, prompt_version, file_name, ran_at }
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]); // last 2 completed runs, newest first
  const dropRef = useRef(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        setAdminCheck("denied");
        return;
      }
      const { data: adminRow } = await supabase
        .from("platform_admins")
        .select("auth_user_id")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      setAdminCheck(adminRow ? "ok" : "denied");
    })();
  }, []);

  function onPickFile(f) {
    if (!f) return;
    setFile(f);
    setResult(null);
    setError("");
    setStatusMessages([]);
  }

  function onDrop(e) {
    e.preventDefault();
    dropRef.current?.removeAttribute("data-drag");
    const f = e.dataTransfer.files?.[0];
    onPickFile(f);
  }

  async function runExtraction() {
    if (!file || running) return;
    setRunning(true);
    setError("");
    setStatusMessages([]);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sign in expired. Reload and try again.");

      // Upload to Storage
      const path = `${session.user.id}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage
        .from("program-documents")
        .upload(path, file, { upsert: false });
      if (upErr) throw new Error(`Upload failed: ${upErr.message}`);

      // Fetch SSE stream
      const resp = await fetch(`${API_BASE}/extract-program-details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ document_path: path, prompt_version: promptVersion }),
      });

      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Function call failed (${resp.status})`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalEvent = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE chunks are split by blank lines
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const block of events) {
          const lines = block.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload = null;
          try { payload = JSON.parse(data); } catch { /* ignore */ }
          if (event === "status" && payload?.message) {
            setStatusMessages((prev) => [...prev, payload.message]);
          } else if (event === "done") {
            finalEvent = payload;
          } else if (event === "error") {
            throw new Error(payload?.message || "Extraction failed");
          }
        }
      }

      if (!finalEvent) throw new Error("Stream closed without a result.");

      const run = {
        ...finalEvent,
        file_name: file.name,
        ran_at: new Date().toLocaleTimeString(),
      };
      setResult(run);
      setHistory((prev) => [run, ...prev].slice(0, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  if (adminCheck === "loading") {
    return <div style={{ color: MUTED, padding: 24 }}>Checking platform-admin access…</div>;
  }
  if (adminCheck === "denied") {
    return (
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 520 }}>
        <h2 style={{ marginTop: 0, color: PLUM }}>Platform admin only</h2>
        <p style={{ color: INK, fontSize: 14 }}>
          This dev surface is restricted to platform admins. Org-level admin access alone is not enough.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, color: PLUM, fontSize: 26, fontWeight: 700 }}>Extraction Test</h1>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
          Drop a curriculum doc and run the AI extraction. Results live in memory — refresh to clear.
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Left: input panel */}
        <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 18 }}>
          <div
            ref={dropRef}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.setAttribute("data-drag", "1"); }}
            onDragLeave={(e) => e.currentTarget.removeAttribute("data-drag")}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${RULE}`,
              borderRadius: 6,
              padding: 28,
              textAlign: "center",
              background: CHALK,
              cursor: "pointer",
            }}
            onClick={() => document.getElementById("extraction-file-input")?.click()}
          >
            <input
              id="extraction-file-input"
              type="file"
              accept=".pdf,.docx,.txt,.md,.xlsx"
              style={{ display: "none" }}
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
            {file ? (
              <div>
                <div style={{ fontWeight: 600, color: INK }}>{file.name}</div>
                <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                  {(file.size / 1024).toFixed(1)} KB · click to pick a different file
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontWeight: 600, color: INK }}>Drop a curriculum doc here</div>
                <div style={{ color: MUTED, fontSize: 12, marginTop: 4 }}>
                  .pdf · .docx · .xlsx · .txt · .md (or click to browse)
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ fontSize: 13, color: MUTED }}>Prompt version</label>
            <select
              value={promptVersion}
              onChange={(e) => setPromptVersion(e.target.value)}
              style={{
                padding: "6px 8px", border: `1px solid ${RULE}`, borderRadius: 4,
                fontFamily: "inherit", fontSize: 13, background: "#fff", color: INK,
              }}
            >
              {PROMPT_VERSION_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <button
            onClick={runExtraction}
            disabled={!file || running}
            style={{
              marginTop: 16,
              width: "100%",
              padding: "10px 14px",
              background: !file || running ? "#c8c4b7" : PLUM,
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 600,
              cursor: !file || running ? "default" : "pointer",
            }}
          >
            {running ? "Running…" : "Run extraction"}
          </button>

          {error && (
            <div style={{ marginTop: 14, padding: 10, background: "#fff5f5", border: "1px solid #f0c4c4", color: "#7a1a1a", borderRadius: 4, fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>

        {/* Right: live status + result */}
        <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 18, minHeight: 360 }}>
          <div style={{ fontWeight: 600, color: INK, marginBottom: 10 }}>Status</div>
          {statusMessages.length === 0 && !result && (
            <div style={{ color: MUTED, fontSize: 13 }}>Waiting for a run…</div>
          )}
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {statusMessages.map((m, i) => (
              <li key={i} style={{ color: i === statusMessages.length - 1 && running ? PLUM : INK, fontSize: 13, padding: "3px 0" }}>
                {i === statusMessages.length - 1 && running ? "→ " : "✓ "}{m}
              </li>
            ))}
          </ul>

          {result && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontWeight: 600, color: INK }}>
                  Extracted JSON
                  <span style={{ marginLeft: 8, color: MUTED, fontSize: 12, fontWeight: 400 }}>
                    {result.prompt_version} · {result.ran_at}
                  </span>
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(JSON.stringify(result.extracted, null, 2))}
                  style={{ padding: "5px 10px", fontSize: 12, background: GOLD, color: INK, border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                >
                  Copy JSON
                </button>
              </div>
              {result.parse_error && (
                <div style={{ padding: 8, background: "#fff8e8", border: "1px solid #e7d18a", color: "#6b4a00", borderRadius: 4, fontSize: 12, marginBottom: 8 }}>
                  Parse warning: {result.parse_error}. Showing raw output below.
                </div>
              )}
              <pre style={preStyle}>
                {result.extracted
                  ? JSON.stringify(result.extracted, null, 2)
                  : result.raw}
              </pre>
            </div>
          )}
        </div>
      </div>

      {history.length === 2 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontWeight: 600, color: PLUM, fontSize: 16, marginBottom: 10 }}>Compare last 2 runs</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {history.map((run, i) => (
              <div key={i} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, color: MUTED, fontSize: 12 }}>
                  <span><strong style={{ color: INK }}>{run.file_name}</strong></span>
                  <span>{run.prompt_version} · {run.ran_at}</span>
                </div>
                <pre style={{ ...preStyle, maxHeight: 360 }}>
                  {run.extracted ? JSON.stringify(run.extracted, null, 2) : run.raw}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const preStyle = {
  background: "#fafaf5",
  border: `1px solid ${RULE}`,
  borderRadius: 4,
  padding: 12,
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: INK,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 480,
  overflow: "auto",
  margin: 0,
};
