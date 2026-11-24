// /admin/settings — tenant-level settings, grouped by job: Your page & sign-ups,
// Emails & photos, Instructors (canManageInstructors), Connections (non-lean).
// Each setting is one row; most open their own page under /admin/*.
//
// Multi-tenant: connection rows are org-scoped via RLS. Each org admin sees
// their own org's connections. Copy is brand-neutral (no J2S strings).

import { Children, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { canManageInstructors } from "../../lib/entitlements.js";
import ClassPhotosSettingsCard from "./ClassPhotosSettingsCard.jsx";
import SettingSwitch from "../../components/SettingSwitch.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const GREEN = "#2f7d32";
const RED = "#a13a3a";

const GOOGLE_OAUTH_CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export default function AdminSettings() {
  const { org, user, setOrg } = useOutletContext();
  const [connection, setConnection] = useState(null); // { id, google_email, scopes, user_id } | null
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null); // { kind: 'success' | 'error', message }

  // Drain success/error toasts left by the /auth/google/callback page (passed
  // via location.search). We clear the query string after reading so refresh
  // doesn't re-fire the toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleStatus = params.get("google");
    const errorMsg = params.get("error_message");
    if (googleStatus === "connected") {
      setToast({ kind: "success", message: "Google Drive connected." });
    } else if (googleStatus === "error") {
      setToast({ kind: "error", message: errorMsg || "Google Drive connection failed." });
    }
    if (googleStatus) {
      const url = new URL(window.location.href);
      url.searchParams.delete("google");
      url.searchParams.delete("error_message");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("organization_google_tokens")
        .select("id, google_email, scopes, user_id, updated_at")
        .eq("organization_id", org.id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setToast({ kind: "error", message: `Couldn't check connection status: ${error.message}` });
      }
      setConnection(data ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  function startConnect() {
    if (!GOOGLE_OAUTH_CLIENT_ID) {
      setToast({ kind: "error", message: "Google OAuth isn't configured (missing VITE_GOOGLE_OAUTH_CLIENT_ID)." });
      return;
    }
    if (!org?.id) return;
    const state = crypto.randomUUID();
    const redirectUri = `${window.location.origin}/auth/google/callback`;
    // Stash everything the callback page needs to complete the exchange. State
    // is the CSRF anchor; org_id tells the callback which org to attach to.
    sessionStorage.setItem("google_oauth_state", state);
    sessionStorage.setItem("google_oauth_org_id", org.id);
    sessionStorage.setItem("google_oauth_redirect_uri", redirectUri);

    const params = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      // openid+email gets us the connected account's email for display;
      // drive.readonly is the actual access scope.
      scope: ["openid", "email", GOOGLE_DRIVE_SCOPE].join(" "),
      access_type: "offline",
      // prompt=consent forces Google to return a refresh_token even on
      // re-auth. Without it we'd only get access_token (1h, no refresh).
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async function disconnect() {
    if (!connection?.id || busy) return;
    if (!window.confirm("Disconnect Google Drive? You can reconnect anytime.")) return;
    setBusy(true);
    try {
      // The RLS policy "user_manages_own_google_token" only lets the user
      // who created the token row delete it. If a different admin tries to
      // disconnect a teammate's connection, they'll get 0 rows affected.
      const { error, count } = await supabase
        .from("organization_google_tokens")
        .delete({ count: "exact" })
        .eq("id", connection.id);
      if (error) throw error;
      if (count === 0) {
        throw new Error(`Only ${connection.google_email} can disconnect this connection (they set it up).`);
      }
      // Note: vault secret rows are left behind here — they're not reachable
      // without the secret_id from the deleted row, so they're harmless. We
      // could vacuum them with a vault_delete_secret RPC in a follow-up.
      setConnection(null);
      setToast({ kind: "success", message: "Google Drive disconnected." });
    } catch (e) {
      setToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const isLean = org?.instructor_pay_model === "enrops_platform";

  return (
    <div>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Settings</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5 }}>
        How your page looks, what families get, and how your team runs.
      </p>

      {toast && (
        <div
          style={{
            ...toastStyle,
            background: toast.kind === "success" ? "#f0f8f0" : "#fff5f5",
            borderColor: toast.kind === "success" ? "#bfd9bf" : "#f0c4c4",
            color: toast.kind === "success" ? GREEN : RED,
          }}
        >
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} style={toastClose}>×</button>
        </div>
      )}

      {/* Grouped by job (Jessica approved 2026-11-24): one group per job, one
          row per setting. Every row keeps the name it had as a card, because
          guides, the tenant-sender test email ("Settings → Email sender") and
          the Drive error ("Settings → Connections") send people here by name. */}

      <SettingsGroup title="Your page & sign-ups" intro="What families see when they find you and sign up.">
        {/* Signup promises this twice ("you can change this address anytime in
            Settings"). Registration operators only: changing an established
            tenant's address would break every link they have ever handed out. */}
        {isLean && (
          <PageAddressSection
            org={org}
            onSaved={(slug) => {
              // Correct the shell's copy straight away: every other surface reads
              // org.slug for share links and the embed snippet, and the address
              // field itself compares against it to know what "changed" means.
              setOrg?.((o) => (o ? { ...o, slug } : o));
              setToast({ kind: "success", message: `Your page address is now ${slug}.` });
            }}
          />
        )}
        {/* Not gated by operator type: the logo shows in the public header and
            the catalog reads org_branding for every tenant (verified 2026-07-31).
            The /admin/branding route itself was never gated. */}
        <SettingsRow title="Branding" to="/admin/branding">
          Your logo, colors and the words at the top of your class list.
        </SettingsRow>
        <SettingsRow title="Registration questions" to="/admin/registration-questions">
          What your sign-up form asks families.
        </SettingsRow>
        <SettingsRow title="Waivers & policies" to="/admin/waivers">
          What families sign, and the policies on your page.
        </SettingsRow>
        {/* Only where families register on enrops - elsewhere it would do nothing. */}
        {org?.uses_enrops_registration !== false && <LateJoinSettingsCard org={org} setOrg={setOrg} />}
      </SettingsGroup>

      <SettingsGroup title="Emails & photos" intro="What families get from you after they sign up.">
        {/* Title matches the destination page's own h1 ("Email sender"):
            NO_TENANT_INBOX_MESSAGE tells an operator to find it from Settings.
            Registration operators' copy leaves out the sender-name and signature
            controls that branding covers for them. */}
        <SettingsRow title="Email sender" to="/admin/email-sender">
          {isLean
            ? "Where family replies go, and where your alerts land."
            : "Your sender name and signature, where family replies go, and where your alerts land."}
        </SettingsRow>
        <ClassPhotosSettingsCard org={org} />
      </SettingsGroup>

      {/* Gated on the ENTITLEMENT, not the nav shape: a founding registration
          operator manages instructors too, and their instructors cannot onboard
          without documents and the background-check switch (which defaults ON
          in WizardHost). See canManageInstructors. The lean-ops "Locations"
          card that once lived on this page is a tab under Programs now. */}
      {canManageInstructors(org) && (
        <SettingsGroup title="Instructors" intro="Onboarding, pay and scheduling for your team.">
          <SettingsRow title="Instructor documents" to="/admin/instructor-documents">
            What your instructors sign when they join.
          </SettingsRow>
          <SettingsRow title="Background checks" to="/admin/background-checks">
            Whether onboarding asks for one, and where to get it.
          </SettingsRow>
          <SettingsRow title="Training videos" to="/admin/training">
            Videos new instructors watch during onboarding.
          </SettingsRow>
          <SettingsRow title="Pay rates" to="/admin/pay-rates">
            What you pay per session.
          </SettingsRow>
          <SettingsRow title="Availability survey" to="/admin/survey-settings">
            What the survey asks your instructors.
          </SettingsRow>
        </SettingsGroup>
      )}

      {/* Google Drive is for importing curriculum documents, a J2S workflow
          with no counterpart for a registration operator. */}
      {!isLean && (
        <SettingsGroup title="Connections" intro="Outside services linked to enrops.">
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: ROW_PAD }}>
            <div style={iconBox}>
              <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                {/* Simple Drive triangle mark — no need to load Google's logo SVG */}
                <path fill={VIOLET} d="M7.71 3h8.58l5.71 9.86-4.29 7.43H6.29L2 12.86 7.71 3z" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={rowTitle}>Google Drive</div>
              <div style={rowDesc}>
                {loading
                  ? "Checking connection…"
                  : connection
                  ? <>Connected as <strong style={{ color: INK }}>{connection.google_email}</strong></>
                  : "Import curriculum documents straight from Drive."}
              </div>
            </div>
            <div>
              {loading ? null : connection ? (
                <button type="button" onClick={disconnect} disabled={busy} style={secondaryBtn}>
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              ) : (
                <button type="button" onClick={startConnect} style={primaryBtn}>
                  Connect Google Drive
                </button>
              )}
            </div>
          </div>
        </SettingsGroup>
      )}
    </div>
  );
}
// One group of settings: a small heading, one line on what the group is for,
// then a single panel holding its rows with a hairline between them. A row
// gated off with `cond && <Row/>` is dropped here, so it leaves no empty
// divider, and a group whose rows are all gated off disappears.
function SettingsGroup({ title, intro, children }) {
  const rows = Children.toArray(children).filter(Boolean);
  if (rows.length === 0) return null;
  return (
    <section style={{ marginTop: 26 }}>
      <h2 style={{ ...sectionTitle, marginBottom: 2 }}>{title}</h2>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 10px", lineHeight: 1.5 }}>{intro}</p>
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10 }}>
        {rows.map((row, i) => (
          <div key={row.key ?? i} style={i > 0 ? { borderTop: `1px solid ${RULE}` } : undefined}>{row}</div>
        ))}
      </div>
    </section>
  );
}

