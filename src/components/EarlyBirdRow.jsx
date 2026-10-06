// The "Early bird" row on the program form: what this program will get, and a
// switch to take it out.
//
// ONE component for all three places a program is created or edited (the classic
// wizard, the lean builder, and the Programs calendar's edit panel) so the three
// cannot drift into saying different things about the same rule.
//
// Nothing here decides anything. The eligibility rule and the price both come
// back from program_early_bird_preview, which is the same SQL the term-wide Apply
// runs, so the row's "-> $260" and what Apply would write are one number. See
// src/lib/earlyBird.js for why no price is computed on this side.
//
// THE TRAP IN THE RPC's SHAPE: it returns early_bird_cents (what the term's
// discount COMES TO for this price) alongside skip_reason, and it fills both in.
// A cancelled $285 class comes back as early_bird_cents 26000, skip_reason
// 'cancelled'. The price is only ever shown when skip_reason is null.

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase.js";
import {
  formatDeadlineShort,
  formatDollars,
  skipReasonSentence,
  isReasonReversible,
} from "../lib/earlyBird.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const GREEN_BG = "#f0fdf4";
const GREEN_INK = "#166534";

// Ask the database what this program would get. Re-asks whenever any input the
// rule reads changes, debounced because price is typed a digit at a time.
//
// p_opt_out is always false: we want the INHERENT answer -- "may this class have
// an early bird at all" -- so that turning the switch off doesn't erase the
// explanation of what it would get if turned back on. Whether the operator has
// switched it off is this component's own state, not a question for the rule.
export function useEarlyBirdPreview({ orgId, term, priceCents, status, runsOwnRegistration, priceTier }) {
  // undefined = still asking. null = the lookup failed, which is NOT "no early
  // bird": a save must leave the stored value alone rather than act on a guess.
  const [preview, setPreview] = useState(undefined);

  useEffect(() => {
    if (!orgId || !term) { setPreview(undefined); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc("program_early_bird_preview", {
        p_org: orgId,
        p_term: term,
        p_status: status ?? "open",
        p_runs_own_registration: !!runsOwnRegistration,
        p_price_tier: priceTier ?? "standard",
        p_price_cents: priceCents == null || priceCents === "" ? 0 : Number(priceCents),
        p_opt_out: false,
      });
      if (cancelled) return;
      if (error) { setPreview(null); return; }
      setPreview((Array.isArray(data) ? data[0] : data) ?? null);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [orgId, term, priceCents, status, runsOwnRegistration, priceTier]);

  return preview;
}

// The columns a save should write, or null meaning "don't touch the early-bird
// fields at all".
//
// Returning null is the fail-safe direction and it is used twice. A lookup that
// failed must not wipe a discount a family is registering under, and a term whose
// programs carry DIFFERENT discounts has no price this form could honestly write
// -- in both cases the stored value is the best answer available, so it stays.
// The operator is told which of those two it is by the row itself.
export function earlyBirdPatch(preview, enabled) {
  if (!preview) return null;                       // still asking, or lookup failed
  if (preview.skip_reason) {
    // Not allowed one. Clear any it is carrying -- this is what stops a cancelled
    // class keeping its discount -- but do NOT record an opt-out: the operator
    // did not choose this, and recording it would keep the class out of the term
    // discount even after it is un-cancelled.
    return { early_bird_price_cents: null, early_bird_deadline: null };
  }
  if (preview.early_bird_cents == null) return null; // no offer, or no single one
  return enabled
    ? {
        early_bird_price_cents: preview.early_bird_cents,
        early_bird_deadline: preview.deadline,
        early_bird_opt_out: false,
      }
    : { early_bird_price_cents: null, early_bird_deadline: null, early_bird_opt_out: true };
}

// How the term's discount reads in a sentence: "$25 off" or "10% off".
function describeOffer(preview) {
  const v = Number(preview?.discount_value);
  if (!Number.isFinite(v)) return "";
  return preview.discount_type === "percent" ? `${v}% off` : `${formatDollars(Math.round(v * 100))} off`;
}

export default function EarlyBirdRow({ preview, enabled, onChange, disabled, termLabel }) {
  // Six states, six sentences. The one that is easy to skip is the fifth -- a
  // term whose programs are on different deals -- and it is the state most in
  // need of an explanation, because the switch is off through no choice of the
  // operator's and nothing else on screen says why.
  const term = termLabel || "this term";
  let body;
  let live = false;

  if (preview === undefined) {
    body = <span style={{ color: MUTED }}>Checking this term's early bird…</span>;
  } else if (preview === null) {
    body = (
      <span style={{ color: "#991b1b" }}>
        Couldn't check {term}'s early bird. Saving won't change this program's early-bird price.
      </span>
    );
  } else if (preview.skip_reason) {
    body = (
      <span style={{ color: MUTED }}>
        {skipReasonSentence(preview.skip_reason)}
        {isReasonReversible(preview.skip_reason) && " Switch it back on to put it back in."}
      </span>
    );
    live = isReasonReversible(preview.skip_reason);
  } else if (Number(preview.term_program_count ?? 0) === 0) {
    body = (
      <span style={{ color: MUTED }}>
        {term} doesn't have an early bird. You can start one in Money &gt; Discounts.
      </span>
    );
  } else if (preview.early_bird_cents == null) {
    body = (
      <span style={{ color: "#92400e" }}>
        {term}'s programs aren't all on the same early-bird deal, so there's no single price to
        put here. Set one in Money &gt; Discounts and every program gets it.
      </span>
    );
  } else {
    live = true;
    const offer = `${describeOffer(preview)} through ${formatDeadlineShort(preview.deadline)}`;
    body = enabled ? (
      <span style={{ color: INK }}>
        {offer} <span style={{ color: GREEN_INK, fontWeight: 700 }}>→ {formatDollars(preview.early_bird_cents)}</span>
      </span>
    ) : (
      <span style={{ color: MUTED }}>
        Off for this class. Families pay the standard price. Switch on for {offer}
        {" "}<span style={{ fontWeight: 700 }}>→ {formatDollars(preview.early_bird_cents)}</span>.
      </span>
    );
  }

  const canToggle = live && !disabled;
  const on = live && enabled;

  return (
    <div style={{
      display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between",
      padding: "12px 14px", border: `1px solid ${RULE}`, borderRadius: 10,
      background: on ? GREEN_BG : "#fff", marginBottom: 14,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: PURPLE, marginBottom: 3 }}>Early bird</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{body}</div>
      </div>
      {/* A real checkbox, not a styled div: it is reachable by keyboard and reads
          to a screen reader as the control it is. Shown disabled rather than
          hidden when the class can't have one -- a control that vanishes reads as
          a bug, one that is greyed out beside a reason reads as an answer. */}
      <label style={{
        display: "flex", alignItems: "center", gap: 7, flexShrink: 0,
        cursor: canToggle ? "pointer" : "not-allowed", opacity: canToggle ? 1 : 0.55,
        fontSize: 13, fontWeight: 600, color: canToggle ? INK : MUTED,
      }}>
        <input
          type="checkbox"
          checked={on}
          disabled={!canToggle}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: 16, height: 16, accentColor: GREEN_INK, cursor: canToggle ? "pointer" : "not-allowed" }}
        />
        {on ? "On" : "Off"}
      </label>
    </div>
  );
}
