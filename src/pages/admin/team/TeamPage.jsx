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

  // Per-row member-management state.
  const [busyId, setBusyId] = useState(null);          // member id currently updating
  const [confirmRemoveId, setConfirmRemoveId] = useState(null);
  const [rowError, setRowError] = useState(null);      // { id, message }

  const canManage = orgMember?.role === "owner" || orgMember?.role === "admin";
  const canInvite = canManage;
  const canMintOwner = orgMember?.role === "owner";

  // A member row is editable when the caller can manage the team, it isn't their
  // own row, and — for owner rows / promoting to owner — the caller is an owner.
  function canEditMember(m) {
    if (!canManage || m.is_caller) return false;
    if (m.role === "owner" && !canMintOwner) return false;
    return true;
  }

  // Role options the caller may assign to a given member (owner only if owner).
  function roleOptionsFor(m) {
    const base = ["admin", "staff", "viewer"];
    if (canMintOwner || m.role === "owner") base.unshift("owner");
    return base;
  }

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

  // Map backend error codes to plain language (no codes shown to operators).
  function friendlyError(code) {
    switch (code) {
      case "last_owner":
        return "This is the only owner — promote someone else to owner first.";
      case "forbidden":
        return "Only an owner can change or remove an owner.";
      case "cannot_change_self":
      case "cannot_remove_self":
        return "You can't change your own access — ask another admin or the owner.";
      case "member_not_found":
        return "That person is no longer on the team — refreshing the list.";
      default:
        return "Something went wrong. Please try again.";
    }
  }

  async function changeRole(member, nextRole) {
    if (nextRole === member.role) return;
    setRowError(null);
    setBusyId(member.id);
    const { data, error } = await supabase.functions.invoke("admin-set-member-role", {
      body: { member_id: member.id, role: nextRole },
    });
    setBusyId(null);
    if (error || data?.error) {
      setRowError({ id: member.id, message: friendlyError(data?.error) });
      fetchMembers();
      return;
    }
    fetchMembers();
  }

  async function removeMember(member) {
    setRowError(null);
    setBusyId(member.id);
    const { data, error } = await supabase.functions.invoke("admin-remove-member", {
      body: { member_id: member.id },
    });
    setBusyId(null);
    setConfirmRemoveId(null);
    if (error || data?.error) {
      setRowError({ id: member.id, message: friendlyError(data?.error) });
      fetchMembers();
      return;
    }
    fetchMembers();
  }

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: PURPLE, margin: 0 }}>Team</h1>
        <div style={{ color: MUTED, fontSize: 14, marginTop: 4 }}>
          Everyone who can access {org?.name ?? "this organization"}'s workspace, and what they can do.
        </div>
      </div>

      {canInvite && (
        <div
          style={{
            background: "#fff",
            border: `1px solid ${RULE}`,
            borderRadius: 12,
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
                  <option value="staff">Staff</option>
                  <option value="viewer">Viewer</option>
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
              <div style={{ fontSize: 12, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>
                They'll get a magic-link sign-in from {org?.name ?? "your"} Enrops workspace.
                <br />
                <strong>Admin</strong> — everything, including money &amp; settings.{" "}
                <strong>Staff</strong> — run programs, rosters &amp; emails (no money or settings).{" "}
                <strong>Viewer</strong> — read-only, can't see money.
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
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 150px 130px 150px",
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
          <div />
        </div>
        {loading ? (
          <div style={{ padding: 18, color: MUTED, fontSize: 14 }}>Loading…</div>
        ) : members.length === 0 ? (
          <div style={{ padding: 18, color: MUTED, fontSize: 14 }}>No team members yet.</div>
        ) : (
          members.map((m, i) => {
            const editable = canEditMember(m);
            const isBusy = busyId === m.id;
            return (
              <div key={m.id} style={{ borderTop: i === 0 ? "none" : `1px solid ${RULE}` }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 150px 130px 150px",
                    padding: "12px 16px",
                    alignItems: "center",
                    fontSize: 14,
                  }}
                >
                  <div style={{ color: INK }}>
                    {m.email ?? <span style={{ color: MUTED }}>(no email on file)</span>}
                    {m.is_caller && (
                      <span style={{ color: MUTED, fontSize: 12, marginLeft: 8 }}>you</span>
                    )}
                  </div>

                  <div>
                    {editable ? (
                      <select
                        value={m.role}
                        disabled={isBusy}
                        onChange={(e) => changeRole(m, e.target.value)}
                        style={{ ...inputStyle(), padding: "6px 8px", width: "100%" }}
                      >
                        {roleOptionsFor(m).map((r) => (
                          <option key={r} value={r}>
                            {r.charAt(0).toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span style={roleBadge(m.role)}>{m.role ?? "—"}</span>
                    )}
                  </div>

                  <div style={{ color: MUTED, fontSize: 13 }}>
                    {m.accepted_at ? formatDate(m.accepted_at) : "—"}
                  </div>

                  <div style={{ textAlign: "right" }}>
                    {editable && (
                      confirmRemoveId === m.id ? (
                        <span style={{ fontSize: 13 }}>
                          <span style={{ color: MUTED, marginRight: 8 }}>Remove?</span>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => removeMember(m)}
                            style={linkBtn(CORAL)}
                          >
                            {isBusy ? "Removing…" : "Yes"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRemoveId(null)}
                            style={linkBtn(MUTED)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => { setRowError(null); setConfirmRemoveId(m.id); }}
                          style={linkBtn(CORAL)}
                        >
                          Remove
                        </button>
                      )
                    )}
                  </div>
                </div>

                {rowError?.id === m.id && (
                  <div style={{ padding: "0 16px 12px", color: CORAL, fontSize: 13 }}>
                    {rowError.message}
                  </div>
                )}
              </div>
            );
          })
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

// Colored pill for a non-editable role cell.
function roleBadge(role) {
  const colors = {
    owner: { bg: "#EDE7FB", fg: PURPLE },
    admin: { bg: "#ECEAFB", fg: BRIGHT },
    staff: { bg: "#EFEEFF", fg: "#5b54b8" },
    viewer: { bg: "#F1F0EC", fg: MUTED },
  };
  const c = colors[role] ?? colors.viewer;
  return {
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 999,
    background: c.bg,
    color: c.fg,
    fontSize: 12,
    fontWeight: 600,
    textTransform: "capitalize",
  };
}

// Minimal text button for inline row actions (Remove / Yes / Cancel).
function linkBtn(color) {
  return {
    background: "transparent",
    border: "none",
    color,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    padding: "2px 6px",
    fontFamily: "inherit",
  };
}
