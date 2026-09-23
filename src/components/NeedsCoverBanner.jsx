// NeedsCoverBanner — coral alert for a schedule page listing upcoming class-days
// that are genuinely UNCOVERED: a sub declined and no one else is filling in for
// that class+date. Silent when everything's covered.
//
// Data comes from ONE source of truth — the get_sub_coverage(p_org) RPC — shared
// with the homescreen (AdminOverview). The RPC only returns slots whose parent
// class is still alive (camp not cancelled/withdrawn, program not cancelled,
// parent not deleted), so a cancelled/orphaned class can't leave a stale
// "needs cover" alarm here. It splits coverage the same way the homescreen does,
// in three states (migration 20260923b):
//   'uncovered' - somebody said no and no offer is out   -> shown here
//   'at_risk'   - somebody said no and an offer IS out   -> shown here
//   'lead_out'  - the instructor marked the date off in their availability
//                 survey and NOBODY has been asked yet   -> shown here
//   'awaiting'  - offers out and nobody has said no      -> not shown here
// We filter to this page's parentType.
//
// One row is one COVERAGE SLOT -- a class needing somebody on a date -- not one
// calendar day and not one offer. A camp session staffed by both a lead and a
// developing instructor is two slots, so a day both are out is two rows and two
// people to find. The day somebody ACCEPTED is excluded whole, so the losing
// offers it records as declines can never put a covered day on this banner.
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

// Who turned this day down. A day can now be offered to several people at once,
// so there are four states and each sentence has to be TRUE in the state that
// selects it — no branch may borrow another's wording:
//   several declined  -> count them; naming one would be false about the others
//   one, named        -> name them (also the path an older RPC takes, since it
//                        sends no count and `?? 0` leaves this the only branch)
//   one, unnamed      -> say somebody did, rather than swallowing the decline
//   nothing known     -> say only what is certain: no sub yet
function whoDeclined(it) {
  // The instructor told us they are out and nobody has been asked yet. This is
  // NOT a decline and must never borrow a decline's wording: nobody refused
  // this class, and saying somebody did would send the operator looking for a
  // conversation that never happened.
  if (it.state === "lead_out") {
    return it.leadOut
      ? ` · ${it.leadOut} is out — no sub asked yet`
      : " · the instructor is out — no sub asked yet";
  }
  // Who said no. One named person, several counted, or one we cannot name.
  const said = it.declineCount > 1
    ? `${it.declineCount} people declined`
    : it.decliner
      ? `${it.decliner} declined`
      : it.declineCount === 1
        ? "someone declined"
        : null;
  // What is happening now. A day with an offer still out is NOT the same as a
  // day with nobody asked, and it must not borrow the other's wording.
  // "no sub yet" implied nobody had got round to asking. Two newer populations
  // arrive in this same branch and that sentence is false of both: a day whose
  // cover was RELEASED had a sub and lost one, and a day whose offer email
  // never left has rows but no ask. The wording has to be true of all three,
  // and "nobody is covering this" is the thing they actually have in common.
  const now = it.offersOut > 0
    ? (it.offersOut === 1 ? "1 offer still out" : `${it.offersOut} offers still out`)
    : "nobody is covering it";
  return said ? ` · ${said}, ${now}` : ` · ${now}`;
}

export default function NeedsCoverBanner({ org, parentType }) {
  const [items, setItems] = useState([]);
  // A failed read is not "everything is covered". The homescreen's own failure
  // card sends the operator HERE to resolve it, so this page rendering a clean
  // board on the same failure would be the one surface that lies about it.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!org?.id || (parentType !== "camp" && parentType !== "program")) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc("get_sub_coverage", { p_org: org.id });
        if (error) throw error;
        // 'uncovered' = somebody said no and nothing is out. 'at_risk' = somebody
        // said no and an offer is still out. BOTH belong here: a day two people
        // have already turned down is not a day to sit quietly on because a
        // third has not replied.
        const built = (data ?? [])
          .filter((r) => r.parent_assignment_type === parentType
                      && (r.state === "uncovered" || r.state === "at_risk" || r.state === "lead_out"))
          .map((r) => ({
            parent: r.parent_assignment_id,
            date: r.slot_date,
            state: r.state,
            decliner: r.decliner_name || null,
            leadOut: r.lead_out_name || null,
            declineCount: r.decline_count ?? 0,
            offersOut: r.offers_out ?? 0,
            label: `${r.curriculum_label || "A class"}${r.location_label ? ` · ${r.location_label}` : ""}`,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));
        if (!cancelled) { setItems(built); setFailed(false); }
      } catch (e) {
        console.error("[NeedsCoverBanner] load failed", e);
        if (!cancelled) { setItems([]); setFailed(true); }
      }
    })();
    return () => { cancelled = true; };
  }, [org?.id, parentType]);

  if (failed) {
    return (
      <div style={{ background: `${CORAL}0F`, border: `1px solid ${CORAL}55`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: CORAL, marginBottom: 4 }}>
          We couldn&rsquo;t check sub coverage
        </div>
        <div style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
          This board can&rsquo;t tell you whether any class day needs a sub right now. Reload the page to try again.
        </div>
      </div>
    );
  }

  if (!items.length) return null;

  // Count the SLOTS, one per class needing somebody on a date -- which is what
  // each line below is, and what the operator has to act on.
  //
  // Deduping on the date alone was tried and is worse: two different classes
  // uncovered on the same Monday would collapse to "1 day needs cover" over two
  // lines, and an operator who reads the headline lines up one sub and leaves
  // the other class empty. An alarm may over-count (a camp session needing both
  // a lead and a developing sub counts twice, which is two people to find) but
  // must never under-count.
  const slotCount = items.length;

  return (
    <div style={{ background: `${CORAL}0F`, border: `1px solid ${CORAL}55`, borderRadius: 12, padding: "12px 14px", marginBottom: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: CORAL, marginBottom: 6 }}>
        {slotCount === 1 ? "1 class day needs cover" : `${slotCount} class days need cover`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((it) => (
          <div key={`${it.parent}|${it.date}`} style={{ fontSize: 13, color: INK, lineHeight: 1.45 }}>
            <strong>{fmtDate(it.date)}</strong>{" — "}{it.label}
            <span style={{ color: MUTED }}>{whoDeclined(it)}</span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
        Line up another sub on the day below, or the lead can take it back.
      </div>
    </div>
  );
}
