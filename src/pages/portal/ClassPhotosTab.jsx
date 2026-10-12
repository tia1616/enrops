// Parent portal: the photos an instructor took in a class the family is enrolled
// in, newest class day first.
//
// WHAT A FAMILY SEES IS DECIDED BY THE DATABASE. class_photos RLS lets a parent
// read a photo only when they hold a paid-or-confirmed registration in that class;
// the private bucket resolves through that same row. This screen asks for each of
// the family's classes and shows what comes back, so a refunded family simply gets
// nothing back.
//
// A family can save any photo to their phone. A family that does not want their
// child in class photos emails the provider (the line under the gallery names the
// provider's own address), and the provider deletes photos from Settings. There is
// deliberately no in-app report button.

import { useEffect, useMemo, useState, useCallback } from "react";
import { listClassPhotos, signPhotoUrls, groupByDay } from "../../lib/classPhotos.js";
import { PhotoGrid, PhotoLightbox } from "../../components/ClassPhotoGrid.jsx";

const prettyDay = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) : "";

export default function ClassPhotosTab({ enrollments, supportEmail, orgName }) {
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
                <PhotoGrid photos={g.photos} urls={urls} onOpen={(p) => setOpen({ programId: c.programId, id: p.id })} />
              </div>
            ))}
          </section>
        );
      })}

      {/* How a family asks for their child to be left out. The provider's own
          address (the view's support_email cascade), never a platform one; a
          provider with no address on file gets the sentence without a link. */}
      <p className="text-xs text-j2s-ink/50">
        Don't want your child in class photos?{" "}
        {supportEmail ? (
          <>Email <a className="underline" href={`mailto:${supportEmail}`}>{supportEmail}</a>.</>
        ) : (
          <>Let {orgName || "your program"} know.</>
        )}
      </p>

      {openPhoto && (
        <PhotoLightbox
          photo={openPhoto}
          url={urls[openPhoto.storage_path]}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
