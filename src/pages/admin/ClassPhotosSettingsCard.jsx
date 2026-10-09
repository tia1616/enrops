// Settings card for class photos: the on/off switch, and the review list.
//
// The switch is organizations.class_photos_enabled, default OFF for every
// provider. Off hides the instructor "Class photos" section and the family Photos
// tab; it does not delete anything already taken.
//
// The review list is the safety valve behind "no per-child tagging": any family
// can report a photo, which hides it from every family at once, and it lands
// here first, marked Reported, where an admin can put it back or delete it. Any
// other recent photo can be deleted from the same list.

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
      // Reported photos first, then the newest. 60 is plenty for a review list.
      const { data, error } = await supabase
        .from("class_photos")
        .select("id, program_id, session_date, storage_path, created_at, flagged_at")
        .eq("organization_id", orgId)
        .order("flagged_at", { ascending: false, nullsFirst: false })
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

  useEffect(() => { loadPhotos(); }, [loadPhotos]);

  async function toggle() {
    setSaving(true);
    setErr("");
    const next = !enabled;
    const { error } = await supabase.from("organizations").update({ class_photos_enabled: next }).eq("id", orgId);
    setSaving(false);
    if (error) { console.error("[ClassPhotosSettingsCard] save failed", error); setErr("That didn't save. Try again."); return; }
    setEnabled(next);
  }

  const openPhoto = open ? (photos || []).find((p) => p.id === open) : null;
  const reported = (photos || []).filter((p) => p.flagged_at);

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
            {reported.length > 0 && (
              <div style={{ background: "#fbeae9", border: "1px solid #e6b3b1", borderRadius: 8, padding: 10, fontSize: 13, color: "#7a2523", marginBottom: 12 }}>
                {reported.length} photo{reported.length === 1 ? " has" : "s have"} been reported by a family and {reported.length === 1 ? "is" : "are"} hidden from everyone. Open {reported.length === 1 ? "it" : "each"} to restore or delete.
              </div>
            )}
            {photos.length === 0 ? (
              <div style={{ fontSize: 13, color: MUTED }}>No photos yet.</div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Recent photos, reported first</div>
                <PhotoGrid photos={photos} urls={urls} onOpen={(p) => setOpen(p.id)} badge={(p) => (p.flagged_at ? "Reported" : null)} />
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
            ...(openPhoto.flagged_at ? [{
              label: "Restore photo",
              onClick: async (p) => {
                const { error } = await supabase.from("class_photos").update({ flagged_at: null, flagged_by_parent_id: null }).eq("id", p.id);
                if (error) throw error;
                setOpen(null);
                await loadPhotos();
              },
            }] : []),
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
