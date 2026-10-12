// Settings card for class photos: the on/off switch, and the review list.
//
// The switch is organizations.class_photos_enabled, ON by default for every
// provider. Off hides the instructor "Class photos" section and the family Photos
// tab; it does not delete anything already taken.
//
// The photo list is how a provider honours "please take my child out of that
// photo": families are told to email the provider, and the provider deletes the
// photo here without having to find the instructor who took it.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase.js";
import { signPhotoUrls, deleteClassPhoto } from "../../lib/classPhotos.js";
import { PhotoGrid, PhotoLightbox } from "../../components/ClassPhotoGrid.jsx";

const PURPLE = "#1C004F";
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";
const sectionTitle = { fontSize: 13, fontWeight: 700, color: PURPLE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 12 };

const prettyDay = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

export default function ClassPhotosSettingsCard({ org }) {
  const orgId = org?.id;
  const [enabled, setEnabled] = useState(null); // null = loading
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [photos, setPhotos] = useState(null);
  const [urls, setUrls] = useState({});
  const [classNames, setClassNames] = useState({});
  const [open, setOpen] = useState(null);

  useEffect(() => {
    if (!orgId) return undefined;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("organizations").select("class_photos_enabled").eq("id", orgId).maybeSingle();
      if (cancelled) return;
      if (error) { console.error("[ClassPhotosSettingsCard] flag load failed", error); setErr("Couldn't load this setting."); return; }
      setEnabled(data?.class_photos_enabled === true);
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
  useEffect(() => { if (enabled === true) loadPhotos(); }, [enabled, loadPhotos]);

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
    <section style={{ marginTop: 24 }}>
      <h2 style={sectionTitle}>Class photos</h2>
      <div style={{ background: PANEL, border: `1px solid ${RULE}`, borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Instructors share photos with families</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
              Instructors take photos from their portal; each carries a small enrops mark. Every family enrolled in that class sees them in their portal.
              Before shooting, an instructor is shown which children have no photo permission on file.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled === true}
            disabled={enabled === null || saving}
            onClick={toggle}
            style={{ flexShrink: 0, padding: "9px 16px", background: enabled ? "#2f7d32" : BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", opacity: enabled === null || saving ? 0.6 : 1 }}
          >
            {enabled === null ? "..." : saving ? "Saving..." : enabled ? "On" : "Turn on"}
          </button>
        </div>
        {err && <div style={{ color: "#b0413e", fontSize: 13, marginTop: 10 }}>{err}</div>}

        {enabled && photos !== null && (
          <div style={{ marginTop: 16, borderTop: `1px solid ${RULE}`, paddingTop: 14 }}>
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
      </div>

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
    </section>
  );
}
