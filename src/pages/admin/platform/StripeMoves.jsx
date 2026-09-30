// /admin/platform/stripe-moves
//
// Moving a business from one Stripe account to another, without blacking out
// their checkout while Stripe verifies the new one. This is the screen half of
// prepare-then-switch; the two halves are stripe-connect-onboard's start_move
// and stripe-complete-move.
//
// A SEPARATE SCREEN from platform/operators on purpose. That one opens by
// telling you "Read-only: nothing on this screen writes anything anywhere", and
// it is the screen Arielle is handed to answer "who has an account, who has
// published". Bolting the control that moves a business's money onto it would
// make that sentence false. Same gate, same look, its own page.
//
// PLATFORM ADMINS ONLY, three times over: this component checks platform_admins
// before rendering, RLS on organizations answers only for a platform admin
// anyway, and both edge functions check again server-side. The UI check is
// convenience, not the boundary.
//
// NOTHING HERE DECIDES ANYTHING ABOUT MONEY. Every judgement - is the new
// account ready, does it belong to this business, would switching strand a
// payment plan - lives in stripe-complete-move, which re-reads Stripe at the
// moment of the switch. This screen shows what it was told and repeats refusals
// word for word, because a refusal written for a person is worth more than a
// status code translated twice.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const CREAM = "#FBFBFB";
const FLAG = "#B3261E";
const OK = "#1B7F4C";
const AMBER = "#8a6100";

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/**
 * What state is this business's move in? Derived from the row, never from a
 * status column somebody has to remember to set - the same rule the operator
 * overview states for its own stages.
 */
function moveState(o) {
  if (o.stripe_pending_account_id) {
    return { key: "moving", label: "Move in progress", color: AMBER };
  }
  if (!o.stripe_account_id) {
    return { key: "none", label: "No Stripe account", color: MUTED };
  }
  if (o.stripe_charge_model === "direct") {
    return { key: "direct", label: "On direct charges", color: OK };
  }
  return { key: "destination", label: "Enrops collects", color: INK };
}

