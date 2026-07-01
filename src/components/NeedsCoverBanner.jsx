// NeedsCoverBanner — coral alert for a schedule page listing upcoming class-days
// that are genuinely UNCOVERED: a sub declined (or was never confirmed) and no
// one else is filling in for that class+date. Silent when everything's covered.
//
// Self-contained: fetches its own data keyed by org + parent type ('camp' |
// 'program'), so it drops onto Schedule.jsx (camps) and AfterschoolSchedule.jsx
// (after-school) without touching their state. Mirrors the homescreen split in
// AdminOverview — a slot with a confirmed/taught sub is covered; a still-pending
// offer is "awaiting", not shown here; only declined-with-no-replacement surfaces.
//
// Read-only surfacing (v1). Clearing happens through the existing sub UI (assign
// a sub for that day). "Lead can cover after all" + click-to-jump are fast-follows.

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}
function personName(i) {
  if (!i) return null;
  const n = `${i.preferred_name || i.first_name || ""}${i.last_name ? ` ${i.last_name}` : ""}`.trim();
  return n || null;
}

export default function NeedsCoverBanner({ org, parentType }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!org?.id || (parentType !== "camp" && parentType !== "program")) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const { data: subs } = await supabase
          .from("assignment_substitutions")
          .select("parent_assignment_id, date, status, sub:instructors!sub_instructor_id(first_name, preferred_name, last_name)")
          .eq("organization_id", org.id)
          .eq("parent_assignment_type", parentType)
          .gte("date", today);

        // Group by class+date; keep only genuinely-uncovered slots.
        const slots = new Map();
        for (const r of subs ?? []) {
          const k = `${r.parent_assignment_id}|${r.date}`;
          if (!slots.has(k)) slots.set(k, { parent: r.parent_assignment_id, date: r.date, statuses: new Set(), decliner: null });
          const g = slots.get(k);
          g.statuses.add(r.status);
          if (r.status === "declined" && !g.decliner) g.decliner = personName(r.sub);
        }
        const uncovered = [];
        for (const g of slots.values()) {
          if (g.statuses.has("confirmed") || g.statuses.has("taught")) continue; // covered
          if (g.statuses.has("pending")) continue;                                // still awaiting
          if (g.statuses.has("declined")) uncovered.push(g);                      // no one coming
        }
        if (uncovered.length === 0) { if (!cancelled) setItems([]); return; }

        // Resolve a human class label for each uncovered parent assignment.
        const parentIds = Array.from(new Set(uncovered.map((u) => u.parent)));
        const labelBy = new Map();
        if (parentType === "camp") {
          const { data: cas } = await supabase.from("camp_assignments").select("id, camp_session_id").in("id", parentIds);
          const sessIds = Array.from(new Set((cas ?? []).map((c) => c.camp_session_id).filter(Boolean)));
          const { data: sess } = sessIds.length
            ? await supabase.from("camp_sessions").select("id, curriculum_name, location_name").in("id", sessIds)
            : { data: [] };
          const sessById = new Map((sess ?? []).map((s) => [s.id, s]));
          for (const c of cas ?? []) {
            const s = sessById.get(c.camp_session_id);
            labelBy.set(c.id, s ? `${s.curriculum_name || "A class"}${s.location_name ? ` · ${s.location_name}` : ""}` : "A class");
          }
        } else {
          const { data: pas } = await supabase.from("program_assignments").select("id, program_id").in("id", parentIds);
          const progIds = Array.from(new Set((pas ?? []).map((p) => p.program_id).filter(Boolean)));
          const { data: progs } = progIds.length
            ? await supabase.from("programs").select("id, curriculum, program_location_id").in("id", progIds)
            : { data: [] };
          const progById = new Map((progs ?? []).map((p) => [p.id, p]));
          const locIds = Array.from(new Set((progs ?? []).map((p) => p.program_location_id).filter(Boolean)));
          const { data: locs } = locIds.length
            ? await supabase.from("program_locations").select("id, name").in("id", locIds)
            : { data: [] };
          const locName = new Map((locs ?? []).map((l) => [l.id, l.name]));
          for (const p of pas ?? []) {
            const pr = progById.get(p.program_id);
            const loc = pr ? locName.get(pr.program_location_id) : null;
            labelBy.set(p.id, pr ? `${pr.curriculum || "A class"}${loc ? ` · ${loc}` : ""}` : "A class");
          }
        }

        const built = uncovered
          .map((u) => ({ ...u, label: labelBy.get(u.parent) || "A class" }))
          .sort((a, b) => a.date.localeCompare(b.date));
        if (!cancelled) setItems(built);
      } catch (e) {
        console.error("[NeedsCoverBanner] load failed", e);
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, parentType]);

  if (!items.length) return null;

  return (
    <div style={{ background: `${CORAL}0F`, border: `1px solid ${CORAL}55`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: CORAL, marginBottom: 6 }}>
        {items.length === 1 ? "1 day needs cover" : `${items.length} days need cover`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((it) => (
          <div key={`${it.parent}|${it.date}`} style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
            <strong>{fmtDate(it.date)}</strong>{" — "}{it.label}
            <span style={{ color: MUTED }}>{it.decliner ? ` · ${it.decliner} declined, no sub yet` : " · no sub yet"}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
        Line up another sub on the day below, or the lead can take it back.
      </div>
    </div>
  );
}
