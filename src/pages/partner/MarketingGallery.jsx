// "Flyers & graphics" at the top of Classes (Jessica 2026-11-24, "take a step
// back ... delight"): every flyer and social graphic that's in, as thumbnails
// grouped by term, the way Peachjar shows a district its flyer board. Tap a
// picture to view it; Share sends the file itself (a park's marketing team);
// "Download all" hands back one zip per term. Same section on both pages.

import { useEffect, useState } from "react";
import {
  marketingFileUrl, openMarketingFile, copyMarketingLink, canShareFiles, prepareShareFile, shareFile,
  downloadAllZip, COPY_LINK_DAYS,
} from "../../lib/partnerMarketing.js";
import { isPicture, zipName, uniqueNames, itemOf } from "../../lib/partnerMarketingLogic.js";

export default function MarketingGallery({ groups, providerName, viewer = "partner" }) {
  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  if (!total) return null;
  return (
    <div className="px-4 pt-3">
      <h3 className="text-sm font-bold text-j2s-ink">Flyers &amp; graphics</h3>
      {groups.map((g) => <TermGallery key={g.key} group={g} providerName={providerName} viewer={viewer} />)}
    </div>
  );
}

function TermGallery({ group, providerName }) {
  const [zipping, setZipping] = useState(false);
  const [note, setNote] = useState(null);

  async function downloadAll() {
    setZipping(true);
    setNote(null);
    try {
      const names = uniqueNames(group.cards.map((k) => k.name));
      await downloadAllZip(group.cards.map((k, i) => ({ path: k.file.storage_path, name: names[i] })), zipName(providerName, group.label));
    } catch (err) {
      setNote({ err: `Couldn't make the download: ${err?.message ?? "unknown error"}` });
    } finally {
      setZipping(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-j2s-ink/55">{group.label}</div>
        {group.cards.length > 1 && (
          <button type="button" onClick={downloadAll} disabled={zipping} className="text-xs font-semibold text-j2s-purple hover:underline disabled:opacity-60">
            {zipping ? "Getting them ready…" : `Download all ${group.cards.length}`}
          </button>
        )}
      </div>
      {note?.err && <p role="alert" className="text-xs text-red-700">{note.err}</p>}
      <ul className="mt-1.5 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {group.cards.map((k) => <Card key={k.file.storage_path} card={k} />)}
      </ul>
    </div>
  );
}

function Card({ card }) {
  const { c, ask, file, name } = card;
  const [thumb, setThumb] = useState(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const picture = isPicture(file.storage_path);

  useEffect(() => {
    let cancelled = false;
    if (picture) marketingFileUrl(file.storage_path, { days: 1 }).then((u) => { if (!cancelled) setThumb(u); }).catch(() => {});
    return () => { cancelled = true; };
  }, [file.storage_path, picture]);

  async function run(kind, fn) {
    setBusy(kind);
    setNote(null);
    try { await fn(); } catch (err) { setNote({ err: err?.message ?? "Something went wrong." }); } finally { setBusy(""); }
  }
  // Browser calls happen inside the tap (see partnerMarketing.js).
  const view = () => run("view", () => openMarketingFile(file.storage_path, name, { view: true }));
  const download = () => run("download", () => openMarketingFile(file.storage_path, name));
  const share = () => {
    if (!canShareFiles()) {
      run("share", async () => {
        await copyMarketingLink(file.storage_path, name);
        setNote({ ok: `Link copied (works ${COPY_LINK_DAYS} days).` });
      });
      return;
    }
    run("share", async () => {
      const f = prepared ?? await prepareShareFile(file.storage_path, name);
      const r = await shareFile(f);
      if (r === "again") { setPrepared(f); setNote({ ok: "Ready. Tap Share again." }); } else setPrepared(null);
    });
  };

  const btn = "text-xs font-semibold text-j2s-purple hover:underline disabled:opacity-60";
  return (
    <li className="overflow-hidden rounded-xl border border-j2s-ink/10 bg-white">
      <button type="button" onClick={view} className="block w-full" aria-label={`View ${name}`}>
        <span className="flex aspect-[4/5] w-full items-center justify-center bg-j2s-ink/[0.04]">
          {picture && thumb
            ? <img src={thumb} alt="" className="h-full w-full object-contain" loading="lazy" />
            : <span className="text-sm font-bold text-j2s-ink/45">{picture ? "…" : "PDF"}</span>}
        </span>
      </button>
      <div className="p-2">
        <div className="line-clamp-2 text-xs font-semibold leading-snug text-j2s-ink">{c.title || "Class"}</div>
        <div className="text-[11px] text-j2s-ink/55">{itemOf(ask.item_key).label}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          <button type="button" className={btn} onClick={share} disabled={!!busy}>{busy === "share" ? "Sharing…" : "Share"}</button>
          <button type="button" className={btn} onClick={download} disabled={!!busy}>Download</button>
        </div>
        {note?.ok && <div role="status" className="mt-0.5 text-[11px] text-emerald-700">{note.ok}</div>}
        {note?.err && <div role="alert" className="mt-0.5 text-[11px] text-red-700">{note.err}</div>}
      </div>
    </li>
  );
}
