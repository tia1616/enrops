// AICampaignBuilder — top-level container for the 4-question flow.
// Chunk 3.6.05 — state management only; mock setTimeout for draft (real API in 07).
//
// State is forward-compatible with the deployed `marketing-draft-campaign`:
//   - inputs.what: string[] (multi-topic) — UI starts with a single chip but the
//     shape carries the array so chunk 06/07 can add more without state churn.
//   - inputs.who: structured WhoInput (audience + filter) — same forward-compat.
// All tenant context (org, user) comes from useOutletContext(). No hardcoded ids.

import { useReducer } from "react";
import { useOutletContext } from "react-router-dom";
import { PLUM, RULE, INK, MUTED, OK } from "../marketing/tokens.jsx";
import Q1_What from "./questions/Q1_What.jsx";
import Q2_Who from "./questions/Q2_Who.jsx";
import Q3_Duration from "./questions/Q3_Duration.jsx";
import Q4_Channels from "./questions/Q4_Channels.jsx";

const INITIAL = {
  step: 1,
  inputs: {
    what: [],
    who: { audience: "parents", filter: { type: "master_list" } },
    duration: "",
    channels: ["email"],
  },
  draft: null,
  loading: false,
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case "NEXT":
      return { ...state, step: nextStep(state.step) };
    case "BACK":
      return { ...state, step: prevStep(state.step) };
    case "SET_FIELD":
      return { ...state, inputs: { ...state.inputs, [action.field]: action.value } };
    case "START_DRAFTING":
      return { ...state, loading: true, error: null };
    case "DRAFT_RECEIVED":
      return { ...state, loading: false, draft: action.draft, step: "review" };
    case "DRAFT_FAILED":
      return { ...state, loading: false, error: action.error };
    case "RESET":
      return INITIAL;
    default:
      return state;
  }
}

function nextStep(s) {
  if (s === 1) return 2;
  if (s === 2) return 3;
  if (s === 3) return 4;
  return s;
}
function prevStep(s) {
  if (s === 2) return 1;
  if (s === 3) return 2;
  if (s === 4) return 3;
  if (s === "review") return 4;
  return s;
}

// Validation — Next disabled until current question has a non-empty answer.
function isStepValid(step, inputs) {
  if (step === 1) return inputs.what.length > 0;
  if (step === 2) {
    if (!inputs.who?.audience) return false;
    if (inputs.who.audience !== "parents") return false; // partners/instructors disabled in v1
    return !!inputs.who.filter?.type;
  }
  if (step === 3) return !!inputs.duration;
  if (step === 4) return inputs.channels.length > 0;
  return false;
}

export default function AICampaignBuilder() {
  const { org, user } = useOutletContext() ?? {};
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const setField = (field, value) => dispatch({ type: "SET_FIELD", field, value });
  const next = () => dispatch({ type: "NEXT" });
  const back = () => dispatch({ type: "BACK" });

  // Mock draft trigger — chunk 07 swaps this for a real fetch to
  // marketing-draft-campaign. The shape mirrors the real response so the
  // review screen we build next isn't a moving target.
  function startDrafting() {
    dispatch({ type: "START_DRAFTING" });
    setTimeout(() => {
      const topics = state.inputs.what;
      const duration = state.inputs.duration;
      const touchpoints = buildMockSchedule(topics, duration, org?.brand_voice?.closer ?? "");
      dispatch({
        type: "DRAFT_RECEIVED",
        draft: {
          campaign_id: "mock-" + Date.now(),
          schedule: {
            summary: `Mock plan: ${touchpoints.length} touchpoints over ${duration}.`,
            touchpoints,
          },
          sender: {
            name: org?.default_sender_name ?? "(set sender in Settings)",
            email: org?.default_sender_email ?? "",
          },
          recipients: { ids: [], count: 247, segment_summary: "all parents on the master list (mock)" },
        },
      });
    }, 2000);
  }

  // Picks a realistic touchpoint count by duration to mirror the real prompt's
  // cadence heuristics. Subjects and bodies are stubs — real Don writes them.
  function buildMockSchedule(topics, duration, closer) {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() + 2); // first send in 2 days
    function fmtIso(d, hour) {
      const dt = new Date(d);
      dt.setHours(hour, 0, 0, 0);
      return dt.toISOString();
    }
    const plan = [
      { offset: 0,  label: "kickoff",       hour: 10, scope: "primary" },
      { offset: 7,  label: "mid-window",    hour: 10, scope: "primary" },
      { offset: 14, label: "48h-promo",     hour: 10, scope: "primary" },
      { offset: 15, label: "24h-promo",     hour: 7,  scope: "primary" },
      { offset: 21, label: "48h-reg-close", hour: 10, scope: "primary" },
      { offset: 22, label: "24h-reg-close", hour: 7,  scope: "primary" },
    ];
    const count =
      duration === "2 weeks" ? 3 :
      duration === "1 month" ? 6 :
      duration === "2 months" ? 6 :
      4;
    return plan.slice(0, count).map((p, i) => {
      const at = new Date(startDate);
      at.setDate(startDate.getDate() + p.offset);
      return {
        id: `mock-tp-${i}`,
        order_index: i,
        type: "email",
        label: p.label,
        scheduled_at: fmtIso(at, p.hour),
        subject: `${topics.join(" + ").slice(0, 40)} — ${p.label}`,
        body_html: `<p>Hi {{first_name}},</p><p>(${p.label}) Mock body for ${topics.join(" + ")}. Real Don writes this in chunk 07.</p>${closer ? `<p><em>${closer}</em></p>` : ""}`,
        body_text: `(${p.label}) Mock body for ${topics.join(" + ")}.`,
        topics: topics,
        status: "queued",
      };
    });
  }

  // ---- Render ----
  if (!org) {
    return (
      <div style={{ padding: 24, color: MUTED }}>
        Loading your org context…
      </div>
    );
  }

  if (state.step === "review") {
    // Placeholder review screen — chunk 06 builds the real two-column edit UI.
    return (
      <ReviewPlaceholder draft={state.draft} org={org} onReset={() => dispatch({ type: "RESET" })} />
    );
  }

  const sharedProps = {
    inputs: state.inputs,
    setField,
    onNext: next,
    onBack: back,
    canNext: isStepValid(state.step, state.inputs),
    loading: state.loading,
    onStartDrafting: startDrafting,
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 96 }}>
      <ProgressHeader step={state.step} />
      {state.step === 1 && <Q1_What {...sharedProps} />}
      {state.step === 2 && <Q2_Who {...sharedProps} />}
      {state.step === 3 && <Q3_Duration {...sharedProps} />}
      {state.step === 4 && <Q4_Channels {...sharedProps} />}
      {state.error && (
        <div style={{ background: "#fdecea", color: "#b3261e", padding: 12, borderRadius: 6, marginTop: 16, fontSize: 13 }}>
          {state.error}
        </div>
      )}
    </div>
  );
}

