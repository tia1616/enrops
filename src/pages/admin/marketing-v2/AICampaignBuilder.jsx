// AICampaignBuilder — top-level container for the campaign-builder flow.
//
// inputs shape (passed to marketing-draft-campaign):
//   what: {
//     mode: 'programs' | 'camps' | 'other',
//     program_ids: uuid[],        // when mode='programs' — selected `programs` rows
//     camp_session_ids: uuid[],   // when mode='camps' — selected `camp_sessions` rows
//     topics: string[],           // when mode='other' — free-text fallback (partner notes etc.)
//   }
//   who: { audience: 'parents'|'partners'|'instructors', filter: WhoFilter }
//        — when what.mode='programs'/'camps', filter defaults to 'auto' (derived from picks)
//   promo: {
//     early_bird: boolean,           // lead with early-bird savings
//     vip_option: boolean,           // mention STEAM VIP full-year add-on
//     multi_camp_discount: boolean,  // applies BUILD10 promo_code when 2+ camps selected
//     code: string|null,             // optional custom promo_codes.code
//   }
//   duration: string
//   channels: string[]
//
// Edge function loads the selected program/camp rows server-side and injects them
// as KNOWN FACTS into Ennie's prompt — replacing the old fuzzy-string curriculum
// match for the structured path. Falls back to fuzzy match when mode='other'.
//
// All tenant context (org, user) comes from useOutletContext(). No hardcoded ids.

import { useReducer, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
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
    what: {
      mode: "programs",
      program_ids: [],
      camp_session_ids: [],
      topics: [],
    },
    who: { audience: "parents", filter: { type: "auto" } },
    promo: {
      early_bird: false,
      vip_option: false,
      multi_camp_discount: false,
      code: null,
    },
    operator_notes: "",
    registration_url_override: "",
    duration: "",
    send_at: "", // one-off send time (ISO string or 'now'). Used when what.mode='other'.
    channels: ["email"],
  },
  draft: null,
  loading: false,
  error: null,
  scheduled: false,
};

// Final cleanup before sending inputs to the edge function. Q2 already
// resolves filter.type='auto' into a concrete scope, so this is just
// belt-and-suspenders: strip the internal `auto_derived` flag and fall
// back to master_list if filter somehow stayed 'auto'. The structured
// `what` shape (mode + program_ids / camp_session_ids / topics) and
// promo are forwarded as-is — the edge function loads the rows
// server-side and injects grounded facts into Ennie's prompt.
function prepareInputsForEdge(inputs) {
  const { auto_derived: _drop, ...filterCore } = inputs.who.filter ?? {};
  const cleanFilter = filterCore.type === "auto"
    ? { type: "master_list" }
    : filterCore;
  return {
    ...inputs,
    who: { ...inputs.who, filter: cleanFilter },
  };
}

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
  if (step === 1) {
    const w = inputs.what;
    if (!w?.mode) return false;
    if (w.mode === "programs") return Array.isArray(w.program_ids) && w.program_ids.length > 0;
    if (w.mode === "camps") return Array.isArray(w.camp_session_ids) && w.camp_session_ids.length > 0;
    if (w.mode === "other") return Array.isArray(w.topics) && w.topics.length > 0;
    return false;
  }
  if (step === 2) {
    if (!inputs.who?.audience) return false;
    if (inputs.who.audience !== "parents") return false; // partners/instructors disabled in v1
    const f = inputs.who.filter;
    if (!f?.type) return false;
    if (f.type === "auto") return true; // derived from what.mode/picks
    if (f.type === "master_list") return true;
    if (f.type === "school") return Array.isArray(f.school_ids) && f.school_ids.length > 0;
    if (f.type === "area") return typeof f.area === "string" && f.area.length > 0;
    if (f.type === "segment") return Array.isArray(f.segments) && f.segments.length > 0;
    if (f.type === "person") return !!f.recipient_id;
    return false;
  }
  if (step === 3) {
    // Mode='other' is a one-off send; Q3 collects a send time instead of duration.
    if (inputs.what?.mode === "other") {
      return typeof inputs.send_at === "string" && inputs.send_at.length > 0;
    }
    const d = inputs.duration ?? "";
    if (!d) return false;
    // Custom range: only valid once both start and end dates are filled
    if (d.startsWith("custom")) {
      const m = d.match(/^custom:\s*(\d{4}-\d{2}-\d{2})\s*to\s*(\d{4}-\d{2}-\d{2})/);
      return !!m;
    }
    return true;
  }
  if (step === 4) return inputs.channels.length > 0;
  return false;
}