export default function StripeMoves() {
  const [adminCheck, setAdminCheck] = useState("loading"); // loading | denied | ok
  const [rows, setRows] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [busyOrg, setBusyOrg] = useState(null);
  // Per-org result of the last action: { tone: 'ok'|'warn', text, link }.
  const [result, setResult] = useState({});

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) { setAdminCheck("denied"); return; }
      const { data: adminRow } = await supabase
        .from("platform_admins")
        .select("auth_user_id")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      setAdminCheck(adminRow ? "ok" : "denied");
    })();
  }, []);

  const load = useCallback(async () => {
    setLoadErr("");
    // Direct read, not an RPC: RLS on organizations is
    // `is_org_member(id) OR is_platform_admin()`, so this returns every org for
    // a platform admin and nothing extra for anyone else. A 42501 is not
    // possible here - RLS filters rather than raises - so an empty list for a
    // non-admin is handled by the gate above, not by reading an error code.
    const { data, error } = await supabase
      .from("organizations")
      .select("id, name, slug, stripe_account_id, stripe_pending_account_id, stripe_charge_model, stripe_account_status, stripe_charges_enabled")
      .order("name");
    if (error) {
      console.error("[StripeMoves] load failed", error);
      setLoadErr("Couldn't load the businesses. Refresh to try again.");
      setRows([]);
      return;
    }
    setRows(data ?? []);
  }, []);

  useEffect(() => { if (adminCheck === "ok") load(); }, [adminCheck, load]);

  async function callFn(path, body) {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error("Not signed in.");
    const res = await fetch(`${FN_BASE}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
  }

  // `message` FIRST on every path. Both functions write a sentence a person can
  // act on for every refusal they expect; falling straight to `error` would put
  // a bare code like "instalments_would_be_stranded" on a money screen.
  function say(json, fallback) {
    return json?.message || json?.error || fallback;
  }

  async function startOrRefresh(org) {
    setBusyOrg(org.id);
    setResult((r) => ({ ...r, [org.id]: null }));
    try {
      const { ok, json } = await callFn("stripe-connect-onboard", {
        org_id: org.id,
        start_move: true,
        origin: window.location.origin,
      });
      if (!ok || !json.onboarding_url) {
        setResult((r) => ({ ...r, [org.id]: { tone: "warn", text: say(json, "That didn't work.") } }));
        return;
      }
      setResult((r) => ({
        ...r,
        [org.id]: {
          tone: "ok",
          text: `Setup link ready for ${json.pending_account_id}. Send it to the business — it expires, so get a fresh one if they don't use it.`,
          link: json.onboarding_url,
        },
      }));
      await load();
    } catch (e) {
      setResult((r) => ({ ...r, [org.id]: { tone: "warn", text: e.message } }));
    } finally {
      setBusyOrg(null);
    }
  }

  async function complete(org) {
    if (!window.confirm(
      `Switch ${org.name} onto the new Stripe account?\n\nFrom this moment their new payments go to the new account. Payment plans already running keep going to the old one, which stays connected.`
    )) return;
    setBusyOrg(org.id);
    setResult((r) => ({ ...r, [org.id]: null }));
    try {
      const { ok, json } = await callFn("stripe-complete-move", { org_id: org.id });
      setResult((r) => ({
        ...r,
        [org.id]: ok
          ? { tone: "ok", text: `Switched. New payments now go to ${json.now_charging_to}. The previous account stays connected so existing payment plans finish where they started.` }
          : { tone: "warn", text: say(json, "The switch didn't happen.") },
      }));
      await load();
    } catch (e) {
      setResult((r) => ({ ...r, [org.id]: { tone: "warn", text: e.message } }));
    } finally {
      setBusyOrg(null);
    }
  }

  async function abandon(org) {
    if (!window.confirm(
      `Abandon the move for ${org.name}?\n\nNothing about their payments changes — they are still taking money through the account they always were. The half-set-up account stays at Stripe unused.`
    )) return;
    setBusyOrg(org.id);
    setResult((r) => ({ ...r, [org.id]: null }));
    try {
      // Written straight from here, not through a function: the column is
      // locked by guard_organizations_locked_columns, which exempts platform
      // admins, so this write succeeds for exactly the people this screen is
      // for and raises 42501 for anyone else. It also lands in the money audit.
      //
      // The Stripe account is deliberately NOT deleted. It may be mid-review,
      // deleting it is irreversible, and an unused connected account costs
      // nothing. Clearing the pointer is the reversible half.
      const { error } = await supabase
        .from("organizations")
        .update({ stripe_pending_account_id: null })
        .eq("id", org.id);
      if (error) {
        setResult((r) => ({ ...r, [org.id]: { tone: "warn", text: `Couldn't abandon it: ${error.message}` } }));
        return;
      }
      setResult((r) => ({ ...r, [org.id]: { tone: "ok", text: "Move abandoned. Their payments were never affected." } }));
      await load();
    } finally {
      setBusyOrg(null);
    }
  }

  if (adminCheck === "loading") {
    return <div style={{ color: MUTED, padding: 24 }}>Checking platform-admin access…</div>;
  }
  if (adminCheck === "denied") {
    return (
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 520 }}>
        <h2 style={{ marginTop: 0, color: PURPLE }}>Platform admin only</h2>
        <p style={{ color: INK, fontSize: 14 }}>
          This screen moves a business from one Stripe account to another, so it's restricted to
          platform admins. Org-level admin access alone is not enough.
        </p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 style={{ color: PURPLE, margin: "0 0 4px", fontSize: 24 }}>Stripe account moves</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "0 0 20px", maxWidth: 680 }}>
        Move a business onto a different Stripe account without stopping their checkout. Starting a
        move sets the new account up alongside the one they're using; nothing about their payments
        changes until you switch them over, and you can abandon it at any point before that.
      </p>

      {loadErr && (
        <div style={{ background: "#fdecea", border: `1px solid ${FLAG}`, color: FLAG, borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}>
          {loadErr}
        </div>
      )}

      {rows === null ? (
        <div style={{ color: MUTED }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: MUTED }}>No businesses to show.</div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {rows.map((o) => {
            const st = moveState(o);
            const res = result[o.id];
            const busy = busyOrg === o.id;
            const canStart = !!o.stripe_account_id && !o.stripe_pending_account_id;
            const moving = !!o.stripe_pending_account_id;
            return (
              <div key={o.id} style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 16 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ color: INK, fontSize: 16 }}>{o.name}</strong>
                  <span style={{ color: st.color, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                    {st.label}
                  </span>
                </div>

                <div style={{ background: CREAM, borderRadius: 6, padding: 10, margin: "10px 0", fontSize: 13, color: INK }}>
                  <div>
                    <span style={{ color: MUTED }}>Taking payments through: </span>
                    <code>{o.stripe_account_id || "— none —"}</code>
                    {o.stripe_account_id && !o.stripe_charges_enabled && (
                      <span style={{ color: AMBER }}> (Stripe has payments switched off)</span>
                    )}
                  </div>
                  {moving && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ color: MUTED }}>Setting up, not yet taking anything: </span>
                      <code>{o.stripe_pending_account_id}</code>
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {canStart && (
                    <button type="button" disabled={busy} onClick={() => startOrRefresh(o)} style={btn(PURPLE, busy)}>
                      {busy ? "Working…" : "Start a move"}
                    </button>
                  )}
                  {moving && (
                    <>
                      <button type="button" disabled={busy} onClick={() => startOrRefresh(o)} style={btn(PURPLE, busy)}>
                        {busy ? "Working…" : "Get a fresh setup link"}
                      </button>
                      <button type="button" disabled={busy} onClick={() => complete(o)} style={btn(OK, busy)}>
                        {busy ? "Working…" : "Switch them over"}
                      </button>
                      <button type="button" disabled={busy} onClick={() => abandon(o)} style={btn(FLAG, busy, true)}>
                        Abandon the move
                      </button>
                    </>
                  )}
                  {!canStart && !moving && (
                    <span style={{ color: MUTED, fontSize: 13 }}>
                      Nothing to move — this business has no Stripe account yet.
                    </span>
                  )}
                </div>

                {res && (
                  <div style={{
                    marginTop: 10, fontSize: 13, borderRadius: 6, padding: 10,
                    background: res.tone === "ok" ? "#eef7f1" : "#fff6e5",
                    border: `1px solid ${res.tone === "ok" ? OK : AMBER}`,
                    color: INK,
                  }}>
                    <div>{res.text}</div>
                    {res.link && (
                      // Shown as selectable text, not just a link: this gets
                      // pasted into an email to the business, and a link you can
                      // only click is a link you cannot send.
                      <input
                        readOnly
                        value={res.link}
                        onFocus={(e) => e.target.select()}
                        style={{ width: "100%", marginTop: 8, padding: 6, fontSize: 12, fontFamily: "monospace", border: `1px solid ${RULE}`, borderRadius: 4 }}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function btn(color, busy, outline) {
  return {
    background: outline ? "transparent" : color,
    color: outline ? color : "#fff",
    border: `1px solid ${color}`,
    borderRadius: 6,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 600,
    cursor: busy ? "not-allowed" : "pointer",
    opacity: busy ? 0.6 : 1,
  };
}
