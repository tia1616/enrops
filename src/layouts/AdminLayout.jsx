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
import { PLATFORM_LEGAL_LINKS } from "../lib/policies.js";

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
    // Section home is Contacts (the CRM spine) — clicking the sidebar item
    // lands on your people first, not the campaign builder.
    to: "/admin/family-comms/contacts", label: "Comms",
    gate: "send",        // owner/admin/staff — a sending surface, hidden from viewer
    // Comms owns its own 4-tab strip (FamilyCommsTabs, rendered inside each
    // page: Contacts / Campaigns / Automations / Templates) instead of the
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

// Lean registration operators (instructor_pay_model === 'enrops_platform') run a
// registration-only surface — no instructors, curriculum library, or comms yet.
// Trim the sidebar to Home . Programs . Finances . Discounts . Settings and hide
// the paid / curriculum surfaces. Locations (the Partners surface) is a TAB
// under Programs for lean ops — they pick a venue every time they build a class,
// so it belongs beside the programs it serves and not in Settings, where it
// briefly lived. Any legacy_own_platform tenant (J2S) keeps the
// full nav — this returns the SAME array reference for them, so their path is
// unchanged. Empirically safe: every enrops_platform tenant on prod has zero
// instructors and zero programs, so nothing they use is being hidden.
function shapeNavForOrg(nav, org) {
  if (org?.instructor_pay_model !== "enrops_platform") return nav; // full nav (J2S etc.)
  const HIDE_TOP = new Set([
    "/admin",                        // Overview/dashboard — the free tier is
                                     // REGISTRATION ONLY ("nothing else lives
                                     // here"), so there is no dashboard to give
                                     // them. Programs is their home; /admin
                                     // redirects there (see AdminOverview).
    "/admin/team",                   // Extra admin seats. The checklist lists
                                     // "full seats" as a PRO unlock, and free is
                                     // registration + parent portal only — a
                                     // solo operator has nobody to invite, so
                                     // this is clutter until they upgrade. The
                                     // ROUTE still works, so any org that
                                     // already has a second admin keeps it.
    "/admin/schedule",               // Instructors (paid upgrade)
    "/admin/schools",                // Locations/Partners -> now a tab under
                                     // Programs (see the tabs block below), so
                                     // it stays off the top-level sidebar.
    "/admin/family-comms/contacts",  // Comms (paid upgrade)
    "/admin/community",              // Community (coming soon)
  ]);
  const out = [];
  for (const item of nav) {
    if (HIDE_TOP.has(item.to)) continue;
    if (item.to === "/admin/programs" && item.tabs) {
      // Drop the curriculum "Offerings" library and the afterschool custody log,
      // then add the venue surface as a tab. Locations/Calendars used to sit
      // under Settings for lean ops, which is where you put things you configure
      // once -- but a registration operator picks a location every time they
      // build a class, so it belongs beside the programs it serves, not in a
      // settings drawer. Calendars stays an inner tab of that page (it has no
      // route of its own; /admin/calendars just redirects to ?tab=calendars).
      // Label mirrors the page's own reframing, same rule as the sidebar item.
      out.push({
        ...item,
        tabs: [
          ...item.tabs.filter((t) => t.to !== "/admin/curricula" && t.to !== "/admin/class-reports"),
          { to: "/admin/schools", label: org?.venue_model === "own_venue" ? "Locations" : "Partners" },
        ],
      });
      continue;
    }
    if (item.to === "/admin/finances" && item.tabs) {
      // "Money" reads as "Payments" for lean ops. Drop the whole
      // Receivables/Payouts tab strip (Payouts is instructor payroll; a lean op
      // has none, and Stripe payout history lives in their Stripe dashboard), so
      // it's one clean page. Discounts is promoted to its own top-level item.
      const { tabs: _drop, ...rest } = item;
      void _drop;
      out.push({ ...rest, label: "Payments" });
      out.push({ to: "/admin/discounts", label: "Discounts", gate: "viewMoney" });
      continue;
    }
    // NOTE: Settings no longer claims /admin/schools in its `match` list. That
    // existed only to keep Settings lit while the venue surface was reached
    // from there; now it is a Programs tab, so Programs owns the highlight and
    // two nav items lighting at once would be a lie about where you are.
    out.push(item);
  }
  return out;
}

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
  const [authState, setAuthState] = useState("loading"); // loading | unauthorized | org_load_failed | ready
  const [user, setUser] = useState(null);
  const [orgMember, setOrgMember] = useState(null);
  const [org, setOrg] = useState(null);
  // Lifetime time-saved tally (rolling sum of time_saved_events for this org).
  // See project_enrops_time_saved memory: every Director action that completes
  // work for the operator inserts a row; this is the always-on receipt.
  const [timeSavedTotal, setTimeSavedTotal] = useState(null);
  const [timeSavedRecent, setTimeSavedRecent] = useState([]);
  const [tallyOpen, setTallyOpen] = useState(false);
  // Mobile menu. Desktop ignores this entirely — the sidebar is always shown
  // there and the button that toggles this is display:none above 900px.
  const [navOpen, setNavOpen] = useState(false);
  // Tapping a destination should take you there, not leave the menu covering
  // the page you just asked for.
  useEffect(() => { setNavOpen(false); }, [location.pathname]);

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

        // Look up the org_members row for this auth user.
        //
        // .limit(1) is load-bearing, not decorative. A bare .maybeSingle()
        // ERRORS when more than one row matches, and a user may legitimately be
        // staff at one org and admin at another (only OWNER-membership is capped
        // at one - see 20260724a_owner_org_unique_index.sql). Without the limit,
        // such a user gets an "unauthorized" screen despite valid memberships.
        //
        // ?org=<id> is a LANDING HINT, not an access rule. stripe-oauth-callback
        // appends it so the operator returns to the org they just connected
        // rather than whichever row sorted first. It is deliberately NOT
        // authorization: the query is still scoped to this user's own
        // memberships, so an org id they don't belong to simply finds nothing -
        // and when that happens we fall back to their default org instead of
        // locking them out of their own admin over a query string.
        const orgParam = new URLSearchParams(location.search).get("org");

        // ACCEPTED ONLY, and DETERMINISTIC. Both matter and neither is cosmetic:
        //
        // Filtering accepted_at here is not a duplicate of the accepted_at check
        // below - it decides WHICH row .limit(1) gets to return. Without it, a
        // user who is accepted at org A and merely INVITED to org B could have
        // the org B row selected (row order is arbitrary without ORDER BY), fail
        // the check below, and be told "unauthorized" for an org they have every
        // right to. The check below STAYS as a belt-and-braces guard; a filter is
        // not a substitute for validating what came back.
        //
        // ORDER BY makes the choice repeatable instead of leaving it to whatever
        // the planner returns first: same user, same page, same org, every load.
        // Oldest accepted membership wins, which is the closest thing to "their
        // primary org". Tie-break on id so the order is total. Both columns are
        // already in the select, so nothing here assumes a column exists.
        const loadMembership = (orgId) => {
          let q = supabase
            .from("org_members")
            .select("id, role, organization_id, accepted_at")
            .eq("auth_user_id", session.user.id)
            .not("accepted_at", "is", null);
          if (orgId) q = q.eq("organization_id", orgId);
          return q
            .order("accepted_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(1)
            .maybeSingle();
        };

        let { data: memberRow, error: memErr } = await loadMembership(orgParam);
        if (orgParam && !memErr && !memberRow) {
          // The hint pointed at an org this user has no ACCEPTED membership in
          // (wrong org, or an invite they never accepted). Either way it is not
          // somewhere we can land them, so ignore the hint rather than lock them
          // out of their own admin over a query string.
          ({ data: memberRow, error: memErr } = await loadMembership(null));
        }

        console.log("org_members query:", { memberRow, memErr, uid: session.user.id });

        if (!mounted) return;
        if (memErr || !memberRow || !memberRow.accepted_at) {
          setAuthState("unauthorized");
          return;
        }
        setOrgMember(memberRow);

        // Fetch org name + branding (display only — does not gate access)
        //
        // The error is CAPTURED, not discarded. Every admin page reads `org` from
        // the outlet context and most early-return on a falsy org.id, so handing
        // them a null org while declaring authState 'ready' produces pages that
        // render their shell and then sit there — the Payments screen showed a
        // permanent "Checking with Stripe for the details…" this way, with no
        // error and nothing to retry. A shell we cannot populate is a failure, so
        // say so instead of pretending we are ready.
        const { data: orgRow, error: orgFetchErr } = await supabase
          .from("organizations")
          // stripe_charges_enabled rides along so any admin surface can tell the
          // truth about whether this org can actually take money yet (a program
          // can be "open for registration" while payments have nowhere to land).
          // The onboarding answers ride along too: they decide which fields the
          // program builder shows, so every surface that reads `org` from the
          // outlet can adapt without its own query.
          // fee_pass_through rides along so money screens can say which
          // direction the service fee moves. Getting this wrong by defaulting
          // would tell a provider they're absorbing a fee their families are
          // actually paying, which is the opposite of the truth.
          .select("id, name, slug, email, active_registration_term, uses_enrops_registration, venue_model, background_check_config, instructor_pay_model, stripe_charges_enabled, fee_pass_through, venue_answer, program_cadence, default_age_min, default_age_max, onboarding_completed_at")
          .eq("id", memberRow.organization_id)
          .maybeSingle();
        if (!mounted) return;
        if (orgFetchErr || !orgRow) {
          // Membership is valid (proved above), so this is NOT an authorization
          // problem — it is a load failure, and it must not be reported as
          // "you don't have access". Distinct state, distinct message.
          console.error("AdminLayout: org load failed", { orgFetchErr, orgId: memberRow.organization_id });
          setAuthState("org_load_failed");
          return;
        }
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

  // Membership checked out but the org row would not load. Deliberately NOT the
  // "you need to sign in with an admin account" screen: they ARE an admin, and
  // telling them otherwise sends them to re-authenticate against a problem that
  // is on our side. Retry is the only useful action, so offer exactly that.
  if (authState === "org_load_failed") {
    return (
      <div style={{ minHeight: "100vh", background: CREAM, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Poppins', system-ui, sans-serif", padding: 24 }}>
        <div style={{ maxWidth: 440, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 32 }}>
          <div style={{ fontFamily: "'Poppins', system-ui, sans-serif", fontWeight: 700, fontSize: 22, color: PURPLE, marginBottom: 8 }}>
            Enrops Admin
          </div>
          <p style={{ color: INK, fontSize: 15, lineHeight: 1.5, marginTop: 0 }}>
            We couldn't load your business details just now. Nothing is wrong with your
            account — this is on our side.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, background: PURPLE, color: "#fff", border: "none", borderRadius: 6, padding: "9px 16px", fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
          >
            Try again
          </button>
        </div>
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
          {/* The raw "Debug (temporary)" panel that used to render here (uid,
              memErr, memberRow JSON) was visible to ANYONE who reached /admin
              without access — including a parent who just typed the URL. It
              leaked a user UUID and internal error text and read as broken.
              The same details still go to the console above for debugging. */}
        </div>
      </div>
    );
  }

  // Which tabbed section (if any) the current route belongs to, and whether to
  // show its in-page tab strip — only on the tab root pages, not deep sub-flows
  // like /admin/curricula/:id/review.
  const perm = getPermissions(orgMember?.role);
  // Shape the nav for this org (lean for enrops_platform, full for J2S/legacy),
  // then apply the role-permission filter. Using navItems everywhere below keeps
  // the sidebar, the route guard, and the tab strip in sync.
  const navItems = shapeNavForOrg(NAV, org);
  const visibleNav = navItems.filter((it) => !it.gate || perm.can(it.gate));
  // Route guard: if the current path is under a gated section the user can't
  // access, block it (covers direct-URL navigation, not just nav hiding).
  const blockedItem = navItems.find(
    (it) => it.gate && !perm.can(it.gate) && navItemActive(it, location.pathname)
  );

  const activeTabSection = navItems.find(
    (it) => it.tabs && it.tabs.some((t) => location.pathname === t.to || location.pathname.startsWith(t.to + "/"))
  );
  const showSectionTabs =
    activeTabSection && activeTabSection.tabs.some((t) => location.pathname === t.to);

  // Page column: sidebar+content grid on top, legal footer underneath it. The
  // footer is a PAGE footer - it must span the full width below both the sidebar
  // and the content, not hang off the bottom of the middle column
  // (Jessica, 2026-07-31).
  return (
    <div style={{ minHeight: "100vh", background: CREAM, fontFamily: "'Poppins', system-ui, sans-serif", color: INK, display: "flex", flexDirection: "column" }}>
      {/* MOBILE ADMIN. The shell is a hard 240px sidebar + content grid, which on a
          375px phone left ~135px for the page (minus 72px padding = ~63px usable)
          — the admin was effectively unusable on a phone. Operators build programs
          on their phones, so this matters as much as the parent flow.
          Below 900px the sidebar becomes a horizontal, scrollable top bar and the
          content takes the full width. Done in CSS with !important because every
          style here is an inline style prop, which a normal rule can't override.
          The active-item accent moves from a left border (meaningless in a row) to
          the white pill + colour it already carries. */}
      <style>{`
        /* Desktop keeps the sidebar; the mobile bar only exists under 900px. */
        [data-admin-mobilebar] { display: none; }

        @media (max-width: 900px) {
          [data-admin-grid] { grid-template-columns: 1fr !important; }

          /* A menu button, not a scrolling strip.
             The first pass at mobile turned the sidebar into a horizontally
             scrollable row of links, which fixed "unusable" but isn't how a
             phone menu works — items sit off-screen with nothing to say they
             exist, and you have to swipe a strip to find "Settings". Standard
             behaviour is a menu button that opens the whole list, so that's
             what this is. */
          [data-admin-mobilebar] {
            display: flex !important;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 14px;
            background: ${LAVENDER};
            border-bottom: 1px solid ${RULE};
            position: sticky;
            top: 0;
            z-index: 40;
          }

          /* Closed by default; the button reveals it as a full-width panel. */
          [data-admin-sidebar] {
            display: none !important;
          }
          [data-admin-sidebar][data-open="true"] {
            display: flex !important;
            position: static !important;
            height: auto !important;
            padding: 8px 0 14px !important;
            border-right: none !important;
            border-bottom: 1px solid ${RULE} !important;
          }
          /* The wordmark and org name already sit in the bar above. */
          [data-admin-sidebar] > div:first-child { display: none !important; }
          [data-admin-sidebar] nav a { border-left: none !important; }

          [data-admin-main] { padding: 16px 14px !important; max-width: 100% !important; }
          /* The footer left <main>, so it no longer inherits main's mobile
             padding - match it, or the links sit flush against the edge. */
          [data-admin-footer] { padding: 14px !important; }

          /* ROOT CAUSE of admin pages being wider than the phone: a flex or grid
             child defaults to min-width:auto, which refuses to shrink below its
             own content. One long row of buttons or an unbreakable string then
             sets the page's minimum width and pushes everything else off the
             right edge — which is why enrollment numbers were disappearing.
             min-width:0 lets those children actually shrink so text wraps.
             Applied only under 900px, so desktop layout is untouched.
             The grid items THEMSELVES need it too, not just their contents:
             a 1fr track can never be narrower than its item's min-content, so
             main's own min-width:auto was sizing the column at 384px on a
             375px phone and dragging the whole page 10px sideways. */
          [data-admin-main], [data-admin-sidebar] { min-width: 0 !important; }
          [data-admin-main] * { min-width: 0; }
          [data-admin-main] img { max-width: 100%; height: auto; }
          /* Anything genuinely too wide to wrap (a data table) scrolls inside
             its own box rather than dragging the whole page sideways. */
          [data-admin-main] table { display: block; width: 100%; overflow-x: auto; }

          /* iOS Safari zooms the entire page in when you focus a field whose
             text is under 16px, and every admin control is styled inline at
             13-14px — so editing a program on a phone lurched on every single
             field (21 of them in one expanded panel). One rule beats chasing
             the inline styles page by page, and it can't miss a page we
             haven't looked at yet. Mobile only; desktop keeps its denser type.
             Measured at 375px: no page gets wider from the larger text. */
          [data-admin-main] input,
          [data-admin-main] select,
          [data-admin-main] textarea { font-size: 16px !important; }
        }
      `}</style>
      {/* Mobile bar: wordmark, who you're signed in as, and the menu button.
          Hidden entirely on desktop, where the sidebar is always visible. */}
      <div data-admin-mobilebar>
        <div style={{ minWidth: 0 }}>
          <EnropsWordmark height={22} />
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            Admin · {org?.name ?? "—"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setNavOpen((v) => !v)}
          aria-expanded={navOpen}
          aria-controls="admin-nav"
          aria-label={navOpen ? "Close menu" : "Open menu"}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            background: navOpen ? BRIGHT : "#fff",
            color: navOpen ? "#fff" : INK,
            border: `1px solid ${navOpen ? BRIGHT : RULE}`,
            borderRadius: 8, padding: "9px 13px", cursor: "pointer",
            fontFamily: "inherit", fontSize: 14, fontWeight: 600,
            // 44px is the minimum comfortable touch target.
            minHeight: 44,
          }}
        >
          <span aria-hidden="true" style={{ display: "inline-flex", flexDirection: "column", gap: 3.5 }}>
            <span style={{ display: "block", width: 17, height: 2, borderRadius: 2, background: "currentColor" }} />
            <span style={{ display: "block", width: 17, height: 2, borderRadius: 2, background: "currentColor" }} />
            <span style={{ display: "block", width: 17, height: 2, borderRadius: 2, background: "currentColor" }} />
          </span>
          Menu
        </button>
      </div>

      {/* `flex: 1` rather than `minHeight: 100vh`: the grid takes the space left
          over above the footer, so on a short page the footer lands at the
          bottom of the viewport instead of directly under the content, and the
          sidebar still runs the full height of the grid. */}
      <div data-admin-grid style={{ display: "grid", gridTemplateColumns: "240px 1fr", flex: "1 0 auto" }}>
        {/* Sidebar */}
        <aside data-admin-sidebar id="admin-nav" data-open={navOpen ? "true" : "false"} style={{
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
              bars like marketing's "Approve & schedule". Removed 2026-07-24,
              restored 2026-07-27 at Jessica's request. */}
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
          {/* The starter cancellation-policy notice used to sit here, in the
              shell, so it appeared above every admin page. That was the bug:
              a disclosure with nothing to do with the screen you were on read
              as an interruption, and it followed you everywhere until you
              answered it (Jessica, 2026-07-30). The same disclosure now lives
              in the program wizards, next to the waivers, where the operator
              is already looking at what families will see. */}
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
                // A tab that can never apply to this tenant is HIDDEN, not shown
                // greyed out. The old "disabled + hover reason" pattern meant an
                // operator who runs registration through Enrops permanently saw a
                // dead "Class schedule" tab (and vice versa) — a control that can
                // never do anything is just noise, and the hover reason is
                // invisible on a phone anyway. The PAGE and its route stay, so the
                // tenants it does apply to are unaffected.
                const usesReg = org?.uses_enrops_registration !== false; // default true
                const notApplicable = (t.regOnly && !usesReg) || (t.outsideRegOnly && usesReg);
                if (notApplicable) return null;
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
            {/* setOrg is exposed so a page that CHANGES the org can correct the
                shell's copy immediately. Without it, renaming the page address
                left every other surface — the share link, the embed snippet —
                handing out the old address until a full reload, and a second
                rename in the same session did nothing at all because the page
                still believed the old slug was current. */}
            <Outlet context={{ user, org, orgMember, setOrg }} />
          </Suspense>
          </>
          )}

        </main>
      </div>

      {/* The operator app had NO legal footer at all. That was survivable
          until the advertising pixel loaded site-wide: CCPA/CPRA requires a
          clear, always-available way to stop the sharing it performs, and
          the published Cookie Disclosure and Privacy Policy both promise
          "the link on our site". PLATFORM_LEGAL_LINKS only renders in
          PublicLayout, so operators had no standing route to it.

          Deliberately quiet and at the very bottom - it is a legal
          affordance, not navigation, and must not compete with the
          operator's actual work.

          OUTSIDE the grid, not inside <main>. Inside, it inherited the content
          column's width and sat directly under whatever the page happened to
          end with - on a short page that is halfway up an empty screen, reading
          as part of the page rather than the bottom of it. A legal footer is
          page furniture: full width, under the sidebar too, always last. */}
      <footer
        data-admin-footer
        style={{
          padding: "14px 36px",
          borderTop: `1px solid ${RULE}`,
          fontSize: 12,
          color: MUTED,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          // Never absorbed by the grid growing above it.
          flexShrink: 0,
        }}
      >
        {PLATFORM_LEGAL_LINKS.map((l) => (
          <Link key={l.to} to={l.to} style={{ color: MUTED, textDecoration: "none" }}>
            {l.label}
          </Link>
        ))}
      </footer>
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
