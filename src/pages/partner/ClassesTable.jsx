// "Classes at your sites": every class and camp this provider runs at the
// partner's sites that has not ended, with enrolled / max (Jessica 2026-11-19:
// "like 5/18"), the instructor, and a roster the partner opens in the row.
// Rendered by the partner's page AND the provider's own page for that partner
// (admin/PartnerRecord), like the rest of ProviderRecord, so both see the same
// numbers. The provider's page adds "Enter count" on a class it registers
// outside enrops (count_source 'provider').
//
// Loads its own data: listPartnerClasses (20261119a) decides who may see what,
// including per-site logins. A roster is fetched only when opened, and the
// database logs a partner's open in the same call.

import { useEffect, useRef, useState } from "react";
import DocumentStatusBadge from "../../components/DocumentStatusBadge.jsx";
import { formatTermLabel } from "../../lib/terms.js";
import { listPartnerClasses, getClassRoster, getRegistrationFields, setReportedEnrollment } from "../../lib/partnerPortal.js";
import {
  scheduleText, enrolledText, countSourceText, classBadge, rosterAvailable,
  sortClasses, rosterDisplayRows, asksDismissal, showsHomeroom, groupClassesByTerm,
} from "../../lib/partnerClasses.js";

const TH = "border-b border-j2s-ink/10 bg-white px-3 py-2 text-left text-xs font-semibold text-j2s-ink/60";
const TD = "border-b border-j2s-ink/10 px-3 py-2 align-top";

const keyOf = (c) => `${c.kind}:${c.class_id}`;

