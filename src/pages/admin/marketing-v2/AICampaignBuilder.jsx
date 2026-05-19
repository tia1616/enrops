// AICampaignBuilder — top-level container for the 4-question flow.
// Chunk 3.6.05 — state management only; mock setTimeout for draft (real API in 07).
//
// State is forward-compatible with the deployed `marketing-draft-campaign`:
//   - inputs.what: string[] (multi-topic) — UI starts with a single chip but the
//     shape carries the array so chunk 06/07 can add more without state churn.
//   - inputs.who: structured WhoInput (audience + filter) — same forward-compat.
// All tenant context (org, user) comes from useOutletContext(). No hardcoded ids.

import { useReducer, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { PLUM, RULE, INK, MUTED, OK } from "../marketing/tokens.jsx";
import Q1_What from "./questions/Q1_What.jsx";
import Q2_Who from "./questions/Q2_Who.jsx";
import Q3_Duration from "./questions/Q3_Duration.jsx";
import Q4_Channels from "./questions/Q4_Channels.jsx";
import ScheduleReview from "./ScheduleReview.jsx";

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
  scheduled: false,
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
    case "UPDATE_TOUCHPOINT": {
      if (!state.draft) return state;
      const tps = (state.draft.schedule?.touchpoints ?? []).map((tp) =>
        tp.id === action.id ? { ...tp, ...action.patch } : tp,
      );
      return {
        ...state,
        draft: {
          ...state.draft,
          schedule: { ...state.draft.schedule, touchpoints: tps },
        },
      };
    }
    case "REMOVE_RECIPIENT": {
      if (!state.draft) return state;
      const r = state.draft.recipients ?? { ids: [], count: 0 };
      const ids = r.ids.filter((id) => id !== action.id);
      return {
        ...state,
        draft: {
          ...state.draft,
          recipients: { ...r, ids, count: Math.max(0, r.count - 1) },
        },
      };
    }
    case "APPROVE_SCHEDULED":
      return { ...state, scheduled: true };
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
  const [actionBusy, setActionBusy] = useState(false);

  const setField = (field, value) => dispatch({ type: "SET_FIELD", field, value });
  const next = () => dispatch({ type: "NEXT" });
  const back = () => dispatch({ type: "BACK" });

  // Local-only updates for chunk 06. Chunk 07 PATCHes the touchpoint row.
  const updateTouchpoint = (id, patch) => dispatch({ type: "UPDATE_TOUCHPOINT", id, patch });
  const removeRecipient = (id) => dispatch({ type: "REMOVE_RECIPIENT", id });

  // Action stubs — chunk 07 wires these to real edge function + PATCH calls.
  const onSaveDraft = () => {
    setActionBusy(true);
    setTimeout(() => {
      setActionBusy(false);
      alert("Save as draft — chunk 07 wires the PATCH against marketing_campaigns + marketing_campaign_touchpoints.");
    }, 300);
  };
  const onSendTest = () => {
    setActionBusy(true);
    setTimeout(() => {
      setActionBusy(false);
      alert(`Send test to me — chunk 07 calls marketing-send (mode=test) with the admin recipient. ${user?.email ? "Will send to " + user.email : ""}`);
    }, 300);
  };
  const onApprove = () => {
    if (!confirm(`Approve ${state.draft?.schedule?.touchpoints?.length ?? 0} touchpoints and schedule them to ${state.draft?.recipients?.count ?? 0} recipients?`)) return;
    setActionBusy(true);
    setTimeout(() => {
      setActionBusy(false);
      dispatch({ type: "APPROVE_SCHEDULED" });
    }, 400);
  };
  const onRegenerate = (touchpointId) => {
    alert(`Regenerate ${touchpointId} — chunk 07 re-calls marketing-draft-campaign with a regenerate flag for this touchpoint only.`);
  };

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

  // Picks a realistic touchpoint count by duration. Subjects mimic the style
  // real Don writes — short, action-oriented, no clickbait, ≤ 60 chars.
  // Bodies use merge tokens like {{first_name}} and {{school}} so the
  // anti-hallucination pattern is visible end-to-end (the renderer fills
  // them at send time).
  function buildMockSchedule(topics, duration, closer) {
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() + 2);
    const primary = topics[0] ?? "your program";
    function fmtIso(d, hour) {
      const dt = new Date(d);
      dt.setHours(hour, 0, 0, 0);
      return dt.toISOString();
    }
    // Realistic-ish subject lines per touchpoint label. Real Don will write
    // better, more topic-specific copy; this is just to stop the mock from
    // looking like a placeholder.
    const SUBJECT_TEMPLATES = {
      "kickoff": (t) => `${t} is open for registration`,
      "mid-window": (t) => `Halfway through — still time for ${t}`,
      "48h-promo": (t) => `Early-bird pricing ends in 48 hours`,
      "24h-promo": (t) => `Last 24 hours for early-bird pricing`,
      "48h-reg-close": (t) => `Registration closes in 48 hours`,
      "24h-reg-close": (t) => `Last 24 hours to register for ${t}`,
    };
    const BODY_TEMPLATES = {
      "kickoff": (t) => `<p>Hi {{first_name}},</p><p>Great news — ${t} is open for registration at {{school}}. Kids design, code, and build with the tools they already love.</p><p>Tap to register now.</p>`,
      "mid-window": (t) => `<p>Hi {{first_name}},</p><p>Just a heads-up — spots in ${t} are filling up at {{school}}. Lock yours in before the early-bird pricing ends.</p>`,
      "48h-promo": (t) => `<p>Hi {{first_name}},</p><p>Quick reminder — early-bird pricing for ${t} ends in 48 hours. Register today to save on every program.</p>`,
      "24h-promo": (t) => `<p>Hi {{first_name}},</p><p>Last call for early-bird pricing on ${t} — it ends tomorrow. Register tonight to lock in the savings.</p>`,
      "48h-reg-close": (t) => `<p>Hi {{first_name}},</p><p>Registration for ${t} at {{school}} closes in 48 hours. If you've been thinking about it, now's the moment.</p>`,
      "24h-reg-close": (t) => `<p>Hi {{first_name}},</p><p>One more day to register your kid for ${t} at {{school}}. After tomorrow, the roster is set.</p>`,
    };
    const plan = [
      { offset: 0,  label: "kickoff",       hour: 10 },
      { offset: 7,  label: "mid-window",    hour: 10 },
      { offset: 14, label: "48h-promo",     hour: 10 },
      { offset: 15, label: "24h-promo",     hour: 7  },
      { offset: 21, label: "48h-reg-close", hour: 10 },
      { offset: 22, label: "24h-reg-close", hour: 7  },
    ];
    const count =
      duration === "2 weeks" ? 3 :
      duration === "1 month" ? 6 :
      duration === "2 months" ? 6 :
      4;
    return plan.slice(0, count).map((p, i) => {
      const at = new Date(startDate);
      at.setDate(startDate.getDate() + p.offset);
      const subject = (SUBJECT_TEMPLATES[p.label] ?? ((t) => `${t} update`))(primary);
      const body = (BODY_TEMPLATES[p.label] ?? ((t) => `<p>Hi {{first_name}},</p><p>${t} update.</p>`))(primary);
      return {
        id: `mock-tp-${i}`,
        order_index: i,
        type: "email",
        label: p.label,
        scheduled_at: fmtIso(at, p.hour),
        subject: subject.slice(0, 60),
        body_html: `${body}${closer ? `<p><em>${closer}</em></p>` : ""}`,
        body_text: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
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

  if (state.step === "review" && state.scheduled) {
    return (
      <CelebrationScreen
        draft={state.draft}
        onReset={() => dispatch({ type: "RESET" })}
      />
    );
  }

  if (state.step === "review") {
    return (
      <ScheduleReview
        draft={state.draft}
        org={org}
        onBack={() => dispatch({ type: "BACK" })}
        onReset={() => dispatch({ type: "RESET" })}
        onUpdateTouchpoint={updateTouchpoint}
        onRemoveRecipient={removeRecipient}
        onSaveDraft={onSaveDraft}
        onSendTest={onSendTest}
        onApprove={onApprove}
        onRegenerate={onRegenerate}
        busy={actionBusy}
      />
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

function CelebrationScreen({ draft, onReset }) {
  const count = draft?.schedule?.touchpoints?.length ?? 0;
  const recipientCount = draft?.recipients?.count ?? 0;
  const first = draft?.schedule?.touchpoints?.[0];
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", paddingTop: 24, textAlign: "center" }}>
      <div style={{ fontSize: 56 }}>🎉</div>
      <h2 style={{ margin: "8px 0 4px", fontSize: 28, color: PLUM }}>Huzzah!</h2>
      <p style={{ margin: 0, color: INK, fontSize: 15 }}>
        {count} touchpoint{count === 1 ? "" : "s"} scheduled for {recipientCount} recipient{recipientCount === 1 ? "" : "s"}. Don will take it from here.
      </p>
      <div style={{ marginTop: 16, display: "inline-flex", alignItems: "center", gap: 6, background: "#EAF3DE", color: OK, fontWeight: 600, fontSize: 13, padding: "6px 12px", borderRadius: 999, border: `1px solid ${OK}` }}>
        ⏱ Hours of work, done in 90 seconds
      </div>

      {first && (
        <div style={{ textAlign: "left", marginTop: 24, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 16 }}>
          <p style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, margin: 0 }}>Next up</p>
          <p style={{ margin: "4px 0 0", fontSize: 14, color: INK, fontWeight: 600 }}>
            {first.subject}
          </p>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: MUTED }}>
            {new Date(first.scheduled_at).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
      )}

      <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
        <button
          onClick={() => { window.location.href = "/admin/marketing"; }}
          style={{
            padding: "10px 16px", background: "#fff", color: INK,
            border: `1px solid ${RULE}`, borderRadius: 6, cursor: "pointer",
            fontSize: 14, fontFamily: "inherit", fontWeight: 500,
          }}
        >
          Back to campaigns
        </button>
        <button
          onClick={onReset}
          style={{
            padding: "10px 16px", background: PLUM, color: "#fff",
            border: "none", borderRadius: 6, cursor: "pointer",
            fontSize: 14, fontFamily: "inherit", fontWeight: 600,
          }}
        >
          Build another
        </button>
      </div>

      <p style={{ marginTop: 20, fontSize: 11, color: MUTED }}>
        Chunk 06 mock — real approval flow lands in chunk 07.
      </p>
    </div>
  );
}
