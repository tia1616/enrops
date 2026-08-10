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

// The states an operator can be in, in order. Deliberately derived from work
// done (signed in / published / registered), never from a status column
// somebody has to remember to set.
//
// "Nothing published" tests first_published_at, NOT the live count: a class that
// was published in September and closed in October leaves zero live rows, and
// reading that as "never published" is the exact wrong answer to the question
// this screen exists to answer.
//
// The green state tests ACTIVE registrations, not the total. An operator whose
// only registration was cancelled or refunded has a total of 1 and is not
// selling anything; reading that as "Taking registrations" would paint the row
// green on the one screen used to decide who needs help. That case gets its own
// label rather than being folded into "no registrations", which would contradict
// the count of 1 sitting in the next column.
function stageOf(r) {
  if ((r.member_count ?? 0) === 0) return { key: "no_account", label: "No account yet", color: FLAG };
  if ((r.signed_in_member_count ?? 0) === 0) return { key: "no_signin", label: "Never signed in", color: FLAG };
  if (!r.first_published_at) return { key: "no_publish", label: "Nothing published", color: AMBER };
  if ((r.active_registration_count ?? 0) > 0) return { key: "selling", label: "Taking registrations", color: OK };
  if ((r.registration_count ?? 0) > 0) return { key: "all_cancelled", label: "Registrations all cancelled", color: AMBER };
  return { key: "no_regs", label: "Published, no registrations", color: AMBER };
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
      //
      // Matched on the SQLSTATE alone. This used to also match /forbidden/i on
      // the message, which is the wider net: any edge layer that answers "403
      // Forbidden" — a WAF, a rate limiter, Netlify — would have told a real
      // platform admin they lack access, which is a confident claim about their
      // permissions drawn from an error that only proves the request failed.
      if (error.code === "42501") {
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
  const internalCount = (rows ?? []).length - real.length;
  // Derived, never typed in. This used to be the literal string "Jul 3, 2026",
  // which was read off prod's earliest event of ANY kind and was wrong on both
  // environments — prod's first publish event is Jul 8, staging's is Jul 2. The
  // boundary that decides whether a date can be trusted has to come from the
  // same query as the dates.
  const logStart = (rows ?? []).find((r) => r.publish_log_starts_at)?.publish_log_starts_at ?? null;
  const published = real.filter((r) => r.first_published_at).length;
  const selling = real.filter((r) => (r.registration_count ?? 0) > 0).length;

  // Headers wrap. They used to be nowrap, and eight nowrap headers gave the
  // table a min-content width of 1042px inside a 953px slot — <main> is a grid
  // item with the default min-width:auto, so it grew to fit rather than letting
  // the table scroll, and the whole admin shell scrolled sideways with the
  // sidebar. Two-line headers are ordinary in an admin table; a sideways-
  // scrolling shell is not. Numeric cells stay nowrap so no figure ever splits.
  const th = { padding: "10px 12px", borderBottom: `1px solid ${RULE}` };
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
            {real.length} operator{real.length === 1 ? "" : "s"} · {published} who've published · {selling} with registrations
            {internalCount > 0 && ` (${internalCount} internal account${internalCount === 1 ? "" : "s"} excluded from these counts)`}
          </div>

          <div style={{ overflowX: "auto", maxWidth: "100%", minWidth: 0 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 820, fontSize: 13, background: PANEL, border: `1px solid ${RULE}`, borderRadius: 8 }}>
              <thead>
                <tr style={{ textAlign: "left", color: MUTED, fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  <th style={th}>Operator</th>
                  <th style={th}>Where they are</th>
                  <th style={{ ...th, textAlign: "right" }}>Account</th>
                  <th style={{ ...th, textAlign: "center" }}>Stripe</th>
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
                        {/* Stripe used to be a phrase on this line. It is a column
                            now, so it is not said twice. */}
                        <div style={{ fontSize: 11.5, color: MUTED }}>
                          {r.org_slug} · set up {fmtDate(r.org_created_at)}
                          {r.org_platform_plan ? ` · ${r.org_platform_plan}` : ""}
                        </div>
                      </td>
                      <td style={{ ...td, color: stage.color, fontWeight: 600 }}>{stage.label}</td>
                      <td style={num}>
                        {r.signed_in_member_count}/{r.member_count}
                        <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 400 }}>signed in</div>
                      </td>
                      {/* Three states, not two. A tick means money can actually
                          move; "started" means an account exists but Stripe has
                          not cleared it to charge yet (demo-chess-center on
                          staging is exactly this). Ticking that row would say
                          they are ready when a family still cannot pay them. */}
                      <td style={{ ...td, textAlign: "center", whiteSpace: "nowrap" }}>
                        {r.stripe_charges_enabled ? (
                          <span title="Connected and able to take payments" style={{ color: OK, fontWeight: 700, fontSize: 15 }}>✓</span>
                        ) : r.stripe_connected ? (
                          <span title="Account connected, but Stripe has not enabled charges yet"
                                style={{ color: AMBER, fontSize: 11.5, fontWeight: 600 }}>started</span>
                        ) : (
                          <span title="No Stripe account yet" style={{ color: MUTED }}>—</span>
                        )}
                      </td>
                      <td style={num}>
                        {live}
                        {r.live_camp_count > 0 && (
                          <div style={{ fontSize: 11.5, color: MUTED }}>
                            {r.live_program_count} program{r.live_program_count === 1 ? "" : "s"} · {r.live_camp_count} camp{r.live_camp_count === 1 ? "" : "s"}
                          </div>
                        )}
                      </td>
                      {/* An exact date and an estimate must never look alike in the
                          same column — that is how a date nobody should act on
                          gets acted on. Anything published since the event log
                          started on Jul 3 is the real moment. Older ones fall
                          back to when the class was CREATED, and a class is
                          published at or after it is created, never before — so
                          that date is a floor and the label has to read "or
                          later", not "by". */}
                      <td style={num}>
                        {fmtDate(r.first_published_at)}
                        {r.first_published_at && r.first_published_is_exact === false && (
                          <div style={{ fontSize: 11.5, color: MUTED }}>or later</div>
                        )}
                      </td>
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
            "Stripe" ticks when an operator can actually take money. "Started" means they connected an account
            but Stripe hasn't cleared it to charge yet, which is a different problem from never having begun.
            "Live" is what families can register for right now — programs that are open plus camp sessions that
            are active. "First published" counts anything that ever went live, including classes since closed
            or cancelled, so an operator who published last term and closed it still shows the date they did it.
            {logStart
              ? ` Publishing has been recorded as it happens since ${fmtDate(logStart)}, so those dates are exact.`
              : " Nothing has been published yet, so there are no exact dates to compare against."}{" "}
            Anything older falls back to the date the class was created, and a class goes live at or after it's
            created, never before — so those read "or later" and the real date could be any time after.
            "Last activity" is the most recent program, camp or registration — not a login: a login date only
            updates when someone signs in fresh, so a daily user who never gets logged out looks dormant.
            Cancelled registrations are still counted in the total, because the operator did get that first one.
          </div>
        </>
      )}
    </div>
  );
}
