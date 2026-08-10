// src/pages/admin/Finances.jsx
// /admin/finances — operator-facing Stripe Connect onboarding + fee config.
//
// 5 visual states, driven by organizations.stripe_account_status:
//   not_connected   -> "Connect Stripe" CTA, no acct_ID yet.
//   onboarding      -> Stripe is verifying. Show status + "Continue setup".
//   active          -> Fully connected. Fee display, pass-through toggle,
//                      statement descriptor, withdrawal admin fee, "Open
//                      Stripe Dashboard" button.
//   restricted      -> Stripe paused something. Same UI as onboarding + an
//                      alert banner.
//   disconnected    -> Access to the account is gone: either the operator
//                      revoked enrops from Stripe's own dashboard, or they used
//                      Disconnect here. Same UI as not_connected, plus a context
//                      banner whose wording depends on the charge model.
//
// Disconnect (stripe-oauth-disconnect) is offered on every state that HOLDS an
// account — see canDisconnect. Without it, stripe-oauth-start's "already
// connected" refusal was a dead end for anyone who attached the wrong account.
//
// Multi-tenant: reads org from useOutletContext (AdminLayout supplies it).
// Never hardcodes J2S.
//
// Writes go directly through supabase-js for the unlocked columns
// (fee_pass_through, statement_descriptor_suffix, withdrawal_admin_fee_cents).
// RLS allows org members to update; the DB trigger blocks the LOCKED columns
// (stripe_account_id + the three platform fee rate cols) for non-admins.
// "Connect Stripe" / "Open Dashboard" actions go through edge functions.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { pixelStripeConnected } from "../../lib/metaPixel.js";
import EnnieTip from "../../components/EnnieTip.jsx";
import { STRIPE_CONNECT_ESTIMATE_SENTENCE } from "../../lib/stripeConnectEstimate.js";
import { describeOrgSaveFailure } from "../../lib/orgSaveErrors.js";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK = "#3a7c3a";
const AMBER = "#b67e00";
const RED = "#b53737";

