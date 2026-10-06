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
import { isEarlyBirdActive } from "../lib/pricing.js";
import {
  earlyBirdPatch,
  describeOffer,
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
  // { needs_price: true } = there is nothing to ask about yet.
  const [preview, setPreview] = useState(undefined);

  // "" / null / undefined is a price NOT YET TYPED. Zero is a price: a free
  // class. Collapsing the two sends 0 to the rule, which answers 'free' -- so a
  // create form with an empty price box would tell the operator "this class is
  // free, so there's nothing to take off" about a class whose price they are
  // still deciding. The same wrong-by-a-falsy-value trap as grade K being 0.
  const noPriceYet = priceCents == null || priceCents === "";

  useEffect(() => {
    if (!orgId || !term) { setPreview(undefined); return; }
    if (noPriceYet) { setPreview({ needs_price: true }); return; }
    // DROP THE OLD ANSWER THE MOMENT THE QUESTION CHANGES.
    //
    // Without this the hook holds the previous program's answer through the
    // debounce, and a save inside that window writes it: change the price from
    // $285 to $190, hit Save within 300ms, and the row is stored with $190 as the
    // standard price and an early bird computed off $285. Clearing to undefined
    // first makes earlyBirdPatch return null for that window, so a save that
    // lands mid-flight writes nothing to the early-bird columns rather than
    // writing a number that belongs to a price the operator just replaced.
    setPreview(undefined);
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc("program_early_bird_preview", {
        p_org: orgId,
        p_term: term,
        p_status: status ?? "open",
        p_runs_own_registration: !!runsOwnRegistration,
        p_price_tier: priceTier ?? "standard",
        p_price_cents: Number(priceCents),
        p_opt_out: false,
      });
      if (cancelled) return;
      if (error) { setPreview(null); return; }
      setPreview((Array.isArray(data) ? data[0] : data) ?? null);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [orgId, term, priceCents, noPriceYet, status, runsOwnRegistration, priceTier]);

  return preview;
}

// earlyBirdPatch -- which columns a save writes -- lives in src/lib/earlyBird.js
// and is re-exported here so the three forms keep importing it from one place.
// It moved out of this file for one reason: it decides what gets written to a
// money column, and a .jsx file cannot be covered by the plain-node test runner
// that `npm test` uses. Logic that picks a price belongs where a test can reach it.
export { earlyBirdPatch };

export default function EarlyBirdRow({ preview, enabled, onChange, disabled, termLabel }) {
  // Seven states, seven sentences, and two of them exist because the sentence
  // that would otherwise be shown is FALSE rather than merely unhelpful:
  // "no price typed yet" would read as "this class is free", and a term whose
  // programs are on different deals would read as "this term has no early bird".
  // Both are states where the switch is off through no choice of the operator's,
  // and nothing else on screen says why.
  const term = termLabel || "this term";
  let body;
  let live = false;

  if (preview === undefined) {
    body = <span style={{ color: MUTED }}>Checking {term}'s early bird…</span>;
  } else if (preview === null) {
    body = (
      <span style={{ color: "#991b1b" }}>
        Couldn't check {term}'s early bird. Saving will leave this class's early-bird price as it is.
      </span>
    );
  } else if (preview.needs_price) {
    body = (
      <span style={{ color: MUTED }}>
        Enter a price above and this will show what families pay if they sign up early.
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
  } else if (!isEarlyBirdActive(preview.deadline)) {
    // An offer whose deadline has passed is still the term's offer -- the
    // Discounts card needs to know about it to badge the term "Ended" -- but
    // joining a class to it would promise a price families cannot get. The gate
    // is the SAME function the family-facing price uses, not a second reading of
    // what "expired" means.
    body = (
      <span style={{ color: "#92400e" }}>
        {term}'s early bird ended {formatDeadlineShort(preview.deadline)}, so families are
        paying the standard price. Set a later end date in Money &gt; Discounts to run it again.
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
