// /admin/settings — tenant-level settings. Currently just the Connections
// section (Google Drive). Future: branding edits, notification prefs, etc.
//
// Multi-tenant: connection rows are org-scoped via RLS. Each org admin sees
// their own org's connections. Copy is brand-neutral (no J2S strings).

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";

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

  return (
    <div>
      <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Settings</h1>
      <p style={{ color: MUTED, fontSize: 14, margin: "6px 0 22px", lineHeight: 1.5 }}>
        Connect your organization to outside services and manage your account.
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

      {/* Signup promises this twice ("you can change this address anytime in
          Settings") and until now there was nowhere to do it. Registration
          operators only — changing an established tenant's address would break
          every link they have ever handed out. */}
      {org?.instructor_pay_model === "enrops_platform" && (
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

      <section style={{ marginTop: 12 }}>
        <h2 style={sectionTitle}>Waivers &amp; policies</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Waivers &amp; policies</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.5, maxWidth: 460 }}>
              The forms families sign to enroll, plus the policies you publish on your registration site.
            </div>
          </div>
          <Link to="/admin/waivers" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Registration questions</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>What your form asks families</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Choose the pickup, release, and guardian details your registration form collects, and add your own questions. Turn off anything you don't need.
            </div>
          </div>
          <Link to="/admin/registration-questions" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      {/* The lean-ops "Locations" section lived here only because lean ops had
          no top-level venue nav. It is now a tab under Programs -- next to the
          classes it serves, rather than in a drawer you configure once -- so
          keeping a duplicate entry point here would be two doors to one room.
          J2S is unaffected: it keeps its own top-level Locations item. */}

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Availability survey</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Survey questions &amp; intro</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Choose which questions the instructor availability survey asks and set a default intro. Turn off anything you don't need.
            </div>
          </div>
          <Link to="/admin/survey-settings" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      {/* Branding used to be hidden from registration operators, on the reasoning
          that a logo-and-colours screen "barely shows up anywhere" for them. That
          stopped being true. Verified 2026-07-31 before unhiding:
            - the logo renders in the public header on every tenant page,
              including the registration flow (PublicLayout reads
              organizations.logo_url);
            - the catalog page reads org_branding and renders the operator's
              colours and banner image (portal/Home.jsx).
          So the card's own promise - "they appear on your registration page and
          every email you send" - is accurate, while the gate meant the one
          operator type that most needs their own branding was the only one who
          could not reach it. Settings was making a promise the product kept and
          the gate hid. The /admin/branding ROUTE was never gated (the route guard
          blocks on role permissions only), so this only ever hid the entrance. */}
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Branding</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Logo, colors &amp; page wording</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Your logo appears on your registration pages and your emails. Your colors style your emails, and your banner and headline sit at the top of your class list.
            </div>
          </div>
          <Link to="/admin/branding" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      {/* Reply-to is the one exception to "no provider branding in v1", because
          without it a family's reply goes to us instead of to them. The copy is
          narrowed for registration operators so it doesn't advertise the
          signature and sender-name controls that branding covers. */}
      {/* Heading matches the destination page's own h1 ("Email sender") on
          purpose: NO_TENANT_INBOX_MESSAGE tells an operator to find this page
          from Settings, and it can only do that if the words match what is on
          screen. "Email replies" also no longer covered what the page owns. */}
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Email sender</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>
              {org?.instructor_pay_model === "enrops_platform" ? "Where family replies go" : "How your emails show up"}
            </div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              {org?.instructor_pay_model === "enrops_platform"
                ? <>When a family replies to a confirmation or reminder, it goes to <strong>{org?.email || "your email"}</strong>. Change it here if replies should go somewhere else, and set where your own alerts land.</>
                : "Set the sender name, reply-to address, email signature, and mailing address that show on your invites, waivers, and reminders — and where the alerts meant for you land. We handle the sending domain — no DNS setup."}
            </div>
          </div>
          <Link to="/admin/email-sender" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Pay rates</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>What you pay instructors</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Set your per-session pay for lead and developing instructors. Enrops fills these amounts in automatically when a session is confirmed, so payroll adds up on its own.
            </div>
          </div>
          <Link to="/admin/pay-rates" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Background checks</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Instructor background checks</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Choose whether a background check is required in onboarding, and tell instructors where to complete one. Turn it off if you don't need it.
            </div>
          </div>
          <Link to="/admin/background-checks" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Training videos</h2>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Instructor training videos</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Upload training videos new instructors must watch during onboarding — no skipping or speeding up — with optional comprehension questions. Turn it off if you don't need it.
            </div>
          </div>
          <Link to="/admin/training" style={{ flexShrink: 0, padding: "9px 16px", background: BRIGHT, color: "#fff", borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}>Manage →</Link>
        </div>
      </section>
      )}

      {/* Google Drive is for importing curriculum documents — a J2S workflow
          that has no counterpart for a registration operator. Hidden rather
          than left as a card that leads somewhere they'd never use. */}
      {org?.instructor_pay_model !== "enrops_platform" && (
      <section style={{ marginTop: 24 }}>
        <h2 style={sectionTitle}>Connections</h2>

        <div style={connectionCard}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={iconBox}>
              <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                {/* Simple Drive triangle mark — no need to load Google's logo SVG */}
                <path fill={VIOLET} d="M7.71 3h8.58l5.71 9.86-4.29 7.43H6.29L2 12.86 7.71 3z" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, color: INK }}>Google Drive</div>
              <div style={{ color: MUTED, fontSize: 13, marginTop: 2 }}>
                {loading
                  ? "Checking connection…"
                  : connection
                  ? <>Connected as <strong style={{ color: INK }}>{connection.google_email}</strong></>
                  : org?.instructor_pay_model === "enrops_platform"
                  ? "Connect your Google Drive to import documents directly into Enrops."
                  : "Connect your Google Drive to import curriculum documents directly into Enrops."}
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
        </div>
      </section>
      )}
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
    <section style={{ marginTop: 12 }}>
      <h2 style={sectionTitle}>Your page address</h2>
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Where families find you</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
          This is the web address of your registration page. Change it whenever you like.
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
    </section>
  );
}

// --- styles ---

const sectionTitle = { fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 };

const connectionCard = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 12,
  padding: 18,
};

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
