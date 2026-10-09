// Instructor portal: take photos of a class and file them against a class day.
//
// Sits directly above the roster in every instructor view that can take
// attendance (after-school class, program-camp, and a sub's single day), so it
// gets the same class and the same day rules the roster does.
//
// WHAT THIS SCREEN DOES NOT DECIDE. Whether this instructor may photograph this
// class today is the class_photos INSERT policy (the same rule that lets them
// take attendance); whether the provider has the feature on is
// organizations.class_photos_enabled. This component renders nothing when the
// feature is off, and reports the server's refusal if it is asked anyway.
//
// THE CONSENT WARNING. There is no per-child tagging: a photo belongs to the
// class and every enrolled family sees it. So before the instructor shoots, the
// children WITHOUT a recorded yes are named, and the instructor keeps them out of
// the frame. Only a recorded yes is permission (see childrenWithoutPhotoPermission).

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { supabase } from "../../lib/supabase";
import { isOnRoster } from "../../lib/rosterOrder.js";
import { WAITLIST_STATUS } from "../../lib/waitlistState.js";
import {
  childrenWithoutPhotoPermission, uploadClassPhoto, listClassPhotos,
  signPhotoUrls, deleteClassPhoto, todayLocalISO,
} from "../../lib/classPhotos.js";
import { PhotoGrid, PhotoLightbox } from "../../components/ClassPhotoGrid.jsx";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const BRIGHT = "#5847C9";

const prettyDay = (d) =>
  d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";

