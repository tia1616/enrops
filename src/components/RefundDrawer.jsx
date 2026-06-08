// src/components/RefundDrawer.jsx
//
// Shared refund modal for a single registration. Invoked from the Rosters
// row "Refund…" action (and, later, from a Finances account/payment view —
// it's deliberately self-contained so both surfaces share one implementation).
//
// On open it reads the registration's paid installments + prior succeeded
// refunds to show accurate "refundable" math, plus the org's configured
// withdrawal admin fee (Finances → Settings) for the quick-fill. It then
// POSTs to the refund-registration edge function, which does the Stripe
// refund (reverse_transfer + Enrops keeps its fee), records the refund,
// advances payment_status, and — only if the operator chooses to withdraw —
// cancels the registration and frees the seat.
//
// Money-safe by construction: the edge fn re-authorizes owner/admin, guards
// eligibility server-side, and is idempotent. This UI never decides money on
// its own; it just gathers the operator's intent.
//
// Props:
//   registration: { id, organization_id, amount_cents, payment_status,
//                   stripe_payment_intent_id, studentName }
//   onClose():   dismiss without changes
//   onDone():    a refund succeeded — caller should reload

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK = "#3a7c3a";
const RED = "#b53737";
const CREAM = "#FBFBFB";

function fmtCents(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

// Map the edge function's error codes to plain English (no jargon, no codes).
function humanError(code, payload) {
  switch (code) {
    case "amount_exceeds_eligible":
      return `That's more than is left to refund. The most you can refund is ${fmtCents(payload?.eligible_cents)}.`;
    case "nothing_paid":
      return "There's no completed payment on this registration to refund.";
    case "invalid_amount":
      return "Enter a refund amount greater than zero.";
    case "stripe_refund_failed":
      return `Stripe couldn't process the refund${payload?.stripe_message ? `: ${payload.stripe_message}` : ""}. Nothing was charged back.`;
    case "cancel_failed_after_refund":
      return "The refund went through, but freeing the spot didn't. Refresh the roster — if the family is still listed, use Remove or try again.";
    case "forbidden":
      return "You don't have permission to issue refunds for this organization.";
    case "registration_not_found":
      return "This registration no longer exists. Refresh and try again.";
    default:
      return typeof code === "string" && code ? code : "Couldn't issue the refund. Try again.";
  }
}

export default function RefundDrawer({ registration, onClose, onDone }) {
  const reg = registration;
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [paidCents, setPaidCents] = useState(0);
  const [refundedCents, setRefundedCents] = useState(0);
  const [adminFeeCents, setAdminFeeCents] = useState(0);

  const [amountStr, setAmountStr] = useState("");      // dollars, as typed
  const [reason, setReason] = useState("");
  const [seatChoice, setSeatChoice] = useState(null);  // 'keep' | 'withdraw' — forced choice, no default
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const refundableCents = Math.max(0, paidCents - refundedCents);

  // Load eligibility + admin fee on open.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadErr("");
      try {
        const [{ data: inst }, { data: refs }, { data: orgRow }] = await Promise.all([
          supabase.from("installments").select("amount_cents, status").eq("registration_id", reg.id),
          supabase.from("refunds").select("amount_cents, status").eq("registration_id", reg.id).eq("status", "succeeded"),
          supabase.from("organizations").select("withdrawal_admin_fee_cents").eq("id", reg.organization_id).maybeSingle(),
        ]);
        if (!alive) return;
        const paidInst = (inst ?? []).filter((i) => i.status === "paid");
        // Mirror the edge fn's eligibility exactly: a single-pay registration
        // is only refundable if it actually carries a Stripe PaymentIntent.
        // (Seeded/imported "paid" rows without a PI are NOT refundable.)
        const paid = paidInst.length > 0
          ? paidInst.reduce((s, i) => s + (i.amount_cents || 0), 0)
          : (reg.payment_status === "paid" && reg.stripe_payment_intent_id ? (reg.amount_cents || 0) : 0);
        const refunded = (refs ?? []).reduce((s, r) => s + (r.amount_cents || 0), 0);
        setPaidCents(paid);
        setRefundedCents(refunded);
        setAdminFeeCents(orgRow?.withdrawal_admin_fee_cents || 0);
        // Default the field to the full refundable amount.
        setAmountStr(((Math.max(0, paid - refunded)) / 100).toFixed(2));
      } catch (e) {
        if (alive) setLoadErr("Couldn't load this registration's payment details. Close and try again.");
        console.error("[RefundDrawer] load failed", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [reg.id, reg.organization_id, reg.amount_cents, reg.payment_status]);

  const amountCents = (() => {
    const n = parseFloat(amountStr);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
  })();

  const overMax = amountCents > refundableCents;
  const canSubmit =
    !busy && !loading && !loadErr &&
    refundableCents > 0 &&
    amountCents > 0 && !overMax &&
    (seatChoice === "keep" || seatChoice === "withdraw");

  function setFull() { setAmountStr((refundableCents / 100).toFixed(2)); }
  function setKeepFee() { setAmountStr((Math.max(0, refundableCents - adminFeeCents) / 100).toFixed(2)); }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr("");
    try {
      const { data, error } = await supabase.functions.invoke("refund-registration", {
        body: {
          registration_id: reg.id,
          amount_cents: amountCents,
          reason: reason.trim() || undefined,
          cancel_registration: seatChoice === "withdraw",
        },
      });
      if (error || data?.error) {
        setErr(humanError(data?.error || error?.message, data));
        setBusy(false);
        return;
      }
      if (onDone) onDone({ amountCents, cancelled: seatChoice === "withdraw" });
    } catch (e) {
      console.error("[RefundDrawer] refund failed", e);
      setErr(e.message ?? "Couldn't issue the refund. Try again.");
      setBusy(false);
    }
  }

  const showKeepFee = adminFeeCents > 0 && refundableCents > adminFeeCents;

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 16px", zIndex: 220 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", width: "100%", maxWidth: 460, border: `1px solid ${RULE}`, borderRadius: 10, padding: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.2)" }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>
          Refund {reg.studentName || "this registration"}
        </h3>

        {loading && <p style={{ color: MUTED, fontSize: 13, marginTop: 12 }}>Loading payment details…</p>}

        {loadErr && (
          <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>
            {loadErr}
          </div>
        )}

        {!loading && !loadErr && (
          <>
            {/* Money summary */}
            <div style={{ background: CREAM, border: `1px solid ${RULE}`, borderRadius: 8, padding: "10px 12px", marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <span style={{ color: MUTED }}>Paid <strong style={{ color: INK }}>{fmtCents(paidCents)}</strong></span>
              {refundedCents > 0 && <span style={{ color: MUTED }}>Already refunded <strong style={{ color: INK }}>{fmtCents(refundedCents)}</strong></span>}
              <span style={{ color: MUTED }}>Refundable <strong style={{ color: OK }}>{fmtCents(refundableCents)}</strong></span>
            </div>

            {refundableCents <= 0 ? (
              <p style={{ color: MUTED, fontSize: 13, marginTop: 14, lineHeight: 1.5 }}>
                There's nothing left to refund on this registration — it's either already fully refunded or has no Stripe payment to refund against.
              </p>
            ) : (
              <>
                {/* Amount */}
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 16, marginBottom: 6 }}>
                  Refund amount
                </label>
                <div style={{ position: "relative", display: "inline-block" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14 }}>$</span>
                  <input
                    type="number" inputMode="decimal" min="0" step="0.01"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    disabled={busy}
                    style={{ padding: "8px 12px 8px 24px", fontSize: 14, border: `1px solid ${overMax ? RED : RULE}`, borderRadius: 6, fontFamily: "inherit", width: 160 }}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={setFull} disabled={busy} style={chip}>Full refund ({fmtCents(refundableCents)})</button>
                  {showKeepFee && (
                    <button type="button" onClick={setKeepFee} disabled={busy} style={chip}>
                      Keep {fmtCents(adminFeeCents)} admin fee
                    </button>
                  )}
                </div>
                {overMax && (
                  <div style={{ color: RED, fontSize: 12, marginTop: 6 }}>
                    That's more than is refundable ({fmtCents(refundableCents)}).
                  </div>
                )}

                {/* Seat choice — forced, no default */}
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: INK, marginBottom: 8 }}>Their spot</div>
                  <SeatRadio
                    checked={seatChoice === "keep"} onChange={() => setSeatChoice("keep")} disabled={busy}
                    title="Refund only — keep their spot"
                    sub="They stay on the roster. Use for discounts or a refund issued by mistake on your end."
                  />
                  <SeatRadio
                    checked={seatChoice === "withdraw"} onChange={() => setSeatChoice("withdraw")} disabled={busy}
                    title="Refund and withdraw — free their spot"
                    sub="Cancels the registration, opens the seat, and stops any future payments."
                  />
                </div>

                {/* Reason */}
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 16, marginBottom: 6 }}>
                  Reason <span style={{ color: MUTED, fontWeight: 400 }}>(internal note — not sent to the family)</span>
                </label>
                <input
                  type="text" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
                  placeholder="e.g. Family withdrew before start"
                  style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit" }}
                />

                <p style={{ color: MUTED, fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
                  Stripe sends the family its own refund confirmation automatically. The money comes back from your Stripe balance.
                </p>
              </>
            )}

            {err && (
              <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginTop: 12, lineHeight: 1.5 }}>
                {err}
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" onClick={onClose} disabled={busy}
            style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: busy ? "not-allowed" : "pointer" }}>
            Cancel
          </button>
          {!loading && !loadErr && refundableCents > 0 && (
            <button type="button" onClick={submit} disabled={!canSubmit}
              style={{ padding: "8px 16px", background: canSubmit ? PURPLE : "#bbb", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: canSubmit ? "pointer" : "not-allowed" }}>
              {busy ? "Issuing refund…" : `Refund ${fmtCents(amountCents)}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const chip = {
  padding: "5px 10px", background: "transparent", color: PURPLE,
  border: `1px solid ${PURPLE}`, borderRadius: 5, fontSize: 11.5, fontWeight: 600,
  fontFamily: "inherit", cursor: "pointer",
};

function SeatRadio({ checked, onChange, disabled, title, sub }) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 10px", border: `1px solid ${checked ? PURPLE : RULE}`, borderRadius: 7, marginBottom: 6, cursor: disabled ? "not-allowed" : "pointer", background: checked ? "rgba(28,0,79,0.04)" : "#fff" }}>
      <input type="radio" checked={checked} onChange={onChange} disabled={disabled} style={{ marginTop: 2 }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: INK }}>{title}</span>
        <span style={{ display: "block", fontSize: 11.5, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>{sub}</span>
      </span>
    </label>
  );
}