// `onCount(n)`: how many classes loaded, for the count on the page's tab (null = failed).
export default function ClassesTable({ partnerId, orgId, orgName, viewer = "partner", partnerName = "", canEdit = false, onCount }) {
  const [classes, setClasses] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(null);          // key of the class whose roster is open
  const [rosters, setRosters] = useState({});      // key -> { rows, asks } | { error }
  const loadingRoster = useRef(new Set());
  const [edit, setEdit] = useState(null);          // { key, value, saving, error }
  const [saved, setSaved] = useState("");          // key just saved, for the confirmation in that row

  async function load() {
    try {
      const rows = await listPartnerClasses(partnerId);
      setClasses(sortClasses(rows));
      onCount?.(rows.length);
      setLoadError("");
    } catch (err) {
      setClasses((prev) => prev ?? []);
      onCount?.(null);
      setLoadError(`Couldn't load classes: ${err?.message ?? "unknown error"}`);
    }
  }

  useEffect(() => {
    setClasses(null); setOpen(null); setRosters({}); setEdit(null); setSaved("");
    if (partnerId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  async function toggleRoster(c) {
    const k = keyOf(c);
    if (open === k) { setOpen(null); return; }
    setOpen(k);
    if (rosters[k]?.rows || loadingRoster.current.has(k)) return;
    loadingRoster.current.add(k);
    try {
      const [rows, fields] = await Promise.all([
        getClassRoster(partnerId, c.kind, c.class_id),
        getRegistrationFields(orgId, c.kind === "class" ? c.class_id : null),
      ]);
      const shown = rosterDisplayRows(rows);
      setRosters((m) => ({ ...m, [k]: { rows: shown, asks: asksDismissal(fields, c.kind), homeroom: showsHomeroom(shown) } }));
    } catch (err) {
      setRosters((m) => ({ ...m, [k]: { error: `Couldn't load the roster: ${err?.message ?? "unknown error"}` } }));
    } finally {
      loadingRoster.current.delete(k);
    }
  }

  async function saveCount(c) {
    if (!edit || edit.saving) return;
    const n = Number(edit.value);
    if (edit.value === "" || !Number.isInteger(n) || n < 0 || n > 10000) {
      setEdit((e) => ({ ...e, error: "Enter a whole number, 0 or more." }));
      return;
    }
    setEdit((e) => ({ ...e, saving: true, error: "" }));
    try {
      await setReportedEnrollment(c.kind, c.class_id, n);
      // Counts just changed; a roster fetched earlier must not outlive them.
      setRosters({}); setOpen(null);
      await load();
      setEdit(null);
      setSaved(keyOf(c));
    } catch (err) {
      setEdit((e) => ({ ...e, saving: false, error: err?.message ?? "Couldn't save the count." }));
    }
  }

  const heading = viewer === "provider" ? `Classes at ${partnerName || "this partner"}'s sites` : "Classes at your sites";

  return (
    <section className="mt-5 rounded-2xl bg-white shadow-card">
      <h2 className="px-4 pt-4 text-base font-bold text-j2s-ink">{heading}</h2>
      {loadError && <p className="error-text px-4 pt-2">{loadError}</p>}
      {classes === null ? (
        <p className="px-4 pb-4 pt-2 text-sm text-j2s-ink/60">Loading…</p>
      ) : classes.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-j2s-ink/70">
          {viewer === "provider"
            ? `You have no current or upcoming classes at ${partnerName || "this partner"}'s sites.`
            : `${orgName || "This provider"} has no current or upcoming classes at your sites.`}
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                <th className={`${TH} sticky left-0 z-10`}>Class</th>
                <th className={TH}>Enrolled</th>
                <th className={TH}>Status</th>
                <th className={TH}>Instructor</th>
              </tr>
            </thead>
            <tbody>
              {/* One heading row per term (Kacy Cullen, 2026-11-19), then its classes. */}
              {groupClassesByTerm(classes, formatTermLabel).flatMap((g) => [
                <tr key={`term:${g.key}`}>
                  <th colSpan={4} scope="colgroup" className="border-b border-j2s-ink/10 bg-j2s-ink/[0.03] px-3 pb-1.5 pt-3 text-left text-sm font-bold text-j2s-ink">
                    {g.label}
                  </th>
                </tr>,
                ...g.classes.flatMap((c) => {
                const k = keyOf(c);
                const count = enrolledText(c);
                const roster = rosters[k];
                const canEnter = viewer === "provider" && canEdit && c.count_source === "provider";
                const editingThis = edit?.key === k;
                return [
                  <tr key={k}>
                    <td className={`${TD} sticky left-0 z-10 min-w-[11rem] max-w-[16rem] bg-white`}>
                      <div className="font-medium text-j2s-ink">{c.title || "Untitled class"}</div>
                      <div className="text-xs text-j2s-ink/55">{c.site}{c.kind === "camp" ? " · Camp" : ""}</div>
                      <div className="text-xs text-j2s-ink/55">{scheduleText(c)}</div>
                      {/* In the pinned first column so it is on screen on a phone. */}
                      {rosterAvailable(c) && (
                        <button type="button" onClick={() => toggleRoster(c)} aria-expanded={open === k}
                          className="mt-0.5 py-1 text-xs font-semibold text-j2s-purple hover:underline">
                          {open === k ? "Hide roster" : "Roster"}
                        </button>
                      )}
                    </td>
                    <td className={`${TD} min-w-[9rem]`}>
                      {count != null && <div className="text-base font-semibold tabular-nums text-j2s-ink">{count}</div>}
                      <div className="text-xs text-j2s-ink/55">{countSourceText(c, { viewer, partnerName, orgName })}</div>
                      {canEnter && !editingThis && (
                        <button type="button" onClick={() => { setSaved(""); setEdit({ key: k, value: c.enrolled ?? "", saving: false, error: "" }); }}
                          className="mt-1 text-xs font-semibold text-j2s-purple hover:underline">
                          {c.enrolled == null ? "Enter count" : "Update count"}
                        </button>
                      )}
                      {canEnter && editingThis && (
                        <form className="mt-1 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); saveCount(c); }}>
                          <label htmlFor={`count-${k}`} className="sr-only">Enrolled in {c.title}</label>
                          <input id={`count-${k}`} type="number" inputMode="numeric" min="0" max="10000" step="1"
                            value={edit.value} onChange={(e) => setEdit((x) => ({ ...x, value: e.target.value, error: "" }))}
                            className="w-20 rounded border border-j2s-ink/20 px-2 py-1 text-sm" autoFocus />
                          <button type="submit" disabled={edit.saving} className="rounded bg-j2s-purple px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-60">
                            {edit.saving ? "Saving…" : "Save"}
                          </button>
                          <button type="button" disabled={edit.saving} onClick={() => setEdit(null)} className="text-xs text-j2s-ink/60 hover:underline">Cancel</button>
                          {edit.error && <div role="alert" className="w-full text-xs text-red-700">{edit.error}</div>}
                        </form>
                      )}
                      {saved === k && !editingThis && <div role="status" className="mt-1 text-xs font-semibold text-emerald-700">Count saved.</div>}
                    </td>
                    <td className={TD}><DocumentStatusBadge badge={classBadge(c)} /></td>
                    <td className={`${TD} min-w-[8rem] text-j2s-ink/80`}>
                      {c.instructors?.length ? c.instructors.join(", ") : <span className="text-j2s-ink/45">Not assigned yet</span>}
                    </td>
                  </tr>,
                  open === k && (
                    <tr key={`${k}:roster`}>
                      <td colSpan={4} className="border-b border-j2s-ink/10 bg-j2s-ink/[0.02] px-3 py-3">
                        {!roster ? (
                          <p className="text-sm text-j2s-ink/60">Loading roster…</p>
                        ) : roster.error ? (
                          <p className="error-text">{roster.error}</p>
                        ) : roster.rows.length === 0 ? (
                          <p className="text-sm text-j2s-ink/70">No one is enrolled yet.</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="min-w-full text-sm">
                              <thead>
                                <tr>
                                  <th className="px-2 py-1 text-left text-xs font-semibold text-j2s-ink/60">Student</th>
                                  <th className="px-2 py-1 text-left text-xs font-semibold text-j2s-ink/60">Grade</th>
                                  {roster.homeroom && <th className="px-2 py-1 text-left text-xs font-semibold text-j2s-ink/60">Homeroom</th>}
                                  {roster.asks && <th className="px-2 py-1 text-left text-xs font-semibold text-j2s-ink/60">Dismissal</th>}
                                </tr>
                              </thead>
                              <tbody>
                                {roster.rows.map((r) => (
                                  <tr key={r.key}>
                                    <td className="px-2 py-1 text-j2s-ink">{r.name}</td>
                                    <td className="px-2 py-1 text-j2s-ink/80">{r.grade}</td>
                                    {roster.homeroom && <td className="px-2 py-1 text-j2s-ink/80">{r.homeroom ?? "Not stated"}</td>}
                                    {roster.asks && <td className="px-2 py-1 text-j2s-ink/80">{r.dismissal}</td>}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              }),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
