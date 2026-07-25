// QuickProgramBuilder — the lean, curriculum-free program builder for self-serve
// registration operators (dance, martial arts, music, chess, etc.). Registration
// MVP, Chunk 3 slice 1.
//
// Unlike ProgramWizardNew (J2S's curriculum-based wizard), this asks for nothing
// but the essentials — name, price, spots, a simple repeating schedule — and gets
// the operator a LIVE, shareable registration link in one screen. No curriculum,
// no location prerequisite, no term picker.
//
// A few fields are set silently so the generated link actually works downstream
// (verified against the public catalog query in Home.jsx):
//   - term   = org.active_registration_term  (catalog + share link gate on this)
//   - status = 'open'                         (live immediately)
//   - runs_own_registration = false           (native enrops checkout)
//   - curriculum_id / program_location_id = null (no curriculum, location optional)
// The operator never sees "term" — it's enrichment-provider vocabulary, not theirs.

import { useEffect, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import ShareProgram from "../../../components/ShareProgram.jsx";
import PlacesAutocomplete from "../../../components/PlacesAutocomplete.jsx";
import { ensureBrowserSafeImage, extensionFor } from "../../../lib/heicConvert.js";

// Match ProgramWizardNew's palette so the two builders read as one system.
const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

// Title-Case — written straight to programs.day_of_week and compared with `=`
// on the public catalog. Lowercase silently breaks the match (see the note in
// ProgramWizardNew). Keep these Title-Case.
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Indexed by Date.getDay() (0 = Sunday). Used to warn when the chosen first
// class date's weekday doesn't match the selected day-of-week — the session
// dates derive from the DATE's weekday, so a mismatch silently meets on the
// wrong day.
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Convert a native <input type="time"> value ("15:30", 24h) to the "3:30 PM" text
// the rest of the app stores + reads (catalog, checkout, matcher). Mirrors the
// same helper in ProgramWizardNew so both builders write start_time identically.
function toDbTime12h(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${min} ${ampm}`;
}

const labelStyle = { display: "block", fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 };
const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  // 16px MINIMUM: iOS Safari auto-zooms the page when a focused input is under
  // 16px. Operators build programs on their phones, so anything smaller makes
  // the builder lurch on every field tap.
  fontSize: 16,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  fontFamily: "inherit",
  background: "#fff",
};
const helpStyle = { fontSize: 12, color: MUTED, marginTop: 4 };

export default function QuickProgramBuilder() {
  const { org } = useOutletContext();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [spots, setSpots] = useState("18");
  const [day, setDay] = useState("");
  const [startDate, setStartDate] = useState("");
  const [sessions, setSessions] = useState("8");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");
  const [createdId, setCreatedId] = useState(null);
  // Photo (optional). Uploaded to the existing public org-assets bucket the
  // moment it's picked, so the operator sees the real image before saving.
  const [photoUrl, setPhotoUrl] = useState("");
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoErr, setPhotoErr] = useState("");

  // Is the org able to actually take money yet? The share link goes live the
  // moment a program is created, but Arielle's rule is "never a payment-less
  // live page" — so on success we nudge the operator to connect Stripe FIRST
  // (the WOW), before they share. null = still loading, don't nudge yet.
  const [chargesEnabled, setChargesEnabled] = useState(null);
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("organizations")
        .select("stripe_charges_enabled")
        .eq("id", org.id)
        .maybeSingle();
      if (!cancelled) setChargesEnabled(!!data?.stripe_charges_enabled);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Locations the operator has set up (Settings -> Locations). One location
  // auto-selects (no need to pick when there's only one); 2+ shows a picker;
  // none = location-less (still valid — location is optional).
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState("");
  useEffect(() => {
    if (!org?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("program_locations")
        .select("id, name")
        .eq("organization_id", org.id)
        .order("name");
      if (cancelled) return;
      const locs = data ?? [];
      setLocations(locs);
      if (locs.length === 1) setLocationId(locs[0].id);
    })();
    return () => { cancelled = true; };
  }, [org?.id]);

  // Inline "add a location" so a new op can set their venue right here instead
  // of detouring to Settings. Writes to program_locations, then selects it.
  const [addingLocation, setAddingLocation] = useState(false);
  const [newLocName, setNewLocName] = useState("");
  const [newLocAddress, setNewLocAddress] = useState("");
  const [savingLoc, setSavingLoc] = useState(false);
  const [locErr, setLocErr] = useState("");

  async function saveNewLocation() {
    const nm = newLocName.trim();
    if (!nm || savingLoc) return;
    setSavingLoc(true);
    setLocErr("");
    try {
      // program_locations.slug is NOT NULL + globally unique; generate one from
      // the name with a random suffix (mirrors LocationsList).
      const base = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "venue";
      const slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
      const { data, error } = await supabase
        .from("program_locations")
        .insert({ organization_id: org.id, name: nm, address: newLocAddress.trim() || null, slug })
        .select("id, name")
        .single();
      if (error) throw error;
      setLocations((ls) => [...ls, { id: data.id, name: data.name }].sort((a, b) => a.name.localeCompare(b.name)));
      setLocationId(data.id);
      setAddingLocation(false);
      setNewLocName("");
      setNewLocAddress("");
    } catch (e) {
      setLocErr(e?.message ?? "Couldn't save that location.");
    } finally {
      setSavingLoc(false);
    }
  }

  const priceCents = Math.round(parseFloat(price || "0") * 100);
  const spotsNum = parseInt(spots || "0", 10);
  const sessionsNum = parseInt(sessions || "0", 10);
  const priceValid = price !== "" && Number.isFinite(priceCents) && priceCents >= 0;
  const valid = name.trim() !== "" && priceValid && !!day && spotsNum >= 1;

  // Warn (don't block) when the first class date falls on a different weekday
  // than the selected day — the derived sessions follow the date, not the day.
  const firstDateWeekday = startDate ? WEEKDAY_NAMES[new Date(`${startDate}T00:00:00`).getDay()] : null;
  const dayMismatch = !!(day && firstDateWeekday && firstDateWeekday !== day);

  // Upload the photo to org-assets. Mirrors BrandLogoSettings' logo/banner
  // upload exactly: the <org id>/ path prefix is what satisfies the bucket's
  // org_assets_org_admin_insert RLS policy. iPhone HEIC is converted first
  // (heic2any lazy-loads, so it costs nothing unless a HEIC is actually picked)
  // — operators building on a phone is the common case for this field.
  async function handlePhotoPick(file) {
    if (!file) return;
    setPhotoErr("");
    // Friendly pre-checks so the operator never sees a raw storage error.
    // 2 MB is the bucket's own limit; check BEFORE the round trip.
    const safe = await (async () => {
      try {
        return await ensureBrowserSafeImage(file);
      } catch {
        return file; // conversion failed — fall through to the type check below
      }
    })();
    if (!["image/jpeg", "image/png", "image/webp"].includes(safe.type)) {
      setPhotoErr("That file type isn't supported. Try a JPG, PNG, or WEBP.");
      return;
    }
    if (safe.size > 2 * 1024 * 1024) {
      setPhotoErr("That photo is over 2 MB. Try a smaller one.");
      return;
    }
    setUploadingPhoto(true);
    try {
      const path = `${org.id}/program-photos/${Date.now()}.${extensionFor(safe)}`;
      const { error: upErr } = await supabase.storage
        .from("org-assets")
        .upload(path, safe, { contentType: safe.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("org-assets").getPublicUrl(path);
      if (!pub?.publicUrl) throw new Error("Couldn't get the image URL.");
      setPhotoUrl(pub.publicUrl);
    } catch (e) {
      setPhotoErr(e?.message ?? "Couldn't upload that photo.");
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleCreate() {
    if (!valid || submitting) return;
    setSubmitting(true);
    setErr("");
    try {
      const payload = {
        organization_id: org.id,
        // Stamp the org's active term so the program lands in the public catalog
        // and the share link resolves. Operator never picks this.
        term: org.active_registration_term,
        curriculum: name.trim(), // NOT NULL display name; no curriculum record
        curriculum_id: null,
        program_location_id: locationId || null,
        day_of_week: day,
        start_time: startTime ? toDbTime12h(startTime) : null,
        end_time: endTime ? toDbTime12h(endTime) : null,
        first_session_date: startDate || null,
        session_count: sessionsNum >= 1 ? sessionsNum : 1,
        max_capacity: spotsNum,
        price_cents: priceCents,
        program_type: "standard",
        photo_url: photoUrl || null, // optional; NULL renders the no-image card
        runs_own_registration: false, // native enrops checkout
        status: "open", // live the moment it's created
      };
      const { data, error } = await supabase
        .from("programs")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      setCreatedId(data.id);
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function resetForAnother() {
    setName("");
    setPrice("");
    setSpots("18");
    setDay("");
    setStartDate("");
    setSessions("8");
    setStartTime("");
    setEndTime("");
    setLocationId(locations.length === 1 ? locations[0].id : "");
    setPhotoUrl("");
    setPhotoErr("");
    setErr("");
    setCreatedId(null);
  }

  // Guard: outlet not ready yet.
  if (!org) {
    return <div style={{ padding: 40, color: MUTED, textAlign: "center" }}>Loading…</div>;
  }

  // ---- Success: program is live, hand over the shareable link ----
  if (createdId) {
    // Arielle's rule: never a payment-less live page. If Stripe isn't connected
    // yet, lead with that step (the WOW) and dim the share link until it is.
    const notConnected = chargesEnabled === false;
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
        {/* Honest state: with Stripe not connected the page exists but can't take
            money, so "live" overstates it — and it directly contradicted the
            "One step left: connect Stripe" panel right below. Say "almost live"
            until charges are enabled. `notConnected` is only true when we KNOW
            charges are off (=== false), so an unresolved check never downgrades
            the wording for an operator who is actually connected. */}
        <div style={{ fontSize: 22, fontWeight: 700, color: INK, marginBottom: 8 }}>
          {notConnected ? "Your program is almost live." : "Your program is live."}
        </div>

        {notConnected ? (
          <>
            <div style={{ background: "#EEEDFE", border: "1px solid #CECBF6", borderRadius: 12, padding: "16px 18px", marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#26215C", marginBottom: 4 }}>
                One step left: connect Stripe to get paid
              </div>
              <p style={{ fontSize: 13.5, color: "#3C3489", lineHeight: 1.55, margin: "0 0 12px" }}>
                Connect Stripe so families' payments land straight in your bank account. Takes about 5 minutes, then share your link.
              </p>
              <button onClick={() => navigate("/admin/finances")} style={primaryBtn}>
                Connect Stripe →
              </button>
            </div>
            <p style={{ color: MUTED, fontSize: 13, lineHeight: 1.55, margin: "0 0 10px" }}>
              Your registration link — share it once you're set up to get paid:
            </p>
          </>
        ) : (
          <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" }}>
            Families can register now. Share the link below — you'll see sign-ups show
            up as they come in.
          </p>
        )}

        <div style={{ marginBottom: 24, opacity: notConnected ? 0.6 : 1 }}>
          <ShareProgram
            slug={org.slug}
            activeTerm={org.active_registration_term}
            align="left"
            program={{
              id: createdId,
              curriculum: name.trim(),
              status: "open",
              term: org.active_registration_term,
              runs_own_registration: false,
            }}
          />
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button onClick={resetForAnother} style={primaryBtn}>
            Create another
          </button>
          <button
            onClick={() => navigate("/admin/programs")}
            style={{ ...primaryBtn, background: "#fff", color: BRIGHT, border: `1px solid ${RULE}` }}
          >
            Back to programs
          </button>
        </div>
      </div>
    );
  }

  // ---- The lean form ----
  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: INK, marginBottom: 4 }}>
        Create a program
      </div>
      <p style={{ color: MUTED, fontSize: 14, lineHeight: 1.55, margin: "0 0 24px" }}>
        The essentials only. You'll get a shareable registration link the moment
        you save.
      </p>

      <div style={{ display: "grid", gap: 18 }}>
        <div>
          <label style={labelStyle} htmlFor="qpb-name">Program name</label>
          <input
            id="qpb-name"
            style={inputStyle}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Beginner Ballet, Tuesdays"
            maxLength={120}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="qpb-price">Price</label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 12, top: 10, color: MUTED, fontSize: 15 }}>$</span>
              <input
                id="qpb-price"
                style={{ ...inputStyle, paddingLeft: 24 }}
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                placeholder="0.00"
              />
            </div>
          </div>
          <div>
            <label style={labelStyle} htmlFor="qpb-spots">Spots</label>
            <input
              id="qpb-spots"
              style={inputStyle}
              value={spots}
              onChange={(e) => setSpots(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              placeholder="18"
            />
          </div>
        </div>

        <div>
          <label style={labelStyle} htmlFor="qpb-photo">Photo <span style={{ fontWeight: 400, color: "#6b6b6b" }}>(optional)</span></label>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            {photoUrl && (
              <img
                src={photoUrl}
                alt="Program photo preview"
                style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, border: `1px solid ${RULE}` }}
              />
            )}
            <div>
              <input
                id="qpb-photo"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; handlePhotoPick(f); }}
                disabled={uploadingPhoto}
                style={{ fontSize: 14 }}
              />
              <div style={{ fontSize: 12, color: "#6b6b6b", marginTop: 4 }}>
                {uploadingPhoto
                  ? "Uploading…"
                  : photoUrl
                  ? "Looks good. Pick another to replace it."
                  : "A photo makes your class stand out to families. JPG, PNG or WEBP, up to 2 MB."}
              </div>
              {photoUrl && !uploadingPhoto && (
                <button
                  type="button"
                  onClick={() => { setPhotoUrl(""); setPhotoErr(""); }}
                  style={{ marginTop: 6, background: "none", border: "none", color: BRIGHT, fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>
          {photoErr && <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>{photoErr}</div>}
        </div>

        <div>
          <label style={labelStyle} htmlFor="qpb-location">Location</label>
          {addingLocation ? (
            <div style={{ border: `1px solid ${RULE}`, borderRadius: 8, padding: 12, background: "#FBFBFB" }}>
              <input
                style={{ ...inputStyle, marginBottom: 8 }}
                value={newLocName}
                onChange={(e) => setNewLocName(e.target.value)}
                placeholder="Location name (e.g. Downtown Studio)"
                maxLength={80}
                autoFocus
              />
              <PlacesAutocomplete
                value={newLocAddress}
                onChange={setNewLocAddress}
                onSelect={({ name, address }) => { if (!newLocName.trim()) setNewLocName(name); setNewLocAddress(address); }}
                placeholder="Address (optional)"
                style={inputStyle}
              />
              {locErr && <div style={{ color: "#b53737", fontSize: 12, marginTop: 6 }}>{locErr}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button type="button" onClick={saveNewLocation} disabled={savingLoc || !newLocName.trim()} style={{ ...primaryBtn, opacity: savingLoc || !newLocName.trim() ? 0.55 : 1 }}>
                  {savingLoc ? "Saving…" : "Save location"}
                </button>
                <button type="button" onClick={() => { setAddingLocation(false); setNewLocName(""); setNewLocAddress(""); setLocErr(""); }} style={{ ...primaryBtn, background: "#fff", color: BRIGHT, border: `1px solid ${RULE}` }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <select id="qpb-location" style={inputStyle} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                <option value="">No specific location</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div style={{ marginTop: 6 }}>
                <span onClick={() => setAddingLocation(true)} style={{ color: BRIGHT, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>+ Add a location</span>
              </div>
            </>
          )}
        </div>

        <div>
          <label style={labelStyle} htmlFor="qpb-day">Day of the week</label>
          <select
            id="qpb-day"
            style={inputStyle}
            value={day}
            onChange={(e) => setDay(e.target.value)}
          >
            <option value="">Choose a day…</option>
            {DAYS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <div style={helpStyle}>Which day the class meets each week.</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="qpb-start-time">Start time</label>
            <input
              id="qpb-start-time"
              type="time"
              style={inputStyle}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="qpb-end-time">End time</label>
            <input
              id="qpb-end-time"
              type="time"
              style={inputStyle}
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={labelStyle} htmlFor="qpb-start-date">First class date</label>
            <input
              id="qpb-start-date"
              type="date"
              style={inputStyle}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
            <div style={helpStyle}>Optional.</div>
          </div>
          <div>
            <label style={labelStyle} htmlFor="qpb-sessions"># of classes</label>
            <input
              id="qpb-sessions"
              style={inputStyle}
              value={sessions}
              onChange={(e) => setSessions(e.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              placeholder="8"
            />
            <div style={helpStyle}>How many weekly sessions.</div>
          </div>
        </div>

        {dayMismatch && (
          <div style={{ background: "#FDF6E3", border: "1px solid #F0D48A", color: "#8a5a00", borderRadius: 8, padding: "10px 12px", fontSize: 13, lineHeight: 1.5 }}>
            Heads up: your first class date is a <strong>{firstDateWeekday}</strong>, but you chose <strong>{day}</strong>.
            Classes will meet on {firstDateWeekday}s. Pick a {day} date, or change the day to match.
          </div>
        )}

        {err && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b53737", borderRadius: 8, padding: "10px 12px", fontSize: 13 }}>
            {err}
          </div>
        )}

        <button
          onClick={handleCreate}
          disabled={!valid || submitting}
          style={{ ...primaryBtn, width: "100%", opacity: !valid || submitting ? 0.55 : 1, cursor: !valid || submitting ? "not-allowed" : "pointer" }}
        >
          {submitting ? "Creating…" : "Create program & get link"}
        </button>
      </div>
    </div>
  );
}

const primaryBtn = {
  padding: "12px 20px",
  background: BRIGHT,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 15,
  fontWeight: 600,
  fontFamily: "inherit",
  cursor: "pointer",
};
