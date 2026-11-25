// "Marketing" on the Requirements tab (20261123r, Jessica 2026-11-23): what a
// partner asks for on each class (a flyer, a social graphic), in which file
// types, with its logo and/or accessible (ADA), plus the partner's logo for the
// provider to use. The Peachjar / sponsor-portal pattern: the host says once
// what it wants and in what format; each provider uploads against it on the
// class (ClassesTable).
//
// Rendered on BOTH pages (same page both sides): the partner's every-site
// admin edits (`canEdit`, from partner_requirements_control); everyone else
// reads. Never part of compliance: nothing here counts toward requirements.

import { useEffect, useRef, useState } from "react";
import {
  listMarketingAsks, setMarketingAsk, getPartnerLogo, uploadPartnerLogo, openMarketingFile, marketingFileUrl,
} from "../../lib/partnerMarketing.js";
import { MARKETING_ITEMS, FILE_TYPES, ACCESSIBLE_HINT, askLine, extOfPath } from "../../lib/partnerMarketingLogic.js";
import { fileProblem, formatDate } from "../../lib/providerDocumentLogic.js";
import { localDateOf } from "../../lib/partnerPortalLogic.js";

const blankAsk = (key) => ({ item_key: key, wanted: false, file_types: ["pdf", "jpg", "png"], needs_logo: false, needs_accessible: false, note: "" });

