// ContactTimelineDrawer — the per-contact activity timeline for Comms.
//
// A read-side union over tables that already record sends + responses (no new
// central log). Keyed by audience -> its source tables:
//   families    : marketing_sends (by recipient_id) + automation_run_recipients
//                 (by email) + marketing_suppressions
//   instructors : camp/program assignment offers + responses, substitute offers,
//                 instructor_survey_sends, onboarding invite, availability submitted
//   partners    : roster_email_sends (by partner_id, filtered to this contact via
//                 the recipients snapshot: partner_contact_id, else email)
//
// Each source failing is isolated — one bad query drops its own events, never the
// whole timeline. Names are resolved with small batched id->name lookups rather
// than PostgREST embeds (robust, no relationship-name guessing).

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabase.js";
import { BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";

const CREAM = "#FBFBFB";
const RED = "#b53737";
const GREEN = "#3a7c3a";

const TONE = {
  sent: MUTED,
  positive: GREEN,
  negative: RED,
  neutral: MUTED,
};

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function low(s) { return (s ?? "").toString().trim().toLowerCase(); }

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtDay(d) {
  if (!d) return "";
  const dt = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Offer response → label/tone/icon. status values: confirmed / change_requested /
// declined / published (offered, no response yet).
function respLabel(status) {
  if (status === "confirmed") return "confirmed";
  if (status === "change_requested") return "change requested";
  if (status === "declined") return "declined";
  return "responded";
}
function respTone(status) {
  if (status === "confirmed") return "positive";
  if (status === "declined") return "negative";
  return "neutral";
}
function respIcon(status) {
  if (status === "confirmed") return "✅";
  if (status === "declined") return "✖️";
  return "✏️";
}

// ─── Fetchers (one per audience) ─────────────────────────────────────────────

async function fetchFamily(contact, orgId) {
  const events = [];
  const email = low(contact.email);

  const { data: sends } = await supabase
    .from("marketing_sends")
    .select("id, rendered_subject, status, sent_at, opened_at, clicked_at, created_at")
    .eq("recipient_id", contact.id)
    .order("created_at", { ascending: false })
    .limit(300);
  for (const s of sends ?? []) {
    let detail, tone;
    if (s.clicked_at) { detail = "Clicked"; tone = "positive"; }
    else if (s.opened_at) { detail = "Opened"; tone = "positive"; }
    else if (["bounced", "failed"].includes(s.status)) { detail = cap(s.status); tone = "negative"; }
    else { detail = cap(s.status ?? "Sent"); tone = "sent"; }
    events.push({ id: "ms" + s.id, at: s.sent_at ?? s.created_at, icon: "📣", title: s.rendered_subject || "Campaign email", detail, tone });
  }

  if (email) {
    const { data: autos } = await supabase
      .from("automation_run_recipients")
      .select("id, sent_at, status")
      .eq("email", email)
      .order("sent_at", { ascending: false })
      .limit(300);
    for (const a of autos ?? []) {
      const tone = a.status === "sent" ? "sent" : (a.status?.startsWith("skipped") ? "neutral" : "negative");
      events.push({ id: "ar" + a.id, at: a.sent_at, icon: "🔔", title: "Automated email", detail: a.status ? cap(a.status.replace(/_/g, " ")) : "", tone });
    }

    const { data: sup } = await supabase
      .from("marketing_suppressions")
      .select("suppressed_at, reason")
      .eq("organization_id", orgId)
      .eq("email", email)
      .limit(10);
    for (const s of sup ?? []) {
      events.push({ id: "sup" + s.suppressed_at, at: s.suppressed_at, icon: "🚫", title: "Unsubscribed", detail: s.reason ? cap(s.reason) : "", tone: "negative" });
    }

    // Registrations — the programs/camps this family signed up for + attended.
    // Via a SECURITY DEFINER RPC (gated to org members, scoped to org+email)
    // because the parents RLS hides most registered parents from the admin
    // (missing parent_org_relationships), so an email->parents read comes back
    // empty. The RPC returns only this org's registrations for this email.
    const { data: regs } = await supabase.rpc("family_registration_timeline", { p_org: orgId, p_email: email });
    const now = new Date();
    for (const r of regs ?? []) {
      const name = r.program_name || "a program";
      const child = r.child_name || "";
      const cancelled = !!r.cancelled_at;
      const past = !cancelled && r.starts_at && new Date(r.starts_at) < now;
      events.push({
        id: "reg" + r.registration_id,
        at: r.registered_at,
        icon: past ? "🎓" : "📝",
        title: `${past ? "Attended" : "Registered"}: ${name}`,
        detail: [child, cancelled ? "later cancelled" : (r.status && r.status !== "confirmed" ? cap(r.status) : "")].filter(Boolean).join(" · "),
        tone: cancelled ? "neutral" : "positive",
      });
      if (cancelled) {
        events.push({ id: "regc" + r.registration_id, at: r.cancelled_at, icon: "✖️", title: `Cancelled: ${name}`, detail: child, tone: "negative" });
      }
    }
  }
  return events;
}

async function fetchInstructor(contact) {
  const events = [];
  const iid = contact.id;

  const [{ data: camp }, { data: prog }, { data: subs }, { data: surv }, { data: onb }, { data: av }, { data: tav }] = await Promise.all([
    supabase.from("camp_assignments").select("id, status, email_sent_at, instructor_response_at, camp_session_id").eq("instructor_id", iid).not("email_sent_at", "is", null).limit(300),
    supabase.from("program_assignments").select("id, status, email_sent_at, instructor_response_at, program_id").eq("instructor_id", iid).not("email_sent_at", "is", null).limit(300),
    supabase.from("assignment_substitutions").select("id, email_sent_at, declined_at, status, date").eq("sub_instructor_id", iid).not("email_sent_at", "is", null).limit(200),
    supabase.from("instructor_survey_sends").select("id, survey_kind, status, sent_at").eq("instructor_id", iid).order("sent_at", { ascending: false }).limit(100),
    supabase.from("contractor_onboarding_status").select("invited_at").eq("instructor_id", iid).maybeSingle(),
    supabase.from("instructor_availability").select("id, submitted_at").eq("instructor_id", iid).not("submitted_at", "is", null).limit(100),
    supabase.from("instructor_term_availability").select("id, submitted_at, term").eq("instructor_id", iid).not("submitted_at", "is", null).limit(100),
  ]);

  // Batch id->name lookups for the offer labels.
  const csIds = [...new Set((camp ?? []).map((c) => c.camp_session_id).filter(Boolean))];
  const pIds = [...new Set((prog ?? []).map((p) => p.program_id).filter(Boolean))];
  const csMap = new Map();
  const pMap = new Map();
  if (csIds.length) {
    const { data } = await supabase.from("camp_sessions").select("id, curriculum_name, week_num").in("id", csIds);
    for (const s of data ?? []) csMap.set(s.id, s);
  }
  if (pIds.length) {
    const { data } = await supabase.from("programs").select("id, curriculum, term").in("id", pIds);
    for (const p of data ?? []) pMap.set(p.id, p);
  }

  for (const c of camp ?? []) {
    const s = csMap.get(c.camp_session_id);
    const name = s ? `${s.curriculum_name ?? "Camp"}${s.week_num ? ` · Wk ${s.week_num}` : ""}` : "Camp assignment";
    events.push({ id: "ca" + c.id, at: c.email_sent_at, icon: "📋", title: `Assignment offer: ${name}`, detail: "Sent", tone: "sent" });
    if (c.instructor_response_at) events.push({ id: "car" + c.id, at: c.instructor_response_at, icon: respIcon(c.status), title: `Offer ${respLabel(c.status)}: ${name}`, detail: "", tone: respTone(c.status) });
  }
  for (const p of prog ?? []) {
    const pr = pMap.get(p.program_id);
    const name = pr ? `${pr.curriculum ?? "Class"}${pr.term ? ` · ${pr.term}` : ""}` : "Class assignment";
    events.push({ id: "pa" + p.id, at: p.email_sent_at, icon: "📋", title: `Assignment offer: ${name}`, detail: "Sent", tone: "sent" });
    if (p.instructor_response_at) events.push({ id: "par" + p.id, at: p.instructor_response_at, icon: respIcon(p.status), title: `Offer ${respLabel(p.status)}: ${name}`, detail: "", tone: respTone(p.status) });
  }
  for (const s of subs ?? []) {
    events.push({ id: "sub" + s.id, at: s.email_sent_at, icon: "🔄", title: "Substitute offer", detail: s.date ? `for ${fmtDay(s.date)}` : "", tone: "sent" });
    if (s.declined_at) events.push({ id: "subd" + s.id, at: s.declined_at, icon: "✖️", title: "Substitute declined", detail: "", tone: "negative" });
  }
  for (const s of surv ?? []) {
    events.push({ id: "iss" + s.id, at: s.sent_at, icon: "📨", title: "Availability survey sent", detail: s.status === "failed" ? "Failed" : "", tone: s.status === "failed" ? "negative" : "sent" });
  }
  if (onb?.invited_at) events.push({ id: "inv", at: onb.invited_at, icon: "✉️", title: "Onboarding invite sent", detail: "", tone: "sent" });
  for (const a of av ?? []) events.push({ id: "av" + a.id, at: a.submitted_at, icon: "✅", title: "Availability submitted", detail: "", tone: "positive" });
  for (const a of tav ?? []) events.push({ id: "tav" + a.id, at: a.submitted_at, icon: "✅", title: "Availability submitted", detail: a.term || "", tone: "positive" });
  return events;
}

async function fetchPartner(contact) {
  const events = [];
  const pid = contact.partner_id;
  if (!pid) return events;
  const email = low(contact.contact_email);

  const { data: rs } = await supabase
    .from("roster_email_sends")
    .select("id, program_id, camp_session_id, recipients, status, sent_at")
    .eq("partner_id", pid)
    .order("sent_at", { ascending: false })
    .limit(300);

  // Keep only sends this contact was actually on. New sends carry
  // partner_contact_id in the recipients snapshot; older ones match by email.
  const mine = (rs ?? []).filter((r) => Array.isArray(r.recipients) && r.recipients.some(
    (x) => (x.partner_contact_id && x.partner_contact_id === contact.id) || (email && low(x.email) === email),
  ));

  const pIds = [...new Set(mine.map((r) => r.program_id).filter(Boolean))];
  const csIds = [...new Set(mine.map((r) => r.camp_session_id).filter(Boolean))];
  const pMap = new Map();
  const csMap = new Map();
  if (pIds.length) {
    const { data } = await supabase.from("programs").select("id, curriculum").in("id", pIds);
    for (const p of data ?? []) pMap.set(p.id, p);
  }
  if (csIds.length) {
    const { data } = await supabase.from("camp_sessions").select("id, curriculum_name").in("id", csIds);
    for (const s of data ?? []) csMap.set(s.id, s);
  }
  for (const r of mine) {
    let name = "Class roster";
    if (r.program_id && pMap.get(r.program_id)) name = `${pMap.get(r.program_id).curriculum ?? "Class"} roster`;
    else if (r.camp_session_id && csMap.get(r.camp_session_id)) name = `${csMap.get(r.camp_session_id).curriculum_name ?? "Camp"} roster`;
    events.push({ id: "rs" + r.id, at: r.sent_at, icon: "📄", title: `${name} sent`, detail: r.status === "failed" ? "Failed" : "", tone: r.status === "failed" ? "negative" : "sent" });
  }
  return events;
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

export default function ContactTimelineDrawer({ audience, contact, contactLabel, orgId, onClose }) {
  const [events, setEvents] = useState(null); // null = loading
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!contact) return;
    let alive = true;
    setEvents(null); setErr(null);
    (async () => {
      try {
        let evs = [];
        if (audience === "families") evs = await fetchFamily(contact, orgId);
        else if (audience === "instructors") evs = await fetchInstructor(contact);
        else if (audience === "partners") evs = await fetchPartner(contact);
        if (!alive) return;
        evs = evs.filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at));
        setEvents(evs);
      } catch (e) {
        if (!alive) return;
        console.error("[ContactTimelineDrawer] load failed", e);
        setErr(e.message ?? "Couldn't load this contact's activity.");
        setEvents([]);
      }
    })();
    return () => { alive = false; };
  }, [audience, contact, orgId]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 300, display: "flex", justifyContent: "flex-end", fontFamily: "inherit" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 440, maxWidth: "94vw", height: "100%", background: "#fff", boxShadow: "-8px 0 40px rgba(0,0,0,0.2)", display: "flex", flexDirection: "column" }}
      >
        <div style={{ padding: "18px 20px", borderBottom: `1px solid ${RULE}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>Activity</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: INK, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contactLabel}</div>
          </div>
          <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", color: MUTED, fontSize: 20, cursor: "pointer", lineHeight: 1 }} aria-label="Close">✕</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {events === null ? (
            <div style={{ color: MUTED, fontSize: 13, padding: "20px 0" }}>Loading activity…</div>
          ) : err ? (
            <div style={{ color: RED, fontSize: 13, padding: "20px 0" }}>{err}</div>
          ) : events.length === 0 ? (
            <div style={{ color: MUTED, fontSize: 13, padding: "20px 0", lineHeight: 1.6 }}>
              No activity yet. Emails and responses will show up here once this contact has been sent something.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {events.map((e) => (
                <div key={e.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: `1px solid ${CREAM}` }}>
                  <div style={{ fontSize: 18, lineHeight: 1.3, width: 22, textAlign: "center", flexShrink: 0 }}>{e.icon}</div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: INK, lineHeight: 1.35 }}>{e.title}</div>
                    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                      {fmtWhen(e.at)}
                      {e.detail && <> · <span style={{ color: TONE[e.tone] ?? MUTED, fontWeight: 600 }}>{e.detail}</span></>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: "10px 20px", borderTop: `1px solid ${RULE}`, fontSize: 11, color: MUTED }}>
          Shows sign-ups, emails sent, and tracked responses. Replies go to your own reply-to inbox.
        </div>
      </div>
    </div>
  );
}
