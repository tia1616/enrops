// /admin/instructor-documents — write the documents your instructors read and
// sign during onboarding.
//
// WHY THIS EXISTS. Until now nothing in the product could write legal_documents:
// the table was SELECT-only for org members and writable only by platform
// admins, so one provider's seven documents had been seeded by a migration and
// every other provider had none. Their instructors reached the agreement and
// policy steps of onboarding and found them empty. This is the missing surface.
//
// APPEND-ONLY, AND THAT IS THE POINT. Publishing writes a NEW row; nothing here
// updates or deletes an existing one, and the database enforces that (the
// org-admin policy grants INSERT only). A published version can therefore never
// change under someone who already read it — two people who both signed "v1"
// are guaranteed to have read the same words. get-legal-document treats the
// most recently created row for (org, key) as the live one, so publishing is
// exactly an insert and needs no edit to the old row.
//
// Version strings are generated, never typed. Asking a non-technical operator to
// invent "v2.0_2026-06-15" is the same jargon problem as making them type
// markdown; the screen says "Version 2".
//
// Owner/admin only. Enforced by RLS (can_admin_org) and by the route sitting in
// the Settings gate's match list — a hidden link is not a gate.
//
// Body text is PLAIN TEXT, not HTML. Every reader (Screen4/5/6 and the portal's
// documents drawer) splits on blank lines and renders through linkifyText, which
// only linkifies http(s) and is React-escaped. So there is no markup to sanitize
// and no injection surface — do not add dangerouslySetInnerHTML here.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import {
  INSTRUCTOR_DOCUMENTS,
  DOCUMENT_KEYS,
  nextVersionFor,
} from "../../lib/instructorDocuments.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";
const AMBER_INK = "#a16207";
const RED = "#b53737";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

