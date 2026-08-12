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
import { linkifyText } from "../../lib/linkifyText.jsx";
import {
  INSTRUCTOR_DOCUMENTS,
  DOCUMENT_KEYS,
  nextVersionFor,
  versionNumberOf,
  bodyForPublish,
  willAppendSignatureBlock,
  stripAppendedSignatureBlock,
  AGREEMENT_SIGNATURE_BLOCK,
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
// Caught at runtime: publishing at 5:15pm Pacific stamped effective_from as
// tomorrow, because `new Date().toISOString().slice(0,10)` is a UTC date and
// Pacific is 7-8 hours behind.
//
// HONEST SCOPE, because I first described this as worse than it is: NOTHING
// READS effective_from. Grepped the whole repo — the only references are this
// insert and a select that never uses the value. So the stored date is now
// correct, but no operator or instructor sees it today, and the practical
// impact of the bug was zero.
//
// The instance that DOES matter is the same mistake in
// supabase/functions/_shared/agreementTemplate.ts, which builds `signing_date`
// from getUTCDate() and renders it INTO the signed agreement text. 4 of the 22
// agreements already signed on prod carry a date one day off. That one is
// unfixed and is not mine to fix mid-change. Same class as the open backlog
// item on attendance "today".
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
  // A failed READ must never look like "you have no documents". It used to set
  // rows to [], which rendered all seven as "Not written yet" AND opened the
  // editor with live=null saying "Nothing published yet" — so an admin could
  // write a draft and publish it as v1, which (newest created_at wins) instantly
  // became the agreement every instructor signs, silently demoting the real one.
  // A transient network blip could therefore replace a signed legal document.
  // Now a failed read blocks the list entirely.
  const [loadFailed, setLoadFailed] = useState(false);
  const [openKey, setOpenKey] = useState(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    if (!org?.id) return;
    setLoadFailed(false);
    const { data, error } = await supabase
      .from("legal_documents")
      .select("id, document_key, document_version, title, body_text, created_at")
      .eq("organization_id", org.id)
      .order("created_at", { ascending: false });
    if (error) {
      // Do NOT fall through to an empty list — see the note on loadFailed.
      setLoadFailed(true);
      setRows(null);
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

  // Failed read: refuse to render the list at all. Showing seven "Not written
  // yet" rows would invite the operator to overwrite documents that do exist.
  if (loadFailed) {
    return (
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 0 40px" }}>
        <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
        <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>Instructor documents</h1>
        <div role="alert" style={{ background: "#fbfaf6", border: `1px solid ${RED}`, borderRadius: 10, padding: "14px 16px", marginTop: 14 }}>
          <p style={{ margin: 0, fontSize: 14, color: INK, lineHeight: 1.55 }}>
            <strong>We couldn&apos;t load your documents.</strong> Nothing is shown because we
            can&apos;t tell yet what you already have &mdash; and we don&apos;t want you rewriting
            something that&apos;s already there.
          </p>
          <button
            type="button"
            onClick={load}
            style={{ marginTop: 12, background: BRIGHT, color: "#fff", border: "none", borderRadius: 999, padding: "9px 18px", fontSize: 13.5, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

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

      {/* ALL of them block onboarding, not just the agreement. This banner used
          to say "start with the contractor agreement… onboarding cannot be
          completed until it exists", which reads as "that one is the blocker".
          It is not: Screens 5 and 6 fetch the other six by key and refuse to
          advance when any is missing. An operator who followed the old wording
          would publish one document, invite an instructor, and strand them. */}
      {writtenCount < DOCUMENT_KEYS.length && (
        <div style={{ background: "#fbfaf6", border: `1px solid ${RULE}`, borderRadius: 10, padding: "12px 14px", fontSize: 13.5, color: INK, lineHeight: 1.55, marginBottom: 16 }}>
          <strong>
            {writtenCount === 0
              ? "Your instructors can't finish onboarding yet."
              : `${DOCUMENT_KEYS.length - writtenCount} still to write.`}
          </strong>{" "}
          They read and sign <strong>all {DOCUMENT_KEYS.length}</strong> of these during
          onboarding, and it stops at the first one that isn&apos;t published. Start with the
          contractor agreement &mdash; it&apos;s the one they actually sign &mdash; then work down
          the list.
        </div>
      )}

      {toast && (
        <div role="status" style={{ background: GREEN_BG, color: GREEN_INK, border: `1px solid ${GREEN_INK}33`, borderRadius: 8, padding: "10px 12px", fontSize: 13.5, marginBottom: 14 }}>
          {toast}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {INSTRUCTOR_DOCUMENTS.map((d) => {
          const live = liveByKey[d.key];
          // Derived from the STORED version string, never from a row count —
          // see versionNumberOf.
          const shownVersion = live ? versionNumberOf(live.document_version) : null;
          // A ROW with an explicit button, not a giant clickable card. Two
          // reasons: WaiverManager (the closest sibling — it edits this org's
          // other legal documents) does exactly this, so a provider meets one
          // pattern rather than two; and a card that silently drops you into a
          // live textarea gives no signal that you are now editing a legal
          // document. The button also carries the right verb per state.
          return (
            <div
              key={d.key}
              style={{
                background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
                padding: "14px 16px",
                display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap",
              }}
            >
              <div style={{ flex: "1 1 320px", minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>{d.label}</span>
                  {d.signed && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: PURPLE, background: `${PURPLE}0F`, borderRadius: 999, padding: "2px 8px" }}>
                      Signed
                    </span>
                  )}
                  <span style={{ fontSize: 12, fontWeight: 600, color: live ? GREEN_INK : AMBER_INK }}>
                    {live
                      ? `${shownVersion ? `Version ${shownVersion}` : live.document_version} · ${fmtDate(live.created_at)}`
                      : "Not written yet"}
                  </span>
                </div>
                <p style={{ margin: "5px 0 0", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>{d.help}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenKey(d.key)}
                style={{
                  flexShrink: 0, marginLeft: "auto", fontFamily: "inherit", cursor: "pointer",
                  padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  ...(live
                    ? { background: "#fff", border: `1px solid ${RULE}`, color: INK }
                    : { background: BRIGHT, border: "none", color: "#fff" }),
                }}
              >
                {live ? "Edit" : "Write it"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DocumentEditor({ orgId, orgTimezone, docKey, live, versions, onBack, onPublished }) {
  const meta = INSTRUCTOR_DOCUMENTS.find((d) => d.key === docKey);
  const [title, setTitle] = useState(live?.title ?? meta?.label ?? "");
  // STRIPPED. The signature block is never in the editable box — see
  // stripAppendedSignatureBlock. Before this, it was appended once and then lived
  // in body_text, so every edit after the first put it back in the textarea where
  // a line could be deleted and never repaired.
  const [body, setBody] = useState(stripAppendedSignatureBlock(live?.body_text ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A PUBLISHED document opens read-only. You should be able to look at the
  // agreement your instructors sign without the risk of leaning on a key and
  // changing it — and pressing Edit is the moment you know you are editing a
  // legal document, which a box that is silently live never tells you. A blank
  // one opens straight in edit mode; there is nothing to read yet.
  const [editing, setEditing] = useState(!live);
  // Publishing OVER a live document is a one-click, instantly-effective change to
  // the thing instructors sign, and there is no undo beyond publishing again.
  // That is not hypothetical: during testing today a starter draft reading
  // "Test publish. [Describe what you are hiring them to do]" became the live
  // contractor agreement on staging, and stayed live until someone noticed.
  // First publish needs no ceremony — nothing is being replaced.
  const [confirming, setConfirming] = useState(false);

  const nextVersion = nextVersionFor(versions.map((v) => v.document_version));
  // Read the number OUT OF the string we are about to store, so what the screen
  // promises and what the database records are the same fact.
  const versionNumber = versionNumberOf(nextVersion);
  const liveVersionNumber = live ? versionNumberOf(live.document_version) : null;

  // Dirty against what is LIVE, comparing like with like: `body` is stripped, so
  // the live text must be stripped too or every published agreement would look
  // permanently edited and offer a pointless republish.
  const dirty =
    title.trim() !== (live?.title ?? "").trim() ||
    body.trim() !== stripAppendedSignatureBlock(live?.body_text ?? "");
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
      // The signature block is appended HERE, by the system, not typed by the
      // operator — so it cannot be deleted, half-edited, or typo'd into a token
      // that never substitutes.
      body_text: bodyForPublish(docKey, body),
      effective_from: todayForOrg(orgTimezone),
    });
    if (e) {
      setBusy(false);
      // Name the CAUSE, and never guess at one.
      //
      // This used to answer every non-23505 failure with "check you're signed in
      // as an owner or admin" — which told Jessica her permissions were wrong
      // when they were not. can_admin_org returned true for her and the same
      // insert succeeded against the database, so the real cause was somewhere
      // else entirely and the message sent her looking in the wrong place. Same
      // mistake as asserting HOW something failed when you only know THAT it did.
      //
      // The most likely real cause for a long-lived admin tab is an expired
      // session: the access token lapses, the insert comes back 401, and nothing
      // about that is a permissions problem. So check the session first, name
      // permissions ONLY on the code that actually means it, and otherwise show
      // the real message rather than inventing a reason.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setError("Your sign-in expired while this was open, so nothing was published. Refresh the page, sign in again, and your text will still be here to re-paste.");
        return;
      }
      if (e.code === "23505") {
        setError("Someone published a new version of this document while you had it open. Go back, reopen it, and apply your changes to the newer version.");
        return;
      }
      if (e.code === "42501") {
        setError("Your account isn't allowed to publish documents for this program. You need to be an owner or an admin.");
        return;
      }
      setError(`Couldn't publish this document: ${e.message || "unknown error"}. Nothing was saved — your text is still here.`);
      return;
    }
    // Stay disabled THROUGH the parent's reload. setBusy(false) used to run
    // before this await, so the button re-enabled while live/versions were still
    // stale — a double-click then re-inserted the same computed version, hit the
    // unique constraint, and blamed a nonexistent other admin for the conflict.
    await onPublished(meta?.label ?? "Document");
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
          Instructors currently see{" "}
          <strong>{liveVersionNumber ? `version ${liveVersionNumber}` : live.document_version}</strong>, published{" "}
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
          Nothing published yet, so your instructors see an empty step. Use{" "}
          <strong>Start from a template</strong> for a skeleton in square brackets, then replace
          every bracket with your own wording.{" "}
          {meta?.signed && "This is the one they sign, so it is worth a careful read."}
        </div>
      )}

      <label style={{ display: "block", fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 5 }}>
        Title
      </label>
      {editing ? (
        <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} />
      ) : (
        <div style={{ ...inputStyle, background: "#fbfaf6", color: INK }}>{title}</div>
      )}
      <p style={{ margin: "5px 0 16px", fontSize: 11.5, color: MUTED }}>
        The heading instructors see above this document.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5, flexWrap: "wrap" }}>
        <label style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          The document
        </label>
        {/* THE edit affordance. A box that is silently live never tells you that
            typing in it changes a legal document; pressing Edit is the moment you
            know. Mirrors the Edit button on the list and the Edit / Done editing
            toggle the campaign and automation editors already use. */}
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{ background: "transparent", border: "none", color: BRIGHT, cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", padding: 0 }}
          >
            Edit
          </button>
        ) : (
          <span style={{ fontSize: 11.5, color: BRIGHT, fontWeight: 600 }}>Editing</span>
        )}
        {/* AT THE TOP, not under a 22-row box. Jessica cleared the body and could
            not find this, because it only appeared below the fold. Renamed from
            "Start from a draft": "template" is the word every tool uses for
            prefilled starting content, and it is already the word Comms uses. */}
        {editing && !body.trim() && meta?.starter && (
          <button
            type="button"
            onClick={() => setBody(meta.starter)}
            style={{
              marginLeft: "auto", background: "#fff", border: `1px solid ${BRIGHT}`, color: BRIGHT,
              borderRadius: 999, padding: "6px 14px", fontSize: 12.5, fontWeight: 600,
              fontFamily: "inherit", cursor: "pointer",
            }}
          >
            Start from a template
          </button>
        )}
      </div>

      {editing ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={22}
          placeholder="Write the document here, or use Start from a template above."
          style={{ ...inputStyle, lineHeight: 1.6, resize: "vertical", fontSize: 13.5 }}
        />
      ) : (
        <div style={{ ...inputStyle, background: "#fbfaf6", minHeight: 160, whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 13.5 }}>
          {body || <span style={{ color: MUTED }}>Nothing written yet.</span>}
        </div>
      )}
      {editing && (
        <p style={{ margin: "5px 0 0", fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
          Leave a blank line to start a new paragraph. Web addresses become clickable on their own.
        </p>
      )}

      {/* LOCKED, not editable. It used to live inside the box as text a provider
          could delete or typo — and the damage would only surface in an archived
          legal record nobody reads until a dispute. Contract tools do not let you
          free-text a signature field for this reason. Shown so they know it is
          there, greyed so it reads as ours rather than theirs. */}
      {/* Only when it will ACTUALLY be appended. The seeded agreement already ends
          with its own signature wording, so for that document this panel claimed
          "we add this when you publish" while showing the operator a second copy
          of a signature they already have. */}
      {willAppendSignatureBlock(docKey, body) && (
        <div style={{ marginTop: 12, background: "#f4f2ee", border: `1px dashed ${RULE}`, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED }}>
              Added automatically · can&apos;t be edited
            </span>
          </div>
          <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, color: MUTED, lineHeight: 1.6, fontFamily: "ui-monospace, monospace" }}>
            {AGREEMENT_SIGNATURE_BLOCK}
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
            We add this to the bottom when you publish, and fill in the real name, date and time as
            each instructor signs. It&apos;s what makes the saved copy a record of who agreed to what.
          </p>
        </div>
      )}

      {/* PREVIEW — the document as the instructor actually reads it.
          House standard: never draw an approximation, render the real thing.
          Screens 4/5/6 and the portal all split on blank lines and pass each
          paragraph through linkifyText, so this uses exactly that, and shows the
          signature block in place and visibly locked. Without it an operator was
          publishing a legal document having only ever seen their own raw
          keystrokes. Same rule as the registration preview and the confirmation
          page. */}
      {body.trim() && (
        <div style={{ marginTop: 20 }}>
          <label style={{ display: "block", fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 5 }}>
            What your instructors will see
          </label>
          <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, background: "#fff", padding: "16px 18px" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginBottom: 10 }}>{title}</div>
            {body.trim().split(/\n\s*\n/).map((para, i) => (
              <p key={i} style={{ margin: "0 0 10px", whiteSpace: "pre-wrap", fontSize: 13.5, color: INK, lineHeight: 1.6 }}>
                {linkifyText(para)}
              </p>
            ))}
            {willAppendSignatureBlock(docKey, body) && (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px dashed ${RULE}`, position: "relative" }}>
                {AGREEMENT_SIGNATURE_BLOCK.split(/\n\s*\n/).map((para, i) => (
                  <p key={i} style={{ margin: "0 0 8px", whiteSpace: "pre-wrap", fontSize: 13.5, color: MUTED, lineHeight: 1.6 }}>
                    {para}
                  </p>
                ))}
                <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED }}>
                  Locked &middot; filled in as each instructor signs
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{ color: RED, fontSize: 13.5, marginTop: 14, lineHeight: 1.5 }}>{error}</div>
      )}

      {/* Publishing belongs to edit mode. Offering it while you are only reading
          invites a click that either does nothing or republishes unchanged text
          as a new version for no reason. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18, flexWrap: "wrap" }}>
        {editing ? (
          confirming ? (
            // Replacing a live document: name what is being replaced and what
            // happens to people who already signed, then require a second click.
            <>
              {/* Gated on canPublish, not just busy. The textarea is still live
                  behind this confirmation, so emptying the body here used to leave
                  a fully-enabled button whose handler returned at
                  `if (!canPublish) return` — a click that did nothing, said
                  nothing, and looked identical to a working one. */}
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
                {busy ? "Publishing…" : `Yes, publish version ${versionNumber}`}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                style={{
                  background: "transparent", border: `1px solid ${RULE}`, color: INK,
                  borderRadius: 999, padding: "10px 18px", fontSize: 13.5, fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <span style={{ fontSize: 12, color: INK, flex: "1 1 240px", lineHeight: 1.5 }}>
                {canPublish
                  ? "This replaces what your instructors sign from now on. Everyone who already signed keeps the wording they agreed to."
                  : "Add a title and some words before publishing."}
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => (live ? setConfirming(true) : publish())}
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
            </>
          )
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              style={{
                background: BRIGHT, color: "#fff", border: "none", borderRadius: 999,
                padding: "10px 22px", fontSize: 14, fontWeight: 700, fontFamily: "inherit", cursor: "pointer",
              }}
            >
              Edit this document
            </button>
            <span style={{ fontSize: 12, color: MUTED }}>
              Editing writes a new version when you publish. Nobody who already signed is affected.
            </span>
          </>
        )}
      </div>

      {versions.length > 0 && (
        <div style={{ marginTop: 26, borderTop: `1px solid ${RULE}`, paddingTop: 14 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, marginBottom: 8 }}>
            Earlier versions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {/* Each row shows the number parsed from ITS OWN stored version, not
                its position in the list — otherwise a hand-seeded '3.0' renders
                as "Version 1" purely because it happens to be the only row. */}
            {versions.map((v, i) => {
              const n = versionNumberOf(v.document_version);
              return (
                <div key={v.id} style={{ fontSize: 13, color: MUTED }}>
                  {n ? `Version ${n}` : v.document_version} · {fmtDate(v.created_at)}
                  {i === 0 && <span style={{ color: GREEN_INK, fontWeight: 600 }}> · live now</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
