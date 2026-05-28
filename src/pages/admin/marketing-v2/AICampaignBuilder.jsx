// AICampaignBuilder — top-level container for the 4-question flow.
// Chunk 3.6.07 step 1 — real fetch to marketing-draft-campaign.
//
// State is forward-compatible with the deployed `marketing-draft-campaign`:
//   - inputs.what: string[] (multi-topic) — UI starts with a single chip but the
//     shape carries the array so chunk 06/07 can add more without state churn.
//   - inputs.who: structured WhoInput (audience + filter) — same forward-compat.
// All tenant context (org, user) comes from useOutletContext(). No hardcoded ids.

import { useReducer, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { PURPLE, RULE, INK, MUTED, OK } from "../marketing/tokens.jsx";
import Q1_What from "./questions/Q1_What.jsx";
import Q2_Who from "./questions/Q2_Who.jsx";
import Q3_Duration from "./questions/Q3_Duration.jsx";
import Q4_Channels from "./questions/Q4_Channels.jsx";
import ScheduleReview from "./ScheduleReview.jsx";
import DraftingScreen from "./DraftingScreen.jsx";

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

// supabase-js wraps non-2xx edge-function responses in FunctionsHttpError with
// the raw Response on `context.response`. Read it to surface the edge function's
// own JSON error message (e.g. org_not_configured, draft_timeout) — falling back
// to the SDK message if the body isn't parseable.
async function friendlyDraftError(error) {
  let payload = null;
  try {
    const resp = error?.context?.response;
    if (resp && typeof resp.clone === "function") {
      payload = await resp.clone().json();
    }
  } catch {
    // body wasn't JSON or already consumed — fall back below
  }
  const code = payload?.error ?? error?.message ?? "unknown_error";
  if (code === "org_not_configured") {
    const missing = Array.isArray(payload?.missing) ? payload.missing.join(", ") : "sender info";
    return `Your org is missing ${missing}. Add it in Settings, then try again.`;
  }
  if (code === "draft_timeout") {
    return "Ennie took too long to draft this one. Try again — usually clears up on a retry.";
  }
  if (typeof code === "string" && code.toLowerCase().includes("forbidden")) {
    return "You don't have admin access to this org's marketing.";
  }
  if (typeof code === "string" && code.startsWith("audience ")) {
    return "Only the Parents audience is supported in this build. Partners + Instructors are coming soon.";
  }
  return `Couldn't draft the campaign: ${code}`;
}

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
    const f = inputs.who.filter;
    if (!f?.type) return false;
    if (f.type === "master_list") return true;
    if (f.type === "school") return Array.isArray(f.school_ids) && f.school_ids.length > 0;
    if (f.type === "area") return typeof f.area === "string" && f.area.length > 0;
    if (f.type === "segment") return Array.isArray(f.segments) && f.segments.length > 0;
    if (f.type === "person") return !!f.recipient_id;
    return false;
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

  async function startDrafting() {
    if (!org?.id) {
      dispatch({ type: "DRAFT_FAILED", error: "Couldn't find your organization. Refresh and try again." });
      return;
    }
    dispatch({ type: "START_DRAFTING" });
    const { data, error } = await supabase.functions.invoke("marketing-draft-campaign", {
      body: { organization_id: org.id, inputs: state.inputs },
    });
    if (error) {
      const msg = await friendlyDraftError(error);
      dispatch({ type: "DRAFT_FAILED", error: msg });
      return;
    }
    if (!data?.schedule?.touchpoints?.length) {
      dispatch({ type: "DRAFT_FAILED", error: "Ennie couldn't draft a schedule. Try again, or simplify the topics." });
      return;
    }
    dispatch({
      type: "DRAFT_RECEIVED",
      draft: {
        campaign_id: data.campaign_id,
        schedule: {
          summary: data.schedule.summary,
          notes_to_operator: data.schedule.notes_to_operator ?? "",
          touchpoints: data.schedule.touchpoints,
        },
        sender: data.sender,
        recipients: data.recipients,
        mechanical_checks: data.mechanical_checks ?? null,
        warning: data.warning ?? null,
      },
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

  if (state.loading) {
    return <DraftingScreen />;
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
        <span style={{ color: PURPLE, fontWeight: 600 }}>Question {stepNum}</span>
        <span>of 4</span>
      </div>
      <div style={{ marginTop: 6, height: 4, background: RULE, borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: PURPLE, transition: "width 0.18s ease" }} />
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
      <h2 style={{ margin: "8px 0 4px", fontSize: 28, color: PURPLE }}>Huzzah!</h2>
      <p style={{ margin: 0, color: INK, fontSize: 15 }}>
        {count} touchpoint{count === 1 ? "" : "s"} scheduled for {recipientCount} recipient{recipientCount === 1 ? "" : "s"}. Ennie will take it from here.
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
            padding: "10px 16px", background: PURPLE, color: "#fff",
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
