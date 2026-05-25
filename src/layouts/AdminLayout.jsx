// src/layouts/AdminLayout.jsx
// Shell for the Enrops admin portal. Sidebar nav + content area.
// All admin pages render inside <Outlet />. Enrops chrome (Plum/Gold/Chalk).
// Multi-tenant: never hardcodes J2S. Reads org from logged-in user's org_members row.

import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// Enrops brand tokens
const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

// Top-level nav. Items with `children` render as expandable groups (the parent
// label is not itself a route — clicking toggles the group; child routes do
// the navigating). A group auto-expands when any of its children is active.
const NAV = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/marketing", label: "Marketing" },
  { to: "/admin/marketing-v2", label: "Marketing v2" },
  {
    label: "Programs",
    group: "programs",
    children: [
      { to: "/admin/curricula", label: "Curricula" },
      { to: "/admin/programs", label: "Scheduled programs" },
      { to: "/admin/locations", label: "Locations" },
    ],
  },
  { to: "/admin/instructors", label: "Instructors" },
  { to: "/admin/contacts", label: "Contacts" },
  { to: "/admin/schedule", label: "Schedule" },
  { to: "/admin/community", label: "Community", soon: true },
  { to: "/admin/settings", label: "Settings", soon: true },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [authState, setAuthState] = useState("loading"); // loading | unauthorized | ready
  const [user, setUser] = useState(null);
  const [orgMember, setOrgMember] = useState(null);
  const [org, setOrg] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);
  const [openGroups, setOpenGroups] = useState(() => new Set());
  // Lifetime time-saved tally (rolling sum of time_saved_events for this org).
  // See project_enrops_time_saved memory: every Director action that completes
  // work for the operator inserts a row; this is the always-on receipt.
  const [timeSavedTotal, setTimeSavedTotal] = useState(null);
  const [timeSavedRecent, setTimeSavedRecent] = useState([]);
  const [tallyOpen, setTallyOpen] = useState(false);

  // Groups whose child route is currently active are forced open regardless of toggle state.
  const activeGroupKeys = useMemo(() => {
    const active = new Set();
    for (const item of NAV) {
      if (item.children && item.children.some((c) => location.pathname.startsWith(c.to))) {
        active.add(item.group);
      }
    }
    return active;
  }, [location.pathname]);

  function toggleGroup(key) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

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
          .select("id, name, slug")
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
      <div style={{ minHeight: "100vh", background: CHALK, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Space Grotesk', system-ui, sans-serif", color: MUTED }}>
        Loading admin…
      </div>
    );
  }

  if (authState === "unauthorized") {
    return (
      <div style={{ minHeight: "100vh", background: CHALK, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: 24 }}>
        <div style={{ maxWidth: 440, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, padding: 32 }}>
          <div style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", fontWeight: 700, fontSize: 22, color: PLUM, marginBottom: 8 }}>
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
            <Link to="/admin/login" style={btn(PLUM, "#fff")}>Sign in</Link>
            {user && <button onClick={signOut} style={btn("transparent", PLUM, true)}>Sign out</button>}
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

  return (
    <div style={{ minHeight: "100vh", background: CHALK, fontFamily: "'Space Grotesk', system-ui, sans-serif", color: INK }}>
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "100vh" }}>
        {/* Sidebar */}
        <aside style={{
          background: "#fff",
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
            <div style={{ fontWeight: 700, fontSize: 22, color: PLUM, letterSpacing: -0.3 }}>
              Enrops
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
              Admin · {org?.name ?? "—"}
            </div>
          </div>

          <nav style={{ padding: "12px 8px", flex: 1 }}>
            {NAV.map((item) => {
              if (item.children) {
                const isOpen = openGroups.has(item.group) || activeGroupKeys.has(item.group);
                return (
                  <div key={item.group}>
                    <button
                      onClick={() => toggleGroup(item.group)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        width: "100%", padding: "9px 12px", margin: "1px 0", borderRadius: 6,
                        fontSize: 14, fontWeight: 500, color: INK,
                        background: "transparent", border: "none", cursor: "pointer",
                        fontFamily: "inherit", textAlign: "left",
                      }}
                    >
                      <span>{item.label}</span>
                      <span style={{ fontSize: 10, color: MUTED, transition: "transform 0.15s", transform: isOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▸</span>
                    </button>
                    {isOpen && item.children.map((child) => (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        end={child.end}
                        style={({ isActive }) => ({
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          padding: "7px 12px 7px 26px",
                          margin: "1px 0",
                          borderRadius: 6,
                          fontSize: 13,
                          fontWeight: isActive ? 600 : 500,
                          color: isActive ? PLUM : (child.soon ? MUTED : INK),
                          background: isActive ? `${GOLD}22` : "transparent",
                          textDecoration: "none",
                          cursor: child.soon ? "default" : "pointer",
                          pointerEvents: child.soon ? "none" : "auto",
                        })}
                      >
                        <span>{child.label}</span>
                        {child.soon && (
                          <span style={{ fontSize: 10, color: MUTED, fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            soon
                          </span>
                        )}
                      </NavLink>
                    ))}
                  </div>
                );
              }
              return item.external ? (
                <a
                  key={item.to}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "9px 12px", margin: "1px 0", borderRadius: 6,
                    fontSize: 14, fontWeight: 500, color: INK,
                    background: "transparent", textDecoration: "none",
                  }}
                >
                  <span>{item.label}</span>
                  <span style={{ fontSize: 10, color: MUTED }}>↗</span>
                </a>
              ) : (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  style={({ isActive }) => ({
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "9px 12px",
                    margin: "1px 0",
                    borderRadius: 6,
                    fontSize: 14,
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? PLUM : (item.soon ? MUTED : INK),
                    background: isActive ? `${GOLD}22` : "transparent",
                    textDecoration: "none",
                    cursor: item.soon ? "default" : "pointer",
                    pointerEvents: item.soon ? "none" : "auto",
                  })}
                >
                  <span>{item.label}</span>
                  {item.soon && (
                    <span style={{ fontSize: 10, color: MUTED, fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      soon
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>

          {/* Lifetime time-saved tally — every Director action contributes. */}
          {timeSavedTotal != null && timeSavedTotal > 0 && (
            <div style={{ position: "relative", padding: "0 12px", marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setTallyOpen((v) => !v)}
                title="Click for the breakdown"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "rgba(78, 145, 78, 0.12)",
                  border: "1px solid rgba(78, 145, 78, 0.35)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ fontSize: 10, color: "#2d5a2d", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
                  Saved with Enrops
                </div>
                <div style={{ fontSize: 16, color: "#2d5a2d", fontWeight: 700, marginTop: 2 }}>
                  ⏱ {Math.round(timeSavedTotal)}+ hours
                </div>
                <div style={{ fontSize: 10, color: MUTED, marginTop: 4 }}>
                  {tallyOpen ? "tap to close" : "tap for breakdown"}
                </div>
              </button>
              {tallyOpen && (
                <div style={{
                  position: "absolute",
                  bottom: "calc(100% + 6px)",
                  left: 12,
                  right: 12,
                  background: "#fff",
                  border: `1px solid ${RULE}`,
                  borderRadius: 8,
                  padding: 14,
                  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15)",
                  zIndex: 50,
                }}>
                  <div style={{ color: PLUM, fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
                    Saved you {Math.round(timeSavedTotal)}+ hours
                  </div>
                  <div style={{ color: MUTED, fontSize: 11, marginBottom: 10 }}>
                    Lifetime · last 5 actions
                  </div>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12, lineHeight: 1.45 }}>
                    {timeSavedRecent.length === 0 && (
                      <li style={{ color: MUTED }}>No actions logged yet.</li>
                    )}
                    {timeSavedRecent.map((ev, i) => (
                      <li key={i} style={{ display: "flex", justifyContent: "space-between", gap: 6, padding: "5px 0", borderBottom: i < timeSavedRecent.length - 1 ? `1px solid ${RULE}` : "none" }}>
                        <span style={{ flex: 1, color: INK }}>
                          <strong style={{ color: "#2d5a2d" }}>+{Math.round(Number(ev.hours_saved))} hr</strong> · {ev.action_label}
                        </span>
                        <span style={{ color: MUTED, fontSize: 10, whiteSpace: "nowrap" }}>{relativeTime(ev.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div style={{ padding: "12px 20px", borderTop: `1px solid ${RULE}`, fontSize: 12, color: MUTED }}>
            <div style={{ marginBottom: 6, color: INK, fontWeight: 500 }}>{user?.email}</div>
            <div style={{ marginBottom: 10, textTransform: "capitalize" }}>{orgMember?.role ?? "member"}</div>
            <button onClick={signOut} style={{ ...btn("transparent", PLUM, true), padding: "5px 10px", fontSize: 12 }}>
              Sign out
            </button>
          </div>
        </aside>

        {/* Main */}
        <main style={{ padding: "28px 36px", maxWidth: 1200 }}>
          <Outlet context={{ user, org, orgMember }} />
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
