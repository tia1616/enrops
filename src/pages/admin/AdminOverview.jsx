// src/pages/admin/AdminOverview.jsx
// Default landing for /admin. Placeholder cards for the surfaces being built.

import { Link, useOutletContext } from "react-router-dom";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

export default function AdminOverview() {
  const { org, user } = useOutletContext() ?? {};

  return (
    <div>
      <header style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, color: INK, margin: 0, letterSpacing: -0.5 }}>
          Welcome back{user?.email ? `, ${user.email.split("@")[0]}` : ""}.
        </h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 15 }}>
          {org?.name ? `Operating as ${org.name}.` : "Admin overview."}
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <Card
          title="Marketing"
          body="Preview, schedule, and send campaigns."
          to="/admin/marketing-v2"
          cta="Open Marketing"
          ready
        />
        <Card
          title="Contacts"
          body="Instructors, partners, parents. Send onboarding invites, view rosters, upload prior background checks."
          to="/admin/contacts"
          cta="Open Contacts"
          ready
        />
        <Card
          title="Schedule"
          body="Assign instructors to camps and afterschool classes. Manage offers, archive past cycles."
          to="/admin/schedule"
          cta="Open Schedule"
          ready
        />
        <Card
          title="Programs"
          body="Curricula, scheduled programs, locations."
          to="/admin/curricula"
          cta="Open Programs"
          ready
        />
        <Card
          title="Settings"
          body="Org branding, sending domain, payout setup, members & roles."
          soon
        />
      </div>
    </div>
  );
}

function Card({ title, body, to, cta, ready, soon }) {
  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderRadius: 8,
      padding: 20,
      display: "flex",
      flexDirection: "column",
      minHeight: 150,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ fontSize: 17, fontWeight: 600, color: INK, margin: 0 }}>{title}</h2>
        {soon && (
          <span style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
            Coming soon
          </span>
        )}
        {ready && (
          <span style={{ fontSize: 10, color: PLUM, background: `${GOLD}33`, padding: "2px 8px", borderRadius: 999, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
            Live
          </span>
        )}
      </div>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.5, margin: "0 0 14px", flex: 1 }}>{body}</p>
      {ready && to && (
        <Link to={to} style={{
          display: "inline-block",
          padding: "7px 14px",
          background: PLUM,
          color: "#fff",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          textDecoration: "none",
          alignSelf: "flex-start",
        }}>
          {cta}
        </Link>
      )}
    </div>
  );
}
