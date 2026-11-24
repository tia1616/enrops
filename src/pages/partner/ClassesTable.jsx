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
import {
  listMarketingAsks, listClassMedia, uploadClassMedia, removeClassMedia, openMarketingFile,
} from "../../lib/partnerMarketing.js";
import {
  wantedAsks, indexMedia, mediaKey, itemOf, askLine, fileProblemForAsk, shareName, extOfPath, mediaGaps, galleryGroups,
} from "../../lib/partnerMarketingLogic.js";
import MarketingGallery from "./MarketingGallery.jsx";

const TH = "border-b border-j2s-ink/10 bg-white px-3 py-2 text-left text-xs font-semibold text-j2s-ink/60";
const TD = "border-b border-j2s-ink/10 px-3 py-2 align-top";

const keyOf = (c) => `${c.kind}:${c.class_id}`;

// `onCount(n)`: how many classes loaded, for the count on the page's tab (null = failed).
// `onMediaGaps(gaps)`: what the partner asked for that isn't on a class yet
// ([{ item, count }], from mediaGaps), for the provider's To do list.
// `onAskMarketing()`: the partner's page takes it to the Marketing asks.
export default function ClassesTable({ partnerId, orgId, orgName, viewer = "partner", partnerName = "", canEdit = false, onCount, onMediaGaps, onAskMarketing }) {
  const [classes, setClasses] = useState(null);
  // Marketing (20261123r): what the partner asks for, and the files on classes.
  const [asks, setAsks] = useState([]);
  const [media, setMedia] = useState(() => new Map());
  const [mediaError, setMediaError] = useState("");

  async function loadMedia() {
    try {
      const [a, m] = await Promise.all([listMarketingAsks(partnerId), listClassMedia(orgId)]);
      setAsks(a);
      setMedia(indexMedia(m));
      setMediaError("");
      return { a, m: indexMedia(m) };
    } catch (err) {
      setMediaError(`Couldn't load flyers and graphics: ${err?.message ?? "unknown error"}`);
      return null;
    }
  }
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
    if (partnerId) { load(); if (orgId) loadMedia(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId, orgId]);

  // The provider's To do list hears what's still missing.
  useEffect(() => {
    if (classes && onMediaGaps) onMediaGaps(mediaGaps(classes, asks, media));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, asks, media]);

  const wanted = wantedAsks(asks);

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
      {mediaError && <p className="error-text px-4 pt-2">{mediaError}</p>}
      {/* "Flyers on 2 of 4 classes": the partner sees at a glance what's in. */}
      {classes?.length > 0 && wanted.length > 0 && (
        <p className="px-4 pt-1 text-sm text-j2s-ink/70">
          {wanted.map((a) => {
            const live = classes.filter((c) => c.status !== "cancelled");
            const have = live.filter((c) => media.has(mediaKey(c.kind, c.class_id, a.item_key))).length;
            return `${itemOf(a.item_key).plural} on ${have} of ${live.length} classes`;
          }).join(" · ")}
        </p>
      )}
      {/* The flyer board: everything that's in, by term (both pages). */}
      {classes?.length > 0 && wanted.length > 0 && (
        <MarketingGallery
          groups={galleryGroups(groupClassesByTerm(classes, formatTermLabel), asks, media)}
          providerName={orgName} viewer={viewer}
        />
      )}
      {/* Nothing asked yet: tell the partner it can, and take it there. */}
      {viewer === "partner" && classes?.length > 0 && wanted.length === 0 && !mediaError && onAskMarketing && (
        <p className="px-4 pt-1 text-sm text-j2s-ink/70">
          Want a flyer or social graphic for each class?{" "}
          <button type="button" onClick={onAskMarketing} className="font-semibold text-j2s-purple hover:underline">
            Ask {orgName || "the provider"} for them →
          </button>
        </p>
      )}
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
                  <th colSpan={4} scope="rowgroup" className="border-b border-j2s-ink/10 bg-j2s-ink/[0.03] px-3 pb-1.5 pt-3 text-left text-sm font-bold text-j2s-ink">
                    {/* Pinned like the class column, so it stays on screen when a phone scrolls the table sideways. */}
                    <span className="sticky left-3">{g.label}</span>
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
                      {/* Flyer / social graphic (20261123r), in the pinned column so it's on a phone screen. */}
                      {c.status !== "cancelled" && wanted.map((a) => (
                        <ClassMediaLine
                          key={a.item_key} c={c} ask={a} file={media.get(mediaKey(c.kind, c.class_id, a.item_key)) ?? null}
                          viewer={viewer} canEdit={canEdit} orgId={orgId} partnerName={partnerName} termLabel={g.label}
                          onChanged={loadMedia} siblings={classes}
                        />
                      ))}
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

// One asked-for item on one class. The provider views, adds (to this class and
// any others it covers), replaces or removes it. The partner's row only shows
// a small marker; viewing, sharing and downloading are in the gallery above.
function ClassMediaLine({ c, ask, file, viewer, canEdit, orgId, partnerName, termLabel, onChanged, siblings }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null); // { ok } | { err }
  const label = itemOf(ask.item_key).label;
  const isProvider = viewer === "provider";
  const name = file ? shareName(c.title, termLabel, ask.item_key, extOfPath(file.storage_path)) : "";
  const btn = "py-0.5 text-xs font-semibold text-j2s-purple hover:underline disabled:opacity-60";

  async function run(kind, fn) {
    setBusy(kind);
    setNote(null);
    try { await fn(); } catch (err) { setNote({ err: err?.message ?? "Something went wrong." }); } finally { setBusy(""); }
  }

  // A picked file waits here while the provider says which other classes it
  // also covers ("upload once, use for several").
  const [pending, setPending] = useState(null); // { file, also: Set<key> } | null
  const others = (siblings || []).filter((o) => o.status !== "cancelled" && !(o.kind === c.kind && o.class_id === c.class_id));

  async function onPick(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const problem = fileProblemForAsk(f, ask, partnerName || "The partner");
    if (problem) { setNote({ err: problem }); return; }
    if (others.length) { setNote(null); setPending({ file: f, also: new Set() }); return; }
    await doUpload(f, []);
  }

  async function doUpload(f, alsoFor) {
    setPending(null);
    await run("upload", async () => {
      const failed = await uploadClassMedia(orgId, c, ask.item_key, f, alsoFor);
      await onChanged();
      const done = 1 + alsoFor.length - failed.length;
      setNote(failed.length
        ? { err: `Added to ${done} ${done === 1 ? "class" : "classes"}; couldn't add it to ${failed.map((x) => x.c.title).join(", ")}.` }
        : { ok: done === 1 ? `${label} added.` : `${label} added to ${done} classes.` });
    });
  }

  // Each browser call happens inside the tap (see partnerMarketing.js).
  const view = () => run("view", () => openMarketingFile(file.storage_path, name, { view: true }));
  const remove = () => {
    if (!window.confirm(`Remove the ${label.toLowerCase()} from ${c.title || "this class"}?`)) return;
    run("remove", async () => { await removeClassMedia(c, ask.item_key); await onChanged(); });
  };
  const keyOfClass = (o) => `${o.kind}:${o.class_id}`;

  // The partner's rows stay clean: a small marker when it's in, nothing when
  // it isn't (the gallery and the "1 of 4" count say the rest).
  if (!isProvider) {
    return file ? <div className="mt-0.5 text-xs text-emerald-700">✓ {label}</div> : null;
  }

  return (
    <div className="mt-0.5 text-xs">
      <span className="font-semibold text-j2s-ink/70">{label}:</span>{" "}
      {file ? <span className="text-emerald-700">✓ Added</span> : <span className="text-amber-700">Not added yet</span>}
      <div className="flex flex-wrap gap-x-3">
        {file && <button type="button" className={btn} onClick={view} disabled={!!busy}>{busy === "view" ? "Opening…" : "View"}</button>}
        {canEdit && !pending && (
          <label className={`${btn} cursor-pointer`}>
            {busy === "upload" ? "Uploading…" : file ? "Replace" : "Upload"}
            <input type="file" className="sr-only" disabled={!!busy} onChange={onPick}
              accept={ask.file_types.map((t) => (t === "pdf" ? "application/pdf" : t === "png" ? "image/png" : "image/jpeg")).join(",")} />
          </label>
        )}
        {canEdit && file && !pending && <button type="button" className={btn} onClick={remove} disabled={!!busy}>Remove</button>}
      </div>
      {pending && (
        <div className="mt-1 rounded-lg border border-j2s-ink/15 bg-j2s-ink/[0.02] p-2">
          <div className="font-semibold text-j2s-ink">Use this {label.toLowerCase()} for other classes too?</div>
          <div className="mt-1 grid gap-1">
            {others.map((o) => (
              <label key={keyOfClass(o)} className="flex items-start gap-1.5">
                <input type="checkbox" className="mt-0.5 h-3.5 w-3.5"
                  checked={pending.also.has(keyOfClass(o))}
                  onChange={(e) => setPending((p) => {
                    const also = new Set(p.also);
                    if (e.target.checked) also.add(keyOfClass(o)); else also.delete(keyOfClass(o));
                    return { ...p, also };
                  })} />
                <span>{o.title || "Class"}</span>
              </label>
            ))}
          </div>
          <div className="mt-1.5 flex gap-3">
            <button type="button" className="rounded bg-j2s-purple px-2.5 py-1 text-xs font-semibold text-white"
              onClick={() => doUpload(pending.file, others.filter((o) => pending.also.has(keyOfClass(o))))}>
              {pending.also.size ? `Add to ${pending.also.size + 1} classes` : "Add to this class"}
            </button>
            <button type="button" className="text-xs text-j2s-ink/60 hover:underline" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </div>
      )}
      {!file && <div className="text-j2s-ink/55">{askLine(ask, partnerName)}{ask.note ? ` · ${ask.note}` : ""}</div>}
      {note?.ok && <div role="status" className="text-emerald-700">{note.ok}</div>}
      {note?.err && <div role="alert" className="text-red-700">{note.err}</div>}
    </div>
  );
}
