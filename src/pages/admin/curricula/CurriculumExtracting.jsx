// /admin/curricula/:id/extracting
// Step 2 of the upload-first onboarding flow. We're already extracting in the
// background — this page just subscribes to the primary doc's row via Supabase
// Realtime and streams the status messages.
//
// Realtime publication for curriculum_documents was added in migration
// `enable_realtime_curriculum_documents` (2026-05-15). The edge function writes
// status_message + extraction_status at each milestone; we accumulate them
// here so the user sees a calm sequence of "what's happening now."
//
// On complete: surfaces "Review →" CTA (routes to Chunk 3 review screen).
// On failure: "Try again" re-fires the edge function, "Continue anyway" routes
// to the review placeholder so the operator isn't stuck.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { supabase, API_BASE } from "../../../lib/supabase.js";
import ElapsedTimer from "../../../components/ElapsedTimer.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const INITIAL_MESSAGE = "Extracting your offering...";

export default function CurriculumExtracting() {
  const { id: curriculumId } = useParams();
  const { org } = useOutletContext();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [curriculum, setCurriculum] = useState(null);
  const [primaryDoc, setPrimaryDoc] = useState(null);
  const [messages, setMessages] = useState([]); // ordered, unique
  const [status, setStatus] = useState("pending"); // pending | processing | complete | failed
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const channelRef = useRef(null);

  // Live elapsed-time counter while extraction is in-flight. Per
  // feedback_ai_wait_ui: every AI wait surface shows recommended duration +
  // a live m:ss counter. Timer starts when status first transitions into
  // pending/processing and stops on complete/failed.
  const [extractStartedAt, setExtractStartedAt] = useState(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Initial load: pull curriculum + its primary upload doc
  useEffect(() => {
    if (!curriculumId || !org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      setLoadError("");
      const { data: curRow, error: curErr } = await supabase
        .from("curricula")
        .select("id, name, status")
        .eq("id", curriculumId)
        .maybeSingle();
      if (!mounted) return;
      if (curErr || !curRow) {
        setLoadError(curErr?.message || "Offering not found.");
        setLoading(false);
        return;
      }
      setCurriculum(curRow);

      // Match both source types — upload (file dropped on Step 1) and
      // drive_link (fetched from Drive via fetch-drive-document). Both go
      // through the same extraction path.
      const { data: docRow, error: docErr } = await supabase
        .from("curriculum_documents")
        .select("id, original_filename, extraction_status, status_message, extraction_error")
        .eq("curriculum_id", curriculumId)
        .eq("doc_type", "instructor_guide")
        .in("source_type", ["upload", "drive_link"])
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!mounted) return;
      if (docErr || !docRow) {
        setLoadError(docErr?.message || "Couldn't find the uploaded doc for this offering.");
        setLoading(false);
        return;
      }
      setPrimaryDoc(docRow);
      setStatus(docRow.extraction_status);
      if (docRow.extraction_error) setError(docRow.extraction_error);
      if (docRow.status_message) {
        setMessages([docRow.status_message]);
      } else if (docRow.extraction_status === "pending" || docRow.extraction_status === "processing") {
        setMessages([INITIAL_MESSAGE]);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [curriculumId, org?.id]);

  // Realtime subscription on the primary doc row
  useEffect(() => {
    if (!primaryDoc?.id) return;
    const channel = supabase
      .channel(`extracting-${primaryDoc.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "curriculum_documents", filter: `id=eq.${primaryDoc.id}` },
        (payload) => {
          const next = payload.new;
          if (!next) return;
          setStatus(next.extraction_status);
          if (next.status_message) {
            setMessages((prev) => prev[prev.length - 1] === next.status_message ? prev : [...prev, next.status_message]);
          }
          if (next.extraction_error) setError(next.extraction_error);
          else if (next.extraction_status === "complete") setError("");
        },
      )
      .subscribe();
    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [primaryDoc?.id]);

  async function retry() {
    if (!primaryDoc?.id || retrying) return;
    setRetrying(true);
    setError("");
    setMessages([INITIAL_MESSAGE]);
    setStatus("pending");
    try {
      await supabase
        .from("curriculum_documents")
        .update({ extraction_status: "pending", status_message: null, extraction_error: null })
        .eq("id", primaryDoc.id);
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sign in expired.");
      const resp = await fetch(`${API_BASE}/extract-curriculum-details`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ document_id: primaryDoc.id }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Retry failed (${resp.status}).`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("failed");
    } finally {
      setRetrying(false);
    }
  }

  function goReview() {
    navigate(`/admin/curricula/${curriculumId}/review`);
  }

  // NOTE: these status derivations + timer hooks MUST live before any early
  // returns below — React requires a stable hook-call order across renders.
  // Earlier they sat after `if (loading) return …` which silently worked
  // when loadError fired (early return on every render), but broke as soon
  // as a curriculum loaded successfully (first render returned early, second
  // render ran the hooks, hook count changed → "Rendered more hooks…").
  const isDone = status === "complete";
  const isFailed = status === "failed";
  const isWorking = status === "pending" || status === "processing";

  useEffect(() => {
    if (isWorking && extractStartedAt == null) {
      setExtractStartedAt(Date.now());
      setElapsedSec(0);
    } else if (!isWorking && extractStartedAt != null) {
      setExtractStartedAt(null);
      setElapsedSec(0);
    }
  }, [isWorking, extractStartedAt]);

  useEffect(() => {
    if (!isWorking || extractStartedAt == null) return undefined;
    const id = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - extractStartedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isWorking, extractStartedAt]);

  if (loading) {
    return <div style={{ color: MUTED, padding: 24 }}>Loading…</div>;
  }
  if (loadError) {
    // Common case for backfilled drafts (no upload doc): nudge to the review
    // screen where the operator can edit fields manually instead of dead-ending.
    const noDocCase = /uploaded doc/i.test(loadError);
    return (
      <div style={{ ...errorBox, maxWidth: 520 }}>
        {noDocCase
          ? "This offering doesn't have an uploaded document yet — there's nothing to extract. Edit the details manually, or upload a curriculum doc from the library."
          : `Couldn't load this offering: ${loadError}`}
        <div style={{ marginTop: 12, display: "flex", gap: 14 }}>
          {curriculum && noDocCase && (
            <Link to={`/admin/curricula/${curriculum.id}/review`} style={linkStyle}>Edit details →</Link>
          )}
          <Link to="/admin/curricula" style={linkStyle}>← Back to Offerings</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={crumbs}>
        <Link to="/admin/curricula" style={crumbLink}>Offerings</Link>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>{curriculum?.name ?? "New offering"}</span>
        <span style={{ margin: "0 8px", color: MUTED }}>›</span>
        <span>Reading</span>
      </div>

      <div style={centerPanel}>
        <h1 style={{ margin: 0, color: PURPLE, fontSize: 28, fontWeight: 700, textAlign: "center" }}>
          {isDone ? "All set." : isFailed ? "Something went wrong." : "Extracting your offering…"}
        </h1>
        <p style={subline}>
          {isDone
            ? "We pulled out the details. Ready for you to review."
            : isFailed
              ? `We had trouble reading ${primaryDoc?.original_filename ?? "this doc"}.`
              : "This usually takes 30–60 seconds. You can stay here or come back later — we'll keep going either way."}
        </p>
        {isWorking && (
          <div style={{ textAlign: "center", marginTop: -2, marginBottom: 4 }}>
            <ElapsedTimer seconds={elapsedSec} />
          </div>
        )}

        {/* Message stream */}
        {!isFailed && (
          <ul style={messageList}>
            {messages.map((m, i) => {
              const isCurrent = i === messages.length - 1 && isWorking;
              const isCompleted = i < messages.length - 1 || isDone;
              return (
                <li key={i} style={{ ...messageItem, opacity: isCurrent ? 1 : isCompleted ? 0.85 : 1 }}>
                  <span style={{
                    width: 16,
                    color: isCompleted ? VIOLET : PURPLE,
                    fontWeight: 700,
                  }}>
                    {isCurrent ? "→" : "✓"}
                  </span>
                  <span style={{
                    fontSize: 15,
                    color: isCurrent ? PURPLE : INK,
                    fontWeight: isCurrent ? 600 : 400,
                  }}>
                    {m}
                  </span>
                </li>
              );
            })}
            {isDone && messages[messages.length - 1] !== "Done!" && (
              <li style={messageItem}>
                <span style={{ width: 16, color: VIOLET, fontWeight: 700 }}>✓</span>
                <span style={{ fontSize: 15, color: INK }}>Done!</span>
              </li>
            )}
          </ul>
        )}

        {/* Failure UI */}
        {isFailed && (
          <div style={failBox}>
            {error || "We weren't able to read this document."}
            <div style={{ marginTop: 14, display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={retry} disabled={retrying} style={retrying ? primaryBtnDisabled : primaryBtn}>
                {retrying ? "Trying again…" : "Try again"}
              </button>
              <button onClick={goReview} style={secondaryBtn}>Continue anyway</button>
            </div>
          </div>
        )}

        {/* Done CTA */}
        {isDone && (
          <div style={{ marginTop: 20, textAlign: "center" }}>
            <button onClick={goReview} style={primaryBtn}>Review what we found →</button>
          </div>
        )}

        {/* Working state — soft secondary link */}
        {isWorking && (
          <div style={{ marginTop: 22, textAlign: "center" }}>
            <Link to="/admin/curricula" style={linkStyle}>← Come back later</Link>
          </div>
        )}
      </div>
    </div>
  );
}

// --- styles ---

const crumbs = { fontSize: 13, color: MUTED, marginBottom: 16 };
const crumbLink = { color: MUTED, textDecoration: "none" };
const linkStyle = { color: PURPLE, fontSize: 13, fontWeight: 600, textDecoration: "none" };

const centerPanel = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: "36px 32px",
  maxWidth: 560,
  margin: "20px auto 0",
};

const subline = {
  textAlign: "center",
  color: MUTED,
  fontSize: 14,
  margin: "8px 0 24px",
  lineHeight: 1.5,
};

const messageList = {
  listStyle: "none",
  padding: 0,
  margin: "0 auto",
  maxWidth: 420,
};
const messageItem = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  padding: "8px 0",
};

const errorBox = {
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  padding: 14,
  fontSize: 13,
};

const failBox = {
  background: "#fff8e8",
  border: "1px solid #e7d18a",
  color: "#6b4a00",
  borderRadius: 6,
  padding: 16,
  fontSize: 14,
  textAlign: "center",
  marginTop: 8,
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
const secondaryBtn = {
  padding: "11px 20px",
  background: "transparent",
  color: BRIGHT,
  border: `1px solid ${BRIGHT}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
