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
//   disconnected    -> Operator clicked Disconnect in Express Dashboard.
//                      Same UI as not_connected, but with context banner.
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
  const { org, orgMember } = useOutletContext();
  const [searchParams] = useSearchParams();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [savedToast, setSavedToast] = useState(null);
  const [downloading, setDownloading] = useState(false);

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
  const [descriptorSuffix, setDescriptorSuffix] = useState("");
  const [withdrawalAdminFeeDollars, setWithdrawalAdminFeeDollars] = useState("");
  // Pre-Connect business setup
  const [businessType, setBusinessType] = useState("");
  const [country, setCountry] = useState("US");
  const [savingBiz, setSavingBiz] = useState(false);
  // Inline tabs (only meaningful when active). Default to Activity.
  const [tab, setTab] = useState("activity");
  // Collapsible "Manage setup" banner when active. Collapsed by default —
  // the operator doesn't need to see fee toggle / descriptor / admin fee
  // every visit. Click "Manage setup" to expand.
  const [setupOpen, setSetupOpen] = useState(false);

  // Stripe return-from-onboarding banner. Stripe redirects to:
  //   /admin/finances?stripe=return    — operator finished or paused
  //   /admin/finances?stripe=refresh   — link expired, mint a new one
  const stripeParam = searchParams.get("stripe");

  // ── load config ─────────────────────────────────────────────────────────
  async function reload() {
    if (!org?.id) return;
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
        platform_fee_card_pct,
        platform_fee_ach_pct,
        platform_fee_cap_cents,
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
    setBusinessType(data.stripe_business_type || "");
    setCountry(data.stripe_country || "US");
    setLoading(false);
  }

  // Save the business-setup fields (type + country) BEFORE Connect Stripe
  // is clickable. Owner/admin-gated. The edge function defensively re-checks
  // business_type is set, so this is just UI flow.
  async function saveBusinessSetup() {
    if (!canManage) return;
    if (!businessType) {
      setError("Pick a business type first.");
      return;
    }
    if (!/^[A-Z]{2}$/.test(country || "")) {
      setError("Country must be a 2-letter code (US, CA, GB, ...).");
      return;
    }
    setSavingBiz(true);
    setError(null);
    const { error: err } = await supabase
      .from("organizations")
      .update({
        stripe_business_type: businessType,
        stripe_country: country.toUpperCase(),
      })
      .eq("id", org.id);
    setSavingBiz(false);
    if (err) {
      setError(err.message || "Could not save business setup.");
      return;
    }
    setSavedToast("Business setup saved");
    setTimeout(() => setSavedToast(null), 2200);
    await reload();
  }

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
      if (!token) return null;
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
    if (result?.stripe_account_status === "active") {
      setSavedToast("You're all set — payments now route to your bank.");
      setTimeout(() => setSavedToast(null), 3000);
    } else if (result && !result.error) {
      setSavedToast("Still verifying with Stripe — nothing to do yet.");
      setTimeout(() => setSavedToast(null), 3000);
    } else if (result?.error) {
      setError("Couldn't reach Stripe just now. Try again in a moment.");
    }
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [org?.id]);

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
  const isOnboardingOrRestricted = status === "onboarding" || status === "restricted";
  const isDisconnected = status === "disconnected";

  // ── actions ─────────────────────────────────────────────────────────────
  async function startOnboarding() {
    setBusy(true);
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
        throw new Error(
          json?.stripe_message || json?.error || `Onboarding failed (${resp.status}).`
        );
      }
      window.location.href = json.onboarding_url;
    } catch (err) {
      setError(err.message || "Could not start Stripe onboarding.");
      setBusy(false);
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

  async function togglePassThrough(nextValue) {
    if (!canManage) return;
    // Confirm when flipping to pass-through (parents will see a fee)
    if (nextValue === true) {
      const ok = window.confirm(
        "Pass-through mode: families will see the 1% platform fee as a separate line " +
        "at checkout, so you keep your full price. Switch to pass-through?"
      );
      if (!ok) return;
    }
    const prev = feePassThrough;
    setFeePassThrough(nextValue);
    const { error: err } = await supabase
      .from("organizations")
      .update({ fee_pass_through: nextValue })
      .eq("id", org.id);
    if (err) {
      setFeePassThrough(prev);
      setError(err.message || "Could not save fee mode.");
      return;
    }
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
      setError(err.message || "Could not save statement suffix.");
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
      setError(err.message || "Could not save admin fee.");
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

  return (
    <PageShell>
      <h1 style={{ margin: "0 0 4px", color: PURPLE, fontSize: 28, fontWeight: 700 }}>
        Receivables
      </h1>
      <p style={{ margin: "0 0 24px", color: MUTED, fontSize: 14 }}>
        Money coming in — parent payments, invoices to schools, refunds.
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
      {error && (
        <Banner tone="err">{error}</Banner>
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
            <Heading>Get paid through Enrops</Heading>

            {status === "not_connected" && (
              <NotConnectedBody
                onConnect={startOnboarding}
                busy={busy}
                canManage={canManage}
                businessType={businessType}
                setBusinessType={setBusinessType}
                country={country}
                setCountry={setCountry}
                savedBusinessType={config?.stripe_business_type}
                savedCountry={config?.stripe_country}
                saveBusinessSetup={saveBusinessSetup}
                savingBiz={savingBiz}
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

            {isDisconnected && (
              <DisconnectedBody
                onReconnect={startOnboarding}
                busy={busy}
                canManage={canManage}
                businessType={businessType}
                setBusinessType={setBusinessType}
                country={country}
                setCountry={setCountry}
                savedBusinessType={config?.stripe_business_type}
                savedCountry={config?.stripe_country}
                saveBusinessSetup={saveBusinessSetup}
                savingBiz={savingBiz}
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
              <Heading>Platform fee</Heading>
              <p style={{ color: MUTED, fontSize: 14, marginTop: 0 }}>
                Enrops's cut of each parent payment. The rest goes to your bank automatically.
              </p>
              <FeeReadout config={config} />

              <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${RULE}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                  <div>
                    <div style={{ fontWeight: 600, color: INK, fontSize: 15 }}>
                      Who pays the platform fee?
                    </div>
                    <div style={{ color: MUTED, fontSize: 13, marginTop: 4, maxWidth: 480 }}>
                      {feePassThrough
                        ? "Families see the 1% platform fee as a separate line at checkout — you keep your full price."
                        : "Your organization absorbs the fee — families pay your base price."}
                    </div>
                  </div>
                  {canManage ? (
                    <Toggle
                      checked={feePassThrough}
                      onChange={(v) => togglePassThrough(v)}
                      labelOn="Pass-through"
                      labelOff="Absorbed"
                    />
                  ) : (
                    <span style={{ color: MUTED, fontSize: 12 }}>
                      Owner/admin only
                    </span>
                  )}
                </div>
              </div>
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
        </>
      )}

      {/* Tabs (Activity / Invoices / Refunds) — render below the setup detail
          so the expanded "Manage setup" fee config sits under its own banner. */}
      {isActive && (
        <>
          <AchAttention org={org} />
          <TabsNav tab={tab} onTab={setTab} />
          {tab === "activity" && <ActivityTab org={org} />}
          {tab === "invoices" && <InvoicesTab />}
          {tab === "refunds" && <RefundsTab />}
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
            ACH takes 1–3 business days. The seat is held; these mark paid automatically when they clear.
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
        <button
          type="button"
          onClick={onToggle}
          style={{
            padding: "5px 10px",
            background: "transparent",
            color: INK,
            border: `1px solid ${RULE}`,
            borderRadius: 5,
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Manage setup {open ? "▴" : "▾"}
        </button>
      </div>
    </div>
  );
}

// Horizontal tabs nav inside Receivables.
function TabsNav({ tab, onTab }) {
  const items = [
    { key: "activity", label: "Activity" },
    { key: "invoices", label: "Invoices" },
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

// Revenue / Activity — money collected through Enrops, from our own DB (not the
// Stripe API). Reads two money-gated RPCs (owner/admin only): get_revenue_summary
// + get_revenue_activity. NET-to-bank is intentionally NOT shown (Stripe's
// processing fee isn't stored) — we link to Stripe for the real deposit figure.
const RA_PAGE = 25;

function ActivityTab({ org }) {
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
        <div style={{ fontSize: 12, color: OK, fontWeight: 600 }}>Always up to date — no spreadsheet reconciliation.</div>
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
              <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>You collect payments outside Enrops</div>
              Payment totals live in your own system. We track <strong>{ext}</strong> {ext === 1 ? "registration" : "registrations"} for you here — once families pay <em>through</em> Enrops, the money shows up on this screen.
            </>
          ) : (
            <>
              <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>No payments yet</div>
              Once families pay through Enrops, every payment and refund will show up here automatically.
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
        <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700 }}>Collected through Enrops</div>
        <div style={{ fontSize: 34, fontWeight: 800, color: PURPLE, lineHeight: 1.1, marginTop: 2 }}>{fmtCents(collected)}</div>
      </div>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", margin: "12px 0 16px" }}>
        <RAStat label="Refunded" value={fmtCents(refunded)} />
        {expected > 0 && <RAStat label="Expected soon" value={fmtCents(expected)} note="installments due" />}
        <RAStat label="Paid families" value={String(paidFam)} />
      </div>

      {external > 0 && (
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 14 }}>
          {external} {external === 1 ? "registration was" : "registrations were"} paid outside Enrops (imported) and aren&rsquo;t counted above.
        </div>
      )}

      <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 18 }}>
        Your actual bank deposits (after Stripe&rsquo;s processing fee) live in your Stripe dashboard.{" "}
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
          Coming next — Stripe Invoicing with ACH support.
        </div>
      </div>
    </Card>
  );
}

// Read-only refund history. Refunds are issued from Rosters (row → Refund…);
// this is the money-side record of what happened. RLS scopes rows to the org.
function RefundsTab() {
  const [rows, setRows] = useState(null); // null = loading
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from("refunds")
        .select("id, amount_cents, reason, status, cancelled_registration, created_at, succeeded_at, registration:registrations(student:students(first_name, last_name))")
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

  return (
    <Card>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, color: PURPLE, fontWeight: 700 }}>Refund history</h2>
      <p style={{ margin: "0 0 16px", color: MUTED, fontSize: 13 }}>
        Issue a refund from <a href="/admin/rosters" style={{ color: PURPLE }}>Rosters</a> → a family's row → <strong>Refund…</strong>. Every refund is recorded here.
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
                {r.reason && <span style={{ display: "block", color: MUTED, fontSize: 11.5, marginTop: 2 }}>{r.reason}</span>}
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

function Banner({ tone, children }) {
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
    }}>
      {children}
    </div>
  );
}

function NotConnectedBody(props) {
  return (
    <>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: INK, lineHeight: 1.6 }}>
        Connect Stripe to start receiving parent payments directly into your bank account.
        Onboarding is hosted by Stripe — takes about 5–10 minutes.
      </p>
      <WhatToExpect />
      <BusinessSetupForm {...props} />
      <ConnectButton {...props} label="Connect Stripe" />
    </>
  );
}

