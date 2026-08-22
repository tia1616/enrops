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
//
// This SCREEN does not import linkifyText any more. It used to, for a preview
// that no longer exists; the readers above still do, which is where it matters.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import {
  INSTRUCTOR_DOCUMENTS,
  DOCUMENT_KEYS,
  documentByKey,
  documentsBannerPhrase,
  isDocumentEnabled,
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
  // rows to [], which rendered every document as "Not written yet" AND opened the
  // editor with live=null saying "Nothing published yet" — so an admin could
  // write a draft and publish it as v1, which (newest created_at wins) instantly
  // became the agreement every instructor signs, silently demoting the real one.
  // A transient network blip could therefore replace a signed legal document.
  // Now a failed read blocks the list entirely.
  const [loadFailed, setLoadFailed] = useState(false);
  const [openKey, setOpenKey] = useState(null);
  const [toast, setToast] = useState("");
  // Which documents this provider actually uses. ABSENT KEY MEANS ON, with no
  // exceptions as of 2026-08-21, so `{}` (every existing org) is every document.
  // isDocumentEnabled owns that rule and the agreement's pinned-on rule; never
  // re-derive either from this object by hand.
  const [docConfig, setDocConfig] = useState({});
  const [savingKey, setSavingKey] = useState(null);
  // { key, message } — the error renders ON THE ROW THAT FAILED, not at the top
  // of the page. Measured on staging: the seventh row's switch sits 847px below
  // the page-level banner, so a failure explained up there is entirely
  // off-screen. The switch correctly does not move, which without a visible
  // reason is exactly the "click did nothing" silent failure. The success case
  // needs no banner — the row itself flips to "Off · your text is kept".
  const [toggleError, setToggleError] = useState(null);

  const load = useCallback(async () => {
    if (!org?.id) return;
    setLoadFailed(false);
    // Any reload invalidates a per-row toggle error, and publishing is a reload.
    // Without this, following the "Write it first" message's own instructions —
    // click switch, get the red alert, hit Write it, publish — left the stale red
    // alert sitting under the row NEXT TO the green "published" toast, each
    // contradicting the other. The guard's early return skips the only other line
    // that clears it, so this has to be here rather than beside the write.
    setToggleError(null);
    const [{ data, error }, { data: orgRow, error: orgErr }] = await Promise.all([
      supabase
        .from("legal_documents")
        .select("id, document_key, document_version, title, body_text, created_at")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("organizations")
        .select("instructor_document_config")
        .eq("id", org.id)
        .maybeSingle(),
    ]);
    // A failed CONFIG read is as dangerous as a failed document read, and for the
    // same reason: falling back to {} would draw every switch in the ON position,
    // so a provider who had turned two off would see them on, and toggling
    // anything would write that wrong picture back over their real choices.
    if (error || orgErr) {
      // Do NOT fall through to an empty list — see the note on loadFailed.
      setLoadFailed(true);
      setRows(null);
      return;
    }
    setDocConfig(orgRow?.instructor_document_config ?? {});
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

  // "Newest row" and "something an instructor can actually read" are two
  // different questions, and conflating them is what let the toggle guard and the
  // wizard disagree: the guard accepted ANY row while the wizard required text,
  // so an empty-body row passed the guard and then dead-ended the instructor —
  // the two halves of one fix leaving open exactly the gap each was written to
  // close.
  //
  //   liveByKey      — the row get-legal-document would return. What the EDITOR
  //                    opens, and what versionsByKey numbers. Body-agnostic on
  //                    purpose, because that is what the server does.
  //   publishedByKey — that row IF it has readable text. What an instructor can
  //                    acknowledge, and therefore the only thing that counts as
  //                    published for the toggle, the "still to write" count and
  //                    the row badge. Same test the wizard applies.
  const publishedByKey = useMemo(() => {
    const out = {};
    for (const [k, r] of Object.entries(liveByKey)) {
      if (r?.body_text?.trim()) out[k] = r;
    }
    return out;
  }, [liveByKey]);

  const versionsByKey = useMemo(() => {
    const out = {};
    for (const r of rows ?? []) (out[r.document_key] ??= []).push(r);
    return out;
  }, [rows]);

  function flash(msg) { setToast(msg); setTimeout(() => setToast(""), 4000); }

  // Turn one document on or off for this provider.
  //
  // WRITES ONLY THE ONE KEY, onto the config we last read. Spreading the loaded
  // object rather than rebuilding it from the switches on screen is the
  // whole-row-write bug that is still open in six other editors: rebuilding
  // would silently reset any key this screen does not know about.
  //
  // NOTHING IS DELETED. Turning a document off writes `false` and leaves every
  // published version exactly where it is, so turning it back on restores the
  // provider's own text and anyone who already acknowledged it keeps that record.
  async function setDocEnabled(key, next) {
    if (savingKey) return;

    // A "WRITE IT FIRST" GUARD STOOD HERE, and it is deliberately gone rather
    // than generalised. Removed 2026-08-21, when the last default-OFF document
    // stopped defaulting off — it was the only document the guard could ever fire
    // for. (`contractor_status` still exists; it is default-ON now, which is
    // exactly why the guard has nothing to catch. See below.)
    //
    // What it protected against is real: turning on a document nobody has written
    // stops every instructor dead, because the wizard fetches each enabled
    // document by key, a 404 makes Screen6Additional set a screen-wide error and
    // return before rendering anything — so the documents that ARE published
    // disappear too — and gateCheck still requires the step, so onboarding cannot
    // complete.
    //
    // WHY THERE IS NO GUARD NOW. It was scoped to defaultOff, and an earlier
    // version scoped to published-ness instead trapped providers badly: it
    // refused to switch ON any document with no published row, but every other
    // document ships on and unwritten by design ("absent is not a decision"). So
    // a provider who switched photo_video_release off and changed their mind was
    // refused permanently, because this is the only write to
    // instructor_document_config in the app — while three lines of copy on this
    // same screen promise "turn any of them back on whenever you want". A guard
    // that makes a documented, reversible action irreversible is worse than the
    // bug it prevents.
    //
    // With no document defaulting off, every document is already ON for
    // every provider whether or not it is written, so switching one back on
    // returns them to a state they were already in — never a new one. There is
    // nothing left for the guard to catch, and re-adding it in the published-ness
    // form would restore the trap. If a default-OFF document is ever introduced
    // again, bring this back scoped to THAT key and nothing else.

    setSavingKey(key);
    setToggleError(null);
    const updated = { ...docConfig, [key]: next };
    const { error } = await supabase
      .from("organizations")
      .update({ instructor_document_config: updated })
      .eq("id", org.id);
    if (error) {
      // Do not move the switch. A switch that flips and then quietly fails is a
      // lie about what instructors will be asked for.
      setSavingKey(null);
      setToggleError({
        key,
        message: `Couldn't save that: ${error.message || "unknown error"}. Nothing changed — your instructors are still asked for exactly what they were before.`,
      });
      return;
    }
    setDocConfig(updated);
    // The onboarding gate decides overall_status, and it only re-runs from the
    // wizard and the Checkr/Stripe webhooks — never from a settings save. Without
    // this, an instructor already waiting on a document the provider just turned
    // OFF stays stuck until some unrelated webhook happens to fire. Same call the
    // training toggle makes, for the same reason. Non-fatal: the config is saved
    // either way and the gate reconciles on its next natural run.
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
    } catch { /* config saved; gate reconciles on next natural run */ }
    setSavingKey(null);
    const label = documentByKey(key)?.label ?? "This document";
    flash(
      next
        ? `${label} turned on. Instructors will be asked for it from now on.`
        : `${label} turned off. Instructors won't be asked for it. Anything you've written is kept.`,
    );
  }

  // Failed read: refuse to render the list at all. Showing a list of "Not written
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

  // COUNTS THE ENABLED SET, not the whole list. A provider who has switched two off
  // and written the other five is finished, and a banner still saying "2 still
  // to write" about documents nobody will ever be shown is simply untrue —
  // exactly the class of sentence this screen has already had to fix twice.
  const enabledKeys = DOCUMENT_KEYS.filter((k) => isDocumentEnabled(docConfig, k));
  // publishedByKey, not liveByKey: an empty-body row is not something an
  // instructor can read, so counting it as written would tell a provider they had
  // finished when the wizard would still stop their instructors.
  const writtenCount = enabledKeys.filter((k) => publishedByKey[k]).length;
  const enabledCount = enabledKeys.length;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "8px 0 40px" }}>
      <Link to="/admin/settings" style={{ fontSize: 13, color: MUTED, textDecoration: "none" }}>← Settings</Link>
      <h1 style={{ margin: "8px 0 4px", color: PURPLE, fontSize: 24, fontWeight: 700 }}>
        Instructor documents
      </h1>
      <p style={{ color: MUTED, fontSize: 14, marginTop: 0, lineHeight: 1.55, maxWidth: 580 }}>
        What your instructors read and sign when they join. Each one starts as a draft you
        rewrite in your own words — they are prompts, not finished policies. Switch off any
        you don&apos;t use and your instructors are never asked for them.
      </p>

      {/* ALL of them block onboarding, not just the agreement. This banner used
          to say "start with the contractor agreement… onboarding cannot be
          completed until it exists", which reads as "that one is the blocker".
          It is not: Screens 3, 5 and 6 fetch the other seven by key and refuse to
          advance when any is missing. An operator who followed the old wording
          would publish one document, invite an instructor, and strand them.

          IT ALSO USED TO SAY "start with the contractor agreement… then work down
          the list", which stopped being true on 2026-08-21: the agreement is no
          longer first. contractor_status is, because the list is now kept in the
          order instructors meet the documents (Jessica: "can't you just put the
          settings in the order they appear in the onboarding?"). Naming ONE
          document to start with is what made this sentence fragile twice, so it
          now points at the ordering rather than at a particular row. */}
      {writtenCount < enabledCount && (
        <div style={{ background: "#fbfaf6", border: `1px solid ${RULE}`, borderRadius: 10, padding: "12px 14px", fontSize: 13.5, color: INK, lineHeight: 1.55, marginBottom: 16 }}>
          <strong>
            {writtenCount === 0
              ? "Your instructors can't finish onboarding yet."
              : `${enabledCount - writtenCount} still to write.`}
          </strong>{" "}
          They read and sign{" "}
          {/* Three branches, all of which have been wrong at some point — so the
              sentence is built in instructorDocuments.js where a test can assert
              it, rather than inline where it could only be grepped for. */}
          <strong>{documentsBannerPhrase(enabledCount)}</strong>{" "}
          during onboarding, and it stops at the first one that isn&apos;t published. The list
          below is in the order your instructors meet them, so you can work straight down
          it.{" "}
          {/* The way OUT of the banner that isn't "write every one of them".
              Without this a provider reads "you can't finish onboarding yet" and
              assumes the only fix is more writing — which is the exact complaint
              that started this build. Deliberately not a number: the document
              count has moved twice and every hardcoded count in this file rotted
              with it. */}
          Anything you don&apos;t use, switch off.
        </div>
      )}

      {/* Everything is switched off except the agreement. Not an error — a
          perfectly reasonable setup — but worth saying plainly, because from the
          list alone a column of "Off" rows looks like something went wrong. */}
      {enabledCount === 1 && writtenCount === enabledCount && (
        <div style={{ background: "#fbfaf6", border: `1px solid ${RULE}`, borderRadius: 10, padding: "12px 14px", fontSize: 13.5, color: INK, lineHeight: 1.55, marginBottom: 16 }}>
          <strong>Just the agreement.</strong> Everything else is switched off, so your
          instructors sign the contractor agreement and nothing else. Turn any of them back on
          whenever you want &mdash; nothing you&apos;ve written is lost.
        </div>
      )}


      {toast && (
        <div role="status" style={{ background: GREEN_BG, color: GREEN_INK, border: `1px solid ${GREEN_INK}33`, borderRadius: 8, padding: "10px 12px", fontSize: 13.5, marginBottom: 14 }}>
          {toast}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {INSTRUCTOR_DOCUMENTS.map((d) => {
          // The badge says "Version N · date" or "Not written yet", so it must use the
    // same published-means-readable test as the count above and the toggle guard.
    const live = publishedByKey[d.key];
          // Derived from the STORED version string, never from a row count —
          // see versionNumberOf.
          const shownVersion = live ? versionNumberOf(live.document_version) : null;
          const on = isDocumentEnabled(docConfig, d.key);
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
              {/* The switch leads, because on/off is the first decision — there
                  is no point reading "not written yet" about a document you are
                  never going to use. Mirrors the Toggle on the registration
                  questions screen rather than inventing a second switch. */}
              <DocToggle
                on={on}
                locked={d.alwaysOn}
                busy={savingKey === d.key}
                label={d.label}
                onClick={() => setDocEnabled(d.key, !on)}
              />
              <div style={{ flex: "1 1 300px", minWidth: 0, opacity: on ? 1 : 0.55 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>{d.label}</span>
                  {d.signed && (
                    <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: PURPLE, background: `${PURPLE}0F`, borderRadius: 999, padding: "2px 8px" }}>
                      Signed
                    </span>
                  )}
                  {/* HONEST STATE. An off document must not keep saying "Not
                      written yet" — that reads as an outstanding task when it is
                      not one, which is what the banner count got wrong too. And
                      an off document that HAS text says so, because that text is
                      still there waiting if it gets switched back on. */}
                  <span style={{ fontSize: 12, fontWeight: 600, color: !on ? MUTED : live ? GREEN_INK : AMBER_INK }}>
                    {!on
                      ? live ? "Off · your text is kept" : "Off"
                      : live
                        ? `${shownVersion ? `Version ${shownVersion}` : live.document_version} · ${fmtDate(live.created_at)}`
                        : "Not written yet"}
                  </span>
                </div>
                <p style={{ margin: "5px 0 0", fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
                  {on ? d.help : "Your instructors are not asked for this."}
                </p>
              </div>
              {/* Still openable when off. A provider deciding whether to use a
                  document needs to read it, and one switching it back on should
                  find their own words where they left them. */}
              <button
                type="button"
                onClick={() => setOpenKey(d.key)}
                style={{
                  flexShrink: 0, marginLeft: "auto", fontFamily: "inherit", cursor: "pointer",
                  padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  ...(live || !on
                    ? { background: "#fff", border: `1px solid ${RULE}`, color: INK }
                    : { background: BRIGHT, border: "none", color: "#fff" }),
                }}
              >
                {live ? "Edit" : "Write it"}
              </button>
              {/* OUTSIDE the dimmed wrapper above, on its own full-width line.
                  It cannot live inside it: that wrapper drops to opacity 0.55
                  when the row is off, and CSS opacity COMPOUNDS down the tree —
                  an `opacity: 1` on the child multiplies to 0.55, it does not
                  reset. The commonest failure is clicking an OFF row to switch it
                  back ON, when `on` is still false, so the single message
                  explaining why nothing moved would have rendered greyed-out
                  beside a switch that had not moved. That is the "click did
                  nothing" silent failure this message exists to prevent, wearing
                  a disabled look. flex-basis 100% wraps it under the row (the row
                  is already flexWrap). */}
              {toggleError?.key === d.key && (
                <p role="alert" style={{ flex: "1 1 100%", margin: "4px 0 0", fontSize: 12.5, color: RED, lineHeight: 1.5 }}>
                  {toggleError.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The on/off switch on a document row.
//
// Mirrors the Toggle in RegistrationQuestions.jsx — same size, same colours, same
// role="switch" + aria-checked, same `locked` treatment — so a provider meets one
// switch in this product rather than two that look different and behave the same.
//
// LOCKED for the contractor agreement. It is signed rather than acknowledged and
// onboarding cannot complete without it, so it has no off state to offer. Shown
// rather than hidden, with the reason on hover: a missing switch on one row of
// seven reads as a rendering bug.
function DocToggle({ on, locked, busy, label, onClick }) {
  const title = locked
    ? "Always on — this is the one your instructors sign"
    : busy
      ? "Saving…"
      : on
        ? `${label} is on — click to turn off`
        : `${label} is off — click to turn on`;
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label}
      disabled={locked || busy}
      onClick={locked || busy ? undefined : onClick}
      title={title}
      style={{
        flexShrink: 0, width: 44, height: 26, borderRadius: 999, border: "none", position: "relative",
        cursor: locked || busy ? "default" : "pointer", background: on ? BRIGHT : "#cfcbc0",
        opacity: locked ? 0.55 : busy ? 0.7 : 1, transition: "background 120ms", padding: 0, marginTop: 2,
      }}
    >
      <span style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 120ms", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
    </button>
  );
}

function DocumentEditor({ orgId, orgTimezone, docKey, live, versions, onBack, onPublished }) {
  const meta = documentByKey(docKey);
  const [title, setTitle] = useState(live?.title ?? meta?.label ?? "");
  // STRIPPED. The signature block is never in the editable box — see
  // stripAppendedSignatureBlock. Before this, it was appended once and then lived
  // in body_text, so every edit after the first put it back in the textarea where
  // a line could be deleted and never repaired.
  const [body, setBody] = useState(stripAppendedSignatureBlock(live?.body_text ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // THE BOX IS ALWAYS EDITABLE. There is no read-only mode and no Edit button.
  //
  // Jessica called this screen confusing three times, so on the third pass the
  // question stopped being "which control is wrong" and became "what shape do
  // other tools use". Every product that has a tenant write their own legal
  // document gives them ONE always-editable box: Shopify's store policies
  // (Insert template, then Save), Gusto's contractor agreements, WordPress's
  // privacy policy, Google Docs, Notion. Not one of them locks the document and
  // asks you to press Edit first. Doing a third thing nobody does IS the tell.
  //
  // The safety argument for the old gate does not survive contact with how this
  // screen actually works: typing here changes nothing an instructor sees.
  // PUBLISH is the only thing that does, it is a separate deliberate button with
  // its own confirmation on a live document, and every earlier version is kept.
  // So the gate was protecting against a risk `confirming` below already covers,
  // at the price of a whole mode on screen. Jessica chose to drop it, 17 Aug.
  // Publishing OVER a live document is a one-click, instantly-effective change to
  // the thing instructors sign, and there is no undo beyond publishing again.
  // That is not hypothetical: during testing today a starter draft reading
  // "Test publish. [Describe what you are hiring them to do]" became the live
  // contractor agreement on staging, and stayed live until someone noticed.
  // First publish needs no ceremony — nothing is being replaced.
  const [confirming, setConfirming] = useState(false);
  // THERE IS NO PREVIEW. It went through all three shapes and every one was
  // wrong: stacked under the textarea it was Jessica's "two boxes showing the
  // same thing", and as a Write/Preview toggle it was a mode on a screen she
  // then called confusing again.
  //
  // The research settles it - nobody previews a document like this. Google Docs
  // and Notion have none because the surface IS the document. Shopify's policy
  // editor has none. Gusto's has none. WordPress's has none. A preview earns its
  // keep when the output differs from the input; here body_text is plain text and
  // the only differences were paragraph spacing, auto-linked URLs, the title and
  // the signature block.
  //
  // So each of those four is handled without a mode: the title sits in its own
  // field directly above, the hint under the box states the blank-line and link
  // rules, and THE SIGNATURE BLOCK IS NOW PERMANENTLY ON SCREEN below the box
  // rather than only inside the preview. That last one was the only genuinely
  // invisible thing, and it is strictly more visible than it was before.
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateCopied, setTemplateCopied] = useState(false);

  // ONE definition of "is the template button the apply-it one or the read-it
  // one", because the button, its panel and the empty-state banner all have to
  // agree about which control exists right now. The banner used to hardcode
  // "Start from a template" and went on saying it after the button had become
  // "View template" — copy naming a control that is not on screen.
  const templateApplies = !body.trim();
  const templateButtonLabel = templateApplies
    ? "Start from a template"
    : templateOpen ? "Hide template" : "View template";

  function closeTemplate() {
    setTemplateOpen(false);
    setTemplateCopied(false);
  }

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
              empty and the starter only appears once Start from a template is
              pressed, so the old wording described something that was not on
              screen — the same untrue-pointer bug fixed twice elsewhere today.
              (This comment itself said "Start from a draft" until 17 Aug, three
              commits after the button was renamed. A comment is a claim.)
              Only visible in the empty state, which is exactly the state a
              provider setting up for the first time is in. */}
          Nothing published yet, so your instructors see an empty step.{" "}
          {templateApplies ? (
            <>
              Use <strong>{templateButtonLabel}</strong> for a skeleton in square brackets, then
              replace every bracket with your own wording.{" "}
            </>
          ) : !templateOpen ? (
            // Only while the panel is SHUT. With it open the template is already
            // on screen, and the button reads "Hide template", so pointing at
            // "View template" would name a control that is not currently there —
            // the same bug this branch exists to fix.
            <>
              The starter wording is still there under <strong>View template</strong> if you want
              to check it against what you have written.{" "}
            </>
          ) : null}
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

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5, flexWrap: "wrap" }}>
        <label style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>
          The document
        </label>
        {/* THE ONLY CONTROL IN THIS ROW. It used to hold an Edit button, an
            "Editing" badge and a Write/Preview toggle as well - four things above
            the box on a screen whose whole job is "type the words". Edit and
            Preview are both gone (see the state block at the top for why: no other
            product doing this has either), so what is left is the template. */}
        {/* AT THE TOP, not under a 22-row box. Jessica cleared the body and could
            not find this, because it only appeared below the fold. Renamed from
            "Start from a draft": "template" is the word every tool uses for
            prefilled starting content, and it is already the word Comms uses.

            PERMANENT NOW. This carried `!body.trim()`, so the moment a provider
            typed one character the starter was gone for good — and the starter is
            where the square-bracket checklist of what the document has to cover
            lives, which is exactly what you want to re-read halfway through
            writing one.

            Empty box -> apply immediately, because there is nothing to destroy.
            Written-in box -> the button OPENS the template read-only, because
            RE-READING is the thing that was actually missing. Jessica's whole
            ask, in her words: "I just wanted the writer to be able to see the
            template and copy bits of it if they want to after having already
            edited their own." There is deliberately NO replace-what-I-wrote
            path once something is written — it was built, she said she does not
            want it, and it was the only control here that could destroy work.
            Taking bits needs no feature at all: the panel renders the template
            as ordinary selectable text, so highlight + Ctrl+C. That is also how
            the tools do it — Notion opens a template in a side peek you copy
            from, Google Docs opens it as a second document; nobody builds
            per-fragment copy buttons. */}
        {meta?.starter && (
          <button
            type="button"
            onClick={() => {
              // Apply-and-close, not just apply. `templateApplies` short-circuits
              // ahead of the close branch, so with the panel OPEN and the body
              // then emptied this button reads "Start from a template" and the
              // close path becomes unreachable — the panel is stuck open with no
              // control that shuts it. Closing here also stops the panel showing
              // the same words that are now in the box. This is what the deleted
              // "Yes, replace it" handler did, for the same reason.
              if (templateApplies) { setBody(meta.starter); closeTemplate(); return; }
              if (templateOpen) { closeTemplate(); return; }
              setTemplateOpen(true);
              setTemplateCopied(false);
            }}
            style={{
              marginLeft: "auto", background: "#fff", border: `1px solid ${BRIGHT}`, color: BRIGHT,
              borderRadius: 999, padding: "6px 14px", fontSize: 12.5, fontWeight: 600,
              fontFamily: "inherit", cursor: "pointer",
            }}
          >
            {templateButtonLabel}
          </button>
        )}
      </div>

      {/* The template, readable without giving anything up. Read-only, and
          nothing in here can change your document at all — the one button copies
          to the clipboard. That is the entire feature Jessica asked for. */}
      {templateOpen && meta?.starter && (
        <div style={{ border: `1px solid ${RULE}`, borderRadius: 10, background: "#fbfaf6", padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED }}>
              The template
            </span>
            <span style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
              Replace every square bracket with your own wording. Nothing here changes your
              document — highlight any part of it to copy just that bit.
            </span>
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto", whiteSpace: "pre-wrap", fontSize: 12.5, color: INK, lineHeight: 1.6, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px" }}>
            {meta.starter}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            {/* The whole-thing shortcut. "Copy all" rather than "Copy template",
                because copying a PART is the more likely thing here and it is
                done by selecting text, not by this button — a label saying
                "Copy template" reads as though it were the only way. */}
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(meta.starter);
                  setTemplateCopied(true);
                  setTimeout(() => setTemplateCopied(false), 2000);
                } catch {
                  // Clipboard is blocked in some browsers/contexts. Say so rather
                  // than flashing "Copied" over a copy that did not happen — the
                  // text is on screen and selectable either way.
                  setTemplateCopied("failed");
                  setTimeout(() => setTemplateCopied(false), 4000);
                }
              }}
              style={{
                background: "#fff", border: `1px solid ${BRIGHT}`, color: BRIGHT, borderRadius: 999,
                padding: "6px 14px", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
              }}
            >
              {templateCopied === true ? "Copied" : templateCopied === "failed" ? "Press Ctrl+C to copy" : "Copy all"}
            </button>
          </div>
        </div>
      )}

      {/* ONE BOX, ONE STATE. No read-only variant, no preview variant, no
          "Nothing written yet" placeholder panel - an empty textarea with a
          placeholder already says that, and it lets you start typing rather than
          hunting for the control that unlocks it. */}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={22}
        placeholder="Write the document here, or use Start from a template above."
        style={{ ...inputStyle, lineHeight: 1.6, resize: "vertical", fontSize: 13.5 }}
      />
      <p style={{ margin: "5px 0 0", fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
        Leave a blank line to start a new paragraph. Web addresses become clickable on their own.
      </p>

      {/* LOCKED, not editable. It used to live inside the box as text a provider
          could delete or typo — and the damage would only surface in an archived
          legal record nobody reads until a dispute. Contract tools do not let you
          free-text a signature field for this reason. Shown so they know it is
          there, greyed so it reads as ours rather than theirs. */}
      {/* Only when it will ACTUALLY be appended. The seeded agreement already ends
          with its own signature wording, so for that document this panel claimed
          "we add this when you publish" while showing the operator a second copy
          of a signature they already have. */}
      {/* ALWAYS, not just on an empty body. This used to be `!body.trim() && ...`
          because the preview carried the block once you had written something -
          so with the preview gone, that condition would have hidden the ONE thing
          on this screen a provider cannot otherwise see. It is the only part of
          the published document that is not in the box in front of them.
          Permanently visible under the box is what replaces the preview, and it
          costs no mode. */}
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

      {/* NO PREVIEW PANEL HERE, AND NO PREVIEW MODE ABOVE. Both existed; both
          were wrong. See the state block at the top of this component for the
          research - this is the third and last shape, so do not add a fourth
          without Jessica asking for one. */}

      {error && (
        <div role="alert" style={{ color: RED, fontSize: 13.5, marginTop: 14, lineHeight: 1.5 }}>{error}</div>
      )}

      {/* Always offered, because there is no longer a mode this could be wrong in.
          It stays disabled until something has actually changed (`canPublish`
          requires `dirty`), which is what stops a pointless republish of identical
          text - that used to be the job of hiding it outside edit mode. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18, flexWrap: "wrap" }}>
        {(
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
        )}
      </div>
      {/* Publish is the only thing in this row. There was once an "Edit this
          document" button here too, and later the row was hidden outside edit
          mode; both are gone with the mode itself. */}

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
