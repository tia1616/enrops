// Parent portal: the photos an instructor took in a class the family is enrolled
// in, newest class day first.
//
// WHAT A FAMILY SEES IS DECIDED BY THE DATABASE. class_photos RLS lets a parent
// read a photo only when they hold a paid-or-confirmed registration in that class
// and nobody has reported the photo; the private bucket resolves through that same
// row. This screen asks for each of the family's classes and shows what comes back,
// so a refunded family, or a photo someone reported, simply is not in the result.
//
// A family can save any photo to their phone and can report one. Reporting hides
// it from every family at once and tells the provider's admins (the review list in
// Settings); there is no per-child tagging, so this is the safety valve for a child
// whose family did not agree to photos appearing in one.

import { useEffect, useMemo, useState, useCallback } from "react";
import { listClassPhotos, signPhotoUrls, flagClassPhoto, groupByDay } from "../../lib/classPhotos.js";
import { PhotoGrid, PhotoLightbox } from "../../components/ClassPhotoGrid.jsx";

const prettyDay = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "";

export default function ClassPhotosTab({ enrollments }) {
  // One entry per class, not per child: two siblings in one class see one gallery.
  const classes = useMemo(() => {
    const seen = new Map();
    for (const e of enrollments || []) {
      if (!e.programId) continue;
      const cur = seen.get(e.programId) || { programId: e.programId, name: e.name, kids: [] };
      const kid = e.student?.first_name;
      if (kid && !cur.kids.includes(kid)) cur.kids.push(kid);
      seen.set(e.programId, cur);
    }
    return [...seen.values()];
  }, [enrollments]);

  const [byClass, setByClass] = useState(null); // { [programId]: rows }
  const [urls, setUrls] = useState({});
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null); // { programId, id }
  const [reported, setReported] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const entries = await Promise.all(classes.map(async (c) => [c.programId, await listClassPhotos({ programId: c.programId })]));
      const all = entries.flatMap(([, rows]) => rows);
      const signed = await signPhotoUrls(all);
      setByClass(Object.fromEntries(entries));
      setUrls(signed);
    } catch (e) {
      console.error("[ClassPhotosTab] load failed", e);
      setError("We couldn't load your photos. Refresh to try again.");
      setByClass({});
    }
  }, [classes]);

  useEffect(() => { load(); }, [load]);

  if (byClass === null) return <div className="text-sm text-j2s-ink/60">Loading photos...</div>;

  const total = Object.values(byClass).reduce((n, rows) => n + rows.length, 0);
  const openPhoto = open ? (byClass[open.programId] || []).find((p) => p.id === open.id) : null;

  return (
    <div className="space-y-8">
      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {reported && (
        <div className="rounded-lg bg-j2s-purple/5 px-4 py-3 text-sm text-j2s-ink">
          Thanks. That photo is hidden for everyone now, and the team has been told.
        </div>
      )}

      {total === 0 && !error && (
        <div className="rounded-2xl border border-j2s-purple/10 bg-white px-5 py-8 text-center">
          <div className="text-base font-semibold text-j2s-ink">No photos yet</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-j2s-ink/60">
            When your instructor shares photos from class, they'll show up here.
          </p>
        </div>
      )}

      {classes.map((c) => {
        const rows = byClass[c.programId] || [];
        if (!rows.length) return null;
        return (
          <section key={c.programId}>
            <h2 className="text-base font-bold text-j2s-ink">{c.name}</h2>
            {c.kids.length > 0 && <div className="text-xs text-j2s-ink/50">{c.kids.join(" · ")}</div>}
            {groupByDay(rows).map((g) => (
              <div key={g.date} className="mt-4">
                <div className="mb-2 text-sm font-semibold text-j2s-ink/70">{prettyDay(g.date)}</div>
                <PhotoGrid photos={g.photos} urls={urls} onOpen={(p) => { setReported(false); setOpen({ programId: c.programId, id: p.id }); }} />
              </div>
            ))}
          </section>
        );
      })}

      {openPhoto && (
        <PhotoLightbox
          photo={openPhoto}
          url={urls[openPhoto.storage_path]}
          onClose={() => setOpen(null)}
          actions={[{
            label: "Report this photo",
            danger: true,
            confirm: "Report this photo? It will be hidden for every family while the team looks at it.",
            onClick: async (p) => { await flagClassPhoto(p.id); setOpen(null); setReported(true); await load(); },
          }]}
        />
      )}
    </div>
  );
}
