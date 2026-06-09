// src/pages/admin/team/TeamPage.jsx
// Team management for the current org. Lists owners/admins and lets an
// owner or admin invite a new admin by email.
//
// Multi-tenant: reads org from useOutletContext, never hardcodes J2S. The
// invite + list endpoints derive the org from the caller's org_members row.

import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - primary actions (Figma)
const VIOLET = "#8C88FF";
const CREAM = "#FBFBFB";
const CORAL = "#D9694F";
const OK_GREEN = "#3a7c3a";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

export default function TeamPage() {
  const { user, org, orgMember } = useOutletContext() ?? {};
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("admin");
  const [sending, setSending] = useState(false);
  const [inviteError, setInviteError] = useState(null);
  const [inviteSuccess, setInviteSuccess] = useState(null);

  const canInvite = orgMember?.role === "owner" || orgMember?.role === "admin";
  const canMintOwner = orgMember?.role === "owner";

  useEffect(() => {
    if (!org?.id) return;
    fetchMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.id]);

  async function fetchMembers() {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await supabase.functions.invoke("admin-list-members", {
      body: {},
    });
    if (error) {
      console.error("list members failed:", error);
      setLoadError(error.message ?? "Failed to load team.");
      setLoading(false);
      return;
    }
    if (data?.error) {
      setLoadError(data.error);
      setLoading(false);
      return;
    }
    setMembers(data?.members ?? []);
    setLoading(false);
  }

  async function submitInvite(e) {
    e?.preventDefault?.();
    setInviteError(null);
    setInviteSuccess(null);
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError("Enter a valid email address.");
      return;
    }
    setSending(true);
    const { data, error } = await supabase.functions.invoke("admin-invite", {
      body: { email, role: inviteRole },
    });
    setSending(false);
    if (error) {
      console.error("admin-invite failed:", error);
      setInviteError(error.message ?? "Invite failed.");
      return;
    }
    if (data?.error) {
      setInviteError(
        data.detail
          ? `${data.error}: ${data.detail}`
          : data.error.replace(/_/g, " ")
      );
      // Still refresh the list — membership might have been created even if
      // the email send failed (502 email_send_failed branch).
      fetchMembers();
      return;
    }
    setInviteSuccess(
      data?.outcome === "added"
        ? `Invite sent to ${email}. They'll get a magic link.`
        : data?.outcome === "updated"
        ? `${email} updated to ${inviteRole}. Magic link sent.`
        : `Resent invite to ${email}.`
    );
    setInviteEmail("");
    setInviteRole("admin");
    fetchMembers();
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: PURPLE, margin: 0 }}>Team</h1>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 4 }}>
          Owners and admins for {org?.name ?? "this organization"}.
        </div>
      </div>

      {canInvite && (
        <div
          style={{
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 10,
            padding: 16,
            marginBottom: 18,
          }}
        >
          {!inviteOpen ? (
            <button
              type="button"
              onClick={() => {
                setInviteOpen(true);
                setInviteError(null);
                setInviteSuccess(null);
              }}
              style={primaryBtn()}
            >
              Invite admin
            </button>
          ) : (
            <form onSubmit={submitInvite}>
              <div style={{ fontWeight: 600, color: INK, marginBottom: 10 }}>
                Invite someone to this workspace
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 140px auto auto", gap: 8, alignItems: "center" }}>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="person@example.com"
                  autoFocus
                  required
                  style={inputStyle()}
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  style={inputStyle()}
                >
                  <option value="admin">Admin</option>
                  {canMintOwner && <option value="owner">Owner</option>}
                </select>
                <button type="submit" disabled={sending} style={primaryBtn(sending)}>
                  {sending ? "Sending…" : "Send invite"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setInviteOpen(false);
                    setInviteEmail("");
                    setInviteRole("admin");
                    setInviteError(null);
                  }}
                  style={ghostBtn()}
                >
                  Cancel
                </button>
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
                They'll get a magic link sign-in from {org?.name ?? "your"} Enrops workspace.
                {!canMintOwner && " Only owners can promote someone to owner."}
              </div>
              {inviteError && (
                <div style={{ color: CORAL, fontSize: 13, marginTop: 10 }}>{inviteError}</div>
              )}
            </form>
          )}
          {inviteSuccess && (
            <div style={{ color: OK_GREEN, fontSize: 13, marginTop: 12 }}>{inviteSuccess}</div>
          )}
        </div>
      )}

      {loadError && (
        <div style={{ color: CORAL, fontSize: 13, marginBottom: 12 }}>{loadError}</div>
      )}

      <div
        style={{
          background: "#fff",
          border: `1px solid ${RULE}`,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 140px 160px",
            padding: "10px 16px",
            background: CREAM,
            fontSize: 11,
            fontWeight: 600,
            color: MUTED,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          <div>Email</div>
          <div>Role</div>
          <div>Joined</div>
        </div>
        {loading ? (
          <div style={{ padding: 18, color: MUTED, fontSize: 14 }}>Loading…</div>
        ) : members.length === 0 ? (
          <div style={{ padding: 18, color: MUTED, fontSize: 14 }}>No team members yet.</div>
        ) : (
          members.map((m, i) => (
            <div
              key={m.id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 140px 160px",
                padding: "12px 16px",
                borderTop: i === 0 ? "none" : `1px solid ${RULE}`,
                alignItems: "center",
                fontSize: 14,
              }}
            >
              <div style={{ color: INK }}>
                {m.email ?? <span style={{ color: MUTED }}>(no email on auth user)</span>}
                {m.is_caller && (
                  <span style={{ color: MUTED, fontSize: 12, marginLeft: 8 }}>you</span>
                )}
              </div>
              <div style={{ textTransform: "capitalize", color: INK }}>{m.role ?? "—"}</div>
              <div style={{ color: MUTED, fontSize: 13 }}>
                {m.accepted_at ? formatDate(m.accepted_at) : <span style={{ color: VIOLET }}>Invite not accepted yet</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function primaryBtn(disabled = false) {
  return {
    display: "inline-block",
    padding: "9px 16px",
    background: disabled ? MUTED : PURPLE,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    fontWeight: 600,
    fontSize: 14,
    cursor: disabled ? "default" : "pointer",
    fontFamily: "inherit",
  };
}

function ghostBtn() {
  return {
    display: "inline-block",
    padding: "9px 14px",
    background: "transparent",
    color: BRIGHT,
    border: `1px solid ${BRIGHT}`,
    borderRadius: 6,
    fontWeight: 500,
    fontSize: 14,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

function inputStyle() {
  return {
    padding: "9px 12px",
    border: `1px solid ${RULE}`,
    borderRadius: 6,
    fontSize: 14,
    fontFamily: "inherit",
    color: INK,
    background: "#fff",
    minWidth: 0,
  };
}