function DisconnectedBody(props) {
  return (
    <>
      <Banner tone="warn">
        Stripe is disconnected. New parent payments are landing in Enrops's account until
        you reconnect. We'll transfer them to you once you're set up.
      </Banner>
      <WhatToExpect />
      <BusinessSetupForm {...props} />
      <ConnectButton {...props} label="Reconnect Stripe" />
    </>
  );
}

// Pre-Connect instructions panel. Tenant-agnostic — no J2S strings.
// Mirrors the style of the instructor portal's Stripe onboarding step:
// scannable list of what Stripe will ask, then expectations.
function WhatToExpect() {
  const itemStyle = { marginBottom: 6, fontSize: 13, color: INK, lineHeight: 1.55 };
  const labelStyle = { fontWeight: 700, color: PURPLE };
  return (
    <div style={{
      background: "#FBFBFB",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: "14px 16px",
      marginBottom: 16,
    }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: INK, marginBottom: 10 }}>
        What Stripe will ask for — have these handy:
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li style={itemStyle}>
          <span style={labelStyle}>Your email and phone</span> — Stripe sends verification
          codes and account notices here. Use a personal address you check regularly.
        </li>
        <li style={itemStyle}>
          <span style={labelStyle}>Business details</span> — legal name, EIN, business address.
        </li>
        <li style={itemStyle}>
          <span style={labelStyle}>Your personal info as account holder</span> — name,
          date of birth, last 4 of SSN. (Stripe requires this for KYC; it's not stored on
          our side.)
        </li>
        <li style={itemStyle}>
          <span style={labelStyle}>Bank account</span> — routing and account number, or
          connect via Plaid. This is where Stripe deposits parent payments.
        </li>
      </ul>
      <div style={{
        marginTop: 12, paddingTop: 10, borderTop: `1px solid ${RULE}`,
        fontSize: 12, color: MUTED, lineHeight: 1.55,
      }}>
        <strong style={{ color: INK }}>What happens after:</strong> Stripe verifies your
        info (usually instant; up to a day if they need to review documents). You'll be set
        to "Active" automatically, and parents start paying through your account on new
        registrations. Enrops keeps a 1% platform fee (no cap); the
        rest lands in your bank.
        <br /><br />
        <strong style={{ color: INK }}>Already have a Stripe account?</strong> This creates
        a separate account just for Enrops. Your existing Stripe account stays untouched.
      </div>
    </div>
  );
}

