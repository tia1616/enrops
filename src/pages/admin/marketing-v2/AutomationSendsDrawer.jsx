// AutomationSendsDrawer — "open an automation, see what it actually sent".
//
// WHY THIS EXISTS. Jeff asked, on 13 Sept 2026: "I still can't figure out how to
// see outgoing automated comms and if they were sent." He was right that he
// could not. We already record every send, and each family's own page in
// Comms > Contacts shows what they got, but reconstructing one send meant
// opening its recipients one at a time. For a 17-family class that is not an
// answer to "did it go out".
//
// THE SHAPE IS THE ONE EVERY COMPARABLE PRODUCT USES: the automation is the
// anchor. Mailchimp gives each journey its own report, HubSpot shows workflow
// history plus a per-contact timeline, Activity Messenger anchors on the
// template. Nobody makes a chronological "everything that went out" feed the
// primary surface, which is why that idea was dropped rather than built.
//
// REUSED, NOT REINVENTED: the overlay/panel shell mirrors ContactTimelineDrawer,
// and every judgement about what a row MEANS comes from lib/deliveryIssues.js,
// which already owned this table's semantics for the "Didn't send" panel.
//
// WHAT IS DELIBERATELY NOT HERE: Message families history. Those rows live in
// program_family_messages at a different grain (one row per SEND with a
// recipients jsonb, not one row per person), so they need their own reader.
// Folding them in here would mean one component quietly doing two different
// things to two different shapes.
import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { classifyDelivery, summariseDelivery, describeSendScope } from "../../../lib/deliveryIssues.js";
import { PURPLE, BRIGHT, INK, MUTED, RULE, OK, WARN } from "../marketing/tokens.jsx";

const PAGE = 200;

const TONE_COLORS = {
  ok: { fg: OK, bg: "#ecf6ec" },
  bad: { fg: "#b53737", bg: "#fbeae9" },
  warn: { fg: WARN, bg: "#fef5e6" },
  muted: { fg: MUTED, bg: "#f5f4ee" },
};

