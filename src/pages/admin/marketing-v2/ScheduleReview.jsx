// ScheduleReview — the real chunk-06 review screen. Replaces the chunk-05
// ReviewPlaceholder. Shows the full multi-touchpoint schedule with editable
// subject/body/send-time per touchpoint, recipient summary with per-row
// remove, and the sticky action bar (back / save / send test / approve).
//
// All edits are LOCAL until "Save as draft" or "Approve & Schedule". Chunk 07
// wires the real PATCH + marketing-send calls.

import { useEffect, useMemo, useState } from "react";
import TouchpointCard from "./TouchpointCard.jsx";
import { supabase } from "../../../lib/supabase.js";
import { INK, MUTED, PURPLE, RULE, OK, INFO } from "../marketing/tokens.jsx";

// Stable color palette for topic chips. Same five we used in the mockup.
const TOPIC_PALETTE = [
  { background: "#f0e3e8", color: PURPLE },
  { background: "#FAEEDA", color: "#854F0B" },
  { background: "#EAF3DE", color: OK },
  { background: "#fce4ec", color: "#ad1457" },
  { background: "#dbeafe", color: INFO },
];

function fmtDate(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  catch { return iso; }
}

export default function ScheduleReview({
  draft,
  // Operator's in-memory question answers (Q1 picks etc). Used to resolve
  // the picked-schools dropdown for the per-school preview. We could read
  // them back from marketing_campaigns.draft_inputs, but RLS doesn't grant
  // the creating user a SELECT on rows that the service-role-backed draft
  // endpoint wrote — so reading the campaign row 403s. The in-memory shape
  // is equivalent and avoids the round-trip.
  inputs,
  org,
  onBack,
  onReset,
  onUpdateTouchpoint,
  onCommitTouchpoint,
  onRemoveRecipient,
  onSaveDraft,
  onSendTest,
  onApprove,
  onRegenerate,
  busy,
  // Which long-running button is in flight, if any. Lets each button show its
  // OWN spinner text ("Saving…" / "Sending test…" / "Approving…") instead of
  // every button echoing whichever one the operator clicked.
  // Values: null | 'save' | 'test' | 'approve'
  busyAction,
}) {
  const [recipientsOpen, setRecipientsOpen] = useState(false);
  const touchpoints = draft?.schedule?.touchpoints ?? [];
  const recipients = draft?.recipients ?? { count: 0, ids: [], segment_summary: "" };
  const sender = draft?.sender ?? { name: org?.default_sender_name, email: org?.default_sender_email };
  const timezone = org?.timezone ?? "America/Los_Angeles";

  // Whether the operator picked any curricula in Q1. For schedule-change /
  // photo-gallery / partner-event / free-form intents there are no picks —
  // the campaign is school-wide, not about specific programs. The "no
  // picked content for this audience" badge in the per-school preview is
  // meaningless in those cases and looks like an error. Pass this down so
  // TouchpointCard can suppress the badge when no picks were made.
  const hasContentPicks =
    (inputs?.what?.program_ids?.length ?? 0) > 0 ||
    (inputs?.what?.camp_session_ids?.length ?? 0) > 0;

  // Preview entries — the dropdown lets the operator see what a parent in
  // EACH AUDIENCE SCOPE sees. Source of truth: the Q2 audience filter
  // (inputs.who.filter), NOT the Q1 catalog picks. The audience is who the
  // email actually goes to; the preview should mirror that. Unified across
  // all campaign types (afterschool / camps / one-off).
  //
  //   filter.type='school'     → one entry per school in filter.school_ids
  //   filter.type='area'       → one entry per area in filter.areas (or
  //                              legacy filter.area)
  //   filter.type='master_list'→ empty dropdown ("send a test to preview")
  //   filter.type='person'     → single entry for that recipient
  //
  // Each entry: { value, label, kind }
  //   value: a program_locations.id the renderer uses (for area entries we
  //          pick ANY location in that area as the representative; the
  //          synthetic recipient's geo_segment is what drives camp-token
  //          resolution per area)
  //   label: what the operator sees ("Hillsboro" or "Alameda Elementary")
  //   kind:  'school' | 'area' — used for the dropdown placeholder copy
  const [pickedLocations, setPickedLocations] = useState([]);
  const filterKey = JSON.stringify(inputs?.who?.filter ?? {});
  useEffect(() => {
    const filter = inputs?.who?.filter ?? {};
    let alive = true;
    (async () => {
      const out = [];
      const seen = new Set();

      // Audience-scope school: one entry per school
      if (filter.type === "school" && Array.isArray(filter.school_ids) && filter.school_ids.length > 0) {
        const { data: locs, error } = await supabase
          .from("program_locations")
          .select("id, name")
          .eq("organization_id", org?.id)
          .in("id", filter.school_ids);
        if (!error) {
          for (const l of locs ?? []) {
            if (seen.has(l.id)) continue;
            seen.add(l.id);
            out.push({ value: l.id, label: l.name, kind: "school" });
          }
        }
      }

      // Audience-scope area: one entry per area (representative location for
      // the renderer to look up the area's recipients + camps).
      if (filter.type === "area") {
        const areas = Array.isArray(filter.areas)
          ? filter.areas
          : (typeof filter.area === "string" && filter.area ? [filter.area] : []);
        if (areas.length > 0) {
          const { data: locs, error } = await supabase
            .from("program_locations")
            .select("id, name, district")
            .eq("organization_id", org?.id)
            .in("district", areas);
          if (!error) {
            const byDistrict = new Map();
            for (const l of locs ?? []) {
              if (!l.district || byDistrict.has(l.district)) continue;
              byDistrict.set(l.district, l.id);
            }
            for (const area of areas) {
              const locId = byDistrict.get(area);
              if (!locId || seen.has(locId)) continue;
              seen.add(locId);
              out.push({ value: locId, label: area, kind: "area" });
            }
          }
        }
      }

      // master_list / person / auto: dropdown stays empty — operator uses
      // "send test to yourself" for those preview cases.

      out.sort((a, b) => a.label.localeCompare(b.label));
      if (alive) setPickedLocations(out);
    })();
    return () => { alive = false; };
  }, [filterKey, org?.id]);

  const topicColors = useMemo(() => {
    const topics = new Set();
    for (const tp of touchpoints) for (const t of tp.topics ?? []) topics.add(t);
    const map = {};
    [...topics].forEach((t, i) => { map[t] = TOPIC_PALETTE[i % TOPIC_PALETTE.length]; });
    return map;
  }, [touchpoints]);

  const firstDate = touchpoints[0]?.scheduled_at;
  const lastDate = touchpoints[touchpoints.length - 1]?.scheduled_at;
  const operatorNotes = draft?.schedule?.notes_to_operator?.trim();
  const zeroRecipients = draft?.warning === "no_recipients_matched" || recipients.count === 0;

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", paddingBottom: 96 }}>
      <button
        onClick={onBack}
        style={{
          background: "transparent", border: "none", color: MUTED,
          cursor: "pointer", fontSize: 13, fontFamily: "inherit",
          padding: "0 0 12px", display: "inline-flex", alignItems: "center", gap: 4,
        }}
      >
        ← Back to questions
      </button>

      {/* Ennie's note + zero-recipients warning hoisted ABOVE the summary card
          so the operator reads the context (e.g. "early-bird deadline is only
          3 days away — kickoff sends tomorrow, reminders bunch in week 1")
          BEFORE the window dates that the context explains. */}
      {operatorNotes && (
        <div style={{
          background: "#FFF8E1", border: "1px solid #E6C77A", borderRadius: 8,
          padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#5C4A1C",
        }}>
          <strong style={{ fontWeight: 700 }}>A note from Ennie:</strong> {operatorNotes}
        </div>
      )}

      {zeroRecipients && (
        <div style={{
          background: "#FDECEA", border: "1px solid #E5A6A0", borderRadius: 8,
          padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#7A1F19",
        }}>
          <strong style={{ fontWeight: 700 }}>No recipients matched.</strong> Ennie drafted the schedule, but no parents fit this filter yet. Go back and widen the audience, or save as a draft for later.
        </div>
      )}

      <div style={{
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
        padding: "18px 20px", marginBottom: 12,
      }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, margin: 0 }}>
          Draft plan · review &amp; approve
        </p>
        <h2 style={{ margin: "4px 0 6px", fontSize: 22, color: INK }}>
          Here's the campaign Ennie put together.
        </h2>
        <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>
          {draft?.schedule?.summary || "Expand any touchpoint to edit and preview. Approve when it's right."}
        </p>

        {/* Plan summary grid — Topics and Audience are surfaced elsewhere
            (topic chips on each touchpoint card; recipient count in its own
            card below), so this row stays minimal: when + who-the-sender-is. */}
        <div style={{
          marginTop: 14, display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12, fontSize: 13,
        }}>
          <div>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Window</div>
            <div style={{ marginTop: 2 }}>{fmtDate(firstDate)} — {fmtDate(lastDate)}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", letterSpacing: 0.4, fontWeight: 600 }}>Sender</div>
            <div style={{ marginTop: 2 }}>{sender.name}</div>
            {sender.email && (
              <div style={{ marginTop: 1, fontSize: 11, color: MUTED, fontFamily: "ui-monospace, monospace" }}>
                {sender.email}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recipient summary */}
      <div style={{
        background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10,
        padding: 14, marginBottom: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: INK }}>
              {recipients.count} recipients
            </div>
            <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{recipients.segment_summary}</div>
          </div>
          <button
            onClick={() => setRecipientsOpen((v) => !v)}
            style={{
              background: "#fff", border: `1px solid ${RULE}`, color: INK,
              padding: "6px 12px", borderRadius: 6, cursor: "pointer",
              fontSize: 12, fontFamily: "inherit",
            }}
          >
            {recipientsOpen ? "Hide list" : "View list"}
          </button>
        </div>
        {recipientsOpen && (
          <RecipientList ids={recipients.ids} onRemove={onRemoveRecipient} />
        )}
      </div>

      {/* Touchpoint list */}
      <h3 style={{ margin: "16px 0 8px", fontSize: 14, color: INK, fontWeight: 700 }}>
        The schedule ({touchpoints.length} touchpoint{touchpoints.length === 1 ? "" : "s"})
      </h3>
      {touchpoints.map((tp, i) => (
        <TouchpointCard
          key={tp.id}
          touchpoint={tp}
          defaultOpen={i === 0}
          timezone={timezone}
          topicColors={topicColors}
          onUpdate={onUpdateTouchpoint}
          onCommit={onCommitTouchpoint}
          onSendTest={onSendTest}
          onRegenerate={onRegenerate}
          // Per-school preview: list of {id, name} for the dropdown,
          // and the campaign id so the card can call mode='preview' itself.
          pickedLocations={pickedLocations}
          hasContentPicks={hasContentPicks}
          campaignId={draft?.campaign_id}
        />
      ))}

      {/* Sticky action bar */}
      <div style={{
        position: "fixed", bottom: 0, left: 0, right: 0,
        padding: "12px 16px", background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(6px)", borderTop: `1px solid ${RULE}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: 12, zIndex: 5,
      }}>
        <div style={{ fontSize: 12, color: MUTED, flex: 1, minWidth: 0 }}>
          Approving locks the schedule. You can still edit before each send fires.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onSaveDraft}
            disabled={busy}
            style={{
              background: busyAction === "save" ? "#efeae0" : "#fff",
              border: `1px solid ${RULE}`,
              color: busyAction === "save" ? MUTED : INK,
              padding: "8px 14px", borderRadius: 6,
              cursor: busy ? "wait" : "pointer",
              fontSize: 13, fontFamily: "inherit",
              transition: "background 0.15s ease, color 0.15s ease",
              opacity: busy && busyAction !== "save" ? 0.5 : 1,
            }}
          >
            {busyAction === "save" ? "Saving…" : "Save as draft"}
          </button>
          <button
            onClick={() => {
              // Send test for the FIRST touchpoint by default — the sticky-bar
              // button is a convenience for "test the whole campaign quickly"
              // without scrolling to a specific touchpoint card. Per-touchpoint
              // buttons in TouchpointCard target their own id.
              // (Bug fix: was `onClick={onSendTest}` which passed the React
              // click event as the first arg, hitting "Converting circular
              // structure to JSON" when supabase.functions.invoke tried to
              // stringify the body.)
              if (touchpoints[0]?.id) onSendTest?.(touchpoints[0].id);
              else alert("No touchpoints to test — draft a campaign first.");
            }}
            disabled={busy || touchpoints.length === 0}
            style={{
              background: busyAction === "test" ? "#efeae0" : "#fff",
              border: `1px solid ${INFO}`,
              color: busyAction === "test" ? MUTED : INFO,
              padding: "8px 14px", borderRadius: 6,
              cursor: busy ? "wait" : "pointer",
              fontSize: 13, fontFamily: "inherit",
              transition: "background 0.15s ease, color 0.15s ease",
              opacity: busy && busyAction !== "test" ? 0.5 : 1,
            }}
          >
            {busyAction === "test" ? "Sending test…" : "Send test to me"}
          </button>
          <button
            onClick={onApprove}
            disabled={busy || touchpoints.length === 0}
            style={{
              background: busyAction === "approve"
                ? "#9b87b9"  // softened purple while the approve write is in-flight
                : (busy || touchpoints.length === 0 ? "#cfcfcf" : PURPLE),
              color: "#fff", border: "none",
              padding: "10px 16px", borderRadius: 6,
              cursor: busy || touchpoints.length === 0 ? "wait" : "pointer",
              fontSize: 14, fontWeight: 600, fontFamily: "inherit",
              transition: "background 0.15s ease",
              opacity: busy && busyAction !== "approve" ? 0.5 : 1,
            }}
          >
            {busyAction === "approve" ? "Approving…" : "Approve & schedule ✨"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RecipientList({ ids, onRemove }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!ids || ids.length === 0) { setRows([]); return; }
    let alive = true;
    setRows(null);
    setErr(null);
    // PostgREST puts .in(...) values in the URL. ~500 UUIDs is the safe ceiling
    // before the URL exceeds standard length limits and the query silently
    // 414s or returns empty. We render the first 50 anyway, but we still need
    // to look up 'em all so the count-displayed and the rows-displayed agree
    // on which 50 we picked. Chunk into 500-id batches.
    const sliced = ids.slice(0, 1000);
    const CHUNK = 500;
    (async () => {
      try {
        const byId = new Map();
        for (let i = 0; i < sliced.length; i += CHUNK) {
          const batch = sliced.slice(i, i + CHUNK);
          const { data, error } = await supabase
            .from("marketing_recipients")
            .select("id, parent_name, email, school_name")
            .in("id", batch);
          if (error) throw error;
          // eslint-disable-next-line no-console
          console.log(`[RecipientList] batch ${i}-${i + batch.length}: requested ${batch.length}, got ${(data ?? []).length}`);
          for (const r of (data ?? [])) byId.set(r.id, r);
        }
        if (!alive) return;
        // eslint-disable-next-line no-console
        console.log(`[RecipientList] total: requested ${sliced.length}, hydrated ${byId.size}`);
        // Preserve incoming order so the operator sees the same shape they had
        setRows(sliced.map((id) => byId.get(id)).filter(Boolean));
      } catch (e) {
        if (alive) setErr(e?.message ?? "load failed");
      }
    })();
    return () => { alive = false; };
  }, [ids]);

  if (!ids || ids.length === 0) {
    return (
      <p style={{ fontSize: 12, color: MUTED, margin: "8px 0 0" }}>
        No recipients matched this filter.
      </p>
    );
  }
  if (err) {
    return (
      <p style={{ fontSize: 12, color: "#b3261e", margin: "8px 0 0" }}>
        Couldn't load recipient details: <code style={{ fontFamily: "ui-monospace, monospace" }}>{err}</code>. Refresh to retry.
      </p>
    );
  }
  if (rows === null) {
    return <p style={{ fontSize: 12, color: MUTED, margin: "8px 0 0" }}>Loading recipients…</p>;
  }
  return (
    <div style={{
      marginTop: 10, border: `1px solid ${RULE}`, borderRadius: 6,
      maxHeight: 240, overflowY: "auto",
    }}>
      {rows.slice(0, 50).map((r) => (
        <div key={r.id} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", borderBottom: `1px solid ${RULE}`, fontSize: 13, color: INK, gap: 8,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, color: INK }}>{r.parent_name || "(no name on file)"}</div>
            <div style={{ fontSize: 11, color: MUTED, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.email}{r.school_name ? ` · ${r.school_name}` : ""}
            </div>
          </div>
          <button
            onClick={() => onRemove?.(r.id)}
            style={{ background: "transparent", border: "none", color: "#b3261e", cursor: "pointer", fontSize: 12, fontFamily: "inherit", flexShrink: 0 }}
          >
            Remove
          </button>
        </div>
      ))}
      {ids.length > 50 && (
        <div style={{ padding: "8px 12px", fontSize: 11, color: MUTED }}>
          Showing first 50 of {ids.length}.
        </div>
      )}
    </div>
  );
}