function ProgressHeader({ step }) {
  const stepNum = typeof step === "number" ? step : 4;
  const pct = (stepNum / 4) * 100;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: MUTED }}>
        <span style={{ color: PLUM, fontWeight: 600 }}>Question {stepNum}</span>
        <span>of 4</span>
      </div>
      <div style={{ marginTop: 6, height: 4, background: RULE, borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: PLUM, transition: "width 0.18s ease" }} />
      </div>
    </div>
  );
}

function ReviewPlaceholder({ draft, org, onReset }) {
  const touchpoints = draft?.schedule?.touchpoints ?? [];
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 24 }}>
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 24 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: OK, textTransform: "uppercase", letterSpacing: 0.4, margin: 0 }}>
          Schedule ready (chunk 05 mock)
        </p>
        <h2 style={{ margin: "8px 0 6px", fontSize: 22, color: INK }}>
          Here's the campaign Don put together.
        </h2>
        <p style={{ margin: "0 0 16px", color: MUTED, fontSize: 13 }}>
          {draft?.schedule?.summary}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px", fontSize: 13, marginBottom: 16 }}>
          <div style={{ color: MUTED }}>Sender</div>
          <div>{draft?.sender?.name}</div>
          <div style={{ color: MUTED }}>Audience</div>
          <div>{draft?.recipients?.segment_summary} ({draft?.recipients?.count} recipients)</div>
        </div>

        <p style={{ fontSize: 11, fontWeight: 600, color: PLUM, textTransform: "uppercase", letterSpacing: 0.6, margin: "16px 0 8px" }}>
          The schedule ({touchpoints.length} touchpoints)
        </p>

        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {touchpoints.map((tp) => (
            <li key={tp.id} style={{ border: `1px solid ${RULE}`, borderRadius: 6, marginBottom: 8, overflow: "hidden" }}>
              <details>
                <summary style={{ cursor: "pointer", listStyle: "none", padding: 10, display: "flex", alignItems: "center", gap: 10, background: "#fafafa" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 6, background: "#f0e3e8", color: PLUM, fontWeight: 700, fontSize: 14 }}>
                    {tp.type === "email" ? "✉" : tp.type === "social" ? "📣" : "📄"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
                      {tp.label} · {tp.subject}
                    </div>
                    <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                      {new Date(tp.scheduled_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      &nbsp;·&nbsp;{tp.topics?.join(" + ")}
                    </div>
                  </div>
                </summary>
                <div style={{ padding: 12, fontSize: 12, lineHeight: 1.55, color: INK, background: "#fff" }}
                  dangerouslySetInnerHTML={{ __html: tp.body_html ?? "" }}
                />
              </details>
            </li>
          ))}
        </ol>

        <p style={{ marginTop: 16, fontSize: 12, color: MUTED }}>
          The full editable schedule (per-touchpoint edit, send-test, approve &amp; schedule, promo card) lands in chunk 3.6.06.
        </p>
        <button
          onClick={onReset}
          style={{
            marginTop: 16, padding: "8px 14px", background: PLUM, color: "#fff",
            border: "none", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 500,
          }}
        >
          Build another
        </button>
      </div>
    </div>
  );
}
