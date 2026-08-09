// /admin/platform/operators
// Arielle's question, verbatim: "Is there a single place that tells me, per
// operator: do they have an account, have they published, and when?" This is
// that place. Read-only: nothing on this screen writes anything anywhere.
//
// Platform-admin only, same shape as RefundWatch: AdminLayout already gates on
// org_members, and we add a second platform_admins check because this reports
// across EVERY tenant. platform_operator_overview() enforces the same rule again
// in the database (raises 42501), so the UI check is convenience, not the
// security boundary — and the catch below treats a 42501 from the RPC as denied
// rather than as a generic failure.
//
// Route lives under /admin/platform/ rather than /admin/dev/ because this URL
// gets handed to Arielle, who is not a developer; a link reading "dev" reads as
// a test page. Future platform-admin screens belong beside it.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";

const PURPLE = "#1C004F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const FLAG = "#B3261E";
const OK = "#1B7F4C";
const AMBER = "#8a6100";

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

// The four states an operator can be in, in order. Deliberately derived from
// work done (signed in / published / registered), never from a status column
// somebody has to remember to set.
function stageOf(r) {
  const live = (r.live_program_count ?? 0) + (r.live_camp_count ?? 0);
  if ((r.signed_in_member_count ?? 0) === 0) return { key: "no_signin", label: "Never signed in", color: FLAG };
  if (live === 0) return { key: "no_publish", label: "Nothing published", color: AMBER };
  if ((r.registration_count ?? 0) === 0) return { key: "no_regs", label: "Published, no registrations", color: AMBER };
  return { key: "selling", label: "Taking registrations", color: OK };
}