export default function AICampaignBuilder() {
  const { org, user } = useOutletContext() ?? {};
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const [actionBusy, setActionBusy] = useState(false);

  const setField = (field, value) => dispatch({ type: "SET_FIELD", field, value });
  const next = () => dispatch({ type: "NEXT" });
  // On step 1 there's no previous question, so Back exits the builder back
  // to the admin overview instead of being a dead button. Q2/3/4 use the
  // normal in-flow dispatch.
  const back = () => {
    if (state.step === 1) { navigate("/admin"); return; }
    dispatch({ type: "BACK" });
  };

  // Local-only updates for chunk 06. Chunk 07 PATCHes the touchpoint row.
  const updateTouchpoint = (id, patch) => dispatch({ type: "UPDATE_TOUCHPOINT", id, patch });
  const removeRecipient = (id) => dispatch({ type: "REMOVE_RECIPIENT", id });

  // Save as draft — still a stub. Approve flow lands first (next commit) since
  // approve is what unblocks the actual send. Save-as-draft is "park this for
  // later" which is lower priority.
  const onSaveDraft = () => {
    setActionBusy(true);
    setTimeout(() => {
      setActionBusy(false);
      alert("Save as draft — coming soon. For now the draft persists automatically; you can come back and approve later.");
    }, 300);
  };

  // Send a single touchpoint to the admin's inbox for preview. Calls
  // marketing-touchpoint-send with mode='test' which bootstraps the admin
  // into marketing_recipients (segment='_internal_admin') and resolves all
  // tokens with real org / program / recipient data.
  const onSendTest = async (touchpointId) => {
    if (!state.draft?.campaign_id) {
      alert("No campaign drafted yet. Draft first, then send test.");
      return;
    }
    if (!touchpointId) {
      alert("No touchpoint selected. Click the touchpoint card first, then send test.");
      return;
    }
    setActionBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("marketing-touchpoint-send", {
        body: {
          campaign_id: state.draft.campaign_id,
          touchpoint_id: touchpointId,
          mode: "test",
        },
      });
      if (error) {
        // Pull friendly error from edge function response when available
        let msg = error.message ?? "Send failed.";
        try {
          const resp = error?.context?.response;
          if (resp && typeof resp.clone === "function") {
            const payload = await resp.clone().json();
            if (payload?.error) msg = payload.error;
          }
        } catch { /* fall through to raw message */ }
        alert(`Test send failed: ${msg}`);
        return;
      }
      if (data?.sent > 0) {
        alert(`Test sent to ${user?.email ?? "your inbox"}. Check your inbox in a moment.`);
      } else if (data?.skipped_suppressed > 0) {
        alert("Test skipped: your email is on this org's suppression list. Unsubscribe somewhere?");
      } else if (data?.skipped_no_school_program > 0) {
        alert("Test skipped: as the admin recipient, you don't have a school that matches any picked program. (Expected — admin bootstrap has no school.)");
      } else if (data?.skipped_deduped > 0) {
        alert("Test skipped: this campaign already sent to your inbox once. (Dedup is per-campaign right now.)");
      } else {
        alert(`Test attempted but nothing landed. Response: ${JSON.stringify(data)}`);
      }
    } finally {
      setActionBusy(false);
    }
  };

  // Approve & schedule — real DB write. Marks campaign as approved with the
  // current user as approver and bumps status to 'sending'. The touchpoint
  // cron polls campaigns with approved_at IS NOT NULL and fires queued
  // touchpoints as their scheduled_at times arrive. Idempotency: the update
  // is guarded by .is('approved_at', null) so a double-click can't re-approve
  // (and the second click gets a clean "already approved" path).
  const onApprove = async () => {
    if (!state.draft?.campaign_id) {
      alert("No campaign drafted yet. Draft first.");
      return;
    }
    const tpCount = state.draft?.schedule?.touchpoints?.length ?? 0;
    const recipientCount = state.draft?.recipients?.count ?? 0;
    if (!confirm(`Approve ${tpCount} touchpoint${tpCount === 1 ? "" : "s"} and schedule to ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}? Once approved, Ennie sends each touchpoint at its scheduled time. You can't edit after this.`)) return;
    setActionBusy(true);
    try {
      // Captures audience at approve time. If parents subscribe/unsubscribe
      // between draft and send, the approved campaign sends to the
      // approve-time list. Cron reads this column.
      const recipientIds = state.draft?.recipients?.ids ?? [];
      const { data, error } = await supabase
        .from("marketing_campaigns")
        .update({
          approved_at: new Date().toISOString(),
          approved_by: user?.id ?? null,
          status: "sending",
          approved_recipient_ids: recipientIds,
        })
        .eq("id", state.draft.campaign_id)
        .is("approved_at", null) // idempotency guard
        .select("id, approved_at")
        .maybeSingle();
      if (error) {
        alert(`Approve failed: ${error.message}`);
        return;
      }
      if (!data) {
        // Either RLS hid the row OR approved_at was already set (double-click).
        // Re-fetch to find out which.
        const { data: existing } = await supabase
          .from("marketing_campaigns")
          .select("approved_at")
          .eq("id", state.draft.campaign_id)
          .maybeSingle();
        if (existing?.approved_at) {
          // Already approved earlier — treat as success
          dispatch({ type: "APPROVE_SCHEDULED" });
          return;
        }
        alert("Couldn't approve — campaign not found or you don't have admin access.");
        return;
      }
      dispatch({ type: "APPROVE_SCHEDULED" });
    } finally {
      setActionBusy(false);
    }
  };
  const onRegenerate = (touchpointId) => {
    alert(`Regenerate ${touchpointId} — coming soon.`);
  };

  async function startDrafting() {
    if (!org?.id) {
      dispatch({ type: "DRAFT_FAILED", error: "Couldn't find your organization. Refresh and try again." });
      return;
    }
    dispatch({ type: "START_DRAFTING" });

    // Edge function consumes the structured `what` shape directly — loads
    // program/camp rows server-side and injects grounded facts into Ennie's
    // prompt. No more client-side bridge / topic derivation.
    const inputsForEdge = prepareInputsForEdge(state.inputs);

    const { data, error } = await supabase.functions.invoke("marketing-draft-campaign", {
      body: { organization_id: org.id, inputs: inputsForEdge },
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
          onClick={() => { window.location.href = "/admin/marketing-v2"; }}
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