// Today's date in the PROVIDER's timezone, not UTC.
//
// Caught at runtime, not by reading: publishing at 5:15pm Pacific stamped
// effective_from as tomorrow, because `new Date().toISOString().slice(0,10)` is
// a UTC date and Pacific is 7-8 hours behind. Anything published after ~4pm
// local carried the wrong effective date — on a legal document, where the date
// is the whole point of the field. Same bug class as the open UTC-date item on
// the backlog (attendance "today"), so this is one more instance, not a new one.
//
// en-CA because it formats as YYYY-MM-DD, which is what a Postgres date wants.
// Falls back to UTC if the org has no timezone or the runtime rejects it —
// wrong by hours at worst, versus throwing during a publish.
function todayForOrg(timezone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || undefined,
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export default function InstructorDocuments() {
  const { org } = useOutletContext();
  const [rows, setRows] = useState(null); // all legal_documents for this org
  const [loadError, setLoadError] = useState("");
  const [openKey, setOpenKey] = useState(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    if (!org?.id) return;
    setLoadError("");
    const { data, error } = await supabase
      .from("legal_documents")
      .select("id, document_key, document_version, title, body_text, effective_from, created_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError("Couldn't load your documents. Refresh and try again.");
      setRows([]);
      return;
    }
    setRows(data ?? []);
  }, [org?.id]);

  useEffect(() => { load(); }, [load]);

  // Newest row per key IS the live one — same rule get-legal-document applies
  // (most recently created wins), so this screen cannot disagree with what an
  // instructor actually sees.
  const liveByKey = useMemo(() => {
    const out = {};
    for (const r of rows ?? []) {
      if (!out[r.document_key]) out[r.document_key] = r; // rows are created_at desc
    }
    return out;
  }, [rows]);

  const versionsByKey = useMemo(() => {
    const out = {};
    for (const r of rows ?? []) (out[r.document_key] ??= []).push(r);
    return out;
  }, [rows]);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 4000); }

  if (rows === null) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  if (openKey) {
    return (
      <DocumentEditor
        orgId={org?.id}
        orgTimezone={org?.timezone}
        docKey={openKey}
        live={liveByKey[openKey] ?? null}
        versions={versionsByKey[openKey] ?? []}
        onBack={() => setOpenKey(null)}
        onPublished={async (label) => {
          await load();
          setOpenKey(null);
          flash(`${label} published. Instructors will see this version from now on.`);
        }}
      />
    );
  }

  const writtenCount = DOCUMENT_KEYS.filter((k) => liveByKey[k]).length;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>
        Instructor documents
      </h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.55, maxWidth: 580 }}>
        What your instructors read and sign when they join. Each one starts as a draft you
        rewrite in your own words — they are prompts, not finished policies.
      </p>

      {writtenCount === 0 && (
        <div style={{ background: "#fbfaf6", border: `1px solid ${RULE}`, borderRadius: 10, padding: "12px 14px", fontSize: 13.5, color: INK, lineHeight: 1.55, marginBottom: 16 }}>
          <strong>Start with the contractor agreement.</strong> It is the one instructors
          actually sign, and onboarding cannot be completed until it exists.
        </div>
      )}

      {toast && (
        <div role="status" style={{ background: GREEN_BG, color: GREEN_INK, border: `1px solid ${GREEN_INK}33`, borderRadius: 8, padding: "10px 12px", fontSize: 13.5, marginBottom: 14 }}>
          {toast}
        </div>
      )}
      {loadError && (
        <div role="alert" style={{ color: RED, fontSize: 13.5, marginBottom: 14 }}>{loadError}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {INSTRUCTOR_DOCUMENTS.map((d) => {
          const live = liveByKey[d.key];
          const count = (versionsByKey[d.key] ?? []).length;
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => setOpenKey(d.key)}
              style={{
                display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
                padding: "14px 16px", fontFamily: "inherit",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>{d.label}</span>
                {d.signed && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: PURPLE, background: `${PURPLE}0F`, borderRadius: 999, padding: "2px 8px" }}>
                    Signed
                  </span>
                )}
                <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: live ? GREEN_INK : AMBER_INK }}>
                  {live ? `Version ${count} · ${fmtDate(live.created_at)}` : "Not written yet"}
                </span>
              </div>
              <p style={{ margin: "5px 0 0", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>{d.help}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DocumentEditor({ orgId, orgTimezone, docKey, live, versions, onBack, onPublished }) {
  const meta = INSTRUCTOR_DOCUMENTS.find((d) => d.key === docKey);
  const [title, setTitle] = useState(live?.title ?? meta?.label ?? "");
  const [body, setBody] = useState(live?.body_text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nextVersion = nextVersionFor(versions.map((v) => v.document_version));
  const versionNumber = versions.length + 1;

  // Dirty against what is LIVE. A first draft is dirty as soon as it has text.
  const dirty =
    title.trim() !== (live?.title ?? "").trim() ||
    body.trim() !== (live?.body_text ?? "").trim();
  const canPublish = title.trim().length > 0 && body.trim().length > 0 && dirty && !busy;

  async function publish() {
    if (!canPublish) return;
    setBusy(true);
    setError("");
    const { error: e } = await supabase.from("legal_documents").insert({
      organization_id: orgId,
      document_key: docKey,
      document_version: nextVersion,
      title: title.trim(),
      body_text: body.trim(),
      effective_from: todayForOrg(orgTimezone),
    });
    setBusy(false);
    if (e) {
      // 23505 = the UNIQUE(org, key, version) constraint. Means another tab (or
      // another admin) published while this form was open, so our computed
      // version is stale. Say so plainly rather than "something went wrong".
      setError(
        e.code === "23505"
          ? "Someone published a new version of this document while you had it open. Go back, reopen it, and apply your changes to the newer version."
          : "Couldn't publish this document. Try again, or check you're signed in as an owner or admin."
      );
      return;
    }
    onPublished(meta?.label ?? "Document");
  }

  const inputStyle = {
    width: "100%", padding: "10px 12px", border: `1px solid ${RULE}`, borderRadius: 8,
    fontSize: 14, fontFamily: "inherit", color: INK, background: "#fff", boxSizing: "border-box",
  };

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 0 40px" }}>
      <button
        type="button"
        onClick={onBack}
        style={{ background: "transparent", border: "none", color: MUTED, fontSize: 13, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
      >
        ← All documents
      </button>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>{meta?.label}</h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.55, maxWidth: 580 }}>{meta?.help}</p>

      {live ? (
        <div style={{ background: "#fbfaf6", border: `1px solid ${RULE}`, borderRadius: 10, padding: "11px 13px", fontSize: 13, color: INK, lineHeight: 1.55, margin: "14px 0" }}>
          Instructors currently see <strong>version {versions.length}</strong>, published{" "}
          {fmtDate(live.created_at)}. Publishing again creates <strong>version {versionNumber}</strong> and
          shows that to everyone from then on. <strong>Earlier versions are kept</strong>, and anyone who
          already signed keeps the exact wording they agreed to.
        </div>
      ) : (
        <div style={{ background: "#fbfaf6", border: `1px solid ${RULE}`, borderRadius: 10, padding: "11px 13px", fontSize: 13, color: INK, lineHeight: 1.55, margin: "14px 0" }}>
          {/* Points at the BUTTON, not at "the draft below". The box starts
              empty and the draft only appears once Start from a draft is
              pressed, so the old wording described something that was not on
              screen — the same untrue-pointer bug fixed twice elsewhere today.
              Only visible in the empty state, which is exactly the state a
              provider setting up for the first time is in. */}
          Nothing published yet, so your instructors see an empty step. Press{" "}
          <strong>Start from a draft</strong> below for a skeleton in square brackets, then replace
          every bracket with your own wording.{" "}
          {meta?.signed && "This is the one they sign, so it is worth a careful read."}
        </div>
      )}

      <label style={{ display: "block", fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 5 }}>
        Title
      </label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
      <p style={{ margin: "5px 0 16px", fontSize: 11.5, color: MUTED }}>
        The heading instructors see above this document.
      </p>

      <label style={{ display: "block", fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 5 }}>
        The document
      </label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={22}
        placeholder="Write the document here, or start from the draft below."
        style={{ ...inputStyle, lineHeight: 1.6, resize: "vertical", fontSize: 13.5 }}
      />
      <p style={{ margin: "5px 0 0", fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
        Leave a blank line to start a new paragraph. Web addresses become clickable on their own.
      </p>

      {!body.trim() && meta?.starter && (
        <button
          type="button"
          onClick={() => setBody(meta.starter)}
          style={{
            marginTop: 10, background: "#fff", border: `1px solid ${BRIGHT}`, color: BRIGHT,
            borderRadius: 999, padding: "8px 16px", fontSize: 13, fontWeight: 600,
            fontFamily: "inherit", cursor: "pointer",
          }}
        >
          Start from a draft
        </button>
      )}

      {error && (
        <div role="alert" style={{ color: RED, fontSize: 13.5, marginTop: 14, lineHeight: 1.5 }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18 }}>
        <button
          type="button"
          onClick={publish}
          disabled={!canPublish}
          style={{
            background: canPublish ? BRIGHT : "#cfc6dc", color: "#fff", border: "none",
            borderRadius: 999, padding: "10px 22px", fontSize: 14, fontWeight: 700,
            fontFamily: "inherit", cursor: canPublish ? "pointer" : "not-allowed",
          }}
        >
          {busy ? "Publishing…" : live ? `Publish version ${versionNumber}` : "Publish"}
        </button>
        <span style={{ fontSize: 12, color: MUTED }}>
          {!dirty && live
            ? "No changes yet."
            : !title.trim() || !body.trim()
              ? "Add a title and some words to publish."
              : "Your instructors see this as soon as you publish."}
        </span>
      </div>

      {versions.length > 0 && (
        <div style={{ marginTop: 26, borderTop: `1px solid ${RULE}`, paddingTop: 14 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 8 }}>
            Earlier versions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {versions.map((v, i) => (
              <div key={v.id} style={{ fontSize: 13, color: MUTED }}>
                Version {versions.length - i} · {fmtDate(v.created_at)}
                {i === 0 && <span style={{ color: GREEN_INK, fontWeight: 600 }}> · live now</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