function fmtCents(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

function fmtPct(rate) {
  return `${(Number(rate) * 100).toFixed(2)}%`;
}

// Compute a sensible placeholder for the statement descriptor suffix based on
// the org's actual name. Stripe's rules: uppercase, ASCII, 3-14 chars,
// allowed: letters/numbers/space/period/comma/hyphen. Never hardcode a
// specific tenant's name as the default.
function suggestStatementSuffix(orgName) {
  if (!orgName) return "ACME";
  const clean = orgName
    .toUpperCase()
    .replace(/[^A-Z0-9 .,\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14)
    .trim();
  return clean.length >= 3 ? clean : "ACME";
}

export default function Finances() {
  // setOrg is taken deliberately: this page CHANGES fee_pass_through, and
  // AdminLayout fetches `org` once per mount. Without correcting the context after
  // a save, ActivityTab below keeps rendering the old fee sentence and the screen
  // states both directions at once.
  const { org, orgMember, setOrg } = useOutletContext();
  // Registration-only operators: no school invoicing, no instructor payroll.
  const isLean = org?.instructor_pay_model === "enrops_platform";
  const [searchParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // WHICH action is in flight, not just whether one is. The two connect buttons
  // share `busy` (both must disable so a second click can't start a competing
  // flow), but they must not share the LABEL - clicking "Connect my Stripe
  // account" made "I don't use Stripe yet" also read "Starting…", telling the
  // operator something was happening on a path they never chose.
  const [busyAction, setBusyAction] = useState(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [savedToast, setSavedToast] = useState(null);
  const [downloading, setDownloading] = useState(false);
  // Result of the Disconnect action, rendered BESIDE that button rather than in
  // the page-level banners — see disconnectStripe(). { tone, text }.
  const [disconnectMsg, setDisconnectMsg] = useState(null);

  const canManage = orgMember?.role === "owner" || orgMember?.role === "admin";

  // Finances CSV export range (defaults to the last 90 days).
  const [exportFrom, setExportFrom] = useState(
    () => new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10),
  );
  const [exportTo, setExportTo] = useState(
    () => new Date().toISOString().slice(0, 10),
  );

  // Editable form state (mirrors columns; only used when canManage)
  const [feePassThrough, setFeePassThrough] = useState(false);
  // Failure of the pass-through toggle specifically, rendered beside the toggle
  // rather than in the page-level banner 280px above it.
  const [feeError, setFeeError] = useState(null);
  // True while a fee-mode save is in flight, so the toggle can be disabled. Two
  // fast clicks used to put two PATCHes in flight with no ordering guarantee, and
  // the DB could settle opposite to what the UI showed.
  const [feeSaving, setFeeSaving] = useState(false);
  // Families mid-payment-plan, from org_pending_plan_families.
  //
  // THREE states, and the difference matters: a number, 0, or null meaning WE
  // COULD NOT CHECK. This was a plain useState(0), so a failed count was
  // indistinguishable from "no families affected" — it suppressed the warning and
  // stripped the sentence from the confirm, which is the silent false reassurance
  // the warning exists to prevent. null now says so out loud.
  const [pendingPlans, setPendingPlans] = useState(null);
  const [descriptorSuffix, setDescriptorSuffix] = useState("");
  const [withdrawalAdminFeeDollars, setWithdrawalAdminFeeDollars] = useState("");
  // Inline tabs (only meaningful when active). Default to Activity.
  const [tab, setTab] = useState("activity");
  // Collapsible "Manage setup" banner when active. Collapsed by default —
  // the operator doesn't need to see fee toggle / descriptor / admin fee
  // every visit. Click "Manage setup" to expand.
  const [setupOpen, setSetupOpen] = useState(false);

  // Stripe return-from-onboarding banner. Stripe redirects to:
  //   /admin/finances?stripe=return    — operator finished or paused
  //   /admin/finances?stripe=refresh   — link expired, mint a new one
  //   /admin/finances?stripe=connected — connected an EXISTING account by OAuth
  //   /admin/finances?stripe=cancelled — they hit Cancel at Stripe (not an error)
  //   /admin/finances?stripe=error&reason=… — the connect failed; reason says why
  const stripeParam = searchParams.get("stripe");
  const stripeReason = searchParams.get("reason");

  // /admin/finances?setup=1 — arrive with "Manage setup" already open. Sent from
  // the Cancellation & Refund Policy card in Waivers & policies, which tells the
  // operator to come here and set their withdrawal admin fee. Without this the
  // panel is collapsed on arrival and they land on a page where the setting they
  // were just pointed at is nowhere on screen, which reads as a broken link.
  const wantsSetupOpen = searchParams.get("setup") === "1";

  // ── load config ─────────────────────────────────────────────────────────
  //
  // EVERY column read as `config.x` anywhere in this file must be listed in the
  // select below. Leaving one out does not throw and does not fail a build:
  // supabase-js simply returns an object without the key, the read is
  // `undefined`, and whatever depends on it silently disappears. That is exactly
  // what happened to stripe_charge_model on 2026-07-30 - the Disconnect button
  // could never render for anyone, with deno check, npm run build, the unit
  // tests and every edge-function runtime test all green. Loading the real page
  // is what caught it. No PostgREST select string may contain SQL comments, so
  // this note lives here rather than inline.
  async function reload() {
    if (!org?.id) {
      // CLEAR the flag on the way out. `loading` starts true, so returning
      // without touching it leaves every consumer believing a fetch is still in
      // flight forever - which is how the connect banner ended up showing
      // "Checking with Stripe for the details…" permanently.
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("organizations")
      .select(`
        id,
        name,
        stripe_account_id,
        stripe_account_status,
        stripe_charges_enabled,
        stripe_payouts_enabled,
        stripe_business_type,
        stripe_country,
        stripe_charge_model,
        platform_fee_card_pct,
        platform_fee_ach_pct,
        platform_fee_cap_cents,
        platform_fee_floor_cents,
        fee_pass_through,
        statement_descriptor_suffix,
        withdrawal_admin_fee_cents,
        platform_plan
      `)
      .eq("id", org.id)
      .single();
    if (err) {
      setError(err.message || "Could not load finance settings.");
      setLoading(false);
      return;
    }
    setConfig(data);
    setFeePassThrough(!!data.fee_pass_through);
    setDescriptorSuffix(data.statement_descriptor_suffix || "");
    setWithdrawalAdminFeeDollars(
      data.withdrawal_admin_fee_cents != null
        ? ((data.withdrawal_admin_fee_cents || 0) / 100).toFixed(2)
        : ""
    );
    setLoading(false);
  }

  // Families mid-payment-plan, for the pass-through warning.
  //
  // Its OWN effect, not part of reload(): as a second await inside reload() it
  // gated first paint of the whole money page on an installments scan, for every
  // visitor including the roles and Stripe states that can never see the warning
  // it feeds. Gated on canManage for the same reason.
  //
  // The count lives in SQL (org_pending_plan_families) rather than being derived
  // from fetched rows. The previous client-side version was wrong three ways:
  // DISTINCT registration_id counted registrations rather than families (measured
  // on prod: 30 registrations but only 18 parents); a deny-list of terminal
  // statuses counted paused_card_failed rows that process-installments never
  // charges again; and counting returned rows hits PostgREST's 1000-row cap, the
  // bug stripe-oauth-disconnect documents as proven on staging 2026-07-30.
  useEffect(() => {
    if (!org?.id || !canManage) { setPendingPlans(null); return; }
    let alive = true;
    (async () => {
      const { data, error: err } = await supabase
        .rpc("org_pending_plan_families", { p_org: org.id });
      if (!alive) return;
      if (err) {
        // null, never 0. Zero would read as "no families affected" and silently
        // suppress the warning; null renders an explicit "couldn't check".
        console.warn("[finances] could not count in-flight payment plans:", err.message);
        setPendingPlans(null);
        return;
      }
      setPendingPlans(Number(data) || 0);
    })();
    return () => { alive = false; };
  }, [org?.id, canManage]);

  // A failure message about org A must not survive onto org B.
  useEffect(() => { setFeeError(null); }, [org?.id]);

  // Actively poll Stripe and write the operator's status, then reload. This is
  // the deterministic fallback for the account-activation gap: the webhook
  // (handleAccountUpdated) only fires on the classic v1 `account.updated`
  // event, so an operator whose account is minted as v2 would finish
  // onboarding but never flip to 'active'. sync-operator-stripe-status hits the
  // v1 Accounts API directly (shape-agnostic) and applies the same mapping.
  async function syncStripeStatus() {
    if (!org?.id) return null;
    let result = null;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      // Distinguishable from a network failure. Both used to return null, so
      // "Check status" told an operator whose session had lapsed to "try again
      // in a moment" — advice that can never work, since the fix is signing in
      // again. downloadFinances below has always handled this case correctly.
      if (!token) return { error: "no_session" };
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-operator-stripe-status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ org_id: org.id }),
        }
      );
      result = await resp.json().catch(() => null);
    } catch (err) {
      // Non-fatal: fall back to the passive DB re-read. A real webhook may
      // still land the status moments later.
      console.warn("[finances] operator stripe status sync failed:", err);
    }

    // Advertising conversion, at the ONE moment the operator became able to
    // take money. `changed` is the edge function's own transition flag, and it
    // is the same condition that function uses to log its stripe_connected
    // platform event - so the pixel and our own records cannot disagree about
    // what "connected" means.
    //
    // Both entry paths funnel through here (the ?stripe= return effect and the
    // manual "Check status" button), which is why this sits in the shared
    // helper rather than in either caller.
    //
    // DELIBERATELY OUTSIDE the fetch's try. Inside it, a throw from the pixel
    // was caught by the handler above and logged as "operator stripe status
    // sync failed" - pointing anyone debugging a payments problem at the
    // payments path when the fault was advertising telemetry. Its own try keeps
    // a telemetry failure from breaking the operator's actual task.
    //
    // KNOWN UNDERCOUNT: Stripe often activates an account by webhook while the
    // operator is nowhere near this page, and that transition is invisible to
    // the browser. Those conversions are simply lost to the pixel. The
    // Conversions API is the fix; this is noted for Darren.
    if (result?.changed === true && result?.stripe_account_status === "active") {
      try {
        pixelStripeConnected();
      } catch (pixelErr) {
        console.warn("[finances] StripeConnected pixel event failed:", pixelErr);
      }
    }

    await reload();
    return result;
  }

  // Download a CSV of the org's money records (registrations + instructor
  // payouts) for the operator's bookkeeper. Server re-checks owner/admin.
  async function downloadFinances() {
    if (!org?.id || !canManage) return;
    setDownloading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError("Please sign in again to export.");
        return;
      }
      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/export-finances`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            organization_id: org.id,
            date_from: exportFrom,
            date_to: exportTo,
          }),
        }
      );
      if (!resp.ok) {
        const msg = await resp.json().catch(() => null);
        setError(
          msg?.error === "forbidden"
            ? "Only owners and admins can export finances."
            : "Could not export finances. Please try again."
        );
        return;
      }
      const csv = await resp.text();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `enrops-finances-${exportFrom}_to_${exportTo}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[finances] export failed:", err);
      setError("Could not export finances. Please try again.");
    } finally {
      setDownloading(false);
    }
  }

  // Manual "Check status" — for an operator who finished Stripe earlier but
  // never got flipped (e.g. a v2 account whose activation never reached the
  // webhook) and is revisiting Finances without the ?stripe=return param.
  async function checkStripeStatus() {
    if (!canManage) return;
    setCheckingStatus(true);
    setError(null);
    const result = await syncStripeStatus();
    setCheckingStatus(false);
    // One sentence per state sync can actually return, because "Still verifying
    // — nothing to do yet" is only true for ONE of them. It was being shown for
    // all four non-active outcomes:
    //   onboarding   — the operator's setup is UNFINISHED. Telling them there is
    //                  nothing to do is the opposite of the truth, and this
    //                  button lives on the onboarding screen, so that was the
    //                  most likely outcome of pressing it.
    //   restricted   — Stripe is waiting on THEM.
    //   disconnected — newly reachable: sync now reports the real status when a
    //                  concurrent disconnect supersedes the poll (superseded:
    //                  true). The page re-renders into the disconnected state at
    //                  the same moment, so the old copy would have contradicted
    //                  the screen it sits on.
    const status = result?.stripe_account_status;
    const toast = (msg) => { setSavedToast(msg); setTimeout(() => setSavedToast(null), 3000); };
    if (result?.error === "no_session") {
      setError("Please sign in again to check your Stripe status.");
    } else if (result?.error) {
      setError("Couldn't reach Stripe just now. Try again in a moment.");
    } else if (status === "active") {
      toast("You're all set — payments now route to your own account.");
    } else if (status === "disconnected") {
      toast("That Stripe account is disconnected, so payments are off. Connect one below.");
    } else if (status === "restricted") {
      toast("Stripe needs a bit more from you before payments can switch on.");
    } else if (status === "onboarding") {
      toast("Stripe still needs your setup finished — pick up where you left off.");
    } else if (result) {
      toast("Still verifying with Stripe — nothing to do yet.");
    } else {
      // syncStripeStatus swallows a network failure and returns null, so every
      // branch above misses and the button produced NO feedback at all — the
      // "looks dead" failure. Say something true instead.
      setError("Couldn't reach Stripe just now. Try again in a moment.");
    }
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [org?.id]);

  // Deliberately one-way: it OPENS the panel and never closes it. Tying
  // setupOpen to the param instead would fight the operator, snapping the panel
  // shut again the moment they collapsed it themselves.
  useEffect(() => { if (wantsSetupOpen) setSetupOpen(true); }, [wantsSetupOpen]);

  // Re-fetch when Stripe bounces back so the new status is visible quickly.
  // (The webhook is the source of truth, but it may land a few seconds after
  // the redirect — or never, for v2 accounts. See syncStripeStatus.)
  useEffect(() => {
    if (!stripeParam) return;
    if (stripeParam === "return") {
      // Operator finished/paused onboarding: poll Stripe + write status, then
      // reload. The delayed reload still catches a late v1 webhook.
      syncStripeStatus();
    } else {
      // 'refresh' (link expired) or anything else: just re-read.
      reload();
    }
    const t = setTimeout(reload, 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [stripeParam]);

  // ── derived UI state ────────────────────────────────────────────────────
  const status = config?.stripe_account_status || "not_connected";
  const accountId = config?.stripe_account_id;
  const isActive = status === "active";
  // 'verifying' is deliberately NOT lumped in here. It means Stripe is
  // reviewing and the operator owes nothing, so it must not render the
  // "finish your setup" body — that told an operator who had done everything
  // to go supply information Stripe wasn't asking for.
  const isOnboardingOrRestricted = status === "onboarding" || status === "restricted";
  const isVerifying = status === "verifying";
  const isDisconnected = status === "disconnected";

  // Whether to offer Disconnect at all. Every clause is load-bearing:
  //   canManage      - same bar as connecting. Staff/viewer must not detach the
  //                    account the whole business gets paid through.
  //   accountId      - nothing to disconnect otherwise.
  //   status         - not_connected/disconnected are already there; the button
  //                    would be a no-op that looks like an action.
  //   charge model   - the edge function refuses anything but 'direct' (a
  //                    destination org's charges keep succeeding into the
  //                    platform balance when its account goes away, which is a
  //                    different money story). Gating HERE as well means we
  //                    never render a button whose only outcome is a refusal.
  //                    This is a CONFIG branch, not a tenant branch: both
  //                    connect paths a new tenant can take write 'direct'.
  const chargeModel = config?.stripe_charge_model || null;
  const canDisconnect =
    canManage &&
    !!accountId &&
    status !== "not_connected" &&
    status !== "disconnected" &&
    chargeModel === "direct";

  // ── actions ─────────────────────────────────────────────────────────────
  async function startOnboarding() {
    setBusy(true);
    setBusyAction("create");
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-connect-onboard`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            org_id: org.id,
            origin: window.location.origin,
          }),
        }
      );
      const json = await resp.json();
      if (!resp.ok || !json.onboarding_url) {
        // `message` first: stripe-connect-onboard's org_id_required refusal
        // writes a sentence an operator can act on, and without reading it here
        // the bare code `org_id_required` would land on their money screen.
        throw new Error(
          json?.message || json?.stripe_message || json?.error || `Onboarding failed (${resp.status}).`
        );
      }
      window.location.href = json.onboarding_url;
    } catch (err) {
      setError(err.message || "Could not start Stripe onboarding.");
      setBusy(false);
      setBusyAction(null);
    }
  }

  // Connect a Stripe account the operator ALREADY has.
  //
  // Distinct from startOnboarding, which calls accounts.create and always mints
  // a BRAND NEW account. Stripe's onboarding offers to reuse an existing
  // account's verified details but per its docs "creates a new connected account
  // while reusing and sharing verified information" - it does not connect the
  // account. OAuth is the only mechanism that attaches one that already exists.
  async function startOAuthConnect() {
    setBusy(true);
    setBusyAction("oauth");
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-oauth-start`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            org_id: org.id,
            origin: window.location.origin,
          }),
        }
      );
      const json = await resp.json();
      if (!resp.ok || !json.authorize_url) {
        // The function's own `message` is written for an operator to read
        // (already_connected explains what to do next); prefer it over the code.
        throw new Error(
          json?.message || json?.error || `Could not start Stripe connect (${resp.status}).`
        );
      }
      window.location.href = json.authorize_url;
    } catch (err) {
      setError(err.message || "Could not start Stripe connect.");
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function openExpressDashboard() {
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-stripe-operator-login-link`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ org_id: org.id }),
        }
      );
      const json = await resp.json();
      if (!resp.ok || !json.url) {
        throw new Error(json?.stripe_message || json?.error || `Could not generate dashboard link (${resp.status}).`);
      }
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err.message || "Could not open Stripe dashboard.");
    } finally {
      setBusy(false);
    }
  }

  // Detach the connected Stripe account so a different one can be connected.
  //
  // Until this existed, stripe-oauth-start's "you already have an account
  // connected" refusal was a dead end: nothing in the product could set
  // status='disconnected' except Stripe's own deauthorized webhook, so an
  // operator who connected the WRONG account had to go find the revoke button
  // inside Stripe's dashboard.
  //
  // Feedback is deliberately NOT routed through the page-level `error` /
  // `savedToast` banners at the top of the page. This control lives at the
  // bottom of an expanded settings panel, so a confirmation 1,200px above the
  // click reads as a dead button. The panel renders `disconnectMsg` itself.
  async function disconnectStripe() {
    if (!canManage) return;
    const label = accountId ? `\n\nAccount: ${accountId}` : "";
    const ok = window.confirm(
      "Disconnect this Stripe account?" + label + "\n\n" +
      "• Families won't be able to pay you through enrops until you connect another account — any registration links you've shared will stop taking payments.\n" +
      "• Refunds through enrops on payments already taken on this account will stop working too.\n" +
      "• Your Stripe account itself stays open and yours. We just stop using it.\n\n" +
      "You can connect a different account straight afterwards."
    );
    if (!ok) return;

    setBusy(true);
    setBusyAction("disconnect");
    setDisconnectMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const authToken = session?.access_token;
      if (!authToken) throw new Error("Not signed in.");

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-oauth-disconnect`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ org_id: org.id }),
        }
      );
      const json = await resp.json();
      if (!resp.ok) {
        // The function writes `message` for an operator to read — the
        // unpaid-instalment refusal names the count and the amount, which is
        // the whole point of it. Prefer it over the code every time.
        throw new Error(
          json?.message || json?.error || `Could not disconnect (${resp.status}).`
        );
      }
      // Three outcomes, three sentences, each true only in its own case. The
      // function reports which one happened rather than encoding it in a boolean:
      //   revoked         - we called Stripe and access is genuinely gone.
      //   controlled      - the account is one WE created, so there was no grant
      //                     to revoke; we simply stopped using it. Saying
      //                     "no longer has access" here would be false, and an
      //                     operator looking at their own Stripe connected-apps
      //                     list would catch us in it.
      //   already_revoked - the grant was gone before we asked (they revoked us
      //                     from Stripe's dashboard while we were connected).
      //   already_disconnected - the org was ALREADY in the disconnected state
      //                     before this click. Deliberately its own sentence:
      //                     the row records the status but not how it got there,
      //                     so an org unlinked via the controlled path (never
      //                     revoked, enrops still HAS access) must not be told
      //                     "enrops has no access to it".
      const outcomeText = {
        revoked:
          "Disconnected. enrops no longer has access to that Stripe account. You can connect a different one now.",
        controlled:
          "Disconnected. enrops has stopped using that Stripe account — the account itself is still open and yours. You can connect a different one now.",
        already_revoked:
          "That account is already disconnected — enrops has no access to it. You can connect a different one now.",
        already_disconnected:
          "That account is already disconnected — enrops isn't using it. You can connect a different one now.",
      };
      setDisconnectMsg({
        tone: "ok",
        // The fallback must NOT be one of the three above. If `outcome` is ever
        // missing, defaulting to the "revoked" wording would assert the
        // strongest thing we could say - that access is gone - on the one path
        // where we do not know. This sentence is true in all three cases.
        text: outcomeText[json.outcome] ||
          "Disconnected. enrops has stopped using that Stripe account. You can connect a different one now.",
      });
      await reload();
    } catch (err) {
      setDisconnectMsg({ tone: "err", text: err.message || "Could not disconnect Stripe." });
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function togglePassThrough(nextValue) {
    if (!canManage || feeSaving) return;
    setFeeError(null);

    // ── the in-flight-plan consequence ────────────────────────────────────────
    // There no longer is one, and that is a deliberate change rather than an
    // omission. Every installment row now carries `fee_pass_through` as it stood
    // at CHECKOUT (create-checkout -> checkout_schedules -> the row), and
    // process-installments honours that over live org config. So this toggle
    // cannot reach a plan that is already running: it decides what NEW families
    // are asked to pay, and nothing else.
    //
    // The old guard here refused to flip ON while the pending-plan count was
    // unknown. Its purpose was to stop an operator repricing families blind —
    // the blast radius it was measuring no longer exists, so the guard is gone
    // rather than left as a hoop with no reason behind it. What it protected is
    // now protected in the database, which is the only place it could not be
    // clicked past. (Rows written before the snapshot shipped fall back to live
    // config, so this promise is only true once that backfill has run — it did,
    // on both environments, in the same pass as the column.)
    //
    // What replaces it is the sentence below: operators flip this expecting
    // their margin to change on everything, and they need telling that the
    // families already on plans are not affected. Silence would read as "it
    // changed everything", which is what it used to do.
    const familiesPhrase = pendingPlans === 1 ? "1 family is" : `${pendingPlans} families are`;
    const planNote = pendingPlans > 0
      ? `\n\n${familiesPhrase} partway through a payment plan. They keep the price they ` +
        "agreed to, so their remaining payments do not change. This applies to new " +
        "registrations only."
      : "";
    const prompt = nextValue === true
      ? "Pass-through mode: families will see the service fee as a separate line " +
        "at checkout, so you keep your full price. Switch to pass-through?"
      : "Absorb mode: families pay only your class price and the enrops service fee " +
        "comes out of your payout instead. Switch to absorbing the fee?";
    if (!window.confirm(prompt + planNote)) return;

    const prev = feePassThrough;
    setFeeSaving(true);
    setFeePassThrough(nextValue);
    // .select() is load-bearing. members_update_own_org is FOR UPDATE USING with no
    // WITH CHECK, and a USING-filtered UPDATE returns 204 with error === null — so
    // without reading rows back, a write RLS silently discarded reported "saved".
    // Before 20260806a the trigger raised 42501 on that path; now RLS is the only
    // gate and it fails quietly.
    const { data: updated, error: err } = await supabase
      .from("organizations")
      .update({ fee_pass_through: nextValue })
      .eq("id", org.id)
      .select("id, fee_pass_through");
    setFeeSaving(false);

    if (err || !updated || updated.length === 0) {
      setFeePassThrough(prev);
      // Log the raw error: the mapped copy below is all the operator sees, and
      // without this the code and message are lost for diagnosis.
      console.warn("[finances] fee mode save failed:", err || "0 rows updated");
      // TODO(copy): Arielle owns operator-facing wording — draft only.
      setFeeError(describeOrgSaveFailure(err));
      return;
    }

    // Correct AdminLayout's one-shot org so ActivityTab's fee sentence agrees with
    // the toggle. Without this the same screen states both directions at once.
    setOrg?.((o) => (o ? { ...o, fee_pass_through: updated[0].fee_pass_through } : o));
    setSavedToast("Fee mode saved");
    setTimeout(() => setSavedToast(null), 2200);
  }

  async function saveDescriptorSuffix() {
    if (!canManage) return;
    const trimmed = descriptorSuffix.trim().toUpperCase();
    // Match the CHECK constraint locally so we don't round-trip a bad value.
    if (trimmed !== "" && (trimmed.length < 3 || trimmed.length > 14)) {
      setError("Statement suffix must be 3–14 characters.");
      return;
    }
    if (trimmed !== "" && !/^[A-Z0-9 .,\-]+$/.test(trimmed)) {
      setError("Statement suffix can use letters, numbers, space, period, comma, hyphen only.");
      return;
    }
    setError(null);
    const value = trimmed === "" ? null : trimmed;
    const { error: err } = await supabase
      .from("organizations")
      .update({ statement_descriptor_suffix: value })
      .eq("id", org.id);
    if (err) {
      // Same table, same guard, so the same mapper: err.message here is the raw
      // platform-admin column list, which is developer text.
      console.warn("[finances] statement suffix save failed:", err);
      setError(describeOrgSaveFailure(err));
      return;
    }
    setDescriptorSuffix(value || "");
    setSavedToast("Statement suffix saved");
    setTimeout(() => setSavedToast(null), 2200);
  }

  async function saveAdminFee() {
    if (!canManage) return;
    const numeric = parseFloat(withdrawalAdminFeeDollars);
    if (withdrawalAdminFeeDollars !== "" && (Number.isNaN(numeric) || numeric < 0)) {
      setError("Admin fee must be a positive number, or blank for none.");
      return;
    }
    setError(null);
    const cents = withdrawalAdminFeeDollars === "" ? 0 : Math.round(numeric * 100);
    const { error: err } = await supabase
      .from("organizations")
      .update({ withdrawal_admin_fee_cents: cents })
      .eq("id", org.id);
    if (err) {
      console.warn("[finances] admin fee save failed:", err);
      setError(describeOrgSaveFailure(err));
      return;
    }
    setWithdrawalAdminFeeDollars((cents / 100).toFixed(2));
    setSavedToast("Admin fee saved");
    setTimeout(() => setSavedToast(null), 2200);
  }

  // ── render ──────────────────────────────────────────────────────────────
  if (loading) {
    return <PageShell><Card><div style={{ color: MUTED }}>Loading…</div></Card></PageShell>;
  }

  // Built ONCE and rendered in whichever of the two mutually-exclusive nav
  // surfaces applies: the legacy full-nav panel (!isLean, J2S) and the hoisted
  // lean card. They previously carried duplicate prop lists, and the first pass of
  // this change updated only the lean one — which would have shipped the fix to
  // every tenant except J2S, the org with the most families mid-plan. One element
  // makes that drift impossible rather than something to remember.
  const feePayerRow = (
    <FeePayerRow
      feePassThrough={feePassThrough}
      canManage={canManage}
      onToggle={togglePassThrough}
      error={feeError}
      pendingPlans={pendingPlans}
      saving={feeSaving}
    />
  );

  return (
    <PageShell>
      {/* Heading and subtitle follow the nav. A registration operator's nav says
          "Payments", so a page titled "Receivables" reads as a different screen —
          and the old subtitle promised "invoices to schools", which they don't
          have and can't get. Say what this page actually is for them. J2S keeps
          the accounting language its nav still uses. */}
      {/* ONE tip per page, at the title. Same place on every screen, so the "?"
          becomes something an operator learns once rather than hunts for. It
          used to sit mid-paragraph further down this page, which read as
          floating and broke that rule. Lean only: the fee it explains is the
          registration operator's fee. */}
      <h1 style={{ margin: "0 0 4px", color: PURPLE, fontSize: 28, fontWeight: 700, display: "flex", alignItems: "center", gap: 2 }}>
        {isLean ? "Payments" : "Receivables"}
        {/* `feePassThrough`, not `feeCfg` - feeCfg only exists inside ActivityTab
            further down this file, and referencing it here rendered a blank page
            (a ReferenceError the build cannot catch, because an undefined
            identifier is only a problem at runtime).
            Gated on `config` because feePassThrough starts false and is set from
            the same fetch: before it lands we do not KNOW which is true, and the
            wrong branch is a confident lie about the operator's own fee. Using
            the state rather than config.fee_pass_through so the tip follows the
            toggle without a reload. */}
        {isLean && config && (feePassThrough ? (
          <EnnieTip title="Why do families see the fee?">
            They see it before they pay, on purpose. Costs that appear at the last
            step are the number one reason people abandon an online order (40%,
            Baymard Institute). Shown up front, the same cost doesn&rsquo;t do that.
          </EnnieTip>
        ) : (
          <EnnieTip title="Why is there no fee at checkout?">
            Families pay exactly your class price, because you&rsquo;re covering
            the fee. Nothing turns up at the last step that wasn&rsquo;t on the
            class page &mdash; and last-step surprises are the number one reason
            people abandon an online order (40%, Baymard Institute).
          </EnnieTip>
        ))}
      </h1>
      <p style={{ margin: "0 0 24px", color: MUTED, fontSize: 14 }}>
        {isLean
          ? "Money from families — what's come in, and anything you've refunded."
          : "Money coming in — parent payments, invoices to schools, refunds."}
      </p>

      {stripeParam === "return" && (
        <Banner tone="ok">
          You're back from Stripe. Your status is updating shortly — refresh if needed.
        </Banner>
      )}
      {stripeParam === "refresh" && (
        <Banner tone="info">
          Stripe's setup link expired. Click "Continue setup" below for a fresh one.
        </Banner>
      )}
      {/* CONNECTED is not the same as CAN TAKE MONEY, and this banner must not
          conflate them. buildChargeRouting FAILS CLOSED when an org is
          stripe_charge_model='direct' with stripe_charges_enabled=false
          (connectChargeParams.ts) - checkout is blocked. A Standard account can
          connect in exactly that shape, so a flat "payments will land in it",
          chosen off the URL param alone, would promise money movement on the one
          screen where it is already blocked, while the card below it says the
          opposite. Each branch below is selected by the LOADED status, not by the
          redirect. */}
      {stripeParam === "connected" && (
        loading ? (
          <Banner tone="ok">
            Your Stripe account is connected. Checking with Stripe for the details…
          </Banner>
        ) : !config ? (
          // Done loading and still no config. "Checking…" here would be a
          // progress message that never resolves, so name the failure and give
          // them the one action that helps.
          <Banner tone="warn">
            Your Stripe account is connected, but we couldn't load your payment details
            just now. Reload the page to try again.
          </Banner>
        ) : config.stripe_charges_enabled ? (
          <Banner tone="ok">
            Your Stripe account is connected. Payments from families will land in it.
          </Banner>
        ) : config.stripe_account_status === "verifying" ? (
          <Banner tone="info">
            Your Stripe account is connected. Stripe is still reviewing it, so payments
            aren't switched on yet — there's nothing more for you to do.
          </Banner>
        ) : (
          <Banner tone="warn">
            Your Stripe account is connected, but Stripe needs a bit more before you can
            take payments. The steps are below.
          </Banner>
        )
      )}
      {stripeParam === "cancelled" && (
        <Banner tone="info">
          No problem — nothing changed. Your Stripe account isn't connected yet, so
          you can't take payments until you connect one.
        </Banner>
      )}
      {stripeParam === "error" && (
        <Banner tone="err">{describeConnectFailure(stripeReason)}</Banner>
      )}
      {error && (
        <Banner tone="err">{error}</Banner>
      )}
      {/* A SUCCESSFUL disconnect flips the status, which makes canDisconnect
          false, which UNMOUNTS DisconnectPanel - taking its own confirmation
          with it. Observed live on staging 2026-07-30: the account really was
          disconnected and the page really did re-render, but the operator was
          never told it worked; they had to infer it from the screen changing
          under them. So the message is rendered here whenever the panel is gone.
          The two are mutually exclusive (the panel renders only when
          canDisconnect is true), so exactly one copy is ever on screen - and in
          the post-disconnect state the page collapses to one short card, so this
          IS beside where they just clicked, not a banner far above it. */}
      {disconnectMsg && !canDisconnect && (
        <Banner tone={disconnectMsg.tone}>{disconnectMsg.text}</Banner>
      )}
      {savedToast && (
        <Banner tone="ok">{savedToast}</Banner>
      )}

      {/* When ACTIVE: slim collapsible setup banner + tabs.
          When NOT active: big setup card (operator has to finish setup before
          tabs/activity make sense). */}

      {isActive ? (
        <SetupBanner
          accountId={accountId}
          chargesEnabled={!!config?.stripe_charges_enabled}
          payoutsEnabled={!!config?.stripe_payouts_enabled}
          open={setupOpen}
          onToggle={() => setSetupOpen((v) => !v)}
          onOpenDashboard={openExpressDashboard}
          busy={busy}
        />
      ) : (
        <Card>
          <Section>
            <Heading>Get paid through enrops</Heading>

            {status === "not_connected" && (
              <NotConnectedBody
                onConnect={startOnboarding}
                onConnectExisting={startOAuthConnect}
                busy={busy}
                busyAction={busyAction}
                canManage={canManage}
              />
            )}

            {isOnboardingOrRestricted && (
              <OnboardingBody
                status={status}
                onContinue={startOnboarding}
                onCheckStatus={checkStripeStatus}
                checking={checkingStatus}
                busy={busy}
                canManage={canManage}
                chargesEnabled={!!config?.stripe_charges_enabled}
                payoutsEnabled={!!config?.stripe_payouts_enabled}
              />
            )}

            {isVerifying && (
              <VerifyingBody
                onCheckStatus={checkStripeStatus}
                checking={checkingStatus}
                canManage={canManage}
              />
            )}

            {isDisconnected && (
              <DisconnectedBody
                onReconnect={startOnboarding}
                onConnectExisting={startOAuthConnect}
                busy={busy}
                busyAction={busyAction}
                canManage={canManage}
                chargeModel={chargeModel}
              />
            )}

            {/* Wrong account connected? This is the state an operator is
                actually stuck in — mid-onboarding on an account they didn't
                mean to attach, with stripe-oauth-start refusing to let them
                pick another. Quiet, at the bottom, but present.

                NOT on 'verifying'. That body tells the operator, correctly,
                that everything is submitted, there is nothing more to do, and
                it usually clears in a couple of minutes. Offering "wrong
                account? disconnect it" directly underneath is the opposite
                advice on the same screen, and taking it throws away a Stripe
                review that was about to finish on its own — for a fresh account
                they would have to onboard from the start. If they genuinely
                picked the wrong account they can disconnect once it settles. */}
            {canDisconnect && !isVerifying && (
              <DisconnectPanel
                variant="inline"
                accountId={accountId}
                onDisconnect={disconnectStripe}
                busy={busy}
                busyAction={busyAction}
                checking={checkingStatus}
                message={disconnectMsg}
              />
            )}
          </Section>
        </Card>
      )}

      {/* Expanded "Manage setup" detail — fee config, descriptor, admin fee.
          Renders directly under its banner (above the tabs) when expanded, so
          clicking "Manage setup" reveals the fee config without scrolling past
          the Activity feed. */}
      {isActive && setupOpen && (
        <>
          <Card>
            <Section>
              <Heading>Fees on each payment</Heading>
              {/* "service fee", never "processing fee", for OUR charge. It is
                  enrops's own fee taken as a Stripe Connect application fee, not
                  a markup on the card transaction — and surcharging a card cost
                  to a customer is prohibited in CT/ME/MA and constrained in CA.
                  Stripe's own fee below keeps the word "processing", because
                  that is exactly what it is. The two must never read as one. */}
              <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
                Two separate fees come out of each parent payment — the enrops service
                fee and Stripe's processing fee. They're never bundled into one number.
              </p>

              <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, margin: "4px 0 8px" }}>
                enrops service fee
              </div>
              <FeeReadout config={config} />

              <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, margin: "16px 0 8px" }}>
                Stripe processing fee
              </div>
              <div style={{ background: "#FBFBFB", border: `1px solid ${RULE}`, borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 14, color: INK }}>
                  Stripe's standard rate — about 2.9% + 30&cent; per card payment, or
                  0.8% (never more than $5) if a family pays by bank transfer.
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                  Stripe takes this out before the money reaches your bank. It is separate from
                  the enrops service fee above — not an enrops fee.
                </div>
              </div>

              {/* For lean ops this control is hoisted OUT of "Manage setup" and
                  rendered on the page (see the always-visible card below), so
                  it isn't duplicated here. J2S keeps it in place. */}
              {!isLean && (
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${RULE}` }}>
                  {feePayerRow}
                </div>
              )}
            </Section>
          </Card>

          <Card>
            <Section>
              <Heading>Bank statement label</Heading>
              <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
                What parents see on their card statement. Combined with the platform prefix
                "ENROPS", so a suffix of "J2S" shows up as "ENROPS J2S". 3–14 characters.
              </p>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text"
                  value={descriptorSuffix}
                  onChange={(e) => setDescriptorSuffix(e.target.value.toUpperCase())}
                  disabled={!canManage}
                  placeholder={suggestStatementSuffix(config?.name)}
                  maxLength={14}
                  style={{
                    padding: "8px 12px",
                    fontSize: 14,
                    border: `1px solid ${RULE}`,
                    borderRadius: 6,
                    fontFamily: "inherit",
                    minWidth: 180,
                    textTransform: "uppercase",
                  }}
                />
                {canManage && (
                  <button onClick={saveDescriptorSuffix} style={btn(BRIGHT, "#fff")}>
                    Save
                  </button>
                )}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
                Preview: <strong>ENROPS {descriptorSuffix.trim() || "(your org)"}</strong>
              </div>
            </Section>
          </Card>

          {/* Hidden for registration operators. The export is built around
              registrations AND instructor payouts, and a registration-only
              operator has no payouts — so half of what it promises doesn't
              exist for them. Exporting is also on the paid track, so offering
              it here would be promising something we intend to charge for. */}
          {!isLean && (
          <Card>
            <Section>
              <Heading>Export your finances</Heading>
              <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
                Download a CSV of your registrations and instructor payouts for your
                bookkeeper or accountant — import it into QuickBooks, Xero, or a spreadsheet.
                Your books stay yours; this just hands them clean data.
              </p>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                <label style={{ fontSize: 13, color: MUTED }}>
                  From
                  <input
                    type="date"
                    value={exportFrom}
                    max={exportTo}
                    onChange={(e) => setExportFrom(e.target.value)}
                    style={{ display: "block", marginTop: 4, padding: "8px 12px", fontSize: 14, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit" }}
                  />
                </label>
                <label style={{ fontSize: 13, color: MUTED }}>
                  To
                  <input
                    type="date"
                    value={exportTo}
                    min={exportFrom}
                    onChange={(e) => setExportTo(e.target.value)}
                    style={{ display: "block", marginTop: 4, padding: "8px 12px", fontSize: 14, border: `1px solid ${RULE}`, borderRadius: 6, fontFamily: "inherit" }}
                  />
                </label>
                {canManage ? (
                  <button onClick={downloadFinances} disabled={downloading} style={btn(BRIGHT, "#fff")}>
                    {downloading ? "Preparing…" : "Download CSV"}
                  </button>
                ) : (
                  <span style={{ color: MUTED, fontSize: 12 }}>Owner/admin only</span>
                )}
              </div>
            </Section>
          </Card>
          )}

          <Card>
            <Section>
              <Heading>Withdrawal admin fee</Heading>
              <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
                When a parent withdraws, this amount can be deducted from their refund. It
                shows up as a quick-fill option on the refund screen — you can still type a
                different number. Set to blank if you don't charge one.
              </p>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ position: "relative", display: "inline-block" }}>
                  <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: MUTED, fontSize: 14 }}>$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={withdrawalAdminFeeDollars}
                    onChange={(e) => setWithdrawalAdminFeeDollars(e.target.value)}
                    disabled={!canManage}
                    placeholder="0.00"
                    style={{
                      padding: "8px 12px 8px 24px",
                      fontSize: 14,
                      border: `1px solid ${RULE}`,
                      borderRadius: 6,
                      fontFamily: "inherit",
                      minWidth: 140,
                    }}
                  />
                </div>
                {canManage && (
                  <button onClick={saveAdminFee} style={btn(BRIGHT, "#fff")}>
                    Save
                  </button>
                )}
              </div>
            </Section>
          </Card>

          {canDisconnect && (
            <DisconnectPanel
              variant="card"
              accountId={accountId}
              onDisconnect={disconnectStripe}
              busy={busy}
              busyAction={busyAction}
              checking={checkingStatus}
              message={disconnectMsg}
            />
          )}
        </>
      )}

      {/* Tabs (Activity / Invoices / Refunds) — render below the setup detail
          so the expanded "Manage setup" fee config sits under its own banner. */}
      {isActive && (
        <>
          {/* Checklist: "Operator has a setting to absorb the fee instead — off
              by default." It existed but was buried inside the collapsed
              "Manage setup" panel, so an operator would never know it was a
              choice. On the page now, for lean ops, where a pricing decision
              belongs. Default stays families-pay (fee_pass_through=true from
              provisioning) — absorbing is the opt-in. */}
          {isLean && (
            <Card>
              <Section>
                {feePayerRow}
              </Section>
            </Card>
          )}
          <AchAttention org={org} />
          {/* Invoices is school-billing, which a registration operator has no
              use for. Hidden for lean along with its tab, and `tab` is coerced
              back to activity so a stale "invoices" selection can't render an
              empty screen with no way out. */}
          <TabsNav tab={tab} onTab={setTab} hideInvoices={isLean} />
          {(tab === "activity" || (isLean && tab === "invoices")) && <ActivityTab org={org} />}
          {tab === "invoices" && !isLean && <InvoicesTab />}
          {tab === "refunds" && (
            <>
              <RefundsTab org={org} />
              {/* v4 section 5: disputes live next to refunds because they are the
                  same question for an operator - money going back out. */}
              <DisputesPanel org={org} />
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

// ───────────────────────────── sub-components ──────────────────────────────

// Bank-transfer (ACH) reconcile surface. Surfaces registrations whose bank
// transfer is still clearing ('processing') or bounced ('failed') so the
// operator can act. Failed = chase payment or drop the seat (operator also gets
// an email alert on the bounce). Renders nothing when there's nothing to act on.
// RLS scopes registrations to the org; the explicit org filter is defense-in-depth.
function AchAttention({ org }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("registrations")
        .select("id, amount_cents, ach_payment_state, students(first_name, last_name)")
        .eq("organization_id", org.id)
        .in("ach_payment_state", ["processing", "failed"]);
      if (alive) setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, [org?.id]);

  if (!rows || rows.length === 0) return null;

  const failed = rows.filter((r) => r.ach_payment_state === "failed");
  const processing = rows.filter((r) => r.ach_payment_state === "processing");
  const nameOf = (r) => {
    const s = r.students;
    return s ? `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "—" : "—";
  };
  const Row = ({ r, tone, suffix }) => (
    <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 10px", fontSize: 13, marginBottom: 6 }}>
      <span style={{ fontWeight: 600, color: INK }}>{nameOf(r)}</span>
      <span style={{ color: tone, fontWeight: 600, whiteSpace: "nowrap" }}>{fmtCents(r.amount_cents)} {suffix}</span>
    </div>
  );

  return (
    <Card>
      <Heading>Bank transfers</Heading>
      {failed.length > 0 && (
        <div style={{ marginBottom: processing.length ? 18 : 0 }}>
          <div style={{ fontWeight: 700, color: RED, fontSize: 14 }}>
            {failed.length} bank transfer{failed.length > 1 ? "s" : ""} failed — needs follow-up
          </div>
          <p style={{ color: MUTED, fontSize: 13, margin: "4px 0 8px" }}>
            The seat is still held but unpaid. Contact the family to arrange payment, or drop the seat from Rosters.
          </p>
          {failed.map((r) => <Row key={r.id} r={r} tone={RED} suffix="unpaid" />)}
        </div>
      )}
      {processing.length > 0 && (
        <div>
          <div style={{ fontWeight: 700, color: AMBER, fontSize: 14 }}>
            {processing.length} bank transfer{processing.length > 1 ? "s" : ""} clearing
          </div>
          <p style={{ color: MUTED, fontSize: 13, margin: "4px 0 8px" }}>
            Bank transfers take 1 to 3 business days. The child&rsquo;s place is held, and these tick over to paid on their own once the money clears.
          </p>
          {processing.map((r) => <Row key={r.id} r={r} tone={AMBER} suffix="processing" />)}
        </div>
      )}
    </Card>
  );
}

