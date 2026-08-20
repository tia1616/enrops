// The waiting list for one class, and the one place a family comes off it.
//
// ONE COMPONENT, TWO HOMES. The per-class roster page (/admin/programs/:id/roster) and
// the expanded row on Class rosters (/admin/rosters) are two views of the same thing, and
// the two navs render different components - the standing parity trap in this codebase.
// Jessica, 2026-08-19: "no one will know it's there. shouldn't it be in this expanded
// view" - the roster page is behind a View/print button, so a waiting list that lives
// only there is a feature nobody finds.
//
// So the markup and the Remove action exist HERE, once. Both surfaces mount this.
// Duplicating the rule was how "enrolled" ended up meaning three different things.

import { useState } from "react";
import { supabase } from "../lib/supabase.js";
import { WAITLIST_STATUS } from "../lib/waitlistState.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e6e6e6";
const RED = "#b3261e";
const BRIGHT = "#5847C9";
const PANEL = "#faf9ff";

function gradeText(g) {
  if (g === null || g === undefined || g === "") return null;
  return Number(g) === 0 ? "Grade K" : `Grade ${g}`;
}

/**
 * @param programId  the class
 * @param orgId      the org that owns it
 * @param rows       [{ id, waitlist_position, student:{...}, parent:{...} }] in line order
 * @param canEdit    may this user take someone off the list?
 * @param onChanged  called with the fresh rows after a successful removal
 * @param compact    true inside the Class rosters expanded row, which already has a
 *                   heading and a border around it, so this drops its own chrome
 */
export default function WaitingList({ programId, orgId, rows, canEdit, onChanged, compact = false }) {
  const [removingId, setRemovingId] = useState(null);
  const [error, setError] = useState("");

  // Rendered only when there are some. An empty "Waiting list (0)" on every roster in
  // the platform is noise on a screen operators open constantly.
  if (!rows || rows.length === 0) return null;

  async function remove(row) {
    const childName = `${row.student?.first_name ?? ""} ${row.student?.last_name ?? ""}`.trim() || "this child";
    if (!window.confirm(
      `Take ${childName} off the waitlist for this class?\n\n`
      + `They will lose their place and everyone below them moves up. `
      + `If they want back on, they can join again and go to the end of the list.`
    )) return;

    setRemovingId(row.id);
    setError("");
    const { data, error: rpcErr } = await supabase.rpc("waitlist_remove", {
      p_registration_id: row.id,
      p_org_id: orgId,
    });
    if (rpcErr) {
      // Say so where they are looking. A silent failure reads as "it worked": the row
      // would still be on screen and the operator would tell the family it was done.
      setError(`Couldn't remove ${childName}: ${rpcErr.message}`);
      setRemovingId(null);
      return;
    }
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.removed) {
      setError(`${childName} was already off the list. Refresh to see the current list.`);
      setRemovingId(null);
      return;
    }

    // Re-read rather than splicing locally: waitlist_remove RENUMBERS everyone behind
    // them, so the positions in state are stale the instant this succeeds. Showing the
    // old numbers would contradict what those families are told next.
    const { data: fresh, error: freshErr } = await supabase
      .from("registrations")
      .select(`
        id, waitlist_position, registered_at,
        student:students ( id, first_name, last_name, grade ),
        parent:parents ( first_name, last_name, email, phone )
      `)
      .eq("program_id", programId)
      .eq("status", WAITLIST_STATUS)
      .is("cancelled_at", null)
      .order("waitlist_position", { ascending: true });
    if (!freshErr) onChanged?.(fresh ?? []);
    setRemovingId(null);
  }

  return (
    <div style={{ marginTop: compact ? 14 : 32 }}>
      <h2 style={{ fontSize: compact ? 13 : 15, fontWeight: 700, color: INK, margin: "0 0 4px" }}>
        Waitlist ({rows.length})
      </h2>
      <p style={{ fontSize: 13, color: MUTED, margin: "0 0 12px", maxWidth: 620 }}>
        These families will be automatically notified when a place opens up.
        {canEdit && " If a family asks to come off the waitlist, remove them here."}
      </p>

      {/* Above the rows, so it is next to the one that failed rather than below a list
          that can run past the fold. */}
      {error && (
        <div style={{
          marginBottom: 12, padding: "10px 12px", borderRadius: 8,
          border: `1.5px solid ${RED}`, background: "rgba(179,38,30,0.06)",
          fontSize: 13, color: RED, maxWidth: 620,
        }}>
          {error}
        </div>
      )}

      <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
        {rows.map((w, i) => {
          const s = w.student ?? {};
          const p = w.parent ?? {};
          const childName = `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim() || "(no name)";
          const parentName = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
          const grade = gradeText(s.grade);
          return (
            <div
              key={w.id}
              style={{
                display: "flex", gap: 12, alignItems: "baseline",
                padding: "10px 14px", fontSize: 14, background: PANEL,
                borderTop: i === 0 ? "none" : `1px solid ${RULE}`,
              }}
            >
              {/* The STORED position, not the array index. If the two ever disagree the
                  stored one is what every other surface and email uses, and a
                  renumbered-looking list would make an operator distrust all of it. */}
              <span style={{ minWidth: 22, fontWeight: 700, color: MUTED }}>
                {w.waitlist_position ?? i + 1}
              </span>
              <span style={{ fontWeight: 600, color: INK }}>{childName}</span>
              {grade && <span style={{ color: MUTED, fontSize: 13 }}>{grade}</span>}
              <span style={{ flex: 1 }} />
              <span style={{ color: MUTED, fontSize: 13, textAlign: "right" }}>
                {parentName && <>{parentName} · </>}
                {p.email ? <a href={`mailto:${p.email}`} style={{ color: BRIGHT }}>{p.email}</a> : "no email"}
                {p.phone && <> · {p.phone}</>}
              </span>
              {/* Staff and up. A viewer reads the list but does not change who is on it.
                  Hidden rather than disabled: a control a viewer can never use is noise
                  on every row. waitlist_remove re-checks with can_edit_org either way,
                  so hiding it is presentation, not the guard. */}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => remove(w)}
                  disabled={removingId === w.id}
                  title={`Take ${childName} off the waitlist`}
                  style={{
                    border: "none", background: "none", padding: "2px 4px",
                    color: removingId === w.id ? MUTED : RED,
                    fontSize: 13, fontWeight: 600,
                    cursor: removingId === w.id ? "wait" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {removingId === w.id ? "Removing…" : "Remove"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