export default function ClassPhotosSection({ programId, organizationId, instructorId, sessionDates = [], lockedDate = null }) {
  const todayStr = todayLocalISO();
  const [enabled, setEnabled] = useState(false);
  const [rosterRows, setRosterRows] = useState(null);

  // Only days that have happened can take photos (the database refuses the rest).
  // The parent passes a NEW array every render, so key the memo on its contents.
  const datesKey = (sessionDates || []).join(",");
  const pickable = useMemo(() => {
    if (lockedDate) return lockedDate <= todayStr ? [lockedDate] : [];
    // The class's own meeting dates are the only days that take photos. While the
    // schedule is still loading, or for a class that has not started, the list is
    // empty and the section says photos open on the first class day. It used to
    // fall back to "today" when the list was empty, which let an instructor file a
    // photo against a day the class never met in the moment before the schedule
    // arrived.
    return datesKey ? datesKey.split(",").filter((d) => d <= todayStr).sort() : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datesKey, lockedDate, todayStr]);
  const [day, setDay] = useState(() => pickable[pickable.length - 1] ?? todayStr);
  useEffect(() => {
    if (!pickable.includes(day)) setDay(pickable[pickable.length - 1] ?? todayStr);
  }, [pickable, day, todayStr]);

  const [photos, setPhotos] = useState(null); // null = loading
  const [urls, setUrls] = useState({});
  const [loadErr, setLoadErr] = useState("");
  const [uploads, setUploads] = useState([]); // [{ key, name, state: 'working'|'done'|'failed', message }]
  const [open, setOpen] = useState(null);
  const inputRef = useRef(null);
  const dayRef = useRef(day);
  useEffect(() => { dayRef.current = day; }, [day]);

  // The provider's switch. public_org_directory is the one door both portals read.
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("public_org_directory").select("class_photos_enabled").eq("id", organizationId).maybeSingle();
      if (cancelled) return;
      if (error) console.error("[ClassPhotosSection] flag load failed", error);
      setEnabled(data?.class_photos_enabled === true);
    })();
    return () => { cancelled = true; };
  }, [organizationId]);

  // Who is in the class and what they agreed to.
  useEffect(() => {
    if (!enabled || !programId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("registrations")
        .select("id, status, payment_status, ach_payment_state, photo_release_consent, student:students ( id, first_name, last_name )")
        .eq("program_id", programId)
        .neq("status", WAITLIST_STATUS)
        .not("status", "in", "(cancelled,withdrawn)");
      if (cancelled) return;
      if (error) {
        console.error("[ClassPhotosSection] roster load failed", error);
        setRosterRows(undefined); // unknown: say so rather than claim nobody needs a warning
        return;
      }
      setRosterRows((data ?? []).filter(isOnRoster));
    })();
    return () => { cancelled = true; };
  }, [enabled, programId]);

  const loadPhotos = useCallback(async (forDay) => {
    setLoadErr("");
    try {
      const rows = await listClassPhotos({ programId, sessionDate: forDay });
      const signed = await signPhotoUrls(rows);
      if (dayRef.current !== forDay) return; // the instructor moved on
      setPhotos(rows);
      setUrls(signed);
    } catch (e) {
      console.error("[ClassPhotosSection] photo load failed", e);
      if (dayRef.current === forDay) { setPhotos([]); setLoadErr("Couldn't load the photos. Refresh to try again."); }
    }
  }, [programId]);

  useEffect(() => {
    if (!enabled || !programId || !day) return;
    setPhotos(null);
    loadPhotos(day);
  }, [enabled, programId, day, loadPhotos]);

  async function onPick(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = ""; // so choosing the same photo again fires change
    if (!files.length) return;
    const uploadDay = day;
    const batch = files.map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name || `Photo ${i + 1}`, state: "working", message: "" }));
    setUploads((u) => [...batch, ...u]);
    // One at a time: a classroom wifi connection does worse with ten at once, and
    // a refusal on the first (wrong class, feature off) should stop the rest from
    // each repeating it.
    for (let i = 0; i < files.length; i++) {
      const res = await uploadClassPhoto({ programId, sessionDate: uploadDay, file: files[i] });
      setUploads((u) => u.map((x) => (x.key === batch[i].key ? { ...x, state: res.ok ? "done" : "failed", message: res.ok ? "" : res.message } : x)));
      if (!res.ok && /not set up|switched off|hasn't happened/.test(res.message)) {
        setUploads((u) => u.map((x) => (batch.slice(i + 1).some((b) => b.key === x.key) ? { ...x, state: "failed", message: "Skipped." } : x)));
        break;
      }
    }
    if (dayRef.current === uploadDay) loadPhotos(uploadDay);
  }

  if (!enabled || !programId) return null;

  const blocked = childrenWithoutPhotoPermission(rosterRows || []);
  const working = uploads.some((u) => u.state === "working");
  const openPhoto = open && photos ? photos.find((p) => p.id === open) : null;
  // A reported photo is evidence for the admin who must decide, so the database
  // does not let the instructor who took it delete it; do not offer the button.
  const mine = (p) => instructorId && p.uploaded_by_instructor_id === instructorId && !p.flagged_at;

  return (
    <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: 14, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: INK }}>Class photos</h3>
        {pickable.length > 1 && !lockedDate ? (
          <select value={day} onChange={(e) => setDay(e.target.value)}
            style={{ fontSize: 12, fontFamily: "inherit", color: INK, border: `1px solid ${RULE}`, borderRadius: 6, padding: "3px 6px", background: "#fff" }}>
            {pickable.map((d) => <option key={d} value={d}>{prettyDay(d)}{d === todayStr ? " · today" : ""}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 12, color: MUTED }}>{prettyDay(day)}{day === todayStr ? " · today" : ""}</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, marginBottom: 10 }}>
        Every family in this class can see these photos in their portal, with a small enrops mark in the corner.
      </div>

      {rosterRows === undefined ? (
        <div style={{ background: "#fbf1dc", border: "1px solid #e8cf94", borderRadius: 8, padding: 10, fontSize: 12.5, color: "#6b4a00", marginBottom: 10, lineHeight: 1.5 }}>
          We couldn't check which children have photo permission. Check the roster before you take photos.
        </div>
      ) : blocked.length > 0 && (
        <div style={{ background: "#fbeae9", border: "1px solid #e6b3b1", borderRadius: 8, padding: 10, fontSize: 12.5, color: "#7a2523", marginBottom: 10, lineHeight: 1.5 }}>
          <strong>Keep these children out of the photo.</strong> No photo permission on file:
          <div style={{ marginTop: 4 }}>
            {blocked.map((c, i) => (
              <span key={c.id}>{i > 0 ? ", " : ""}{c.name}{c.declined ? "" : " (not answered)"}</span>
            ))}
          </div>
        </div>
      )}

      {pickable.length === 0 ? (
        <div style={{ fontSize: 12.5, color: MUTED }}>Photos open on the first class day.</div>
      ) : (
        <>
          <input ref={inputRef} type="file" accept="image/*" multiple onChange={onPick} style={{ display: "none" }} />
          {/* Held until the roster has loaded, so the instructor never reaches for the
              camera before the "keep these children out" list has had a chance to show. */}
          <button type="button" onClick={() => inputRef.current?.click()} disabled={working || rosterRows === null}
            style={{ padding: "10px 16px", background: BRIGHT, color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: working || rosterRows === null ? "default" : "pointer", opacity: working || rosterRows === null ? 0.7 : 1 }}>
            {working ? "Uploading..." : "Add photos"}
          </button>
        </>
      )}

      {uploads.length > 0 && (
        <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, fontSize: 12.5 }}>
          {/* Every failure stays on screen. Capping the list to the newest few hid
              a photo that failed in the middle of a long batch, and the instructor
              walked away believing it had been added. */}
          {[...uploads.filter((u) => u.state === "failed"), ...uploads.filter((u) => u.state !== "failed").slice(0, 4)].map((u) => (
            <li key={u.key} style={{ color: u.state === "failed" ? "#b0413e" : u.state === "done" ? "#2f7d32" : MUTED, padding: "2px 0" }}>
              {u.state === "working" ? "Uploading" : u.state === "done" ? "Added" : "Not added"}: {u.name}{u.message ? ` - ${u.message}` : ""}
            </li>
          ))}
        </ul>
      )}

      {loadErr && <div style={{ color: "#b0413e", fontSize: 12.5, marginTop: 10 }}>{loadErr}</div>}
      {photos === null ? (
        <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12 }}>Loading photos...</div>
      ) : photos.length === 0 ? (
        !loadErr && <div style={{ fontSize: 12.5, color: MUTED, marginTop: 12 }}>No photos for {prettyDay(day)} yet.</div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>{photos.length} photo{photos.length === 1 ? "" : "s"} for {prettyDay(day)}</div>
          <PhotoGrid photos={photos} urls={urls} onOpen={(p) => setOpen(p.id)} badge={(p) => (p.flagged_at ? "Reported" : null)} />
        </div>
      )}

      {openPhoto && (
        <PhotoLightbox
          photo={openPhoto}
          url={urls[openPhoto.storage_path]}
          onClose={() => setOpen(null)}
          actions={mine(openPhoto) ? [{
            label: "Delete photo",
            danger: true,
            confirm: "Delete this photo? Families will no longer see it.",
            onClick: async (p) => { await deleteClassPhoto(p); setOpen(null); await loadPhotos(day); },
          }] : []}
        />
      )}
    </div>
  );
}