// Slim status banner shown at the top of Receivables when Stripe is active.
// Shows connection state + a Manage setup ▾ toggle that expands the editable
// fee / descriptor / admin fee cards.
function SetupBanner({ accountId, chargesEnabled, payoutsEnabled, open, onToggle, onOpenDashboard, busy }) {
  return (
    <div style={{
      background: "rgba(58, 124, 58, 0.08)",
      border: `1px solid rgba(58, 124, 58, 0.30)`,
      borderRadius: 8,
      padding: "10px 14px",
      marginBottom: 16,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      flexWrap: "wrap",
      fontSize: 13,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", color: INK }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: OK }}>
          <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: OK }} />
          Stripe connected
        </span>
        <span style={{ color: MUTED, fontFamily: "monospace", fontSize: 11 }}>{accountId || ""}</span>
        <span style={{ color: MUTED }}>·</span>
        <span style={{ color: chargesEnabled ? OK : AMBER }}>
          Charges {chargesEnabled ? "on" : "off"}
        </span>
        <span style={{ color: MUTED }}>·</span>
        <span style={{ color: payoutsEnabled ? OK : AMBER }}>
          Payouts {payoutsEnabled ? "on" : "off"}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          type="button"
          onClick={onOpenDashboard}
          disabled={busy}
          style={{
            padding: "5px 10px",
            background: "transparent",
            color: BRIGHT,
            border: `1px solid ${BRIGHT}`,
            borderRadius: 5,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: busy ? "wait" : "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Stripe Dashboard ↗
        </button>
        {/* This was a 12px outline button with a bare ▾, which reads as
            decoration rather than "there is more behind this" — the fee
            settings inside it went unfound. Now a filled control with an
            explicit verb and a real chevron, so it's obvious it opens. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 14px",
            background: open ? BRIGHT : "#EEEDFE",
            color: open ? "#fff" : BRIGHT,
            border: `1px solid ${open ? BRIGHT : "#CECBF6"}`,
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 700,
            fontFamily: "inherit",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          {open ? "Hide settings" : "Payment settings"}
          <span
            aria-hidden="true"
            style={{
              display: "inline-block",
              fontSize: 11,
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 0.15s",
            }}
          >
            ▼
          </span>
        </button>
      </div>
    </div>
  );
}

// Who pays the platform fee. Extracted so it can render in TWO places without
// drifting: inline under "Manage setup" for J2S, and as an always-visible card
// on the Payments page for registration operators — for whom "do families pay
// the fee, or do I?" is a pricing decision they need to SEE, not an advanced
// setting hidden behind a collapsed panel.
// `error` and `pendingPlans` render HERE, beside the toggle, not through the
// page-level error banner. That banner sits ~280px above this card, so a failed
// toggle looked like it silently reverted: the control snapped back with the only
// explanation off-screen. Feedback belongs where the user is looking.
//
// pendingPlans has THREE meanings: a count, 0, or null = we could not check. The
// unknown state gets its own sentence rather than being folded into "none", because
// silence here reads as "nothing is affected" and that is the false reassurance
// this warning exists to prevent.
function FeePayerRow({ feePassThrough, canManage, onToggle, error, pendingPlans = null, saving = false }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 600, color: INK, fontSize: 15 }}>
            Who pays the enrops service fee?
          </div>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4, maxWidth: 480 }}>
            {feePassThrough
              ? "Families cover the enrops service fee as a separate line at checkout. (Stripe's processing fee still comes out before the money reaches your bank.)"
              : "Your organization absorbs the enrops service fee — families pay your base price. (Stripe's processing fee still applies.)"}
          </div>
        </div>
        {canManage ? (
          <Toggle
            checked={feePassThrough}
            onChange={(v) => onToggle(v)}
            labelOn="Pass-through"
            labelOff="Absorbed"
            disabled={saving}
          />
        ) : (
          <span style={{ color: MUTED, fontSize: 12 }}>
            Owner/admin only
          </span>
        )}
      </div>

      {/* Counted by org_pending_plan_families, which mirrors process-installments'
          own predicate (status='pending') and counts distinct PARENTS.

          This banner used to WARN that changing the toggle also changed who paid
          the fee on those remaining payments. It did, and it was the consent
          problem the snapshot was built to remove: every installment row now
          carries the decision the family agreed to at checkout, and
          process-installments honours that over live config. So the same fact
          the operator needs to know has inverted — it is now a reassurance, and
          `tone` moves from warn to info with it. Leaving the old sentence up
          would be the product describing a behaviour it no longer has. */}
      {canManage && pendingPlans > 0 && (
        <div style={{ marginTop: 12, maxWidth: 520 }}>
          <Banner tone="info">
            {pendingPlans === 1
              ? "1 family is partway through a payment plan. They keep the price they agreed to — this setting only affects new registrations."
              : `${pendingPlans} families are partway through a payment plan. They keep the price they agreed to — this setting only affects new registrations.`}
          </Banner>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, maxWidth: 520 }}>
          <Banner tone="err" role="alert">{error}</Banner>
        </div>
      )}
    </div>
  );
}