// One setting that lives on its own page: name, one line, "Manage →".
function SettingsRow({ title, to, children }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, padding: ROW_PAD }}>
      <div style={{ minWidth: 0 }}>
        <div style={rowTitle}>{title}</div>
        <div style={rowDesc}>{children}</div>
      </div>
      <Link to={to} aria-label={`Manage ${title}`} style={manageLink}>Manage →</Link>
    </div>
  );
}

// Late sign-ups: organizations.late_join_allowed (20261124c), ON by default.
// On: a family can join a weekly class after it starts and pays for the
// sessions left (pricing.js proratedBaseCents). Off: a class stops selling once
// its first session has happened (classSeasons.isClassOnSale, and
// create-registration refuses it). Same switch pattern as ClassPhotosSettingsCard,
// including reading the row back so a refused write is visible.
function LateJoinSettingsCard({ org, setOrg }) {
  const orgId = org?.id;
  const [allowed, setAllowed] = useState(null); // null = loading
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("organizations").select("late_join_allowed").eq("id", orgId).maybeSingle();
      if (cancelled) return;
      if (error) { console.error("[LateJoinSettingsCard] load failed", error); setErr("Couldn't load this setting."); return; }
      setAllowed(data?.late_join_allowed !== false);
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  async function toggle() {
    setSaving(true);
    setErr("");
    const { data, error } = await supabase
      .from("organizations").update({ late_join_allowed: !allowed }).eq("id", orgId).select("late_join_allowed");
    setSaving(false);
    if (error) { console.error("[LateJoinSettingsCard] save failed", error); setErr("That didn't save. Try again."); return; }
    if (!data || data.length === 0) { setErr("Only an owner or admin can change this setting."); return; }
    const saved = data[0].late_join_allowed !== false;
    setAllowed(saved);
    // Keep the shell's copy current: Programs reads org.late_join_allowed for
    // each class's "Sign-ups closed · class started" chip.
    setOrg?.((o) => (o ? { ...o, late_join_allowed: saved } : o));
  }

  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, padding: ROW_PAD }}>
      <div style={{ minWidth: 0 }}>
        <div style={rowTitle}>Late sign-ups</div>
        <div style={rowDesc}>
          {allowed === false
            ? "A class stops taking sign-ups once its first session has happened."
            : "Families can join after a class starts and pay for the sessions left."}
        </div>
        {err && <div style={{ color: RED, fontSize: 13, marginTop: 8 }}>{err}</div>}
      </div>
      <SettingSwitch
        on={allowed === true}
        loading={allowed === null}
        busy={saving}
        label="Late sign-ups"
        onChange={toggle}
      />
    </div>
  );
}

