// NeedsCoverBanner — coral alert for a schedule page listing upcoming class-days
// that are genuinely UNCOVERED: a sub declined and no one else is filling in for
// that class+date. Silent when everything's covered.
//
// Data comes from ONE source of truth — the get_sub_coverage(p_org) RPC — shared
// with the homescreen (AdminOverview). The RPC only returns slots whose parent
// class is still alive (camp not cancelled/withdrawn, program not cancelled,
// parent not deleted), so a cancelled/orphaned class can't leave a stale
// "needs cover" alarm here. It splits coverage the same way the homescreen does:
// confirmed/taught => covered (not returned), pending => 'awaiting' (not shown
// here), declined => 'uncovered' (shown). We filter to this page's parentType.
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

export default function NeedsCoverBanner({ org, parentType }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    if (!org?.id || (parentType !== "camp" && parentType !== "program")) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("get_sub_coverage", { p_org: org.id });
        if (error) throw error;
        const built = (data ?? [])
          .filter((r) => r.parent_assignment_type === parentType && r.state === "uncovered")
          .map((r) => ({
            parent: r.parent_assignment_id,
            date: r.slot_date,
            decliner: r.decliner_name || null,
            label: `${r.curriculum_label || "A class"}${r.location_label ? ` · ${r.location_label}` : ""}`,
          }))
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