// Horizontal tabs nav inside the payments/receivables page.
function TabsNav({ tab, onTab, hideInvoices = false }) {
  const items = [
    { key: "activity", label: "Activity" },
    // Invoices = billing a partner school. A registration operator bills
    // families through checkout and never raises one.
    ...(hideInvoices ? [] : [{ key: "invoices", label: "Invoices" }]),
    { key: "refunds",  label: "Refunds" },
  ];
  return (
    <div style={{
      display: "flex",
      gap: 4,
      borderBottom: `1px solid ${RULE}`,
      marginBottom: 16,
    }}>
      {items.map((it) => {
        const active = tab === it.key;
        return (
          <button
            key={it.key}
            type="button"
            onClick={() => onTab(it.key)}
            style={{
              padding: "10px 14px",
              background: "transparent",
              color: active ? BRIGHT : MUTED,
              border: "none",
              borderBottom: active ? `2px solid ${BRIGHT}` : "2px solid transparent",
              fontSize: 14,
              fontWeight: active ? 700 : 500,
              fontFamily: "inherit",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// Revenue / Activity — money collected through enrops, from our own DB (not the
// Stripe API). Reads two money-gated RPCs (owner/admin only): get_revenue_summary
// + get_revenue_activity. NET-to-bank is intentionally NOT shown (Stripe's
// processing fee isn't stored) — we link to Stripe for the real deposit figure.
const RA_PAGE = 25;

function ActivityTab({ org }) {
  // Which fee story to tell under the headline number. Registration operators
  // see both fees named; J2S keeps its original wording.
  const isLean = org?.instructor_pay_model === "enrops_platform";
  const feeCfg = org;
  const [terms, setTerms] = useState([]);            // [{ term, anchor }]
  const [period, setPeriod] = useState(null);        // { kind:'term'|'30d'|'year'|'all', term?, label }
  const [summary, setSummary] = useState(null);      // null=loading, undefined=error
  const [sumErr, setSumErr] = useState("");
  const [rows, setRows] = useState(null);            // null=loading
  const [actErr, setActErr] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeErr, setStripeErr] = useState("");

  // Term list + sensible default (nearest upcoming/current term, else latest).
  useEffect(() => {
    if (!org?.id) return;
    let alive = true;
    (async () => {
      const { data } = await supabase
        .from("programs")
        .select("term, first_session_date")
        .eq("organization_id", org.id)
        .not("term", "is", null);
      if (!alive) return;
      const byTerm = new Map();
      for (const p of data ?? []) {
        const ex = byTerm.get(p.term);
        if (!byTerm.has(p.term)) byTerm.set(p.term, p.first_session_date ?? null);
        else if (p.first_session_date && (ex == null || p.first_session_date < ex)) byTerm.set(p.term, p.first_session_date);
      }
      const list = [...byTerm.entries()].map(([term, anchor]) => ({ term, anchor }));
      setTerms(list);
      const today = new Date().toISOString().slice(0, 10);
      const dated = list.filter((t) => t.anchor).sort((a, b) => (a.anchor < b.anchor ? -1 : 1));
      const def = dated.find((t) => t.anchor >= today) || dated[dated.length - 1] || list[0];
      setPeriod(def ? { kind: "term", term: def.term, label: def.term } : { kind: "all", label: "All time" });
    })();
    return () => { alive = false; };
  }, [org?.id]);

  function bounds(p) {
    if (!p || p.kind === "all") return { from: null, to: null, term: null };
    if (p.kind === "term") return { from: null, to: null, term: p.term };
    const now = new Date();
    if (p.kind === "30d") { const f = new Date(now); f.setDate(f.getDate() - 30); return { from: f.toISOString(), to: null, term: null }; }
    if (p.kind === "year") { const f = new Date(now.getFullYear(), 0, 1); return { from: f.toISOString(), to: null, term: null }; }
    return { from: null, to: null, term: null };
  }

  // Load summary + first page whenever the period changes.
  useEffect(() => {
    if (!org?.id || !period) return;
    let alive = true;
    setSummary(null); setSumErr(""); setRows(null); setActErr(""); setOffset(0); setHasMore(false);
    const { from, to, term } = bounds(period);
    (async () => {
      const [sRes, aRes] = await Promise.all([
        supabase.rpc("get_revenue_summary", { p_org: org.id, p_from: from, p_to: to, p_term: term }),
        supabase.rpc("get_revenue_activity", { p_org: org.id, p_from: from, p_to: to, p_term: term, p_limit: RA_PAGE, p_offset: 0 }),
      ]);
      if (!alive) return;
      if (sRes.error) { console.error("[Activity] summary", sRes.error); setSumErr("Couldn't load revenue. Refresh."); setSummary(undefined); }
      else setSummary(sRes.data?.[0] ?? null);
      if (aRes.error) { console.error("[Activity] feed", aRes.error); setActErr("Couldn't load the activity feed. Refresh."); setRows([]); }
      else { const r = aRes.data ?? []; setRows(r); setHasMore(r.length === RA_PAGE); setOffset(r.length); }
    })();
    return () => { alive = false; };
  }, [org?.id, period]);

  async function loadMore() {
    if (loadingMore || !org?.id || !period) return;
    setLoadingMore(true);
    const { from, to, term } = bounds(period);
    const { data, error } = await supabase.rpc("get_revenue_activity",
      { p_org: org.id, p_from: from, p_to: to, p_term: term, p_limit: RA_PAGE, p_offset: offset });
    setLoadingMore(false);
    if (error) { setActErr("Couldn't load more. Refresh."); return; }
    const more = data ?? [];
    setRows((prev) => [...(prev ?? []), ...more]);
    setHasMore(more.length === RA_PAGE);
    setOffset((o) => o + more.length);
  }

  async function openStripe() {
    setStripeBusy(true); setStripeErr("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not signed in.");
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-stripe-operator-login-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
        body: JSON.stringify({ org_id: org.id }),
      });
      const json = await resp.json();
      if (!resp.ok || !json.url) throw new Error(json?.stripe_message || json?.error || "Couldn't open Stripe.");
      window.open(json.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setStripeErr(err.message || "Couldn't open your Stripe dashboard.");
    } finally {
      setStripeBusy(false);
    }
  }

  const periodOptions = [
    ...terms.map((t) => ({ kind: "term", term: t.term, label: t.term })),
    { kind: "30d", label: "Last 30 days" },
    { kind: "year", label: "This year" },
    { kind: "all", label: "All time" },
  ];

  const header = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
      <div>
        <h2 style={{ margin: "0 0 2px", fontSize: 18, color: PURPLE, fontWeight: 700 }}>Money in</h2>
        <div style={{ fontSize: 12, color: OK, fontWeight: 600 }}>Always up to date — no spreadsheet to keep in sync.</div>
      </div>
      {period && (
        <select
          value={period.kind === "term" ? `term:${period.term}` : period.kind}
          onChange={(e) => {
            const v = e.target.value;
            const opt = v.startsWith("term:")
              ? { kind: "term", term: v.slice(5), label: v.slice(5) }
              : periodOptions.find((o) => o.kind === v);
            if (opt) setPeriod(opt);
          }}
          style={{ padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, color: INK, background: "#fff", fontFamily: "inherit" }}
        >
          {periodOptions.map((o) => (
            <option key={o.kind === "term" ? `term:${o.term}` : o.kind} value={o.kind === "term" ? `term:${o.term}` : o.kind}>
              {o.kind === "term" ? `Term: ${o.label}` : o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );

  // ---- loading / error ----
  if (summary === null) {
    return <Card>{header}<div style={{ color: MUTED, fontSize: 13, padding: "24px 0" }}>Loading…</div></Card>;
  }
  if (summary === undefined) {
    return <Card>{header}<div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5 }}>{sumErr}</div></Card>;
  }

  // ---- empty states ----
  if (!summary.has_enrops_payments) {
    const ext = Number(summary.external_count || 0);
    return (
      <Card>
        {header}
        <div style={{ textAlign: "center", padding: "28px 16px", color: MUTED, fontSize: 14, lineHeight: 1.6 }}>
          {ext > 0 ? (
            <>
              <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>You collect payments outside enrops</div>
              Payment totals live in your own system. We track <strong>{ext}</strong> {ext === 1 ? "registration" : "registrations"} for you here — once families pay <em>through</em> enrops, the money shows up on this screen.
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>No payments yet</div>
              Once families pay through enrops, every payment and refund will show up here automatically.
            </>
          )}
        </div>
      </Card>
    );
  }

  // ---- full summary + feed ----
  const collected = Number(summary.collected_cents || 0);
  const refunded = Number(summary.refunded_cents || 0);
  const expected = Number(summary.expected_soon_cents || 0);
  const paidFam = Number(summary.paid_count || 0);
  const external = Number(summary.external_count || 0);

  return (
    <Card>
      {header}

      {/* Summary band */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>
          {isLean ? "Your class fees" : "Collected through enrops"}
        </div>
        <div style={{ fontSize: 34, fontWeight: 800, color: PURPLE, lineHeight: 1.1, marginTop: 2 }}>{fmtCents(collected)}</div>
      </div>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", margin: "12px 0 16px" }}>
        <RAStat label="Refunded" value={fmtCents(refunded)} />
        {expected > 0 && <RAStat label="Expected soon" value={fmtCents(expected)} note="installments due" />}
        <RAStat label="Paid families" value={String(paidFam)} />
      </div>

      {external > 0 && (
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 14 }}>
          {external} {external === 1 ? "registration was" : "registrations were"} paid outside enrops (imported) and aren&rsquo;t counted above.
        </div>
      )}

      {/* The headline is the sum of CLASS PRICES — not what families paid, and
          not what lands in the bank. Two different fees sit between them and
          only one of them was ever mentioned here, which made the number read
          as "yours" when part of it isn't:
            - the enrops service fee is paid by families ON TOP of the price
              when pass-through is on, so it never comes out of this figure;
            - Stripe's processing fee IS deducted before the money reaches the
              provider's bank.
          We don't store the exact Stripe fee per charge, so this says which
          direction each fee moves and points at Stripe for the real deposit,
          rather than printing an estimate as if it were a fact. */}
      <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 18, lineHeight: 1.6 }}>
        {isLean && (
          <>
            This is the total of your class prices.{" "}
            {feeCfg?.fee_pass_through
              ? <>The enrops service fee is added on top at checkout and paid by families, so it isn&rsquo;t taken out of this.</>
              : <>You&rsquo;ve chosen to cover the enrops service fee, so it comes out of this.</>}{" "}
            {/* The fee explainer used to sit here, mid-paragraph. It moved to the
                page title: one tip per page, always in the same place, so the "?"
                is learned once instead of hunted for. Both branches of the tip
                live up there together, because this sentence branches too and a
                single explainer would be false in one state. */}
            Stripe&rsquo;s processing fee is deducted before the money reaches your bank.{" "}
          </>
        )}
        {!isLean && <>Your actual bank deposits (after Stripe&rsquo;s processing fee) live in your Stripe dashboard.{" "}</>}
        {isLean && <>Your actual deposits live in your Stripe dashboard.{" "}</>}
        <button type="button" onClick={openStripe} disabled={stripeBusy}
          style={{ background: "none", border: "none", color: BRIGHT, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit", fontSize: 12.5 }}>
          {stripeBusy ? "Opening…" : "Open Stripe →"}
        </button>
        {stripeErr && <span style={{ color: RED, marginLeft: 8 }}>{stripeErr}</span>}
      </div>

      {/* Activity feed */}
      <h3 style={{ margin: "0 0 8px", fontSize: 14, color: INK, fontWeight: 700 }}>Activity</h3>
      {actErr && <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginBottom: 10 }}>{actErr}</div>}
      {rows === null && <div style={{ color: MUTED, fontSize: 13, padding: "12px 0" }}>Loading…</div>}
      {rows !== null && rows.length === 0 && !actErr && (
        <div style={{ color: MUTED, fontSize: 13, padding: "16px 0" }}>No payments in this period.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((r, i) => <RAFeedRow key={`${r.registration_id}-${r.kind}-${i}`} r={r} />)}
        </div>
      )}
      {hasMore && (
        <div style={{ marginTop: 12, textAlign: "center" }}>
          <button type="button" onClick={loadMore} disabled={loadingMore}
            style={{ padding: "7px 14px", background: "transparent", color: BRIGHT, border: `1px solid ${BRIGHT}`, borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </Card>
  );
}

function RAStat({ label, value, note }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: INK, marginTop: 1 }}>{value}</div>
      {note && <div style={{ fontSize: 10.5, color: MUTED }}>{note}</div>}
    </div>
  );
}

function RAFeedRow({ r }) {
  const isRefund = r.kind === "refund";
  const cents = Number(r.amount_cents || 0);
  const when = r.occurred_at
    ? new Date(r.occurred_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";
  const kindLabel = isRefund ? "Refund" : r.kind === "installment" ? "Installment" : "Payment";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "baseline", border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: INK }}>{r.family_name || "—"}</span>
        <span style={{ marginLeft: 8, fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, border: `1px solid ${RULE}`, borderRadius: 4, padding: "1px 5px" }}>{kindLabel}</span>
        {r.label && <span style={{ display: "block", color: MUTED, fontSize: 11.5, marginTop: 2 }}>{r.label}</span>}
      </span>
      <span style={{ fontWeight: 600, whiteSpace: "nowrap", color: isRefund ? RED : OK }}>
        {isRefund ? `−${fmtCents(Math.abs(cents))}` : fmtCents(cents)}
      </span>
      <span style={{ color: MUTED, whiteSpace: "nowrap" }}>{when}</span>
    </div>
  );
}

function InvoicesTab() {
  return (
    <Card>
      <div style={{ color: MUTED, fontSize: 14, textAlign: "center", padding: "32px 16px" }}>
        Send invoices to schools and partners — track paid, overdue, outstanding.
        <div style={{ fontSize: 12, marginTop: 8 }}>
          Coming next — invoices families can pay by bank transfer.
        </div>
      </div>
    </Card>
  );
}

// Read-only dispute mirror (v4 section 5). Enrops never responds to or decides
// a dispute; Stripe does. This exists so an operator is not the last to know
// because they were not watching a second dashboard.
//
// It states WHO BEARS IT rather than assuming. On a direct charge Stripe debits
// the operator, which is what the checklist assumes throughout. On a destination
// charge Stripe debits the PLATFORM, so Enrops carries J2S's disputes for as
// long as J2S stays on destination charges, which is permanently. Telling a
// legacy operator "this came out of your balance" would be false.
function DisputesPanel({ org }) {
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("disputes")
        .select("id, amount_cents, reason, status, borne_by, opened_at, evidence_due_at, registration:registrations(student:students(first_name, last_name))")
        .eq("organization_id", org.id)
        .order("opened_at", { ascending: false })
        .limit(100);
      if (!alive) return;
      if (error) {
        console.error("[DisputesPanel] load failed", error);
        setErr("Couldn't load disputes. Refresh to try again.");
        setRows([]);
        return;
      }
      setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, [org.id]);

  // Stripe's status vocabulary in plain English. Unknown values fall through
  // rather than being swallowed, so a new Stripe status is visible not hidden.
  const STATUS = {
    warning_needs_response: "Early warning — response needed",
    warning_under_review: "Early warning — under review",
    warning_closed: "Early warning — closed",
    needs_response: "Response needed",
    under_review: "Under review with the bank",
    won: "Resolved in your favour",
    lost: "Lost",
    charge_refunded: "Refunded instead",
  };
  const URGENT = new Set(["needs_response", "warning_needs_response"]);

  const fmtWhen = (iso) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

  if (rows !== null && rows.length === 0 && !err) {
    return (
      <Card>
        <h2 style={{ margin: "0 0 4px", fontSize: 18, color: PURPLE, fontWeight: 700 }}>Disputes</h2>
        <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
          No disputes. If a family ever challenges a charge with their bank, it will appear here so you don't
          have to watch your Stripe dashboard for it.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, color: PURPLE, fontWeight: 700 }}>Disputes</h2>
      <p style={{ margin: "0 0 16px", color: MUTED, fontSize: 13 }}>
        When a family challenges a charge with their bank. You respond in Stripe, not here — this is so you
        know about it.
      </p>

      {err && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginBottom: 12 }}>{err}</div>
      )}
      {rows === null && <div style={{ color: MUTED, fontSize: 13, padding: "8px 0" }}>Loading…</div>}

      {rows !== null && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {rows.map((d) => {
            const s = d.registration?.student;
            const who = s ? `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() : "";
            const urgent = URGENT.has(d.status);
            return (
              <div key={d.id} style={{ border: `1px solid ${urgent ? RED : RULE}`, borderRadius: 6, padding: "10px 12px", fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <span style={{ fontWeight: 600, color: INK }}>{who || "A family"}</span>
                  <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{fmtCents(d.amount_cents)}</span>
                </div>
                <div style={{ color: urgent ? RED : MUTED, fontSize: 12, marginTop: 2, fontWeight: urgent ? 700 : 400 }}>
                  {STATUS[d.status] ?? d.status}
                  {d.evidence_due_at && urgent && ` · respond by ${fmtWhen(d.evidence_due_at)}`}
                </div>
                <div style={{ color: MUTED, fontSize: 11.5, marginTop: 2 }}>
                  Opened {fmtWhen(d.opened_at)}
                  {d.borne_by === "operator" && " · comes out of your Stripe balance"}
                  {d.borne_by === "platform" && " · enrops covers this one"}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// Read-only refund history. Refunds are issued from Rosters (row → Refund);
// this is the money-side record of what happened.
//
// SCOPED EXPLICITLY TO THIS ORG. It used to rely on RLS alone, which was wrong:
// the refunds policy is `can_handle_money(organization_id) OR is_platform_admin()`,
// so the moment an Enrops platform admin opened their own operator dashboard they
// saw EVERY tenant's refunds sitting in their Finances page. Found by Jessica on
// staging with 9 of another operator's refunds on screen. Platform-wide views
// belong on a platform surface, never on an operator one — so this filters by
// org.id and does not depend on the policy being narrow enough.
function RefundsTab({ org }) {
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("refunds")
        .select("id, amount_cents, reason, status, cancelled_registration, created_at, succeeded_at, refunded_by_user_id, platform_fee_refunded_cents, registration:registrations(student:students(first_name, last_name))")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (!alive) return;
      if (error) {
        console.error("[RefundsTab] load failed", error);
        setErr("Couldn't load refund history. Refresh.");
        setRows([]);
        return;
      }
      setRows(data ?? []);
    })();
    return () => { alive = false; };
  }, []);

  const fmtWhen = (iso) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const nameOf = (r) => {
    const s = r.registration?.student;
    return s ? `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "—" : "—";
  };
  // A refund with no Enrops user behind it came from the operator's own Stripe
  // dashboard. Without saying so, a refund nobody here issued just appears in
  // this list with no explanation.
  const originOf = (r) => (r.refunded_by_user_id ? "In Enrops" : "Stripe dashboard");
  // Stripe's reason is an API enum. Show plain English, not the raw token.
  const STRIPE_REASONS = {
    requested_by_customer: "Requested by the family",
    duplicate: "Duplicate charge",
    fraudulent: "Marked fraudulent",
    expired_uncaptured_charge: "Payment expired",
  };
  const reasonOf = (r) => {
    const raw = (r.reason ?? "").trim();
    if (!raw) return "—";
    return STRIPE_REASONS[raw] ?? raw;
  };

  return (
    <Card>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, color: PURPLE, fontWeight: 700 }}>Refund history</h2>
      <p style={{ margin: "0 0 16px", color: MUTED, fontSize: 13 }}>
        Issue a refund from <a href="/admin/rosters" style={{ color: PURPLE }}>Rosters</a> → a family's row → <strong>Refund</strong>. Refunds you make directly in Stripe show up here too, marked <strong>Stripe dashboard</strong>.
      </p>

      {err && (
        <div style={{ background: `${RED}1A`, color: RED, padding: 10, borderRadius: 6, fontSize: 12.5, marginBottom: 12 }}>{err}</div>
      )}

      {rows === null && <div style={{ color: MUTED, fontSize: 13, padding: "16px 0" }}>Loading…</div>}

      {rows !== null && rows.length === 0 && !err && (
        <div style={{ color: MUTED, fontSize: 13, textAlign: "center", padding: "24px 16px" }}>
          No refunds yet.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, fontSize: 11, color: MUTED, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, padding: "0 4px 4px" }}>
            <span>Family</span><span>Amount</span><span>Date</span>
          </div>
          {rows.map((r) => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, alignItems: "baseline", border: `1px solid ${RULE}`, borderRadius: 6, padding: "8px 10px", fontSize: 13 }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: INK }}>{nameOf(r)}</span>
                {r.cancelled_registration && <span style={{ marginLeft: 8, fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, border: `1px solid ${RULE}`, borderRadius: 4, padding: "1px 5px" }}>Withdrew</span>}
                {r.status === "failed" && <span style={{ marginLeft: 8, fontSize: 10, color: RED, fontWeight: 700, textTransform: "uppercase" }}>Failed</span>}
                {r.status === "pending" && <span style={{ marginLeft: 8, fontSize: 10, color: AMBER, fontWeight: 700, textTransform: "uppercase" }}>Pending</span>}
                {!r.refunded_by_user_id && <span style={{ marginLeft: 8, fontSize: 10, color: PURPLE, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, border: `1px solid ${PURPLE}`, borderRadius: 4, padding: "1px 5px" }}>Stripe dashboard</span>}
                {r.reason && <span style={{ display: "block", color: MUTED, fontSize: 11.5, marginTop: 2 }}>{reasonOf(r)}</span>}
                {r.status === "succeeded" && r.platform_fee_refunded_cents > 0 && (
                  <span style={{ display: "block", color: MUTED, fontSize: 11.5, marginTop: 2 }}>
                    {fmtCents(r.platform_fee_refunded_cents)} of the enrops fee returned to you
                  </span>
                )}
              </span>
              <span style={{ fontWeight: 600, color: r.status === "succeeded" ? OK : MUTED, whiteSpace: "nowrap" }}>{fmtCents(r.amount_cents)}</span>
              <span style={{ color: MUTED, whiteSpace: "nowrap" }}>{fmtWhen(r.succeeded_at || r.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PageShell({ children }) {
  return <div style={{ maxWidth: 760 }}>{children}</div>;
}

function Card({ children }) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 10,
      padding: 24,
      marginBottom: 16,
    }}>
      {children}
    </div>
  );
}

