// src/layouts/AdminLayout.jsx
// Shell for the Enrops admin portal. Sidebar nav + content area.
// All admin pages render inside <Outlet />. Enrops chrome (Plum/Gold/Chalk).
// Multi-tenant: never hardcodes J2S. Reads org from logged-in user's org_members row.

import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

// Enrops brand tokens
const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

const NAV = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/marketing", label: "Marketing" },
  { to: "/admin/programs", label: "Programs", soon: true },
  { to: "/admin/contacts", label: "Contacts", soon: true },
  { to: "/admin/instructors", label: "Instructors", soon: true },
  { to: "/admin/schedule", label: "Schedule", soon: true },
  { to: "/admin/community", label: "Community", external: true, href: "#" },
  { to: "/admin/settings", label: "Settings", soon: true },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const [authState, setAuthState] = useState("loading"); // loading | unauthorized | ready
  const [user, setUser] = useState(null);
  const [orgMember, setOrgMember] = useState(null);
  const [org, setOrg] = useState(null);
  const [debugInfo, setDebugInfo] = useState(null);

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
        <aside style={{ background: "#fff", borderRight: `1px solid ${RULE}`, padding: "20px 0", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "0 20px 18px", borderBottom: `1px solid ${RULE}` }}>
            <div style={{ fontWeight: 700, fontSize: 22, color: PLUM, letterSpacing: -0.3 }}>
              Enrops
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
              Admin · {org?.name ?? "—"}
            </div>
          </div>

          <nav style={{ padding: "12px 8px", flex: 1 }}>
            {NAV.map((item) => item.external ? (
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
            ))}}
          </nav>

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
