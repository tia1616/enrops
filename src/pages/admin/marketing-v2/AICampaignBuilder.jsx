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
import { PURPLE, BRIGHT, RULE, INK, MUTED, OK } from "../marketing/tokens.jsx";
import Q1_What from "./questions/Q1_What.jsx";
import Q2_Who from "./questions/Q2_Who.jsx";
import Q3_Duration from "./questions/Q3_Duration.jsx";
import Q4_Channels from "./questions/Q4_Channels.jsx";
import ScheduleReview from "./ScheduleReview.jsx";
import DraftingScreen from "./DraftingScreen.jsx";
import FamilyCommsTabs from "./FamilyCommsTabs.jsx";
import CampaignsList from "./CampaignsList.jsx";
import CampaignDetail from "./CampaignDetail.jsx";

const INITIAL = {
  // "list"   = the Campaigns landing (drafts + scheduled list + Build button).
  // 1..4 → "review" = the numbered wizard, entered via START_NEW / LOAD_DRAFT.
  // "detail" = read/manage a single scheduled campaign (detail_id holds which).
  step: "list",
  // Which campaign the "detail" step is showing. Set by OPEN_DETAIL.
  detail_id: null,
  inputs: {
    what: {
      mode: "programs",
      program_ids: [],
      camp_session_ids: [],
      topics: [],
      // Identifier of the Q1 intent the operator picked (e.g. 'last_call',
      // 'registration_opened', 'fill_remaining_seats', 'low_enrollment_push',
      // 'other_schedule_change'). Drives tone/cadence in the edge function
      // prompt's INTENT-DRIVEN rule. null = operator used the manual catalog
      // picker, in which case the edge function falls back to the duration-
      // and-deadline cadence heuristics.
      intent_key: null,
    },
    who: { audience: "parents", filter: { type: "auto" }, exclude_already_registered: false },
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
  // A null payload means a platform-level failure (timeout / crash) whose body
  // isn't the edge function's own JSON — `code` is then the SDK's generic
  // "Edge Function returned a non-2xx status code" string. Translate that into
  // something a non-technical operator can actually act on.
  if (!payload) {
    return "Ennie hit a snag drafting this — it may have taken too long. Give it another try; if it keeps failing, let us know.";
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
    case "APPLY_PRESELECT": {
      // Applies an intent's preselect (from lib/intents.js) atomically. Each
      // intent click is a fresh campaign start, so `who` is replaced wholesale
      // (intent owns the audience scope). `promo` is merged over defaults
      // when the intent specified one, otherwise defaults stand. `what` is
      // merged so the operator's pre-existing topics/notes aren't dropped if
      // they happen to be set — though for Q1 cards they'll typically be empty.
      const p = action.preselect ?? {};
      return {
        ...state,
        inputs: {
          ...state.inputs,
          what: { ...state.inputs.what, ...(p.what ?? {}) },
          who: p.who ?? state.inputs.who,
          duration: p.duration ?? state.inputs.duration,
          promo: p.promo
            ? { ...state.inputs.promo, ...p.promo }
            : state.inputs.promo,
        },
      };
    }
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
    case "START_NEW":
      // Fresh wizard from the list (or "Build another" on the success screen).
      return { ...INITIAL, step: 1 };
    case "LOAD_DRAFT":
      // Resume an existing draft: hydrate the wizard from the saved campaign +
      // its touchpoints and jump straight to the review screen. inputs come
      // from the draft's draft_inputs (merged over INITIAL so any newer input
      // fields not present on an older draft still have sane defaults).
      return {
        ...INITIAL,
        step: "review",
        inputs: {
          ...INITIAL.inputs,
          ...(action.inputs ?? {}),
        },
        draft: action.draft,
      };
    case "OPEN_DETAIL":
      // Open a scheduled campaign's detail/manage view.
      return { ...INITIAL, step: "detail", detail_id: action.campaignId };
    case "GO_LIST":
      // Back to the Campaigns landing, discarding any in-progress wizard state.
      return { ...INITIAL, step: "list" };
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
    if (f.type === "area") {
      // Multi-select 2026-06-02. Tolerate legacy single-area drafts so back-
      // navigation from a previously-loaded draft still validates.
      if (Array.isArray(f.areas)) return f.areas.length > 0;
      return typeof f.area === "string" && f.area.length > 0;
    }
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
  // Tracks which long-running button is currently in flight so each button can
  // show its OWN spinner copy ("Saving…" / "Sending test…" / "Approving…")
  // instead of every button reflecting whichever one was clicked. null = idle.
  const [busyAction, setBusyAction] = useState(null); // null | 'save' | 'test' | 'approve'

  const setField = (field, value) => dispatch({ type: "SET_FIELD", field, value });
  // Apply an intent preselect AND advance to Q2 in one dispatch — the
  // operator's intent click is "I pick this, take me to review."
  const applyPreselectAndAdvance = (preselect) => {
    dispatch({ type: "APPLY_PRESELECT", preselect });
    dispatch({ type: "NEXT" });
  };
  const next = () => dispatch({ type: "NEXT" });
  // On step 1 there's no previous question, so Back returns to the Campaigns
  // list (the tab's landing) instead of being a dead button. Q2/3/4 use the
  // normal in-flow dispatch.
  const back = () => {
    if (state.step === 1) { dispatch({ type: "GO_LIST" }); return; }
    dispatch({ type: "BACK" });
  };

  // In-memory only — wires keystroke-by-keystroke updates so the UI stays
  // responsive without firing a DB write per character. The matching
  // commitTouchpoint below persists at natural save points (textarea Done
  // editing, EditableField blur, datetime change) so Send test / Approve
  // / a tab refresh always reflects what the operator sees on screen.
  const updateTouchpoint = (id, patch) => dispatch({ type: "UPDATE_TOUCHPOINT", id, patch });
  const removeRecipient = (id) => dispatch({ type: "REMOVE_RECIPIENT", id });

  // Persist the touchpoint to the DB. Dispatches the in-memory update first
  // so React state is the latest, then PATCHes the row using the merged
  // (existing + patch) payload. Skips DB write if no campaign_id yet (the
  // operator is still building before the first Draft call).
  const commitTouchpoint = async (id, patch) => {
    dispatch({ type: "UPDATE_TOUCHPOINT", id, patch });
    if (!state.draft?.campaign_id) return;
    const tp = state.draft?.schedule?.touchpoints?.find((t) => t.id === id);
    if (!tp) return;
    const merged = { ...tp, ...patch };
    try {
      const { error } = await supabase
        .from("marketing_campaign_touchpoints")
        .update({
          scheduled_at: merged.scheduled_at,
          payload: {
            label: merged.label,
            subject: merged.subject ?? null,
            body_html: merged.body_html ?? null,
            body_text: merged.body_text ?? null,
            // Preserve the server-computed timing reason so editing a resumed
            // draft doesn't wipe the "why this email lands when it does" copy.
            reason: merged.reason ?? null,
          },
          topics: merged.topics ?? [],
        })
        .eq("id", id);
      if (error) console.error("[commitTouchpoint] PATCH failed:", error);
    } catch (e) {
      console.error("[commitTouchpoint] exception:", e);
    }
  };

  // Save as draft — persists any inline edits the operator made on
  // ScheduleReview (subject/body/scheduled_at) to the touchpoint rows.
  // Campaign row itself is already in 'draft' status from when Ennie's draft
  // call created it; this just snapshots the operator's working state so
  // approve-later picks up the edits, not the original.
  const onSaveDraft = async () => {
    if (!state.draft?.campaign_id) {
      alert("No campaign drafted yet. Walk through Q1–Q4 + click Draft first.");
      return;
    }
    const touchpoints = state.draft?.schedule?.touchpoints ?? [];
    if (touchpoints.length === 0) {
      alert("No touchpoints to save.");
      return;
    }
    setBusyAction("save");
    try {
      // PATCH each touchpoint with current local state. Campaigns table
      // itself doesn't need updating — campaign is already in 'draft' with
      // approved_at=null, which is what we want.
      const updates = touchpoints.map((tp) => supabase
        .from("marketing_campaign_touchpoints")
        .update({
          scheduled_at: tp.scheduled_at,
          payload: {
            label: tp.label,
            subject: tp.subject ?? null,
            body_html: tp.body_html ?? null,
            body_text: tp.body_text ?? null,
            reason: tp.reason ?? null,
          },
          topics: tp.topics ?? [],
        })
        .eq("id", tp.id));
      const results = await Promise.all(updates);
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        alert(`Saved ${results.length - failed.length} of ${results.length}. ${failed.length} touchpoint${failed.length === 1 ? "" : "s"} failed: ${failed[0].error.message}`);
        return;
      }
      // Refresh the local draft state so subsequent edits compare against
      // the latest persisted version (no surprise overwrites).
      alert(`Saved! Your changes are safe. This stays a draft until you hit Approve — reopen it any time from Campaigns → Drafts → Resume.`);
      // Return to the Campaigns list so the operator sees their saved draft and
      // isn't stranded on the review screen (the top tabs / sidebar are route
      // links to the route we're already on, so they can't reset the wizard).
      dispatch({ type: "GO_LIST" });
    } finally {
      setBusyAction(null);
    }
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
    setBusyAction("test");
    try {
      const { data, error } = await supabase.functions.invoke("marketing-touchpoint-send", {
        body: {
          campaign_id: state.draft.campaign_id,
          touchpoint_id: touchpointId,
          mode: "test",
        },
      });
      if (error) {
        // Pull friendly error from edge function response when available.
        // supabase-js wraps non-2xx as FunctionsHttpError with the original
        // Response on error.context — clone+read for the JSON body Ennie's
        // function actually returned.
        let msg = error.message ?? "Send failed.";
        let rawBody = null;
        let httpStatus = null;
        try {
          const resp = error?.context?.response ?? error?.context;
          if (resp && typeof resp.clone === "function") {
            httpStatus = resp.status;
            const text = await resp.clone().text();
            rawBody = text;
            try {
              const payload = JSON.parse(text);
              if (payload?.error) msg = payload.error;
            } catch { /* not JSON, leave msg alone */ }
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[onSendTest] failed to read error body:", e);
        }
        // eslint-disable-next-line no-console
        console.error("[onSendTest] edge function error", { httpStatus, msg, rawBody, error });
        alert(`Test send failed (HTTP ${httpStatus ?? "?"}): ${msg}\n\nFull response body logged to console.`);
        return;
      }
      if (data?.sent > 0) {
        alert(`Test sent to ${user?.email ?? "your inbox"}. Check your inbox in a moment.`);
      } else if (data?.skipped_suppressed > 0) {
        alert("Test skipped: your email is on this org's suppression list. Unsubscribe somewhere?");
      } else if (data?.skipped_no_school_program > 0) {
        // This fires in a defensive edge case where the admin recipient isn't
        // tagged _internal_admin so the first-program fallback didn't kick in.
        // Operator-facing copy: just point them to the in-app preview dropdown
        // instead, which always works regardless of recipient state.
        alert("Couldn't render this preview by email. Use the 'Preview as parent at' dropdown above the email body — it shows the same rendered output for any school you pick, no email needed.");
      } else if (data?.skipped_deduped > 0) {
        // TODO: test mode should bypass per-touchpoint dedup — operators want
        // to re-preview the same touchpoint after edits. Backlog'd alongside
        // the other Family Comms audit items. For now, this alert just tells
        // them why the second click went nowhere.
        alert("Already previewed this touchpoint once today. Try a different touchpoint, or click Edit on the body to make a change and redraft.");
      } else {
        alert(`Test attempted but nothing landed. Response: ${JSON.stringify(data)}`);
      }
    } finally {
      setBusyAction(null);
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
    // Guard: approving with no audience silently schedules to nobody. This is
    // easy to hit on a RESUMED draft, whose recipients aren't re-resolved yet.
    // Block it and send the operator back to pick the audience.
    if (recipientCount === 0) {
      alert('This campaign has no audience yet — approving now would send to nobody. Go back to "Who" and pick who should get it, then approve.');
      return;
    }
    if (!confirm(`Approve ${tpCount} touchpoint${tpCount === 1 ? "" : "s"} and schedule to ${recipientCount} recipient${recipientCount === 1 ? "" : "s"}? Once approved, Ennie sends each touchpoint at its scheduled time. You can't edit after this.`)) return;
    setBusyAction("approve");
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
      setBusyAction(null);
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

  // Resume a saved draft from the Campaigns list. Fetches the campaign row +
  // its touchpoints, maps each touchpoint to the builder's in-memory shape,
  // and dispatches LOAD_DRAFT to hydrate the review screen. Recipients are a
  // best-effort snapshot from approved_recipient_ids (drafts may have none yet).
  const resumeDraft = async (campaignId) => {
    if (!campaignId || !org?.id) return;
    try {
      const [cRes, tpRes] = await Promise.all([
        supabase
          .from("marketing_campaigns")
          .select("id, name, status, draft_inputs, approved_recipient_ids")
          .eq("id", campaignId)
          .eq("organization_id", org.id)
          .maybeSingle(),
        supabase
          .from("marketing_campaign_touchpoints")
          .select("id, order_index, scheduled_at, status, payload, topics")
          .eq("campaign_id", campaignId)
          .eq("organization_id", org.id)
          .order("order_index", { ascending: true }),
      ]);
      if (cRes.error) throw cRes.error;
      if (tpRes.error) throw tpRes.error;
      const campaign = cRes.data;
      if (!campaign) {
        alert("Couldn't open that draft — it may have been deleted, or you don't have access.");
        return;
      }
      // Map each touchpoint row to the builder's touchpoint shape.
      const touchpoints = (tpRes.data ?? []).map((tp) => ({
        id: tp.id,
        type: "email",
        order_index: tp.order_index,
        label: tp.payload?.label ?? "",
        subject: tp.payload?.subject ?? "",
        body_html: tp.payload?.body_html ?? "",
        body_text: tp.payload?.body_text ?? "",
        reason: tp.payload?.reason ?? "",
        topics: tp.topics ?? [],
        scheduled_at: tp.scheduled_at,
        status: tp.status,
      }));
      const recipientIds = campaign.approved_recipient_ids ?? [];
      const draft = {
        campaign_id: campaign.id,
        schedule: {
          summary: "",
          notes_to_operator: "",
          touchpoints,
        },
        sender: { name: org?.default_sender_name, email: org?.default_sender_email },
        recipients: {
          ids: recipientIds,
          count: recipientIds.length,
          segment_summary: "",
        },
        mechanical_checks: null,
        warning: null,
      };
      dispatch({ type: "LOAD_DRAFT", inputs: campaign.draft_inputs ?? {}, draft });
    } catch (err) {
      alert(`Couldn't open that draft: ${err?.message ?? "unknown error"}`);
    }
  };

  // ---- Render ----
  if (!org) {
    return (
      <div style={{ padding: 24, color: MUTED }}>
        Loading your org context…
      </div>
    );
  }

  if (state.step === "list") {
    return (
      <CampaignsList
        onNew={() => dispatch({ type: "START_NEW" })}
        onResume={(campaignId) => resumeDraft(campaignId)}
        onOpenDetail={(campaignId) => dispatch({ type: "OPEN_DETAIL", campaignId })}
      />
    );
  }

  if (state.step === "detail") {
    return (
      <CampaignDetail
        campaignId={state.detail_id}
        org={org}
        onBack={() => dispatch({ type: "GO_LIST" })}
      />
    );
  }

  if (state.step === "review" && state.scheduled) {
    return (
      <CelebrationScreen
        draft={state.draft}
        onReset={() => dispatch({ type: "START_NEW" })}
        onHome={() => navigate("/admin")}
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
        // Pass the operator's in-memory picks so ScheduleReview can resolve
        // the picked-schools dropdown without a redundant round-trip to
        // marketing_campaigns.draft_inputs (same data lives in both places
        // by the time we're rendering ScheduleReview).
        inputs={state.inputs}
        org={org}
        onBack={() => dispatch({ type: "BACK" })}
        onReset={() => dispatch({ type: "RESET" })}
        onUpdateTouchpoint={updateTouchpoint}
        onCommitTouchpoint={commitTouchpoint}
        onRemoveRecipient={removeRecipient}
        onSaveDraft={onSaveDraft}
        onSendTest={onSendTest}
        onApprove={onApprove}
        onRegenerate={onRegenerate}
        busy={busyAction !== null}
        busyAction={busyAction}
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
    onApplyPreselect: applyPreselectAndAdvance, // Q1 only
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 96 }}>
      <FamilyCommsTabs active="marketing" onReset={() => dispatch({ type: "GO_LIST" })} />
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
        <div style={{ width: `${pct}%`, height: "100%", background: BRIGHT, transition: "width 0.18s ease" }} />
      </div>
    </div>
  );
}

function CelebrationScreen({ draft, onReset, onHome }) {
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
        <div style={{ textAlign: "left", marginTop: 24, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 16 }}>
          <p style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600, margin: 0 }}>Next up</p>
          <p style={{ margin: "4px 0 0", fontSize: 14, color: INK, fontWeight: 600 }}>
            {/* Subject contains tokens like {{school}} that resolve per-recipient
                at send time. The success screen has no recipient context, so
                we replace tokens with friendly placeholders for display only —
                the real send still resolves them per parent. */}
            {first.subject?.replace(/\{\{school\}\}/g, "your school")
                          .replace(/\{\{first_name\}\}/g, "there")
                          .replace(/\{\{curriculum\}\}/g, "the program")
                          .replace(/\{\{\w+\}\}/g, "")}
          </p>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: MUTED }}>
            {new Date(first.scheduled_at).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </p>
        </div>
      )}

      <div style={{ marginTop: 24, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
        <button
          onClick={onHome}
          style={{
            padding: "10px 16px", background: "#fff", color: INK,
            border: `1px solid ${RULE}`, borderRadius: 6, cursor: "pointer",
            fontSize: 14, fontFamily: "inherit", fontWeight: 500,
          }}
        >
          Back to admin home
        </button>
        <button
          onClick={onReset}
          style={{
            padding: "10px 16px", background: BRIGHT, color: "#fff",
            border: "none", borderRadius: 6, cursor: "pointer",
            fontSize: 14, fontFamily: "inherit", fontWeight: 600,
          }}
        >
          Build another
        </button>
      </div>

    </div>
  );
}