function Section({ children }) {
  return <div>{children}</div>;
}

function Heading({ children }) {
  return (
    <h2 style={{ margin: "0 0 12px", fontSize: 18, color: PURPLE, fontWeight: 700 }}>
      {children}
    </h2>
  );
}

// `role` is optional and defaults to unset, so every existing caller renders
// byte-identically. Passing role="alert" lets a failure announce itself to a
// screen reader without forking these styles.
function Banner({ tone, children, role }) {
  const colors = {
    ok:   { bg: "rgba(58, 124, 58, 0.10)", fg: OK,    bd: "rgba(58, 124, 58, 0.35)" },
    info: { bg: `${BRIGHT}1F`,             fg: BRIGHT, bd: `${BRIGHT}66` },
    warn: { bg: "rgba(182, 126, 0, 0.10)", fg: AMBER, bd: "rgba(182, 126, 0, 0.35)" },
    err:  { bg: "rgba(181, 55, 55, 0.08)", fg: RED,   bd: "rgba(181, 55, 55, 0.35)" },
  };
  const c = colors[tone] || colors.info;
  return (
    <div style={{
      background: c.bg,
      border: `1px solid ${c.bd}`,
      color: c.fg,
      borderRadius: 8,
      padding: "10px 14px",
      marginBottom: 14,
      fontSize: 14,
    }} role={role}>
      {children}
    </div>
  );
}