// Business type + country capture. Must be saved before Connect Stripe button
// is enabled. Per-tenant, never hardcoded.
function BusinessSetupForm({
  canManage, businessType, setBusinessType, country, setCountry,
  savedBusinessType, savedCountry, saveBusinessSetup, savingBiz,
}) {
  if (!canManage) return null;
  const isDirty = businessType !== (savedBusinessType || "") || country !== (savedCountry || "US");
  return (
    <div style={{ background: "#FBFBFB", border: `1px solid ${RULE}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
      <div style={{ fontWeight: 600, fontSize: 14, color: INK, marginBottom: 8 }}>Business setup</div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
        Tell us how you're organized and where you operate. Stripe uses these to set up your account.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 120px auto", gap: 10, alignItems: "end" }}>
        <label style={{ display: "block", fontSize: 12, color: MUTED }}>
          Business type
          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 5, fontSize: 13, fontFamily: "inherit" }}
          >
            <option value="">Choose…</option>
            <option value="company">Company / LLC</option>
            <option value="individual">Individual / sole proprietor</option>
            <option value="non_profit">Non-profit</option>
            <option value="government_entity">Government entity</option>
          </select>
        </label>
        <label style={{ display: "block", fontSize: 12, color: MUTED }}>
          Country
          <input
            type="text"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
            maxLength={2}
            placeholder="US"
            style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 10px", border: `1px solid ${RULE}`, borderRadius: 5, fontSize: 13, fontFamily: "inherit", textTransform: "uppercase" }}
          />
        </label>
        <button
          onClick={saveBusinessSetup}
          disabled={savingBiz || !isDirty}
          style={btn(BRIGHT, "#fff", false, savingBiz || !isDirty)}
        >
          {savingBiz ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function ConnectButton({ onConnect, onReconnect, busy, canManage, savedBusinessType, label }) {
  const handler = onConnect || onReconnect;
  if (!canManage) {
    return (
      <em style={{ color: MUTED, fontSize: 13 }}>
        Only an owner or admin can connect Stripe.
      </em>
    );
  }
  const blocked = !savedBusinessType;
  return (
    <>
      <button
        onClick={handler}
        disabled={busy || blocked}
        style={btn(BRIGHT, "#fff", false, busy || blocked)}
      >
        {busy ? "Starting…" : label}
      </button>
      {blocked && (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
          Save your business setup above before connecting.
        </div>
      )}
    </>
  );
}

function OnboardingBody({ status, onContinue, onCheckStatus, checking, busy, canManage, chargesEnabled, payoutsEnabled }) {
  return (
    <>
      {status === "restricted" && (
        <Banner tone="warn">
          Stripe has paused some of your account capabilities. You'll usually fix this by
          providing additional info — click below to continue.
        </Banner>
      )}
      <p style={{ margin: "0 0 16px", fontSize: 14, color: INK, lineHeight: 1.6 }}>
        Stripe still needs more info before they can verify your account. Pick up where you
        left off — Stripe remembers what you've already entered.
      </p>
      <div style={{ marginBottom: 16, fontSize: 14, color: INK }}>
        <div style={{ marginBottom: 4 }}>
          <strong>Charges:</strong>{" "}
          <Pill on={chargesEnabled}>{chargesEnabled ? "enabled" : "pending"}</Pill>
        </div>
        <div>
          <strong>Payouts:</strong>{" "}
          <Pill on={payoutsEnabled}>{payoutsEnabled ? "enabled" : "pending"}</Pill>
        </div>
      </div>
      <WhatToExpect />
      {canManage ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <button onClick={onContinue} disabled={busy || checking} style={btn(BRIGHT, "#fff", false, busy || checking)}>
            {busy ? "Loading…" : "Continue setup"}
          </button>
          <button onClick={onCheckStatus} disabled={busy || checking} style={btn("transparent", BRIGHT, true, busy || checking)}>
            {checking ? "Checking…" : "Already finished? Check status"}
          </button>
        </div>
      ) : (
        <em style={{ color: MUTED, fontSize: 13 }}>
          Only an owner or admin can finish Stripe setup.
        </em>
      )}
    </>
  );
}

function ActiveBody({ accountId, onOpenDashboard, busy }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{
          display: "inline-block", width: 10, height: 10, borderRadius: "50%",
          background: OK,
        }} />
        <strong style={{ color: OK, fontSize: 14 }}>Connected</strong>
      </div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
        Account ID: <code style={{ fontFamily: "monospace", fontSize: 12 }}>{accountId}</code>
      </div>
      <button onClick={onOpenDashboard} disabled={busy} style={btn("transparent", BRIGHT, true, busy)}>
        {busy ? "Loading…" : "Open Stripe Dashboard ↗"}
      </button>
      <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
        Manage payouts, view balances, update bank info.
      </div>
    </>
  );
}

function FeeReadout({ config }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
      <FeeStat label="Card" value={fmtPct(config.platform_fee_card_pct)} />
      <FeeStat label="ACH" value={fmtPct(config.platform_fee_ach_pct)} note="(when supported)" />
      <FeeStat
        label="Fee cap"
        value={config.platform_fee_cap_cents >= 100000000 ? "No cap" : fmtCents(config.platform_fee_cap_cents)}
        note="per transaction"
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

function Toggle({ checked, onChange, labelOn, labelOff }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 64,
        height: 32,
        borderRadius: 999,
        border: "none",
        background: checked ? BRIGHT : "#cccccc",
        cursor: "pointer",
        fontFamily: "inherit",
        display: "flex",
        alignItems: "center",
        padding: 2,
        transition: "background 0.15s",
      }}
      aria-label={checked ? labelOn : labelOff}
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