export default function OperatorOverview() {
  const [adminCheck, setAdminCheck] = useState("loading"); // loading | denied | ok
  const [rows, setRows] = useState(null); // null = loading
  const [loadErr, setLoadErr] = useState("");

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
    const { data, error } = await supabase.rpc("platform_operator_overview");
    if (error) {
      // The function raises 42501 for a non-platform-admin. Showing that as
      // "couldn't load" would be a lie about why the screen is empty.
      if (error.code === "42501" || /forbidden/i.test(error.message ?? "")) {
        setAdminCheck("denied");
        return;
      }
      console.error("[OperatorOverview] load failed", error);
      setLoadErr("Couldn't load the operator list. Refresh to try again.");
      setRows([]);
      return;
    }
    setRows(data ?? []);
  }, []);

  useEffect(() => { if (adminCheck === "ok") load(); }, [adminCheck, load]);

  if (adminCheck === "loading") {
    return <div style={{ color: MUTED, padding: 24 }}>Checking platform-admin access…</div>;
  }
  if (adminCheck === "denied") {
    return (
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 520 }}>
        <h2 style={{ marginTop: 0, color: PURPLE }}>Platform admin only</h2>
        <p style={{ color: INK, fontSize: 14 }}>
          This screen shows every operator on the platform, so it's restricted to platform admins.
          Org-level admin access alone is not enough.
        </p>
      </div>
    );
  }

  const real = (rows ?? []).filter((r) => !r.org_is_internal);
  const published = real.filter((r) => (r.live_program_count ?? 0) + (r.live_camp_count ?? 0) > 0).length;
  const selling = real.filter((r) => (r.registration_count ?? 0) > 0).length;

  const th = { padding: "10px 12px", borderBottom: `1px solid ${RULE}`, whiteSpace: "nowrap" };
  const td = { padding: "10px 12px", borderBottom: `1px solid ${RULE}`, verticalAlign: "top" };
  const num = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Operators</h1>
        <div style={{ color: MUTED, fontSize: 13, marginTop: 4, maxWidth: 640 }}>
          Every operator on the platform, in the order they were set up: whether anyone has signed in,
          whether they've put anything live, and when their first registration came in.
        </div>
      </div>

      {loadErr && (
        <div style={{ background: `${FLAG}12`, color: FLAG, padding: 10, borderRadius: 6, fontSize: 12.5, marginBottom: 12, maxWidth: 640 }}>
          {loadErr}
        </div>
      )}

      {rows === null && <div style={{ color: MUTED, fontSize: 13, padding: "16px 0" }}>Loading…</div>}

      {rows !== null && rows.length === 0 && !loadErr && (
        <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8, padding: 24, maxWidth: 640, color: MUTED, fontSize: 13 }}>
          No operators yet.
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
            {real.length} operator{real.length === 1 ? "" : "s"} · {published} with something live · {selling} with registrations
            {rows.length !== real.length && " (internal accounts excluded from these counts)"}
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8 }}>
              <thead>
                <tr style={{ textAlign: "left", color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  <th style={th}>Operator</th>
                  <th style={th}>Where they are</th>
                  <th style={{ ...th, textAlign: "right" }}>Account</th>
                  <th style={{ ...th, textAlign: "right" }}>Live</th>
                  <th style={{ ...th, textAlign: "right" }}>First published</th>
                  <th style={{ ...th, textAlign: "right" }}>Registrations</th>
                  <th style={{ ...th, textAlign: "right" }}>First registration</th>
                  <th style={{ ...th, textAlign: "right" }}>Last activity</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const stage = stageOf(r);
                  const live = (r.live_program_count ?? 0) + (r.live_camp_count ?? 0);
                  return (
                    <tr key={r.org_id}>
                      <td style={{ ...td, color: INK }}>
                        <span style={{ fontWeight: 600 }}>{r.org_name}</span>
                        {r.org_is_internal && (
                          <span style={{ marginLeft: 8, fontSize: 10, color: MUTED, fontWeight: 700, textTransform: "uppercase",
                                         letterSpacing: ".05em", border: `1px solid ${RULE}`, borderRadius: 4, padding: "1px 5px" }}>
                            Internal
                          </span>
                        )}
                        <div style={{ fontSize: 11.5, color: MUTED }}>
                          Set up {fmtDate(r.org_created_at)}
                          {r.org_platform_plan ? ` · ${r.org_platform_plan}` : ""}
                          {r.stripe_charges_enabled ? " · Stripe on" : " · Stripe not connected"}
                        </div>
                      </td>
                      <td style={{ ...td, color: stage.color, fontWeight: 600, whiteSpace: "nowrap" }}>{stage.label}</td>
                      <td style={num}>
                        {r.signed_in_member_count}/{r.member_count}
                        <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 400 }}>signed in</div>
                      </td>
                      <td style={num}>
                        {live}
                        {r.live_camp_count > 0 && (
                          <div style={{ fontSize: 11.5, color: MUTED }}>
                            {r.live_program_count} program{r.live_program_count === 1 ? "" : "s"} · {r.live_camp_count} camp{r.live_camp_count === 1 ? "" : "s"}
                          </div>
                        )}
                      </td>
                      <td style={num}>{fmtDate(r.first_published_at)}</td>
                      <td style={num}>
                        {r.registration_count}
                        {r.registration_count !== r.active_registration_count && (
                          <div style={{ fontSize: 11.5, color: MUTED }}>{r.active_registration_count} not cancelled</div>
                        )}
                      </td>
                      <td style={num}>{fmtDate(r.first_registration_at)}</td>
                      <td style={num}>{fmtDate(r.last_activity_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 10, maxWidth: 720, lineHeight: 1.6 }}>
            "Live" counts programs that are open plus camp sessions that are active. "First published" is the
            earliest one of those was created — the platform doesn't stamp the moment something goes live, so
            for anything built as a draft first this reads early by however long it sat in draft.
            "Last activity" is the most recent program, camp or registration, not a login: a login date only
            updates when someone signs in fresh, so a daily user who never gets logged out looks dormant.
            Cancelled registrations are still counted in the total, because the operator did get that first one.
          </div>
        </>
      )}
    </div>
  );
}