// Turn a `reason` code from stripe-oauth-callback into something an operator can
// act on. EVERY reason that function can emit has a case here - a code with no
// case would surface as raw text like "exchange_failed" on their money screen.
//
// Each string is written to be TRUE in the state that produces it, not merely
// reassuring: "already connected to another provider" is a genuinely different
// problem from "the link expired", and telling someone to try again when the
// account is spoken for would loop them forever.
function describeConnectFailure(reason) {
  switch (reason) {
    case "missing_state":
    case "state_unreadable":
    case "link_expired":
    case "missing_code":
      // These fire AFTER Stripe has redirected the operator back, so for most of
      // them they already approved enrops and only our end of the handshake was
      // missing. "Nothing changed" would be false in exactly those cases, so this
      // says what is true of every one of them: we did not save it.
      return "That connect link expired before we could finish, so the account wasn't saved. Click Connect again to start over — approving enrops a second time is safe.";
    case "exchange_failed":
      // Deliberately does NOT say "nothing changed": the operator has already
      // approved Enrops at Stripe by this point, and the exchange can fail after
      // that approval landed. Claiming nothing happened would contradict what
      // they can see in their own Stripe settings.
      return "Stripe couldn't finish connecting that account, so we didn't save it. Please try again — approving enrops a second time is safe.";
    case "account_in_use":
      return "That Stripe account is already connected to a different provider on enrops. Pick a different account, or contact us if you think this is wrong.";
    case "already_connected":
      // Emitted when the org gained a DIFFERENT Stripe account while this flow
      // was open (two admins connecting at once). "You already have one" alone
      // would read as success and hide the fact that THEIR pick was refused.
      return "A different Stripe account was connected to this business while you were at Stripe, so the one you picked wasn't saved. Reload to see which account is connected.";
    case "account_unreadable":
      return "You approved enrops at Stripe, but we couldn't read the account back, so we didn't save it. Please try again — approving a second time is safe.";
    case "persist_failed":
      // By this point the grant EXISTS at Stripe; only our own write failed. "No
      // changes at all" would be false and would confuse anyone who then looks
      // at their Stripe connected-apps list.
      return "You approved enrops at Stripe, but we couldn't save it on our side, so it isn't connected yet. Please try again — approving a second time is safe.";
    default:
      // Covers 'internal' and any reason added to the callback later.
      return "Something went wrong connecting Stripe. Nothing changed — please try again, and tell us if it keeps happening.";
  }
}