export default function MarketingAsksSection({ partner, viewer = "partner", orgName = "", canEdit = false, onSaved }) {
  const isPartner = viewer === "partner";
  const [asks, setAsks] = useState(null);      // item_key -> ask (with edits)
  const [logo, setLogo] = useState(undefined); // undefined loading, null none
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState("");
  const [msg, setMsg] = useState({});          // item_key|'logo' -> { ok|err }

  async function load() {
    try {
      const [rows, lg] = await Promise.all([listMarketingAsks(partner.id), getPartnerLogo(partner.id)]);
      const byKey = Object.fromEntries(MARKETING_ITEMS.map((i) => [i.key, blankAsk(i.key)]));
      for (const r of rows) byKey[r.item_key] = { ...r, note: r.note ?? "" };
      savedNote.current = Object.fromEntries(Object.entries(byKey).map(([k, v]) => [k, v.note]));
      setAsks(byKey);
      setLogo(lg);
      setLoadError("");
    } catch (err) {
      setLoadError(`Couldn't load marketing asks: ${err?.message ?? "unknown error"}`);
      setAsks((a) => a ?? {});
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [partner.id]);

  // A small picture of the uploaded logo (Jessica 2026-11-23), so both sides
  // can see at a glance that it's there and which one it is. A PDF logo has no
  // picture; it shows as a PDF tile.
  const [logoThumb, setLogoThumb] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setLogoThumb(null);
    if (logo?.storage_path && extOfPath(logo.storage_path) !== "pdf") {
      marketingFileUrl(logo.storage_path, { days: 1 })
        .then((u) => { if (!cancelled) setLogoThumb(u); })
        .catch(() => {}); // no picture is fine; the name and Download still show
    }
    return () => { cancelled = true; };
  }, [logo?.storage_path]);

  // Saves the moment a box is ticked, like the requirements list above it
  // (Jessica 2026-11-24); the note saves when you leave the box. Saves for one
  // item queue in order, so quick ticks never land out of order.
  const chain = useRef({});
  const savedNote = useRef({});
  function save(key, next) {
    setMsg((m) => ({ ...m, [key]: { saving: true } }));
    chain.current[key] = (chain.current[key] ?? Promise.resolve())
      .then(() => setMarketingAsk(partner.id, next))
      .then(() => {
        savedNote.current[key] = next.note ?? "";
        setMsg((m) => ({ ...m, [key]: { ok: "Saved." } }));
        onSaved?.();
      })
      .catch((err) => setMsg((m) => ({ ...m, [key]: { err: `That didn't save: ${err?.message ?? "unknown error"}` } })));
  }
  function change(key, patch) {
    const next = { ...asks[key], ...patch };
    if (next.wanted && !next.file_types.length) {
      setMsg((m) => ({ ...m, [key]: { err: "Keep at least one file type ticked." } }));
      return;
    }
    setAsks((a) => ({ ...a, [key]: next }));
    save(key, next);
  }
  const typeNote = (key, note) => setAsks((a) => ({ ...a, [key]: { ...a[key], note } }));
  function saveNote(key) {
    const a = asks[key];
    if ((a.note ?? "") !== (savedNote.current[key] ?? "")) save(key, a);
  }

  async function onLogo(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) { setMsg((m) => ({ ...m, logo: { err: problem } })); return; }
    setSaving("logo");
    setMsg((m) => ({ ...m, logo: null }));
    try {
      await uploadPartnerLogo(partner.id, file);
      setLogo(await getPartnerLogo(partner.id));
      setMsg((m) => ({ ...m, logo: { ok: "Logo saved." } }));
    } catch (err) {
      setMsg((m) => ({ ...m, logo: { err: `That didn't upload: ${err?.message ?? "unknown error"}` } }));
    } finally {
      setSaving("");
    }
  }

  async function openLogo(view = false) {
    try {
      const name = `${partner.partner_name || "Partner"} logo.${extOfPath(logo.storage_path)}`;
      // Opens the tab inside the tap, so a phone's pop-up blocker allows it.
      await openMarketingFile(logo.storage_path, name, { view });
    } catch (err) {
      setMsg((m) => ({ ...m, logo: { err: `Couldn't open the logo: ${err?.message ?? "unknown error"}` } }));
    }
  }

  const Msg = ({ k }) => msg[k]?.ok ? <p role="status" className="mt-1 text-xs font-semibold text-emerald-700">{msg[k].ok}</p>
    : msg[k]?.err ? <p role="alert" className="mt-1 text-xs text-red-700">{msg[k].err}</p> : null;

  return (
    // id: Classes' "Ask ... for them" scrolls here.
    <section id="marketing-asks" className="mt-5 scroll-mt-24 rounded-2xl bg-white p-4 shadow-card">
      <h2 className="text-base font-bold text-j2s-ink">
        {/* Says "flyers" (Jessica 2026-11-25: "i don't see flyer asks?"). */}
        {isPartner ? `Flyers and social graphics you ask ${orgName || "this provider"} for` : `Flyers and social graphics ${partner.partner_name} asks for`}
      </h2>
      <p className="mt-1 text-sm text-j2s-ink/70">
        {isPartner
          ? `Optional. ${orgName || "The provider"} adds these on each class, and you download or share them from Classes. They never count toward your requirements.`
          : "Add these on each class under Classes. They never count toward requirements."}
      </p>
      {loadError && <p className="error-text mt-2">{loadError}</p>}
      {asks === null ? <p className="mt-2 text-sm text-j2s-ink/60">Loading…</p> : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {MARKETING_ITEMS.map((item) => {
            const a = asks[item.key] ?? blankAsk(item.key);
            if (!isPartner || !canEdit) {
              return (
                <div key={item.key} className="rounded-xl border border-j2s-ink/10 p-3">
                  <div className="text-sm font-semibold text-j2s-ink">{item.label} for each class</div>
                  {a.wanted ? (
                    <>
                      <div className="mt-1 text-sm text-j2s-ink/80">{askLine(a, partner.partner_name)}</div>
                      {a.needs_accessible && item.accessible && <div className="mt-1 text-xs text-j2s-ink/60">Accessible: {ACCESSIBLE_HINT}</div>}
                      {a.note && <div className="mt-1 text-sm text-j2s-ink">{a.note}</div>}
                    </>
                  ) : <div className="mt-1 text-sm text-j2s-ink/55">Not asked for.</div>}
                </div>
              );
            }
            return (
              <fieldset key={item.key} className="rounded-xl border border-j2s-ink/10 p-3">
                <legend className="sr-only">{item.label}</legend>
                <label className="flex items-center gap-2 text-sm font-semibold text-j2s-ink">
                  <input type="checkbox" checked={a.wanted} onChange={(e) => change(item.key, { wanted: e.target.checked })} className="h-4 w-4" />
                  Ask for {item.lower} for each class
                </label>
                {a.wanted && (
                  <div className="mt-2 grid gap-2 pl-6 text-sm text-j2s-ink">
                    <div>
                      <div className="text-xs font-semibold text-j2s-ink/60">File types you take</div>
                      <div className="mt-1 flex flex-wrap gap-3">
                        {FILE_TYPES.map((t) => (
                          <label key={t.key} className="flex items-center gap-1.5">
                            <input type="checkbox" className="h-4 w-4" checked={a.file_types.includes(t.key)}
                              onChange={(e) => change(item.key, { file_types: e.target.checked ? [...a.file_types, t.key] : a.file_types.filter((x) => x !== t.key) })} />
                            {t.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="h-4 w-4" checked={a.needs_logo} onChange={(e) => change(item.key, { needs_logo: e.target.checked })} />
                      Must include our logo
                    </label>
                    {item.accessible && (
                      <label className="flex items-start gap-2">
                        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={a.needs_accessible} onChange={(e) => change(item.key, { needs_accessible: e.target.checked })} />
                        <span>Must be accessible (ADA)<span className="block text-xs text-j2s-ink/60">{ACCESSIBLE_HINT}</span></span>
                      </label>
                    )}
                    <label className="text-xs font-semibold text-j2s-ink/60">
                      Anything else, in your words
                      <input type="text" maxLength={300} value={a.note} onChange={(e) => typeNote(item.key, e.target.value)}
                        onBlur={() => saveNote(item.key)}
                        placeholder={item.example}
                        className="mt-1 block w-full rounded border border-j2s-ink/20 px-2 py-1 text-sm font-normal text-j2s-ink" />
                    </label>
                  </div>
                )}
                {msg[item.key]?.saving ? <p role="status" className="mt-1 text-xs text-j2s-ink/55">Saving…</p> : <Msg k={item.key} />}
              </fieldset>
            );
          })}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-j2s-ink/10 p-3">
        <div className="text-sm font-semibold text-j2s-ink">{isPartner ? "Your logo" : `${partner.partner_name}'s logo`}</div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          {logo === undefined ? <span className="text-j2s-ink/60">Loading…</span>
            : logo ? (
              <>
                {/* Light grey behind it, so a white or see-through logo still shows. */}
                <span className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-j2s-ink/10 bg-j2s-ink/[0.04]">
                  {logoThumb
                    ? <img src={logoThumb} alt={`${partner.partner_name || "Partner"} logo`} className="max-h-full max-w-full object-contain p-1" />
                    : <span className="text-xs font-semibold text-j2s-ink/55">{extOfPath(logo.storage_path) === "pdf" ? "PDF" : "Logo"}</span>}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-emerald-700">✓ Uploaded{logo.uploaded_at ? ` ${formatDate(localDateOf(logo.uploaded_at))}` : ""}</span>
                  <span className="block truncate text-xs text-j2s-ink/60">{logo.original_filename || "Logo"}</span>
                </span>
                <button type="button" onClick={() => openLogo(true)} className="font-semibold text-j2s-purple hover:underline">View</button>
                <button type="button" onClick={() => openLogo(false)} className="font-semibold text-j2s-purple hover:underline">Download</button>
              </>
            ) : <span className="text-j2s-ink/55">{isPartner ? "Not uploaded yet." : "Not uploaded yet. They add it from their portal."}</span>}
          {isPartner && canEdit && (
            <label className="cursor-pointer font-semibold text-j2s-purple hover:underline">
              {saving === "logo" ? "Uploading…" : logo ? "Replace" : "Upload your logo"}
              <input type="file" accept="image/png,image/jpeg,application/pdf" className="sr-only" onChange={onLogo} disabled={!!saving} />
            </label>
          )}
        </div>
        {isPartner && <p className="mt-1 text-xs text-j2s-ink/60">PNG with a clear background works best. {orgName || "The provider"} can download it for flyers and graphics.</p>}
        <Msg k="logo" />
      </div>
    </section>
  );
}
