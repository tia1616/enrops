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
// refund, records it, advances payment_status, and — only if the operator
// chooses to withdraw — cancels the registration and frees the seat.
//
// The Stripe flags are the edge function's business, not this drawer's, and
// they are no longer one fixed pair: each PaymentIntent is refunded on the
// account it was actually created on (recorded in
// registrations/installments.stripe_charge_account_id), with reverse_transfer
// only on the destination-charge path. This UI is unchanged by any of that —
// it still sends registration_id + amount_cents and shows what came back.
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
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { formatCalendarDate } from "../lib/programSchedule";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK = "#3a7c3a";
const RED = "#b53737";
const CREAM = "#FBFBFB";
// Same value CancelClassModal uses for "needs your attention, not an error".
const AMBER = "#a16207";

function fmtCents(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

// A due date is a CALENDAR date, not a moment, and this repo already has one
// place that knows that: formatCalendarDate parses at local midnight (so a
// charge due 5 Jan does not render as 4 Jan) and returns null rather than a
// rolled-over guess for a malformed date. Always shows the year - a payment
// date months out is exactly where a bare "Jan 5" is ambiguous.
function fmtDue(iso) {
  return formatCalendarDate(iso, { month: "short", day: "numeric", year: "numeric" });
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
      // TWO DIFFERENT ANSWERS, because "Stripe said no" and "Stripe never
      // answered" are not the same fact. On the second we genuinely do not
      // know whether the money moved, so claiming "nothing was charged back"
      // is a guess the operator would act on - and acting on it means
      // refunding or crediting the same dollars again.
      return payload?.outcome_unknown
        ? `We didn't get an answer back from Stripe${payload?.stripe_message ? `: ${payload.stripe_message}` : ""}. The refund may or may not have gone through, so we've held this amount rather than releasing it. Check the payment in Stripe before trying again.`
        : `Stripe couldn't process the refund${payload?.stripe_message ? `: ${payload.stripe_message}` : ""}. Nothing was charged back.`;
    case "cancel_failed_after_refund":
      return "The refund went through, but freeing the spot didn't. Refresh the roster — if the family is still listed, use Remove or try again.";
    // The two outcomes of the withdraw path. Both used to fall through to the
    // default and show the operator the raw code, which is precisely the
    // opposite of what this function exists for — and the second of them is the
    // half-done state that most needs explaining.
    case "pause_failed":
      return "We couldn't stop this family's scheduled payments, so nothing was changed — they're still enrolled and still due to be charged. Try again, and if it keeps failing don't leave it: their card will be charged on schedule.";
    case "cancel_failed_charges_stopped":
      return `Their scheduled payments ARE stopped${payload?.pending_charges_stopped ? ` (${payload.pending_charges_stopped})` : ""}, but freeing their spot didn't work. No money moved. Refresh the roster and, if they're still listed, try again.`;
    // THE CREDIT PATH'S OUTCOMES. Each one says what DID happen as well as what
    // did not, because every failure below leaves a different amount of the job
    // done and the operator's next move is different in each.
    case "credit_write_failed":
      return "The credit couldn't be recorded, so nothing was changed — they're still enrolled and still due to be charged. Try again.";
    case "credit_issued_pause_failed":
      return `The ${fmtCents(payload?.credited_cents)} credit IS recorded, but we couldn't stop this family's scheduled payments, so they're still enrolled and still due to be charged. Try again, and don't leave it: their card will be charged on schedule.`;
    case "credit_issued_cancel_failed_charges_stopped":
      return `The ${fmtCents(payload?.credited_cents)} credit IS recorded and their scheduled payments ARE stopped${payload?.pending_charges_stopped ? ` (${payload.pending_charges_stopped})` : ""}, but freeing their spot didn't work. Refresh the roster and, if they're still listed, use Remove.`;
    case "invalid_credit_reason":
      return "Choose whether you cancelled the class or the family did, then try again.";
    case "charge_unreadable_credit_refused":
      return "We couldn't read this family's original payment from Stripe, so we haven't recorded a credit — we'd be guessing at the amount. Nothing was changed. Try again in a minute, and if it keeps failing, refund them instead.";
    case "idempotency_key_unusable":
      // Not reachable from this drawer, which generates a fresh key every time
      // it opens. Mapped anyway so it can never surface as a raw code.
      return "Something went wrong recording this credit. Close the panel and open it again, then try once more.";
    case "amount_exceeds_eligible_now":
      // Distinct from `amount_exceeds_eligible`, which means the amount was too
      // big when it was typed. This one means it was fine when the drawer
      // opened and somebody else used the money up in between, so the fix is to
      // reopen rather than to type a smaller number.
      //
      // The refund path can hit this PART WAY THROUGH a multi-payment refund,
      // and that is a different situation to say out loud: some money has
      // already gone back. Telling them only "there isn't enough left" would
      // send them to retry the whole amount.
      return payload?.partial?.length
        ? "Part of this refund went through, then someone else refunded or credited this registration and the rest couldn't. Refresh and check what's already been refunded before trying again."
        : "Someone else refunded or credited this registration while this was open, so there isn't enough left. Close and reopen to see what's actually available.";
    case "registration_has_no_parent":
      return "This registration isn't linked to a parent account, so a credit would have nobody to belong to. Refund it instead.";
    case "forbidden":
      return "You don't have permission to issue refunds for this organization.";
    case "lookup_failed":
      // The server could not read the registration or what has already been
      // refunded/credited against it, and fails closed rather than acting on a
      // possibly-wrong zero. Reachable on the submit press, where `default`
      // would otherwise print the literal code to a non-technical operator.
      return "We couldn't check this registration's payment history, so nothing was changed. Refresh and try again.";
    case "refund_row_insert_failed":
      return "We couldn't record the refund, so nothing was charged back. Refresh and try again.";
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
  // What the server says is still available — paid, less refunds, less credits.
  const [eligibleCents, setEligibleCents] = useState(0);
  const [adminFeeCents, setAdminFeeCents] = useState(0);
  // Pending installments on THIS registration. Shown so a withdrawal states
  // what it actually prevents, in money, rather than promising vaguely to
  // "stop any future payments" and leaving the operator to hope.
  const [pendingCharges, setPendingCharges] = useState([]);
  // THREE STATES, NOT TWO. "no pending charges" and "could not find out" are
  // different facts and only one of them is safe to tell an operator who is
  // about to withdraw a family.
  const [pendingChargesUnknown, setPendingChargesUnknown] = useState(false);

  const [amountStr, setAmountStr] = useState("");      // dollars, as typed
  const [reason, setReason] = useState("");
  const [seatChoice, setSeatChoice] = useState(null);  // 'keep' | 'withdraw' — forced choice, no default
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // WHAT THE FAMILY GETS. 'refund' sends money back to their card; 'credit'
  // keeps it with the business and records it as an enrops credit they can
  // spend later.
  //
  // THE PRE-SELECTION FOLLOWS THE MONEY LAYER'S TWO DEFAULTS, which are
  // opposites and turn on WHO ended the enrollment (section 6):
  //   the class is cancelled  -> the BUSINESS ended it -> REFUND is the default
  //   the class is running    -> the FAMILY ended it   -> CREDIT is the default
  // Set once the preview lands, in the load effect below; the form is hidden
  // behind `loading` until then, so the operator never sees it change under
  // them. 'refund' is only the value held while that is in flight.
  //
  // Jessica's decision, 2026-09-23: follow the doc literally. I had argued for
  // refund-always on the grounds that the doc's defaults describe what a FAMILY
  // gets when asked, and nobody is asked yet - so on a running class this now
  // opens pre-set to "keep their money", which is the case to watch. It is
  // guarded by being loud rather than by being cautious: the amount label, the
  // quick-fill chip, the footer and the button all say CREDIT, and the seat
  // choice disappears. An operator who reads any one of those sees it.
  //
  // Unknown (the class could not be read) keeps 'refund'. Neither rule can be
  // evaluated without knowing which side cancelled, and refund is the side that
  // cannot leave a family out of pocket.
  const [outcome, setOutcome] = useState("refund"); // 'refund' | 'credit'

  // Which kind of cancellation this was. Only asked once credit is chosen,
  // because it is only written on a credit - family_credits.reason. Pre-selected
  // from whether the class itself is cancelled, which CORRELATES with a business
  // cancellation without proving one, so it stays changeable.
  const [cancelKind, setCancelKind] = useState(null); // 'business_cancelled' | 'family_cancelled'
  const [programCancelled, setProgramCancelled] = useState(false);
  const [creditedCents, setCreditedCents] = useState(0);
  // Money counted against the ceiling that we cannot say the family has: a
  // refund reserved and still in flight, or one Stripe never answered on.
  // Without it the summary band is a riddle - paid $240, refunded $0,
  // refundable $190, and nothing accounting for the missing $50.
  const [heldCents, setHeldCents] = useState(0);
  // Whether the server could read the real charge from Stripe. Only the credit
  // path cares: a refund still works, because Stripe itself is the backstop.
  const [chargeReadable, setChargeReadable] = useState(true);

  // One key per drawer opening. A double-clicked button or a retried request
  // sends the SAME key, and the server returns the credit it already wrote
  // instead of writing a second one. Generated here rather than server-side
  // precisely because it has to survive the retry.
  const [idempotencyKey] = useState(() =>
    (globalThis.crypto?.randomUUID?.() ?? `credit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  );

  // THE CEILING IS THE SERVER'S NUMBER, NOT A SECOND COPY OF ITS ARITHMETIC.
  // This used to be `paidCents - refundedCents`, which was the whole truth while
  // a refund was the only way money could leave a registration. Credits consume
  // the same ceiling, so that expression now drifts from what the server will
  // actually allow - it would offer back money already given away as credit.
  // Reading `eligible_cents` keeps one implementation, the same reason the
  // drawer stopped deriving this locally in the first place.
  const refundableCents = Math.max(0, eligibleCents);

  // Load eligibility + admin fee on open.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadErr("");
      try {
        // Eligibility comes from the edge function in preview mode, NOT from a
        // local recomputation. It used to be derived here from installments /
        // registrations, which meant the ceiling lived in two places — and both
        // used amount_cents, the BASE price. When the operator passes the fee to
        // families the card was charged base + fee, so a family who paid $276.74
        // could only be offered $274.00 back. The server now reads the real
        // charged total from Stripe; asking it is the only way this UI can be
        // sure it is showing a number the server will honour.
        const [{ data: elig, error: eligErr }, { data: orgRow }, { data: pendingRows, error: pendingErr }] = await Promise.all([
          supabase.functions.invoke("refund-registration", {
            body: { registration_id: reg.id, preview: true },
          }),
          supabase.from("organizations").select("withdrawal_admin_fee_cents").eq("id", reg.organization_id).maybeSingle(),
          supabase
            .from("installments")
            .select("id, amount_cents, due_date")
            .eq("registration_id", reg.id)
            .eq("status", "pending")
            .order("due_date"),
        ]);
        if (!alive) return;
        if (eligErr || !elig || typeof elig.eligible_cents !== "number") {
          // Do NOT fall back to a locally-computed number: a wrong ceiling here
          // either blocks a legitimate refund or invites one the server will
          // reject. Say so instead.
          throw eligErr || new Error("no eligibility returned");
        }
        const paid = elig.total_paid_cents || 0;
        const refunded = elig.total_refunded_cents || 0;
        setPaidCents(paid);
        setRefundedCents(refunded);
        setEligibleCents(elig.eligible_cents);
        setCreditedCents(elig.total_credited_cents || 0);
        setHeldCents(elig.held_cents || 0);
        // Pre-selects the cancellation kind IF the operator goes on to choose
        // credit. Not a claim on its own, and it decides nothing until then.
        //
        // THREE STATES. null means the server could not read the class at all,
        // which is neither "cancelled" nor "still running" - so nothing is
        // pre-selected and the operator is asked outright. `canSubmit` already
        // requires a kind, so an unknown becomes a forced choice rather than a
        // confident wrong guess about the one fact nothing else records.
        // `!== false` so an older preview without the field is treated as
        // readable, which is exactly today's behaviour.
        setChargeReadable(elig.charge_readable !== false);
        setProgramCancelled(elig.program_cancelled ?? null);
        setCancelKind(
          elig.program_cancelled === true ? "business_cancelled"
            : elig.program_cancelled === false ? "family_cancelled"
              : null,
        );
        // THE DOC'S TWO DEFAULTS, applied here rather than at declaration
        // because both depend on an answer only the server has. A running class
        // means the family ended it, and section 6 makes CREDIT the default
        // there; a cancelled class means the business did, and refund is the
        // default. Unknown falls through to the 'refund' the state was born
        // with. Safe to set here: `loading` hides the whole form until this
        // resolves, so nothing moves under the operator's hands.
        //
        // No guard for "credit is not available on this charge" is needed -
        // `isCredit` already requires `creditAvailable`, so a pre-selected
        // credit on an unreadable charge simply presents as a refund.
        if (elig.program_cancelled === false) setOutcome("credit");
        setAdminFeeCents(orgRow?.withdrawal_admin_fee_cents || 0);
        // A failed read must not block a refund, so it is recorded rather than
        // thrown - but it is RECORDED, because an empty list and a failed query
        // are indistinguishable otherwise and the copy below would tell an
        // operator there are no scheduled charges when it simply could not look.
        setPendingChargesUnknown(!!pendingErr);
        setPendingCharges(pendingErr ? [] : (pendingRows || []));
        // Default the field to the full refundable amount.
        setAmountStr(((Math.max(0, elig.eligible_cents)) / 100).toFixed(2));
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

  // NOTHING TO REFUND IS NOT NOTHING TO DO. A family that leaves before a later
  // term has been charged has no money coming back, but their PENDING
  // installments are still armed - and stopping those lives behind this same
  // drawer. Until 2026-09-22 this state hid the submit button entirely, so the
  // operator's only options were to leave the charges running or have someone
  // edit the database by hand.
  const nothingToRefund = refundableCents <= 0;

  // WITHDRAW WITHOUT REFUNDING. Two different situations, one action:
  //   - there is nothing to refund (a later term never charged), or
  //   - there IS money but the operator is deliberately keeping it (the family
  //     attended the term they paid for and is leaving after it).
  // Both were unreachable: the first hid the button, the second refused to
  // submit with a zero amount. Escher Swanson on 2026-09-22 needed BOTH on the
  // same child on the same day - keep the fall money, stop the winter and
  // spring charges - and neither could be done from this drawer.
  //
  // KEEPING THE MONEY MUST BE TYPED, NOT ARRIVED AT. `amountCents` collapses an
  // EMPTY field to 0 as well as a typed zero, so keying off it alone meant that
  // select-all-deleting the amount to retype it silently relabelled the primary
  // button to "Withdraw without refunding" and left it ENABLED - one misclick
  // away from cancelling the registration and keeping the family's money, with
  // no receipt and no refund record. An empty field is an unfinished thought,
  // not an instruction.
  const typedZero = (() => {
    const t = amountStr.trim();
    if (t === "") return false;
    const n = parseFloat(t);
    return Number.isFinite(n) && Math.round(n * 100) === 0;
  })();

  // CREDIT IS ONLY OFFERED WHEN THERE IS MONEY TO CREDIT. With nothing
  // refundable the family has paid nothing that could be owed back, and the
  // nothing-to-refund panel above already handles that case as a withdrawal.
  // Guarding the derived flag rather than only the radio means a credit cannot
  // survive a state where its own precondition stopped being true.
  // AND only when the server could actually read what they paid. A credit is a
  // debt sized from the real charge; when Stripe could not be read the server
  // refuses to write one, so offering the option here would walk the operator
  // through the whole form to a dead end. Defaults to true so a preview from an
  // older deploy, which does not send the field, behaves as it does today.
  const creditAvailable = refundableCents > 0 && chargeReadable;
  const isCredit = outcome === "credit" && creditAvailable;

  // A CREDIT ALWAYS WITHDRAWS. The family is leaving the class - that is why
  // money is owed back to them - so the seat is freed and their future payments
  // stopped, exactly as a refund-and-withdraw does. There is no keep-their-spot
  // credit in this chunk: that would be a goodwill credit, which the database
  // has a separate reason for and no surface issues yet.
  const withdrawNoRefund = !isCredit && (nothingToRefund || (seatChoice === "withdraw" && typedZero));

  // Flattened: the old nested ternary's true-branch was a tautology. Inside it
  // `withdrawNoRefund` holds, and if `nothingToRefund` is false the other
  // disjunct forces `seatChoice === "withdraw"` - so it could never reject
  // anything while reading like a guard.
  const canSubmit =
    !busy && !loading && !loadErr &&
    (isCredit
      // The seat choice is not consulted: a credit always withdraws. The
      // cancellation kind IS, because it is written to the credit row and the
      // two values are not interchangeable - it is the only record of which
      // side ended the enrollment.
      ? (amountCents > 0 && !overMax &&
        (cancelKind === "business_cancelled" || cancelKind === "family_cancelled"))
      : (withdrawNoRefund ||
        (amountCents > 0 && !overMax &&
          (seatChoice === "keep" || seatChoice === "withdraw"))));

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
          // Zero when there is nothing to refund. The server accepts that ONLY
          // alongside cancel_registration, and takes a path that never calls
          // Stripe at all.
          amount_cents: withdrawNoRefund ? 0 : amountCents,
          reason: reason.trim() || undefined,
          // A credit always withdraws, so this is true without consulting the
          // seat choice - which is not even shown in that mode.
          cancel_registration: isCredit ? true : (withdrawNoRefund ? true : seatChoice === "withdraw"),
          ...(isCredit
            ? {
              issue_credit: true,
              credit_reason: cancelKind,
              idempotency_key: idempotencyKey,
            }
            : null),
        },
      });
      if (error) {
        // supabase-js puts the edge fn's JSON body on error.context (a Response)
        // for non-2xx replies — read it so the operator sees the real reason,
        // not the generic "non-2xx status code".
        let payload = null;
        try { payload = await error.context?.json?.(); } catch { /* not JSON */ }
        setErr(humanError(payload?.error || error.message, payload));
        setBusy(false);
        return;
      }
      if (data?.error) {
        setErr(humanError(data.error, data));
        setBusy(false);
        return;
      }
      // THE REFUND WORKED. What follows is only for things that are still the
      // OPERATOR'S to finish. An alert rather than an inline note because the
      // drawer closes on the next line, and these must not be the thing nobody
      // sees. When there is nothing for them to do the alert does not fire at
      // all and the refund just succeeds quietly, which is the common case.
      //
      // (The margin shortfall used to be listed here too. It still must never
      // imply the refund FAILED - the function used to return 502 and leave the
      // registration marked paid, which is what sent an operator back to press
      // Refund a second time on a real card. It does not do that any more; the
      // shortfall is a warning on a successful refund. See below for why the
      // operator is no longer the one warned.)
      const notes = [];
      // THE MARGIN SHORTFALL IS DELIBERATELY NOT SHOWN TO THE OPERATOR.
      //
      // It used to be, and on 2026-09-08 Jeff read it: it told him enrops was
      // short of funds, handed him an internal Stripe fee id, and asked him to
      // watch for a balance he cannot see. Every fact in it was true and none of
      // it was his to act on. An operator cannot refund an application fee -
      // only the platform can - so the message named a task, gave it to the one
      // person who cannot do it, and disclosed the platform's cash position to a
      // customer in the same breath.
      //
      // NOTHING IS LOST BY REMOVING IT. The shortfall is written to the
      // `refunds` row before this response is built - `platform_fee_refunded_cents`
      // and `failure_reason`, which carries Stripe's own wording and the amount.
      // That row is the durable record and the only one that survives a closed
      // tab. What is missing is that nobody is TOLD; that is a platform alert to
      // enrops, not an alert to the provider, and it is the follow-up to this.
      //
      // The two notes below stay. Both are things the OPERATOR must act on: a
      // seat that did not free is still on their roster, and a part-finished
      // refund needs checking before they press the button again.
      if (data?.cancel_failed) {
        // The seat did NOT free. Say it, because the roster will still show them
        // and the operator has to finish the withdrawal by hand.
        notes.push(
          `Their spot could not be freed (${data.cancel_failed}). They are still on the roster — ` +
          `withdraw them manually. Any pending instalments have been stopped.`,
        );
      }
      if (data?.fee_lookup_aborted) {
        notes.push(
          `Part of this payment could not be read from Stripe, so refunding stopped partway. ` +
          `Check the amount actually refunded before trying again.`,
        );
      }
      if (data?.stripe_aborted) {
        // Stripe refused, or never answered, on a later payment. The earlier
        // ones DID go back and the seat was handled, so this is a note on a
        // success - but the two cases need different next steps, and only one
        // of them is safe to describe as "didn't go through".
        notes.push(
          (data.stripe_aborted_unknown
            ? `Part of this refund is UNRESOLVED — we didn't get an answer back from Stripe (${data.stripe_aborted}), so it may or may not have gone through. We've held that amount rather than releasing it. Check the payment in Stripe.`
            : `Part of this refund didn't go through: ${data.stripe_aborted}.`) +
          ` ${fmtCents(data?.total_refunded_cents)} has been refunded in total.`,
        );
      }
      if (data?.reserve_aborted) {
        // A note on a SUCCESS, not an error: money did move, so telling the
        // operator only "it failed" sends them to press Refund again on a
        // charge that has already been partly returned.
        //
        // IT SAYS NOTHING ABOUT THE SPOT. An earlier draft asserted "their spot
        // and scheduled payments were still handled", which is false in two
        // reachable states: the operator may have chosen "keep their spot", in
        // which case nothing was withdrawn and nothing was paused; and the
        // withdrawal may have failed, which the `cancel_failed` note directly
        // above already reports - so the two would have contradicted each other
        // in the same alert. The seat has its own note; this one owns the money.
        notes.push(
          (data.reserve_aborted === "amount_exceeds_eligible_now"
            ? `Only part of this refund went through — someone else refunded or credited this registration while it was open, so the rest couldn't. `
            : `Only part of this refund went through — we couldn't record the rest. `) +
          `${fmtCents(data?.total_refunded_cents)} has been refunded in total. Check that before trying again.`,
        );
      }
      // THE HEADLINE HAS TO MATCH WHAT ACTUALLY HAPPENED. "The family has their
      // money back" is false on a credit - the money is precisely what they did
      // NOT get back - and it is the sentence an operator would repeat to them.
      if (isCredit) {
        // ALWAYS alerts, unlike the refund path, and that is the point. A refund
        // announces itself: the family sees it on their card. A credit is
        // silent - nothing is emailed by this flow - so the one thing standing
        // between the family and never hearing about their money is this
        // sentence. It must not be conditional on something having gone wrong.
        // THE LEDGER'S NUMBER, NOT THE TYPED ONE. The server deliberately
        // answers a retry with the amount it already holds, and reading
        // `amountCents` here threw that away. The field stays editable after a
        // partial failure (credit written, pause failed), so an operator who
        // adjusts the amount and presses again would be told "$300 credit
        // recorded" while $240 sits in the ledger - and that sentence is the
        // one they repeat to the family, with no email to contradict it.
        const written = data?.credited_cents ?? amountCents;
        // NAME THE TICK BOX, because the credit just took them off the roster.
        // A credit always withdraws, so by the time this alert is read the
        // child is gone from the class and the obvious reading of "go to
        // Message families" is that they cannot be reached at all. They can:
        // they are in the "families who have left or been refunded" group,
        // which is off by default. CancelClassModal already warns about this
        // exact trap for refunds; the credit path is worse, because a refund
        // at least announces itself on the family's card and a credit is
        // completely silent. Caught by Jessica walking staging, 2026-09-23.
        //
        // AND IT IS CONDITIONAL, because `cancel_failed` is appended to THIS
        // alert a few lines down and says "They are still on the roster -
        // withdraw them manually". An unconditional "this has taken them off
        // the roster" contradicts that note inside one alert box, and it wins,
        // because it is two paragraphs higher. That is the same mistake the
        // reserve_aborted note above documents and refuses to repeat: the seat
        // has ONE owner in this alert, and when the withdrawal failed the
        // owner is that note, not this sentence.
        const seatFreed = !data?.cancel_failed;
        alert(
          `${fmtCents(written)} credit recorded${data?.already_existed ? " (it was already issued — no second credit was created)" : ""}.\n\n` +
          (seatFreed
            ? `They have NOT been emailed, and this has taken them off the class roster.\n\n` +
              `To tell them: Class rosters › Message families, then tick "Also include families who have left or been refunded" — they won't show up without it.`
            : `They have NOT been emailed. Tell them from Class rosters › Message families — do that BEFORE you withdraw them by hand, while they are still on the roster.`) +
          (notes.length > 0 ? `\n\n${notes.join("\n\n")}` : ""),
        );
      } else if (notes.length > 0) {
        alert(`Refunded. The family has their money back.\n\n${notes.join("\n\n")}`);
      }
      // `cancelled` drives the caller's roster refresh. A credit ALWAYS
      // withdraws but never sets seatChoice - it is not asked - so reading the
      // seat choice alone reported false and left a freed seat still showing as
      // taken.
      if (onDone) {
        onDone({
          // Same rule as the alert: report what was written, not what was asked
          // for, so a caller that displays or totals this cannot inherit the
          // wrong number from a retry.
          // WHAT MOVED, on BOTH paths. The rule above was applied to credits and
          // left off refunds, and this round created the first case where a
          // refund's actual total can be smaller than the typed one: a partial
          // walk now returns success. `total_refunded_cents` is the honest
          // figure and was sitting unread.
          amountCents: isCredit
            ? (data?.credited_cents ?? amountCents)
            // THIS CALL's amount, which is what a caller refreshing a roster
            // after one action wants - not the registration's lifetime total,
            // which is what `total_refunded_cents` now means on every response.
            : (data?.refunded_this_call_cents ?? amountCents),
          cancelled: isCredit || seatChoice === "withdraw",
          credited: isCredit,
        });
      }
    } catch (e) {
      console.error("[RefundDrawer] refund failed", e);
      setErr(e.message ?? "Couldn't issue the refund. Try again.");
      setBusy(false);
    }
  }

  const showKeepFee = adminFeeCents > 0 && refundableCents > adminFeeCents;

  // One link, three sentences. Defined once so the three branches below cannot
  // drift apart in styling or destination.
  const payLink = (
    <Link to="/admin/finances" target="_blank" rel="noreferrer" style={{ color: BRIGHT, textDecoration: "none" }}>
      Payments&nbsp;&#8599;
    </Link>
  );

  return (
    <div
      onClick={busy ? undefined : onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 16px", zIndex: 220 }}
    >
      {/* THE BOX MUST SCROLL. It had no height limit, so on a laptop viewport
          the Cancel and confirm buttons fell off the bottom of the screen with
          no way to reach them - the drawer rendered perfectly and could not be
          used. Adding the itemised list of scheduled payments is what pushed it
          over, but the bug was always there waiting for a tall enough state: a
          family with three pending charges, a long error, or a smaller screen.
          Caught by Jessica on staging, 2026-09-22. */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", width: "100%", maxWidth: 460, border: `1px solid ${RULE}`, borderRadius: 10, padding: 22, boxShadow: "0 10px 40px rgba(0,0,0,0.2)", maxHeight: "85vh", overflowY: "auto" }}
      >
        {/* Matches the button that opens it. "Refund <name>" sat above a panel
            explaining there was nothing to refund, and above a button reading
            "Withdraw without refunding" - a heading contradicting the screen
            underneath it. One name for one entry point, true in every state. */}
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>
          Refund / remove {reg.studentName || "this registration"}
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
              {/* Credits consume the same ceiling as refunds, so leaving this
                  out turns the available figure into a riddle: "$240 paid, $0
                  refunded, $0 you can refund" reads as a bug rather than as
                  money already given back another way. */}
              {creditedCents > 0 && <span style={{ color: MUTED }}>Already credited <strong style={{ color: INK }}>{fmtCents(creditedCents)}</strong></span>}
              {/* Deliberately NOT called "refunded": nobody can say this money
                  reached the family. It is shown because otherwise the
                  refundable figure is short by an amount with no explanation
                  anywhere on the screen. */}
              {heldCents > 0 && (
                <span style={{ color: MUTED }} title="A refund that is still in flight, or one Stripe never confirmed. Held so it can't be given out twice.">
                  On hold <strong style={{ color: AMBER }}>{fmtCents(heldCents)}</strong>
                </span>
              )}
              <span style={{ color: MUTED }}>Refundable <strong style={{ color: OK }}>{fmtCents(refundableCents)}</strong></span>
            </div>

            {nothingToRefund ? (
              <div style={{ marginTop: 14 }}>
                <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                  There's nothing to refund here — this registration has no payment to refund against, or it has already been fully refunded.
                </p>

                {pendingCharges.length > 0 ? (
                  <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 12px", marginTop: 12 }} role="alert">
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#7c2d12", marginBottom: 6 }}>
                      Their card is still scheduled to be charged
                    </div>
                    <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 12.5, color: "#7c2d12", lineHeight: 1.7 }}>
                      {pendingCharges.map((c) => (
                        <li key={c.id}>
                          {/* Guard on the FORMATTED value, not the raw one: an
                              unparseable date used to leave a dangling "on "
                              with nothing after it. */}
                          <strong>{fmtCents(c.amount_cents)}</strong>{fmtDue(c.due_date) ? ` on ${fmtDue(c.due_date)}` : ""}
                        </li>
                      ))}
                    </ul>
                    <div style={{ fontSize: 12, color: "#7c2d12", lineHeight: 1.5 }}>
                      Withdrawing stops {pendingCharges.length === 1 ? "this payment" : `all ${pendingCharges.length} of these`} for <strong>this class</strong>. No money is refunded, because none was collected. If they are enrolled in other terms, those are separate and are not affected.
                    </div>
                  </div>
                ) : (
                  <p style={{ color: MUTED, fontSize: 12.5, marginTop: 10, lineHeight: 1.5 }}>
                    {pendingChargesUnknown
                      ? "We couldn't check whether this class has any scheduled payments. Withdrawing still frees their spot and stops anything that is scheduled, but check their payment plan afterwards."
                      : "This class has no scheduled payments either. Withdrawing frees their spot and takes them off the roster. Any other terms they are enrolled in are separate and are not affected."}
                  </p>
                )}

                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 16, marginBottom: 6 }}>
                  Reason <span style={{ color: MUTED, fontWeight: 400 }}>(internal note — not sent to the family)</span>
                </label>
                <input
                  type="text" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
                  placeholder="e.g. Moving schools"
                  style={{ width: "100%", boxSizing: "border-box", padding: "8px 12px", fontSize: 13, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit" }}
                />

                <p style={{ color: MUTED, fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
                  The family is not emailed about this — Stripe only writes to them when money actually moves. Tell them yourself if they should know.
                </p>
              </div>
            ) : (
              <>
                {/* Amount */}
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: INK, marginTop: 16, marginBottom: 6 }}>
                  {isCredit ? "Credit amount" : "Refund amount"}
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
                  {/* The chip fills the same field either way, but it must not
                      call the action by the wrong name: "Full refund" sitting
                      above a "Give $240 credit" button is the screen telling an
                      operator two different things about one press. */}
                  <button type="button" onClick={setFull} disabled={busy} style={chip}>
                    {isCredit ? "Full credit" : "Full refund"} ({fmtCents(refundableCents)})
                  </button>
                  {showKeepFee && (
                    <button type="button" onClick={setKeepFee} disabled={busy} style={chip}>
                      Keep {fmtCents(adminFeeCents)} admin fee
                    </button>
                  )}
                </div>
                {/* Whether a fee EXISTS and whether we can offer the shortcut are
                    two different questions, and this copy must answer the first.
                    Branching on showKeepFee told an operator with a $35 fee that
                    they had none, whenever the refundable amount was under $35 -
                    the exact opposite of the truth, in the line written to tell
                    them the truth.

                    NEW TAB, deliberately. This link lives inside the drawer, so
                    navigating in place would unmount it and silently bin a
                    half-typed refund amount and the spot choice. Nobody expects
                    "where do I change this?" to throw away what they were doing. */}
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                  {adminFeeCents <= 0 ? (
                    <>You can set a standard admin fee to keep on withdrawals in {payLink}.</>
                  ) : showKeepFee ? (
                    <>Your admin fee. Change it in {payLink}, or just type a different amount here.</>
                  ) : (
                    // Fee set, but it's >= everything left to refund, so the
                    // shortcut is hidden. Say why rather than going quiet.
                    <>Your {fmtCents(adminFeeCents)} admin fee is more than what's refundable here, so there's no shortcut to apply. Change it in {payLink}.</>
                  )}
                </div>
                {overMax && (
                  <div style={{ color: RED, fontSize: 12, marginTop: 6 }}>
                    That's more than is refundable ({fmtCents(refundableCents)}).
                  </div>
                )}

                {/* WHAT THE FAMILY GETS. Only shown when there is money to give
                    back - with nothing refundable there is nothing to credit
                    either, and that case has its own panel above. */}
                {/* The option is WITHHELD, so say so. A choice that silently
                    fails to appear reads as a product that does not have the
                    feature, and the operator's next move - refunding instead -
                    is the right one only if they know why. Shown only when
                    there IS money to give back, since the nothing-to-refund
                    case has its own panel and no credit to discuss. */}
                {!chargeReadable && refundableCents > 0 && (
                  <div style={{ marginTop: 18, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: 12, fontSize: 12.5, color: "#7c2d12", lineHeight: 1.5 }}>
                    <strong>Credit isn't available on this one.</strong> We couldn't read the original
                    payment from Stripe, so we can't tell what they actually paid — and a credit has to be
                    for the right amount. Refunding still works normally.
                  </div>
                )}

                {creditAvailable && (
                  <div style={{ marginTop: 18 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: INK, marginBottom: 8 }}>What they get</div>
                    <SeatRadio
                      checked={!isCredit} onChange={() => setOutcome("refund")} disabled={busy}
                      title="Refund to their card"
                      sub="The money goes back to the card they paid with. Five to ten business days."
                    />
                    <SeatRadio
                      checked={isCredit} onChange={() => setOutcome("credit")} disabled={busy}
                      title="Give enrops credit instead"
                      // "stops any future payments" without a scope is a promise
                      // this action does not keep. The pause is filtered to THIS
                      // registration, and the nightly charger gates on the
                      // PROGRAM's status, never the registration's - so the other
                      // terms of a year-long bundle keep charging. On production
                      // 114 registrations are paid and confirmed while another
                      // leg for the same parent and child still has pending
                      // instalments, so this is the common case, not the corner.
                      // The withdraw panel above already says it correctly; this
                      // copy dropped the qualifier.
                      sub="The money stays with you and they can spend it on a future class. No expiry. Frees their spot and stops the scheduled payments for this class. Any other terms they are enrolled in are separate and are not affected."
                    />
                    {isCredit && (
                      <div style={{ marginTop: 10, background: "#fdf6e3", border: "1px solid #ecdca6", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: INK, marginBottom: 8 }}>
                          Who ended this enrollment?
                        </div>
                        {/* THE ONE FACT NOTHING ELSE RECORDS. registrations.status
                            says 'cancelled' either way, so if this is not stated
                            here it is not stored anywhere - and the money layer's
                            rules for the two are opposites. Pre-selected from
                            whether the class is cancelled, which correlates
                            without proving: a family who withdrew on Monday
                            before the class was pulled on Friday looks exactly
                            like a business cancellation to that test. So the
                            operator confirms it. */}
                        <SeatRadio
                          checked={cancelKind === "business_cancelled"} onChange={() => setCancelKind("business_cancelled")} disabled={busy}
                          title="We cancelled the class"
                          sub="Low enrolment, no instructor, or any other reason on your side."
                        />
                        <SeatRadio
                          checked={cancelKind === "family_cancelled"} onChange={() => setCancelKind("family_cancelled")} disabled={busy}
                          title="The family cancelled"
                          sub="They changed their mind, moved school, or dropped out."
                        />
                        <div style={{ fontSize: 12, color: MUTED, marginTop: 2, lineHeight: 1.6 }}>
                          {/* Both branches are true in the state that selects
                              them: the first is only reachable when the class
                              really is cancelled, the second only when it is
                              not. */}
                          {/* Three states, three sentences, and the third is the
                              one that must not be skipped: a failed read is not
                              evidence the class is running. Saying so is also
                              the honest explanation for why nothing is
                              pre-selected here when it usually is. */}
                          {programCancelled === true
                            ? "This class is cancelled, so we've assumed it was your cancellation. Change it if the family had already pulled out."
                            : programCancelled === false
                              ? "This class is still running, so we've assumed the family pulled out. Change it if you cancelled their place."
                              : "We couldn't check whether this class is cancelled, so we haven't assumed either way — pick the one that happened."}
                        </div>
                        {/* SAID BEFORE THE ACTION, not only in the alert after
                            it. A credit always withdraws, so issuing one takes
                            the child off the roster - and the easiest way to
                            tell the family is while they are still on it.
                            Naming the order here means the operator never has
                            to discover the tick box at all. */}
                        <div style={{ fontSize: 12, color: INK, marginTop: 10, lineHeight: 1.6 }}>
                          <strong>Nothing is emailed.</strong> They won't know about this credit until you tell
                          them. Easiest is to message them <em>first</em>, while they're still on the roster.
                          If you issue it now, you can still reach them from Message families by ticking
                          &ldquo;Also include families who have left or been refunded&rdquo;.
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Seat choice — forced, no default. Hidden on the credit path,
                    where there is no choice to make: a credit always withdraws,
                    so showing a keep-their-spot option would offer something
                    that cannot happen. */}
                <div style={{ marginTop: 18, display: isCredit ? "none" : undefined }}>
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

                  {/* The button's MEANING changes when a zero is typed, so it
                      has to say so here rather than letting an operator discover
                      it after pressing. This whole arm renders only when there
                      IS money to refund - the nothing-to-refund case has its own
                      panel above - so the condition is just the typed zero. */}
                  {withdrawNoRefund && (
                    <div style={{ marginTop: 10, padding: "10px 12px", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, color: "#7c2d12", fontSize: 12.5, lineHeight: 1.5 }} role="alert">
                      <div>
                        You typed $0, so <strong>no money goes back to the family</strong>. Their {fmtCents(refundableCents)} stays with you, and their spot is freed.
                      </div>
                      {pendingChargesUnknown ? (
                        <div style={{ marginTop: 6 }}>
                          We couldn't check this class's scheduled payments, so check their payment plan afterwards.
                        </div>
                      ) : pendingCharges.length > 0 ? (
                        <>
                          {/* ITEMISED, not counted. "2 payments are stopped" asks an
                              operator to take it on trust; the amounts and dates let
                              them recognise the plan they are cancelling - and catch
                              it if the drawer is showing the wrong family. */}
                          <div style={{ marginTop: 6 }}>These scheduled payments are stopped:</div>
                          <ul style={{ margin: "4px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
                            {pendingCharges.map((c) => (
                              <li key={c.id}>
                                <strong>{fmtCents(c.amount_cents)}</strong>{fmtDue(c.due_date) ? ` on ${fmtDue(c.due_date)}` : ""}
                              </li>
                            ))}
                          </ul>
                          <div style={{ marginTop: 4 }}>Other terms are separate and are not affected.</div>
                        </>
                      ) : null}
                    </div>
                  )}
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

                {/* This footer described a refund unconditionally, so in the
                    withdraw-without-refunding state it promised the family a
                    Stripe confirmation for money that never moves - the drawer
                    telling an operator the opposite of what it is about to do.
                    Caught by Jessica on staging, 2026-09-22. */}
                {/* THREE OUTCOMES, THREE SENTENCES. This was a two-way branch on
                    `withdrawNoRefund`, and the credit path makes that flag
                    false - so a credit fell into the refund arm and the last
                    line an operator read before pressing "Give $240 credit" was
                    "Stripe sends the family its own refund confirmation
                    automatically. The money comes back from your Stripe
                    balance." Neither happens on a credit, and it contradicted
                    the credit panel's own "Nothing is emailed" a few lines
                    above, so the drawer asserted both at once. Exactly the
                    defect the comment above says was fixed for the withdraw
                    arm, reintroduced by adding a third outcome to a two-way
                    branch. */}
                <p style={{ color: MUTED, fontSize: 11.5, marginTop: 10, lineHeight: 1.5 }}>
                  {isCredit
                    ? "No money leaves your Stripe balance, and Stripe does not write to the family — it only emails them when a real refund happens. Telling them about the credit is yours to do."
                    : withdrawNoRefund
                      ? "No money moves, so the family is not emailed — Stripe only writes to them when a refund actually happens. Tell them yourself if they should know."
                      : "Stripe sends the family its own refund confirmation automatically. The money comes back from your Stripe balance."}
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
          {!loading && !loadErr && (
            <button type="button" onClick={submit} disabled={!canSubmit}
              style={{ padding: "8px 16px", background: canSubmit ? PURPLE : "#bbb", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: canSubmit ? "pointer" : "not-allowed" }}>
              {/* Three modes, three labels. The button is the last thing an
                  operator reads before money is decided, so it names the actual
                  outcome rather than a generic "Confirm" - and "Refund $240" on
                  a press that gives no refund is the lie this guards against. */}
              {isCredit
                ? (busy ? "Issuing credit…" : `Give ${fmtCents(amountCents)} credit`)
                : withdrawNoRefund
                  ? (busy ? "Withdrawing…" : "Withdraw without refunding")
                  : (busy ? "Issuing refund…" : `Refund ${fmtCents(amountCents)}`)}
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

// EXPORTED because the credits panel on Finances needs the identical control: a
// forced choice with a subtitle, on the other money screen an operator uses in
// the same sitting. It was reimplemented there as a bare <button>, which looked
// close enough and exposed no selected state to a screen reader at all. One
// control, one place - and the real radio input is the accessible half.
export function SeatRadio({ checked, onChange, disabled, title, sub }) {
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