// The state a BRAND NEW tenant lands in: no Stripe account on the org at all.
// Every lean gate that says "you can't get paid yet" links here (the term banner
// and the share-link gate in ProgramsCalendar), so this is the one screen that
// has to offer both real paths.
//
// TWO PATHS, because they are genuinely different actions and the old copy
// conflated them. `onConnectExisting` runs Connect OAuth, which attaches an
// account the operator already owns. `onConnect` runs accounts.create, which
// always mints a NEW one - Stripe's onboarding can reuse a previous account's
// verified DETAILS, but per Stripe's docs it "creates a new connected account",
// so the old subtitle's promise ("you'll keep using the one you have") was false
// on the only path that existed.
function NotConnectedBody({ onConnect, onConnectExisting, busy, busyAction, canManage }) {
  if (!canManage) {
    return (
      <StripeHero
        title="Get paid straight into your own account"
        subtitle="Families pay through enrops. The money goes into your own Stripe account, and Stripe sends it on to your bank."
      >
        <em style={{ color: MUTED, fontSize: 13 }}>
          Only an owner or admin can connect Stripe.
        </em>
        <TrustChips />
      </StripeHero>
    );
  }

  return (
    <StripeHero
      title="Get paid straight into your own account"
      subtitle="Families pay through enrops. The money goes into your own Stripe account, and Stripe sends it on to your bank. You'll need this before you can take payments."
    >
      <div style={{ display: "grid", gap: 14, justifyItems: "center" }}>
        <div>
          <button
            onClick={onConnectExisting}
            disabled={busy}
            style={btn(BRIGHT, "#fff", false, busy)}
          >
            {busyAction === "oauth" ? "Starting…" : "Connect my Stripe account"}
          </button>
          <div style={{ color: MUTED, fontSize: 12.5, marginTop: 6 }}>
            Already use Stripe? Sign in and pick the account you already have.
          </div>
        </div>

        <div>
          <button
            onClick={onConnect}
            disabled={busy}
            style={btn("transparent", BRIGHT, true, busy)}
          >
            {busyAction === "create" ? "Starting…" : "I don't use Stripe yet"}
          </button>
          <div style={{ color: MUTED, fontSize: 12.5, marginTop: 6 }}>
            We'll walk you through setting one up. It takes a few minutes.
          </div>
        </div>
      </div>
      <TrustChips />
      <WhatYouWillNeed />
    </StripeHero>
  );
}

// Detach the connected Stripe account. Two shapes, ONE control: `variant="card"`
// sits at the bottom of the expanded payment settings for a live account;
// `variant="inline"` is the same action for an operator stuck part-way through
// setup on an account they didn't mean to connect. Both render their own result
// so the confirmation lands where the click did.
//
// This is not styled as a big red destructive button on purpose. It is a
// recoverable, one-minute-to-undo action (connect another account and you're
// back), and the surrounding copy carries the weight rather than the colour.
// `checking` is NOT cosmetic. checkStripeStatus() sets only `checkingStatus`,
// never `busy`, so gating this button on `busy` alone left it clickable during a
// status poll — and sync-operator-stripe-status reads the org row, round-trips
// to Stripe, and only THEN writes. A disconnect landing inside that window gets
// overwritten by the poll's pre-disconnect snapshot, leaving the screen saying
// "Stripe connected" while the grant is actually revoked and every charge fails.
// The server-side half of this fix is the conditional UPDATE in
// sync-operator-stripe-status; this half stops the UI offering the collision.
// `variant` also decides what this panel is FOR, because the two placements
// answer different operator questions:
//
//   "card"   — rendered under Payment settings on a LIVE account. The question
//              is "this is the wrong account".
//   "inline" — rendered on onboarding / verifying / restricted, i.e. an account
//              exists but setup isn't finished. The likeliest way to get here is
//              clicking "I don't use Stripe yet" by mistake: that mints an
//              account on the first click, and the two connect buttons then
//              DISAPPEAR because they only render at 'not_connected'. So the
//              operator who meant to use the Stripe they already have is stuck
//              with no signpost back. Disconnect is the way back, and until now
//              nothing said so. Found on prod 2026-07-30 by the first human to
//              try it, who did exactly this.
function DisconnectPanel({ variant, accountId, onDisconnect, busy, busyAction, checking, message }) {
  const working = busyAction === "disconnect";
  const blocked = busy || checking;
  const midSetup = variant === "inline";
  const body = (
    <>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: PURPLE }}>
        {midSetup
          ? "Wrong account, or meant to use the Stripe you already have?"
          : "Connected the wrong Stripe account?"}
      </div>
      <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: "4px 0 10px", maxWidth: 520 }}>
        {/* Deliberately makes NO promise about the half-finished account. After a
            disconnect, stripe-connect-onboard treats the org as a fresh onboard
            and only sometimes recovers the old account (an orphan search by
            metadata, which needs exactly one non-rejected candidate and is
            subject to Stripe's search-index delay). So "nothing you entered is
            lost" would be true on some runs and false on others - the exact
            conditional-copy trap. This says only what is certain: you get the
            choice back. */}
        {midSetup
          ? "Disconnect this one and you'll get both choices back — sign in to the Stripe account you already have, or set one up from scratch."
          : "Disconnect it and you can connect a different one straight away. While nothing is connected, your registration links can't take payments."}
      </p>
      <button
        type="button"
        onClick={onDisconnect}
        disabled={blocked}
        style={{
          padding: "7px 12px",
          background: "transparent",
          color: RED,
          border: `1px solid ${RED}`,
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: blocked ? "wait" : "pointer",
          opacity: blocked && !working ? 0.55 : 1,
        }}
      >
        {working ? "Disconnecting…" : "Disconnect Stripe"}
      </button>
      {/* Say WHY it is greyed out. A disabled control with no explanation is the
          same "looks dead" failure as a button that silently does nothing. */}
      {checking && !working && (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
          Available once the Stripe check finishes.
        </div>
      )}
      {accountId && (
        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 6, fontFamily: "monospace" }}>
          {accountId}
        </div>
      )}
      {/* Result renders HERE, under the button that caused it — not in the
          page-level banner far above this panel. */}
      {message && (
        <div style={{ marginTop: 10, maxWidth: 520 }}>
          <Banner tone={message.tone}>{message.text}</Banner>
        </div>
      )}
    </>
  );

  if (variant === "card") {
    return <Card><Section>{body}</Section></Card>;
  }
  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${RULE}`, textAlign: "left" }}>
      {body}
    </div>
  );
}

// Where an org lands after its Stripe access goes away — either the operator
// revoked enrops from Stripe's own dashboard (account.application.deauthorized)
// or they used Disconnect here.
//
// The old copy said "New parent payments are landing in enrops's account until
// you reconnect. We'll transfer them to you once you're set up." That is only
// true for a DESTINATION-charge org, where buildConnectChargeParams returns {}
// and the charge falls through to the platform. For a DIRECT org —
// which is every new tenant — buildChargeRouting FAILS CLOSED: nothing is
// charged at all, so no money is landing anywhere and there is nothing to
// transfer on. Promising a transfer that will never happen is worse than saying
// payments have stopped. Each branch below is true in the state that selects it.
//
// Reconnect offers BOTH paths, same as NotConnectedBody. The single
// "Reconnect Stripe" button ran startOnboarding (accounts.create), which mints a
// BRAND NEW Stripe account — the wrong answer for the operator whose whole
// problem is that they already have one.
function DisconnectedBody({ onReconnect, onConnectExisting, busy, busyAction, canManage, chargeModel }) {
  const isDirect = chargeModel === "direct";
  return (
    <>
      <Banner tone="warn">
        {isDirect
          ? "Stripe is disconnected, so your registration links can't take payments right now. Connect an account and they start working again immediately."
          : "Stripe is disconnected. New parent payments are landing in enrops's account until you reconnect. We'll transfer them to you once you're set up."}
      </Banner>
      <StripeHero
        title="Connect Stripe to get paid again"
        subtitle="Your money goes into your own Stripe account, and Stripe sends it on to your bank. Use the account you already have, or set up a new one."
      >
        {!canManage ? (
          <em style={{ color: MUTED, fontSize: 13 }}>
            Only an owner or admin can connect Stripe.
          </em>
        ) : (
          <div style={{ display: "grid", gap: 14, justifyItems: "center" }}>
            <div>
              <button
                onClick={onConnectExisting}
                disabled={busy}
                style={btn(BRIGHT, "#fff", false, busy)}
              >
                {busyAction === "oauth" ? "Starting…" : "Connect my Stripe account"}
              </button>
              <div style={{ color: MUTED, fontSize: 12.5, marginTop: 6 }}>
                Sign in and pick the account you want to use.
              </div>
            </div>
            <div>
              <button
                onClick={onReconnect}
                disabled={busy}
                style={btn("transparent", BRIGHT, true, busy)}
              >
                {busyAction === "create" ? "Starting…" : "Set up a new Stripe account"}
              </button>
              <div style={{ color: MUTED, fontSize: 12.5, marginTop: 6 }}>
                We'll walk you through it. It takes a few minutes.
              </div>
            </div>
          </div>
        )}
        <TrustChips />
        <WhatYouWillNeed />
      </StripeHero>
    </>
  );
}

// Small stroke icon used across the Stripe connect states (hero + trust chips).
function SIcon({ size = 20, children }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// Centered hero shell for the connect states: icon tile + headline + one line
// of copy, then the caller's primary action + reassurance. Replaces the old
// wall-of-text panel so the primary action stays the visual anchor.
function StripeHero({ title, subtitle, children }) {
  return (
    <div style={{ textAlign: "center", maxWidth: 480, margin: "0 auto", padding: "8px 0" }}>
      <div style={{
        width: 48, height: 48, borderRadius: 12, background: "#EEEDFE",
        display: "flex", alignItems: "center", justifyContent: "center",
        margin: "0 auto 12px", color: BRIGHT,
      }}>
        <SIcon size={26}>
          <path d="M3 21h18" /><path d="M5 21v-9M19 21v-9M10 21v-9M14 21v-9" /><path d="M12 3l8 4H4l8-4z" />
        </SIcon>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: PURPLE, marginBottom: 6 }}>{title}</div>
      <p style={{ fontSize: 14, color: MUTED, lineHeight: 1.55, margin: "0 0 18px" }}>{subtitle}</p>
      {children}
    </div>
  );
}

// Compact reassurance row — answers the "how long / is it safe / where's my
// money" worries as three chips instead of a paragraph.
// `midSetup` drops the timing chip. That chip estimates how long CONNECTING
// takes and is split by whether you already have Stripe — a choice that is not
// on offer once an account exists, so mid-setup it answers a question the
// operator can no longer act on. "Secured by Stripe" and "Paid into your own
// account" stay: both are true in every state.
//
// The chip used to read "Straight to your bank", matching a hero titled "Get
// paid straight to your bank". Both were removed 2026-07-31: money settles in
// the operator's own STRIPE account and Stripe pays out to the bank on its own
// schedule (a rolling delay for a new US account), so "straight to your bank"
// promised a timeline neither we nor the operator controls. "Your own account"
// keeps the part that is actually true and actually the selling point - the
// money is theirs, in their account, not held by us - and is true under both
// the direct and destination charge models.
function TrustChips({ midSetup = false }) {
  const chip = { display: "flex", alignItems: "center", gap: 5, fontSize: 12.5, color: MUTED };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 16, marginTop: 14 }}>
      {!midSetup && (
      <span style={chip}>
        <SIcon size={16}><circle cx="12" cy="12" r="9" /><path d="M12 8v4l2.5 1.5" /></SIcon>
        {/* Two numbers, not one: quoting a flat "5 minutes" badly undersells the
            already-have-Stripe path, and overstating the effort on the screen
            that gates every payment talks operators out of a one-minute job.
            The wording itself now lives in lib/stripeConnectEstimate.js, with the
            measurement it came from, because the first-program step strip shows
            the same figure - two hardcoded copies is how they drift apart. Edit
            it there, not here. */}
        {STRIPE_CONNECT_ESTIMATE_SENTENCE}
      </span>
      )}
      <span style={chip}>
        <SIcon size={16}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></SIcon>
        Secured by Stripe
      </span>
      <span style={chip}>
        <SIcon size={16}><path d="M3 21h18" /><path d="M5 21v-9M19 21v-9M10 21v-9M14 21v-9" /><path d="M12 3l8 4H4l8-4z" /></SIcon>
        Paid into your own account
      </span>
    </div>
  );
}

// What actually happens on the next screen, split by the ONE thing that changes
// the answer: whether the operator already has Stripe.
//
// This used to say "Already have a Stripe account? This creates a separate one
// just for enrops. Your existing account stays untouched." That was true of the
// old Express accounts. It is now the opposite: with controller-based accounts
// Stripe asks you to SIGN IN and use the account you already have — which is
// faster, but is a nasty surprise if the screen just told you the reverse and
// then asks for a password. Rewritten 2026-07-27 after exactly that happened.
//
// Open by default: this is the screen where operators stall, so the answer
// should not be behind a click. Tenant-agnostic, no J2S strings.
// `midSetup` = an account already exists and setup is unfinished. In that state
// the two-paths framing below is describing a CHOICE THE SCREEN NO LONGER OFFERS
// - there is no "sign in with your usual Stripe login" button on the onboarding
// body, only "Continue setup". Reading a confident description of an option you
// cannot see is a large part of why that screen felt like a dead end (prod,
// 2026-07-30). Mid-setup, show only what Stripe will ask for.
function WhatYouWillNeed({ midSetup = false }) {
  const [open, setOpen] = useState(true);
  const item = { fontSize: 13, color: INK, lineHeight: 1.55, marginBottom: 6 };
  const lbl = { fontWeight: 600, color: PURPLE };
  const pathTitle = { fontSize: 13.5, fontWeight: 700, color: PURPLE, marginBottom: 4 };
  const pathTime = { fontSize: 12, color: MUTED, fontWeight: 600 };
  return (
    <div style={{ maxWidth: 460, margin: "16px auto 0", textAlign: "left" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 6, margin: "0 auto",
          background: "transparent", border: "none", color: MUTED, fontSize: 13,
          fontFamily: "inherit", cursor: "pointer",
        }}
      >
        <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>
          <SIcon size={16}><path d="M6 9l6 6 6-6" /></SIcon>
        </span>
        What happens next
      </button>
      {open && (
        <div style={{ marginTop: 10, background: "#FBFBFB", border: `1px solid ${RULE}`, borderRadius: 8, padding: "12px 14px" }}>

          {/* The two-paths framing belongs ONLY where both paths are on offer. */}
          {!midSetup && (
            <div style={{ marginBottom: 12 }}>
              <div style={pathTitle}>
                If you already use Stripe <span style={pathTime}>· about a minute</span>
              </div>
              <p style={{ ...item, marginBottom: 0 }}>
                Sign in with your usual Stripe login and choose that account. You'll
                use the account you already have — nothing new is created, and the
                payments you take outside enrops carry on exactly as they do now.
                Stripe already has your business and bank details, so there's
                nothing to re-enter.
              </p>
            </div>
          )}

          <div style={midSetup ? {} : { paddingTop: 12, borderTop: `1px solid ${RULE}` }}>
            {!midSetup && (
              <div style={pathTitle}>
                If you're new to Stripe <span style={pathTime}>· about 5–10 minutes</span>
              </div>
            )}
            <p style={{ ...item, marginBottom: 8 }}>
              {midSetup
                ? "Stripe will ask for these. Have them ready:"
                : "You'll create your Stripe account on the next screen. Have these ready:"}
            </p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li style={item}><span style={lbl}>Email and phone</span> — where Stripe sends verification codes.</li>
              <li style={item}><span style={lbl}>Business details</span> — legal name, EIN, address.</li>
              <li style={item}><span style={lbl}>Your ID</span> — name, date of birth, last 4 of SSN. Stripe needs this to verify you; it isn't stored on our side.</li>
              <li style={{ ...item, marginBottom: 0 }}><span style={lbl}>Bank account</span> — routing and account number, or connect via Plaid. This is where your money lands.</li>
            </ul>
          </div>

          <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${RULE}`, fontSize: 12, color: MUTED, lineHeight: 1.55 }}>
            {/* "Either way" names two paths; mid-setup there is only one. */}
            {midSetup
              ? "When you come back, Stripe may spend a minute or two checking your details before payments switch on. That's normal and there's nothing for you to do while it finishes."
              : "Either way, when you come back Stripe may spend a minute or two checking your details before payments switch on. That's normal and there's nothing for you to do while it finishes."}
          </div>
        </div>
      )}
    </div>
  );
}

