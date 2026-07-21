// src/layouts/AdminLayout.jsx
// Shell for the Enrops admin portal. Sidebar nav + content area.
// All admin pages render inside <Outlet />. Enrops chrome (Plum/Gold/Chalk).
// Multi-tenant: never hardcodes J2S. Reads org from logged-in user's org_members row.

import { Suspense, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import PwaInstallButton from "../components/pwa/PwaInstallButton.jsx";
import EnropsWordmark from "../components/EnropsWordmark.jsx";
import FeedbackWidget from "../components/feedback/FeedbackWidget.jsx";
import AnnouncementBanner from "../components/feedback/AnnouncementBanner.jsx";
import { defaultTenantSlug } from "../lib/tenants.js";
import { getPermissions } from "../lib/permissions";
import PortalSwitcher from "../components/PortalSwitcher.jsx";
import RouteFallback from "../components/RouteFallback.jsx";
import { setOrgGroup } from "../lib/analytics";

// Enrops brand tokens
const PURPLE = "#1C004F";   // deep plum — wordmark, headings, body accents
const BRIGHT = "#5847C9";   // indigo — primary actions + active nav (sampled #6857E1, darkened a step per Jessica)
const LAVENDER = "#F2F0FF"; // sidebar background (sampled from Figma)
const CREAM = "#FBFBFB";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

// Flat sidebar nav — every item is a single page. Sections with multiple
// facets (Programs, Instructors, Money) expose an in-page tab strip (rendered
// in <main>) instead of an expandable sidebar group, so the sidebar pattern is
// uniform. Partners (/admin/schools) and Comms (/admin/family-comms) own their
// own internal tab strips, so they have no shell tab strip — `match` keeps the
// sidebar item lit on their sub-routes (for Partners, incl. the retired
// /admin/calendars, which now redirects into the Calendars tab).
//
// URL guardrail: /admin/finances stays put — the Stripe return_url in
// stripe-connect-onboard is hardcoded to /admin/finances?stripe=return.
const NAV = [
  { to: "/admin", label: "Overview", end: true },
  {
    // Current-term-first: clicking "Programs" lands on Scheduled programs (which
    // defaults to the term in progress), then Class rosters, then Offerings (the
    // reference library) last. Per Arielle's feedback 2026-06-25.
    to: "/admin/programs", label: "Programs",
    tabs: [
      // A tenant is one type: they run registration through Enrops (term programs)
      // OR they upload their own schedule. Show both tabs; disable the one that
      // doesn't apply with a why (Enrops house style: disabled + coaching note).
      { to: "/admin/programs", label: "Scheduled programs", regOnly: true,
        offReason: "You bring your own registration — use Class schedule instead." },
      { to: "/admin/class-schedule", label: "Class schedule", outsideRegOnly: true,
        offReason: "You run registration through Enrops — your classes are under Scheduled programs." },
      { to: "/admin/rosters", label: "Class rosters" },
      { to: "/admin/class-reports", label: "Class Reports", gate: "reports" }, // owner/admin/staff — custody/safety log, hidden from viewer
      { to: "/admin/curricula", label: "Offerings" },
    ],
  },
  {
    to: "/admin/schools", label: "Partners",
    match: ["/admin/schools", "/admin/calendars"],
  },
  {
    // Schedule-first: clicking "Instructors" lands on the Schedule (the live
    // operating picture — who's teaching where/when), not the static roster.
    // Per Arielle's feedback 2026-06-25. "Instructor Roster" disambiguates from
    // "Class rosters" under Programs.
    to: "/admin/schedule", label: "Instructors",
    tabs: [
      { to: "/admin/schedule", label: "Schedule" },
      { to: "/admin/instructors", label: "Instructor Roster" },
      { to: "/admin/availability", label: "Availability" },
    ],
  },
  {
    to: "/admin/finances", label: "Money",
    gate: "viewMoney",   // owner/admin only — staff + viewer are money-blind
    tabs: [
      { to: "/admin/finances", label: "Receivables" },
      { to: "/admin/payouts", label: "Payouts" },
      { to: "/admin/discounts", label: "Discounts" },
    ],
  },
  {
    to: "/admin/family-comms/marketing", label: "Comms",
    gate: "send",        // owner/admin/staff — a sending surface, hidden from viewer
    // Comms owns its own 4-tab strip (FamilyCommsTabs, rendered inside each
    // page: Campaigns / Automations / Contacts / Templates) instead of the
    // shell strip. Same pattern as Partners — a shell strip here would be a
    // second, redundant row, and the campaign list⇄wizard live on ONE route
    // (internal reducer state) so the "Campaigns" tab needs an onReset the
    // generic shell <Link> can't give. `match` keeps the sidebar item lit
    // across all four sub-routes.
    match: ["/admin/family-comms"],
  },
  { to: "/admin/community", label: "Community", soon: true },
  // Settings owns Waivers as a sub-page (/admin/waivers) — keep this item lit there.
  { to: "/admin/settings", label: "Settings", gate: "settings", match: ["/admin/settings", "/admin/waivers", "/admin/survey-settings", "/admin/pay-rates"] }, // owner/admin only
  { to: "/admin/team", label: "Team", gate: "team" },             // owner/admin only
];

// A sidebar item is "active" when the current path is (or is under) any of its
// routes. Overview matches exactly; tabbed sections match any tab route;
// Partners matches its `match` list; otherwise the item's own `to`.
function navItemActive(item, pathname) {
  if (item.end) return pathname === item.to;
  const roots = item.tabs ? item.tabs.map((t) => t.to) : item.match || [item.to];
  return roots.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [authState, setAuthState] = useState("loading"); // loading | unauthorized | ready
  const [user, setUser] = useState(null);
  const [orgMember, setOrgMember] = useState(null);
  const [org, setOrg] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);
  // Lifetime time-saved tally (rolling sum of time_saved_events for this org).
  // See project_enrops_time_saved memory: every Director action that completes
  // work for the operator inserts a row; this is the always-on receipt.
  const [timeSavedTotal, setTimeSavedTotal] = useState(null);
  const [timeSavedRecent, setTimeSavedRecent] = useState([]);
  const [tallyOpen, setTallyOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!mounted) return;
        if (!session?.user) {
          setAuthState("unauthorized");
          return;
        }
        setUser(session.user);

        // Look up org_members row for this auth user
        const { data: memberRow, error: memErr } = await supabase
          .from("org_members")
          .select("id, role, organization_id, accepted_at")
          .eq("auth_user_id", session.user.id)
          .maybeSingle();

        console.log("org_members query:", { memberRow, memErr, uid: session.user.id });

        if (!mounted) return;
        if (memErr || !memberRow || !memberRow.accepted_at) {
          setAuthState("unauthorized");
          setDebugInfo({ uid: session.user.id, memErr: memErr?.message, memberRow });
          return;
        }
        setOrgMember(memberRow);

        // Fetch org name + branding (display only — does not gate access)
        const { data: orgRow } = await supabase
          .from("organizations")
          .select("id, name, slug, active_registration_term, uses_enrops_registration, venue_model, background_check_config")
          .eq("id", memberRow.organization_id)
          .maybeSingle();
        if (!mounted) return;
        setOrg(orgRow);
        setAuthState("ready");
      } catch (err) {
        console.error("AdminLayout auth error:", err);
        if (mounted) setAuthState("unauthorized");
      }
    })();
    return () => { mounted = false; };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    navigate("/");
  }

  // Load the time-saved tally once we know which org the operator's in.
  // Refetches on route change so newly-fired events show up after the
  // operator publishes / schedules / etc.
  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      const [{ data: sumRows }, { data: recentRows }] = await Promise.all([
        supabase
          .from("time_saved_events")
          .select("hours_saved")
          .eq("organization_id", org.id),
        supabase
          .from("time_saved_events")
          .select("action_label, hours_saved, created_at")
          .eq("organization_id", org.id)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      if (!mounted) return;
      const total = (sumRows ?? []).reduce((s, r) => s + Number(r.hours_saved || 0), 0);
      setTimeSavedTotal(total);
      setTimeSavedRecent(recentRows ?? []);
    })();
    return () => { mounted = false; };
  }, [org?.id, location.pathname]);

  // Tag the analytics session with the tenant so replays/events filter by org.
  useEffect(() => {
    if (org?.id) setOrgGroup(org, orgMember?.role);
  }, [org?.id, orgMember?.role]);

  function relativeTime(iso) {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diffSec = Math.max(0, Math.round((now - then) / 1000));
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  if (authState === "loading") {
    return (
      <div style={{ minHeight: "100vh", background: CREAM, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Poppins', system-ui, sans-serif", color: MUTED }}>
        Loading admin…
      </div>
    );
  }

  if (authState === "unauthorized") {
    return (
      <div style={{ minHeight: "100vh", background: CREAM, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Poppins', system-ui, sans-serif", padding: 24 }}>
        <div style={{ maxWidth: 440, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 32 }}>
          <div style={{ fontFamily: "'Poppins', system-ui, sans-serif", fontWeight: 700, fontSize: 22, color: PURPLE, marginBottom: 8 }}>
            Enrops Admin
          </div>
          <p style={{ color: INK, fontSize: 15, lineHeight: 1.5, marginTop: 0 }}>
            You need to sign in with an admin account to access this area.
          </p>
          {user && (
            <p style={{ color: MUTED, fontSize: 13, marginTop: 16 }}>
              Signed in as <strong>{user.email}</strong> but not registered as an admin for any organization.
            </p>
          )}
          <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
            <Link to="/admin/login" style={btn(BRIGHT, "#fff")}>Sign in</Link>
            {user && <button onClick={signOut} style={btn("transparent", BRIGHT, true)}>Sign out</button>}
          </div>
          {debugInfo && (
            <div style={{ marginTop: 16, padding: 10, background: "#f7f6ef", borderRadius: 4, fontSize: 11, color: MUTED, wordBreak: "break-all" }}>
              <strong>Debug (temporary):</strong><br />
              uid: {debugInfo.uid}<br />
              memErr: {debugInfo.memErr || "none"}<br />
              memberRow: {JSON.stringify(debugInfo.memberRow)}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Which tabbed section (if any) the current route belongs to, and whether to
  // show its in-page tab strip — only on the tab root pages, not deep sub-flows
  // like /admin/curricula/:id/review.
  const perm = getPermissions(orgMember?.role);
  const visibleNav = NAV.filter((it) => !it.gate || perm.can(it.gate));
  // Route guard: if the current path is under a gated section the user can't
  // access, block it (covers direct-URL navigation, not just nav hiding).
  const blockedItem = NAV.find(
    (it) => it.gate && !perm.can(it.gate) && navItemActive(it, location.pathname)
  );

  const activeTabSection = NAV.find(
    (it) => it.tabs && it.tabs.some((t) => location.pathname === t.to || location.pathname.startsWith(t.to + "/"))
  );
  const showSectionTabs =
    activeTabSection && activeTabSection.tabs.some((t) => location.pathname === t.to);

  return (
    <div style={{ minHeight: "100vh", background: CREAM, fontFamily: "'Poppins', system-ui, sans-serif", color: INK }}>
      <div data-admin-grid style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "100vh" }}>
        {/* Sidebar */}
        <aside data-admin-sidebar style={{
          background: LAVENDER,
          borderRight: `1px solid ${RULE}`,
          padding: "20px 0",
          display: "flex",
          flexDirection: "column",
          position: "sticky",
          top: 0,
          alignSelf: "start",
          height: "100vh",
          overflowY: "auto",
        }}>
          <div style={{ padding: "0 20px 18px", borderBottom: `1px solid ${RULE}` }}>
            <EnropsWordmark height={26} />
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              Admin · {org?.name ?? "—"}
            </div>
          </div>

          {/* Cross-portal switcher — shows only for operators who also teach
              and/or are a parent. Placed up top so it's discoverable, not
              buried at the foot of the sidebar. Single-role admins see nothing. */}
          <div style={{ padding: "14px 20px 0" }}>
            <PortalSwitcher current="admin" slug={org?.slug ?? defaultTenantSlug()} label="Switch view" block />
          </div>

          <nav style={{ padding: "12px 8px", flex: 1 }}>
            {visibleNav.map((item) => {
              const active = navItemActive(item, location.pathname);
              // Own-venue tenants (a center/studio, no external partner schools)
              // see the /admin/schools surface as plain "Locations" — mirror the
              // page's own reframing so the sidebar matches. Partner tenants (J2S)
              // are unaffected and keep "Partners".
              const label =
                item.to === "/admin/schools" && org?.venue_model === "own_venue"
                  ? "Locations"
                  : item.label;
              return (
                <Link
                  key={item.to}
                  to={item.soon ? location.pathname : item.to}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 12px",
                    margin: "2px 0",
                    borderRadius: 8,
                    borderLeft: active ? `3px solid ${BRIGHT}` : "3px solid transparent",
                    fontSize: 14,
                    fontWeight: active ? 600 : 500,
                    color: active ? BRIGHT : (item.soon ? MUTED : INK),
                    background: active ? "#fff" : "transparent",
                    boxShadow: active ? "0 1px 3px rgba(28, 0, 79, 0.08)" : "none",
                    textDecoration: "none",
                    cursor: item.soon ? "default" : "pointer",
                    pointerEvents: item.soon ? "none" : "auto",
                  }}
                >
                  <span>{label}</span>
                  {item.soon && (
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      soon
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Always-available feedback path for early partners. Lives here in the
              sidebar (not a floating corner pill) so it never covers page action
              bars like marketing's "Approve & schedule". */}
          <FeedbackWidget org={org} />

          {/* Lifetime time-saved tally — every Director action contributes. */}
          {timeSavedTotal != null && timeSavedTotal > 0 && (
            <div style={{ position: "relative", padding: "0 12px", marginBottom: 8 }}>
              <Link
                to="/admin/time-saved"
                title="See the full time-saved breakdown"
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  width: "100%",
                  boxSizing: "border-box",
                  textDecoration: "none",
                  background: "#fff",
                  border: `1px solid ${RULE}`,
                  borderRadius: 12,
                  padding: "12px 14px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span style={{
                  flexShrink: 0, marginTop: 1,
                  width: 18, height: 18, borderRadius: 999,
                  background: "#2e9e4f", color: "#fff",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 11, fontWeight: 700, lineHeight: 1,
                }}>✓</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                    Saved with Enrops
                  </div>
                  <div style={{ fontSize: 16, color: INK, fontWeight: 700, marginTop: 2 }}>
                    {Math.round(timeSavedTotal)}+ hours
                  </div>
                  <div style={{ fontSize: 10, color: MUTED, marginTop: 4 }}>
                    tap for breakdown
                  </div>
                </div>
              </Link>
            </div>
          )}

          <div style={{ padding: "12px 20px", borderTop: `1px solid ${RULE}`, fontSize: 12, color: MUTED }}>
            <div style={{ marginBottom: 10 }}>
              <PwaInstallButton />
            </div>
            <div style={{ marginBottom: 6, color: INK, fontWeight: 500 }}>{user?.email}</div>
            <div style={{ marginBottom: 10, textTransform: "capitalize" }}>{orgMember?.role ?? "member"}</div>
            <button onClick={signOut} style={{ ...btn("transparent", BRIGHT, true), padding: "5px 10px", fontSize: 12 }}>
              Sign out
            </button>
          </div>
        </aside>

        {/* Main */}
        <main data-admin-main style={{ padding: "28px 36px", maxWidth: 1200 }}>
          <AnnouncementBanner />
          {blockedItem ? (
            <div style={{ maxWidth: 460, margin: "40px auto 0", background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: PURPLE, marginBottom: 8 }}>
                {blockedItem.label} isn’t available for your role
              </div>
              <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: 0 }}>
                Your access is <strong style={{ textTransform: "capitalize" }}>{orgMember?.role ?? "member"}</strong>.
                Ask an owner or admin if you need access to {blockedItem.label.toLowerCase()}.
              </p>
              <Link to="/admin" style={{ ...btn(BRIGHT, "#fff"), marginTop: 18 }}>Back to Overview</Link>
            </div>
          ) : (
          <>
          {showSectionTabs && (
            <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 22 }}>
              {activeTabSection.tabs.filter((t) => !t.gate || perm.can(t.gate)).map((t) => {
                const tabActive =
                  location.pathname === t.to || location.pathname.startsWith(t.to + "/");
                // Registration vs outside-registration tenant: disable (don't hide)
                // the tab that doesn't apply, with a hover reason.
                const usesReg = org?.uses_enrops_registration !== false; // default true
                const disabled = (t.regOnly && !usesReg) || (t.outsideRegOnly && usesReg);
                if (disabled) {
                  return (
                    <span
                      key={t.to}
                      title={t.offReason || ""}
                      style={{
                        padding: "8px 14px",
                        borderBottom: "2px solid transparent",
                        color: `${MUTED}80`,
                        fontWeight: 500,
                        fontSize: 13,
                        position: "relative",
                        top: 1,
                        cursor: "not-allowed",
                      }}
                    >
                      {t.label}
                    </span>
                  );
                }
                return (
                  <Link
                    key={t.to}
                    to={t.to}
                    style={{
                      padding: "8px 14px",
                      borderBottom: tabActive ? `2px solid ${BRIGHT}` : "2px solid transparent",
                      color: tabActive ? BRIGHT : MUTED,
                      fontWeight: tabActive ? 700 : 500,
                      fontSize: 13,
                      textDecoration: "none",
                      position: "relative",
                      top: 1,
                    }}
                  >
                    {t.label}
                  </Link>
                );
              })}
            </div>
          )}
          {/* Admin pages are lazy-loaded per route (see App.jsx). This inner
              Suspense keeps the sidebar, header and tab strip on screen while
              the next page's chunk downloads — without it the app-level
              boundary would blank the whole shell on every nav click. */}
          <Suspense fallback={<RouteFallback />}>
            <Outlet context={{ user, org, orgMember }} />
          </Suspense>
          </>
          )}
        </main>
      </div>
    </div>
  );
}

function btn(bg, fg, outlined = false) {
  return {
    display: "inline-block",
    padding: "8px 14px",
    background: bg,
    color: fg,
    border: outlined ? `1px solid ${fg}` : "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    fontFamily: "inherit",
    textDecoration: "none",
  };
}
