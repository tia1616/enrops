// Settings card for class photos: the on/off switch, the "add your logo" switch
// (organizations.class_photo_show_logo, off by default; the enrops mark stays on
// every photo either way), and the review list.
//
// The switch is organizations.class_photos_enabled, ON by default for every
// provider. Off hides the instructor "Class photos" section and the family Photos
// tab; it does not delete anything already taken.
//
// The photo list is how a provider honours "please take my child out of that
// photo": families are told to email the provider, and the provider deletes the
// photo here without having to find the instructor who took it.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../lib/supabase.js";
import { signPhotoUrls, deleteClassPhoto } from "../../lib/classPhotos.js";
import { PhotoGrid, PhotoLightbox } from "../../components/ClassPhotoGrid.jsx";
import SettingSwitch from "../../components/SettingSwitch.jsx";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
// One row in Settings' "Emails & photos" group (AdminSettings draws the group's
// panel and heading). Same three values as AdminSettings' rows so they line up.
const ROW_PAD = "14px 18px";
const rowTitle = { fontSize: 15, fontWeight: 600, color: INK };
const rowDesc = { fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.5, maxWidth: 520 };

const prettyDay = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

export default function ClassPhotosSettingsCard({ org }) {
  const orgId = org?.id;
  const [enabled, setEnabled] = useState(null); // null = loading
  const [saving, setSaving] = useState(false);
  // Their own logo on photos, alongside the enrops mark. OFF by default
  // (organizations.class_photo_show_logo). The logo is the one on the Branding
  // page - logo_email_url is the PNG upload-class-photo stamps.
  const [showLogo, setShowLogo] = useState(null);
  const [hasLogo, setHasLogo] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);
  const [err, setErr] = useState("");
  const [photos, setPhotos] = useState(null);
  const [urls, setUrls] = useState({});
  const [classNames, setClassNames] = useState({});
  const [open, setOpen] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("organizations")
        .select("class_photos_enabled, class_photo_show_logo, logo_email_url")
        .eq("id", orgId)
        .maybeSingle();
      if (cancelled) return;
      if (error) { console.error("[ClassPhotosSettingsCard] flag load failed", error); setErr("Couldn't load this setting."); return; }
      setEnabled(data?.class_photos_enabled === true);
      setShowLogo(data?.class_photo_show_logo === true);
      setHasLogo(!!data?.logo_email_url);
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  const loadPhotos = useCallback(async () => {
    if (!orgId) return;
    try {
      // Newest first. 60 covers "the photo from class last Tuesday".
      const { data, error } = await supabase
        .from("class_photos")
        .select("id, program_id, session_date, storage_path, created_at")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(60);
      if (error) throw error;
      const rows = data ?? [];
      const ids = [...new Set(rows.map((r) => r.program_id))];
      const names = {};
      if (ids.length) {
        const { data: progs } = await supabase.from("programs").select("id, curriculum").in("id", ids);
        for (const p of progs ?? []) names[p.id] = p.curriculum || "Class";
      }
      setClassNames(names);
      setUrls(await signPhotoUrls(rows));
      setPhotos(rows);
    } catch (e) {
      console.error("[ClassPhotosSettingsCard] photo load failed", e);
      setErr("Couldn't load the photos.");
      setPhotos([]);
    }
  }, [orgId]);

  // Only once the provider has the feature on: a provider that never enabled it
  // should not pay for signing URLs, and on an environment without the table
  // (frontend ahead of the migration) should not be shown a load error.
  // And only once they open "Review photos": the list sits folded on Settings,
  // so signing 60 URLs on every visit to the page would buy nothing.
  useEffect(() => { if (enabled === true && reviewOpen) loadPhotos(); }, [enabled, reviewOpen, loadPhotos]);

  async function toggle() {
    setSaving(true);
    setErr("");
    const next = !enabled;
    // .select() so a refused write is VISIBLE: the organizations UPDATE policy lets
    // only an owner or admin change settings, and for anyone else Postgres affects
    // zero rows and returns no error. Without reading the row back, a staff member
    // saw the switch flip to "On" while nothing had changed, and it reverted on reload.
    const { data, error } = await supabase
      .from("organizations").update({ class_photos_enabled: next }).eq("id", orgId).select("class_photos_enabled");
    setSaving(false);
    if (error) { console.error("[ClassPhotosSettingsCard] save failed", error); setErr("That didn't save. Try again."); return; }
    if (!data || data.length === 0) { setErr("Only an owner or admin can change this setting."); return; }
    setEnabled(data[0].class_photos_enabled === true);
  }

  async function toggleLogo() {
    setSavingLogo(true);
    setErr("");
    const next = !showLogo;
    // Read back for the same reason as the main switch: a refused write affects
    // zero rows with no error.
    const { data, error } = await supabase
      .from("organizations").update({ class_photo_show_logo: next }).eq("id", orgId).select("class_photo_show_logo");
    setSavingLogo(false);
    if (error) { console.error("[ClassPhotosSettingsCard] logo save failed", error); setErr("That didn't save. Try again."); return; }
    if (!data || data.length === 0) { setErr("Only an owner or admin can change this setting."); return; }
    setShowLogo(data[0].class_photo_show_logo === true);
  }

  const openPhoto = open ? (photos || []).find((p) => p.id === open) : null;
  // Grouped under "class · day" so a provider can find the photo a parent wrote
  // about ("the one from Tuesday") without opening every thumbnail.
  const groups = [];
  for (const p of photos || []) {
    const key = `${p.program_id}|${p.session_date}`;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, programId: p.program_id, date: p.session_date, photos: [] }; groups.push(g); }
    g.photos.push(p);
  }

  return (
    <div style={{ padding: ROW_PAD }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={rowTitle}>Class photos</div>
            <div style={rowDesc}>
              Instructors share photos from class with families. Each carries a small enrops mark, and instructors see which children have no photo permission.
            </div>
          </div>
          <SettingSwitch
            on={enabled === true}
            loading={enabled === null}
            busy={saving}
            label="Class photos"
            onChange={toggle}
          />
        </div>
        {enabled && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, marginTop: 14, borderTop: `1px solid ${RULE}`, paddingTop: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>Add your logo to photos</div>
              <div style={rowDesc}>
                {hasLogo
                  ? "Your logo goes in the bottom-left corner, alongside the enrops mark. It applies to photos taken from now on."
                  : <>Add your logo on the <Link to="/admin/branding" style={{ color: BRIGHT, fontWeight: 600 }}>Branding page</Link> first.</>}
              </div>
            </div>
            <SettingSwitch
              on={showLogo === true}
              loading={showLogo === null}
              busy={savingLogo}
              disabled={!hasLogo && !showLogo}
              label="Add your logo to photos"
              onChange={toggleLogo}
            />
          </div>
        )}

        {err && <div style={{ color: "#b0413e", fontSize: 13, marginTop: 10 }}>{err}</div>}

        {/* Folded by default so the list does not take over Settings. This is
            where a provider deletes a photo when a family asks, so the link
            says so. */}
        {enabled && (
          <div style={{ marginTop: 12, borderTop: `1px solid ${RULE}`, paddingTop: 10 }}>
            <button
              type="button"
              aria-expanded={reviewOpen}
              onClick={() => setReviewOpen((v) => !v)}
              style={{ background: "none", border: "none", padding: 0, color: BRIGHT, fontSize: 14, fontWeight: 600, fontFamily: "inherit", cursor: "pointer" }}
            >
              {reviewOpen ? "Hide photos" : "Review or delete photos →"}
            </button>
          </div>
        )}

        {enabled && reviewOpen && photos === null && !err && (
          <div style={{ fontSize: 13, color: MUTED, marginTop: 10 }}>Loading photos…</div>
        )}

        {enabled && reviewOpen && photos !== null && (
          <div style={{ marginTop: 12 }}>
            {photos.length === 0 ? (
              !err && <div style={{ fontSize: 13, color: MUTED }}>No photos yet.</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
                  Recent photos. Open one to delete it, for example if a family asks for their child to be left out.
                </div>
                {groups.map((g) => (
                  <div key={g.key} style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>
                      {classNames[g.programId] || "Class"} · {prettyDay(g.date)}
                    </div>
                    <PhotoGrid photos={g.photos} urls={urls} onOpen={(p) => setOpen(p.id)} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}

      {openPhoto && (
        <PhotoLightbox
          photo={openPhoto}
          url={urls[openPhoto.storage_path]}
          onClose={() => setOpen(null)}
          actions={[
            {
              label: "Delete photo",
              danger: true,
              confirm: `Delete this photo from ${classNames[openPhoto.program_id] || "the class"} (${prettyDay(openPhoto.session_date)})? This can't be undone.`,
              onClick: async (p) => { await deleteClassPhoto(p); setOpen(null); await loadPhotos(); },
            },
          ]}
        />
      )}
    </div>
  );
}