// Stripe has everything and is reviewing. The operator owes NOTHING, so this
// body deliberately has no "Continue setup" button — offering one would send
// someone who finished correctly back into a completed form looking for a
// field that isn't there. Observed 2026-07-27: it cleared on its own in about
// a minute, which is what the copy now says.
function VerifyingBody({ onCheckStatus, checking, canManage }) {
  return (
    <StripeHero
      title="Stripe is reviewing your details"
      subtitle="Everything's submitted — there's nothing more for you to do. This usually finishes within a couple of minutes, and payments switch on automatically."
    >
      {canManage && (
        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            onClick={onCheckStatus}
            disabled={checking}
            style={btn("transparent", BRIGHT, true, checking)}
          >
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>
      )}
    </StripeHero>
  );
}

function OnboardingBody({ status, onContinue, onCheckStatus, checking, busy, canManage, chargesEnabled, payoutsEnabled }) {
  return (
    <>
      {status === "restricted" && (
        <Banner tone="warn">
          Stripe has paused part of your account. It usually just needs a bit more
          information from you — click below to finish.
        </Banner>
      )}
      {/* Reachable with NOTHING entered. "I don't use Stripe yet" calls
          accounts.create, which mints the Stripe account on the FIRST click and
          writes status='onboarding' immediately — before the operator types a
          single character. So an operator who clicked that button and then
          closed Stripe's tab lands here having entered nothing at all.
          "Almost there" and "Stripe remembers what you've entered" were both
          false for exactly that person. Observed on prod 2026-07-30, by the
          first human to use this screen.
          `details_submitted` is not stored on organizations, so the UI cannot
          tell "started" from "never started" — which means the copy has to be
          true for BOTH. It no longer claims either. */}
      {/* TWO states share this body, and they are not the same story:
            onboarding  — setup is genuinely unfinished.
            restricted  — Stripe PAUSED an account that may be completely set up,
                          and wants one specific thing it names in their
                          dashboard. Telling that operator to "finish setting up"
                          and handing them the full new-account checklist sends
                          them looking for work that isn't what Stripe asked for. */}
      {/* The restricted hero does NOT restate the banner above it. Rendered
          together they read "Stripe has paused some of your account
          capabilities" immediately followed by "Stripe has paused payments on
          your account" - the same sentence twice, which pads the screen and
          buries the one thing they can act on. Banner states the problem; hero
          gives the next move. */}
      <StripeHero
        title={status === "restricted"
          ? "Tell Stripe what they need"
          : "Finish setting up with Stripe"}
        subtitle={status === "restricted"
          ? "Continue below and Stripe will show you exactly what's outstanding on your account."
          : "Stripe needs your business details before payments can switch on. This opens Stripe's own secure form."}
      >
        <div style={{ display: "flex", justifyContent: "center", gap: 18, marginBottom: 16, fontSize: 13, color: INK }}>
          <span><strong>Charges</strong>{" "}<Pill on={chargesEnabled}>{chargesEnabled ? "on" : "pending"}</Pill></span>
          <span><strong>Payouts</strong>{" "}<Pill on={payoutsEnabled}>{payoutsEnabled ? "on" : "pending"}</Pill></span>
        </div>
        {canManage ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 10 }}>
              <button onClick={onContinue} disabled={busy || checking} style={btn(BRIGHT, "#fff", false, busy || checking)}>
                {busy ? "Loading…" : "Continue setup"}
              </button>
              <button onClick={onCheckStatus} disabled={busy || checking} style={btn("transparent", BRIGHT, true, busy || checking)}>
                {checking ? "Checking…" : "Already finished? Check status"}
              </button>
            </div>
            <TrustChips midSetup />
            {/* Hidden when restricted. We do not know what Stripe wants - it
                could be one document - so listing the full new-account
                checklist would be a guess presented as instructions. The
                banner above already points them at the real answer. */}
            {status !== "restricted" && <WhatYouWillNeed midSetup />}
          </>
        ) : (
          <em style={{ color: MUTED, fontSize: 13 }}>
            Only an owner or admin can finish Stripe setup.
          </em>
        )}
      </StripeHero>
    </>
  );
}

function FeeReadout({ config }) {
  const floor = config.platform_fee_floor_cents;
  const cap = config.platform_fee_cap_cents;
  const hasFloor = typeof floor === "number" && floor > 0;
  const noCap = cap >= 100000000;
  // Show the per-registration bounds as a range when a floor is set (the current
  // 3% / $1.99 / $7.99 model), else fall back to just the cap for legacy orgs.
  const rangeValue = hasFloor
    ? `${fmtCents(floor)}–${noCap ? "no cap" : fmtCents(cap)}`
    : (noCap ? "No cap" : fmtCents(cap));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
      <FeeStat label="Card" value={fmtPct(config.platform_fee_card_pct)} />
      <FeeStat label="Bank transfer" value={fmtPct(config.platform_fee_ach_pct)} note="(when supported)" />
      <FeeStat
        label="Per registration"
        value={rangeValue}
        note={hasFloor ? "min–max" : "cap"}
      />
    </div>
  );
}

function FeeStat({ label, value, note }) {
  return (
    <div style={{ background: "#FBFBFB", border: `1px solid ${RULE}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, color: INK, fontWeight: 700, marginTop: 4 }}>{value}</div>
      {note && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

function Pill({ on, children }) {
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      fontSize: 12,
      borderRadius: 999,
      background: on ? "rgba(58, 124, 58, 0.12)" : "rgba(107, 107, 107, 0.12)",
      color: on ? OK : MUTED,
      fontWeight: 600,
    }}>
      {children}
    </span>
  );
}

// `disabled` defaults to false so existing callers are unchanged. It exists so a
// caller with an in-flight save can stop a second click: this control fires
// onChange(!checked) off the CURRENTLY RENDERED value, so two fast clicks send two
// opposing writes with no ordering guarantee.
function Toggle({ checked, onChange, labelOn, labelOff, disabled = false }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked); }}
      style={{
        position: "relative",
        width: 64,
        height: 32,
        borderRadius: 999,
        border: "none",
        background: checked ? BRIGHT : "#cccccc",
        cursor: disabled ? "wait" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontFamily: "inherit",
        display: "flex",
        alignItems: "center",
        padding: 2,
        transition: "background 0.15s",
      }}
      aria-label={checked ? labelOn : labelOff}
      aria-busy={disabled || undefined}
    >
      <span style={{
        display: "block",
        width: 28, height: 28, borderRadius: "50%",
        background: "#fff",
        transform: `translateX(${checked ? 32 : 0}px)`,
        transition: "transform 0.15s",
        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
      }} />
    </button>
  );
}

function btn(bg, fg, outlined = false, disabled = false) {
  return {
    display: "inline-block",
    padding: "9px 16px",
    background: disabled ? "#ddd" : bg,
    color: disabled ? "#888" : fg,
    border: outlined ? `1px solid ${disabled ? "#ddd" : fg}` : "none",
    borderRadius: 6,
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: "inherit",
    textDecoration: "none",
  };
}