function Pill({ tone, children }) {
  const c = TONE_COLORS[tone] ?? TONE_COLORS.muted;
  return (
    <span style={{
      background: c.bg, color: c.fg, padding: "2px 8px", borderRadius: 999,
      fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

// Absolute, not relative. "3 days ago" is the wrong unit when an operator is
// reconciling against what a parent tells them they did or did not receive.
function when(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function AutomationSendsDrawer({ automationId, title, orgId, onClose }) {
  const [rows, setRows] = useState(null);   // null = loading
  const [total, setTotal] = useState(null); // true row count, may exceed what we list
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!automationId || !orgId) return;
    let alive = true;
    (async () => {
      setRows(null);
      setTotal(null); // cleared with the rows, so a re-run can never describe
      setErr("");     // the new automation's list against the old one's total
      // Org-scoped in the query as WELL as by row security. The policy
      // (members_read_automation_run_recipients) already restricts this to org
      // members, but a screen that relies only on RLS reads as though any row
      // would do, and the next person to copy it may not have a policy.
      //
      // Filtering by automation_id is also what keeps TRANSACTIONAL sends out:
      // registration confirmations and refund receipts live in this same table
      // with automation_id NULL and a `source` instead. Measured on prod: 1370
      // rows carry an automation_id, 101 carry a source, and ZERO carry both.
      //
      // THE TOTAL IS COUNTED SEPARATELY because the list is capped at PAGE and
      // the summary pills below describe only what is listed. J2S's "Welcome -
      // camp" already has 393 recipient rows on prod, so without this the pills
      // would add up to 200 and say nothing about the other 193 - the same class
      // of quiet wrongness this screen exists to remove.
      const [listRes, countRes] = await Promise.all([
        supabase
          .from("automation_run_recipients")
          .select("id, email, label, rendered_subject, sent_at, status, delivery_status, bounce_detail, error_message, attempts")
          .eq("organization_id", orgId)
          .eq("automation_id", automationId)
          .order("sent_at", { ascending: false, nullsFirst: false })
          .limit(PAGE),
        supabase
          .from("automation_run_recipients")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("automation_id", automationId),
      ]);
      if (!alive) return;
      if (listRes.error) { setErr(listRes.error.message || "Couldn't load this automation's sends."); setRows([]); return; }
      setRows(listRes.data ?? []);
      setTotal(countRes.error ? null : (countRes.count ?? null));
    })();
    return () => { alive = false; };
  }, [automationId, orgId]);

  const sum = rows ? summariseDelivery(rows) : null;
  // The wording and the truncation rule live in deliveryIssues.js so they can be
  // tested; staging's biggest automation has 12 recipient rows, so the truncated
  // branch can only be proved by a test, not by clicking.
  const scope = sum ? describeSendScope(sum.total, total, PAGE) : null;

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 300, display: "flex", justifyContent: "flex-end", fontFamily: "inherit" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Sends for ${title || "this automation"}`}
        style={{ background: "#fff", width: "min(560px, 100%)", height: "100%", overflowY: "auto", padding: "18px 20px", textAlign: "left" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: MUTED }}>
              Sends
            </div>
            <h2 style={{ margin: "2px 0 0", fontSize: 18, color: PURPLE, lineHeight: 1.25 }}>{title || "Automation"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ background: "transparent", border: "none", color: MUTED, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        {rows === null && <p style={{ color: MUTED, fontSize: 13 }}>Loading…</p>}

        {err && (
          <p style={{ color: "#b53737", fontSize: 13, background: "#fbeae9", padding: "8px 10px", borderRadius: 6 }}>{err}</p>
        )}

        {/* The button that opens this is gated on there being rows, so an empty
            drawer means they went away between the count and the read, or the
            send was recorded somewhere other than automation_run_recipients.
            Either way, claiming "nothing was sent" would be a stronger statement
            than we can make: the card behind this may well say "Last sent". */}
        {rows !== null && !err && rows.length === 0 && (
          <p style={{ color: MUTED, fontSize: 13, marginTop: 14 }}>
            We don&rsquo;t have a per-recipient record for this automation. If the card says it
            has sent, it went out through a path that doesn&rsquo;t log who received it.
          </p>
        )}

        {sum && sum.total > 0 && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0 4px" }}>
              {sum.delivered > 0 && <Pill tone="ok">{sum.delivered} delivered</Pill>}
              {sum.bounced > 0 && <Pill tone="bad">{sum.bounced} bounced</Pill>}
              {sum.failed > 0 && <Pill tone="bad">{sum.failed} didn&rsquo;t send</Pill>}
              {sum.unconfirmed > 0 && <Pill tone="muted">{sum.unconfirmed} not confirmed</Pill>}
              {sum.skipped > 0 && <Pill tone="muted">{sum.skipped} skipped</Pill>}
            </div>

            {/* Said once, here, rather than repeated on every unconfirmed row.
                Without it "not confirmed" reads as a fault, which it is not. */}
            {sum.unconfirmed > 0 && (
              <p style={{ color: MUTED, fontSize: 12, margin: "6px 0 0", lineHeight: 1.45 }}>
                &ldquo;Not confirmed&rdquo; means the email went out and no delivery receipt has come back.
                It is not a failure. Delivery receipts only became reliable in late August, so older sends
                often look like this.
              </p>
            )}

            {/* Say what the pills above are counting. When there are more sends
                than we list, the pills describe the listed page ONLY, and an
                operator reading "12 delivered" on a 400-send automation would
                otherwise take it as the whole story. */}
            <p style={{ color: MUTED, fontSize: 12, margin: "10px 0 0", lineHeight: 1.45 }}>
              {scope.text}
            </p>

            <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
              {rows.map((r) => {
                const c = classifyDelivery(r);
                return (
                  <li key={r.id} style={{ padding: "10px 0", borderBottom: `1px solid ${RULE}` }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, color: INK, fontSize: 13.5, wordBreak: "break-all" }}>
                        {r.email || "(no address on file)"}
                      </span>
                      <Pill tone={c.tone}>{c.label}</Pill>
                      <span style={{ marginLeft: "auto", color: MUTED, fontSize: 12, whiteSpace: "nowrap" }}>{when(r.sent_at)}</span>
                    </div>
                    {(r.rendered_subject || r.label) && (
                      <div style={{ color: INK, fontSize: 12.5, marginTop: 3 }}>{r.rendered_subject || r.label}</div>
                    )}
                    {c.detail && (
                      <div style={{ color: MUTED, fontSize: 12, marginTop: 2, lineHeight: 1.45 }}>{c.detail}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div style={{ marginTop: 18 }}>
          <button type="button" onClick={onClose}
            style={{ background: BRIGHT, color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
