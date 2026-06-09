// /admin/time-saved
// Full breakdown of the lifetime time-saved tally. The sidebar "Saved with
// Enrops" card links here. Reads time_saved_events for the operator's org and
// groups them by category.
//
// Categories are DERIVED FROM REAL action_types, not hardcoded to the Figma's
// aspirational Marketing/Contacts/Instructors/Community tabs — today our actual
// time-saved data is Curricula + Automations, and more tabs appear automatically
// as instrumentation reaches other surfaces. Org-scoped via outlet context.

import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";   // indigo - active tabs/actions (Figma)
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const GREEN = "#2d5a2d";

// Friendly category per action_type. Unknown types fall back to "Other" so a
// new event type still shows up rather than vanishing.
const CATEGORY_FOR = {
  curriculum_published: "Curricula",
  curriculum_linked: "Curricula",
  automation_fired: "Automations",
};
function categoryFor(actionType) {
  return CATEGORY_FOR[actionType] ?? "Other";
}

function fmtSaved(hours) {
  const h = Number(hours || 0);
  if (h >= 1) return `+${h % 1 === 0 ? h : h.toFixed(1)} hr`;
  return `+${Math.max(1, Math.round(h * 60))} min`;
}

function relativeTime(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export default function TimeSavedPage() {
  const { org } = useOutletContext() ?? {};
  const [events, setEvents] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [activeCat, setActiveCat] = useState("All");

  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from("time_saved_events")
        .select("id, action_type, action_label, hours_saved, created_at")
        .eq("organization_id", org.id)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (err) { setError("Couldn't load your time-saved log."); setEvents([]); return; }
      setEvents(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  const totalHours = useMemo(
    () => (events ?? []).reduce((s, e) => s + Number(e.hours_saved || 0), 0),
    [events],
  );

  // Categories actually present in the data, by summed hours (drives the tabs).
  const categories = useMemo(() => {
    const map = new Map();
    for (const e of events ?? []) {
      const c = categoryFor(e.action_type);
      map.set(c, (map.get(c) ?? 0) + Number(e.hours_saved || 0));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [events]);

  const visible = useMemo(() => {
    if (activeCat === "All") return events ?? [];
    return (events ?? []).filter((e) => categoryFor(e.action_type) === activeCat);
  }, [events, activeCat]);

  return (
    <div>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Saved with Enrops</h1>
        <p style={{ color: MUTED, marginTop: 6, fontSize: 13.5, lineHeight: 1.5 }}>
          Every Enrops action that does work for you — publishing curricula, firing automations, and more — adds to your running total.
        </p>
      </header>

      <div style={{
        display: "inline-flex", alignItems: "center", gap: 12,
        background: "#fff", border: `1px solid ${RULE}`,
        borderRadius: 12, padding: "14px 18px", marginBottom: 18,
      }}>
        <span style={{
          flexShrink: 0, width: 26, height: 26, borderRadius: 999,
          background: "#2e9e4f", color: "#fff",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontSize: 14, fontWeight: 700,
        }}>✓</span>
        <span style={{ fontSize: 30, fontWeight: 700, color: INK }}>{Math.round(totalHours)}+</span>
        <span style={{ fontSize: 14, color: MUTED, fontWeight: 600 }}>hours saved, lifetime</span>
      </div>

      {error && (
        <div style={{ background: "#fff5f5", border: "1px solid #f0c4c4", color: "#7a1a1a", borderRadius: 12, padding: 12, fontSize: 13, marginBottom: 14 }}>
          {error}
        </div>
      )}

      {(events?.length ?? 0) > 0 && (
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${RULE}`, marginBottom: 14, flexWrap: "wrap" }}>
          {["All", ...categories].map((c) => {
            const isActive = c === activeCat;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setActiveCat(c)}
                style={{
                  padding: "8px 14px", background: "transparent", border: "none",
                  borderBottom: isActive ? `2px solid ${BRIGHT}` : "2px solid transparent",
                  color: isActive ? BRIGHT : MUTED, fontWeight: isActive ? 700 : 500,
                  fontSize: 13, fontFamily: "inherit", cursor: "pointer", position: "relative", top: 1,
                }}
              >
                {c}
              </button>
            );
          })}
        </div>
      )}

      {events === null ? (
        <div style={{ color: MUTED, fontSize: 13, padding: 12 }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ background: "#fff", border: `1px dashed ${RULE}`, borderRadius: 12, padding: 28, textAlign: "center", color: MUTED, fontSize: 14 }}>
          No time-saved actions logged yet — they'll show up here as Enrops does work for you.
        </div>
      ) : (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 12, overflow: "hidden" }}>
          {visible.map((e, i) => (
            <div key={e.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              padding: "12px 16px", borderBottom: i < visible.length - 1 ? `1px solid ${RULE}` : "none",
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.3 }}>{e.action_label}</div>
                <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{categoryFor(e.action_type)}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: GREEN }}>{fmtSaved(e.hours_saved)}</span>
                <span style={{ fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>{relativeTime(e.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