// Change the public web address of the registration page.
//
// Goes through the rename_org_slug function rather than updating the row
// directly: RLS only lets an operator see their own organisation, so the
// browser cannot tell whether an address is already taken, and a plain update
// would surface a raw duplicate-key error. The function owns the uniqueness
// check and the reserved-word list, which is the same list provisioning uses.
function PageAddressSection({ org, onSaved }) {
  const [value, setValue] = useState(org?.slug ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [savedSlug, setSavedSlug] = useState("");
  const current = org?.slug ?? "";
  const cleaned = value.trim().toLowerCase();
  const changed = cleaned !== current;

  const MESSAGES = {
    invalid: "Use lowercase letters, numbers, and hyphens only — no spaces.",
    length: "Pick something between 3 and 40 characters.",
    reserved: "That one's reserved by the platform. Try another.",
    taken: "Another business already has that address. Try another.",
    forbidden: "You don't have permission to change this.",
    not_authenticated: "Your sign-in expired — please sign in again.",
  };

  async function save() {
    if (!changed || saving) return;
    setSaving(true);
    setErr("");
    try {
      // The org id is passed explicitly and authorized server-side. The function
      // used to infer it from the caller's oldest membership, which renames the
      // WRONG organisation for anyone who administers two - and on prod the
      // oldest membership is the J2S ownership.
      const { data, error } = await supabase.rpc("rename_org_slug", { p_org_id: org.id, p_slug: cleaned });
      if (error) throw error;
      if (!data?.ok) {
        setErr(MESSAGES[data?.code] || "That didn't work. Please try another address.");
        return;
      }
      setSavedSlug(data.slug);
      onSaved?.(data.slug);
    } catch (e) {
      setErr("That didn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: ROW_PAD }}>
        <div style={rowTitle}>Your page address</div>
        <div style={rowDesc}>
          The web address of your registration page.
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <span style={{ fontSize: 14, color: MUTED, whiteSpace: "nowrap" }}>enrops.com/</span>
          <input
            value={value}
            onChange={(e) => { setValue(e.target.value.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase()); setErr(""); setSavedSlug(""); }}
            maxLength={40}
            aria-label="Your page address"
            style={{
              flex: "1 1 200px", minWidth: 0, boxSizing: "border-box", padding: "10px 12px",
              fontSize: 16, border: `1px solid ${RULE}`, borderRadius: 8, fontFamily: "inherit", background: "#fff",
            }}
          />
          <button
            type="button"
            onClick={save}
            disabled={!changed || saving || cleaned.length < 3}
            style={{
              flexShrink: 0, padding: "10px 18px", background: BRIGHT, color: "#fff", border: "none",
              borderRadius: 8, fontSize: 14, fontWeight: 600, fontFamily: "inherit",
              cursor: !changed || saving || cleaned.length < 3 ? "not-allowed" : "pointer",
              opacity: !changed || saving || cleaned.length < 3 ? 0.5 : 1,
            }}
          >
            {saving ? "Saving…" : "Save address"}
          </button>
        </div>

        {/* Said before they press the button, not after. Anyone who has already
            shared their link is about to break it. */}
        {changed && !err && !savedSlug && (
          <div style={{ fontSize: 12.5, color: "#8a5a00", background: "#FDF6E3", border: "1px solid #F0D48A", borderRadius: 8, padding: "9px 11px", marginTop: 10, lineHeight: 1.5 }}>
            Heads up: any link you&rsquo;ve already shared uses <strong>enrops.com/{current}</strong> and
            will stop working. If families already have your old link, share the new one.
          </div>
        )}
        {err && <div style={{ color: "#b53737", fontSize: 12.5, marginTop: 10 }}>{err}</div>}
        {savedSlug && (
          <div style={{ color: GREEN, fontSize: 12.5, marginTop: 10 }}>
            Saved. Your page is now at enrops.com/{savedSlug}.
          </div>
        )}
    </div>
  );
}

// --- styles ---

const sectionTitle = { fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12, marginTop: 0 };

// Every row on this page uses these so rows line up inside a group.
// ClassPhotosSettingsCard keeps a copy of the same three values (it is imported
// by this file, so importing them back would be a cycle).
const ROW_PAD = "14px 18px";
const rowTitle = { fontSize: 15, fontWeight: 600, color: INK };
const rowDesc = { fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.5, maxWidth: 520 };
const manageLink = { flexShrink: 0, color: BRIGHT, fontSize: 14, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" };

const iconBox = {
  width: 40,
  height: 40,
  borderRadius: 8,
  background: CREAM,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const primaryBtn = {
  padding: "9px 16px",
  background: BRIGHT,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const secondaryBtn = {
  padding: "9px 16px",
  background: "transparent",
  color: BRIGHT,
  border: `1px solid ${BRIGHT}`,
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const toastStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  border: "1px solid",
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 16,
};

const toastClose = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  fontSize: 18,
  cursor: "pointer",
  color: "inherit",
  lineHeight: 1,
  padding: 0,
};
