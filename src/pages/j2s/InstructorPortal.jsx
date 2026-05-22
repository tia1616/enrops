// src/pages/j2s/InstructorPortal.jsx
// Minimal instructor portal: magic-link sign-in, list of published assignments,
// Accept or Request Change per camp. Class detail + My Availability are v2.

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { displayFirstName } from "../../lib/instructorName";
import { avatarUrl } from "../../lib/avatars";
import InstructorAvailabilityForm from "./InstructorAvailabilityForm.jsx";
import InstructorProfile from "./InstructorProfile.jsx";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const CHALK = "#EAEADD";
const CORAL = "#D9694F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const OK_GREEN = "#3a7c3a";

function fmt(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function fmtShort(date) {
  if (!date) return "";
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "pm" : "am";
  return m === 0 ? `${hr12}${ampm}` : `${hr12}:${String(m).padStart(2, "0")}${ampm}`;
}

function titleCase(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function dollars(cents) {
  if (!cents) return "";
  if (cents % 100 === 0) return `$${cents / 100}`;
  return `$${(cents / 100).toFixed(2)}`;
}

export default function InstructorPortal() {
  const [phase, setPhase] = useState("loading"); // loading | login | linking | ready | error
  const [email, setEmail] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [error, setError] = useState("");
  const [instructor, setInstructor] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [actingOn, setActingOn] = useState(null); // assignment id currently being acted on
  const [changeFor, setChangeFor] = useState(null); // assignment object pending request-change message
  const [changeText, setChangeText] = useState("");
  const [impersonating, setImpersonating] = useState(null); // { asEmail, signedInEmail } when admin is viewing as instructor
  const [cycles, setCycles] = useState([]); // open cycles for this org with survey status
  const [editingCycleId, setEditingCycleId] = useState(null); // when set, render the availability form for this cycle
  const [view, setView] = useState("schedule"); // "schedule" | "profile"

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const asEmail = params.get("as");

        const { data: { session } } = await supabase.auth.getSession();
        if (!mounted) return;
        if (!session?.user) {
          setPhase("login");
          return;
        }

        if (asEmail) {
          // Admin-impersonation path: fetch the named instructor and load their
          // view. Works only when the signed-in user is an org admin/owner —
          // RLS on instructors limits other roles.
          setPhase("linking");
          const { data: target, error: targetErr } = await supabase
            .from("instructors")
            .select("id, organization_id, first_name, last_name, preferred_name, email")
            .ilike("email", asEmail)
            .eq("is_active", true)
            .maybeSingle();
          if (!mounted) return;
          if (targetErr || !target) {
            setError(`No active instructor found for ${asEmail}. (Are you signed in as an admin of the right org?)`);
            setPhase("error");
            return;
          }
          setInstructor({
            instructor_id: target.id,
            organization_id: target.organization_id,
            first_name: target.first_name,
            last_name: target.last_name,
            preferred_name: target.preferred_name,
          });
          setImpersonating({ asEmail: target.email, signedInEmail: session.user.email });
          const targetInst = {
            instructor_id: target.id,
            organization_id: target.organization_id,
            first_name: target.first_name,
            last_name: target.last_name,
            preferred_name: target.preferred_name,
          };
          await Promise.all([loadAssignments(target.id), loadCycles(targetInst)]);
          setPhase("ready");
          return;
        }

        await linkAndLoad();
      } catch (err) {
        if (mounted) {
          setError(err.message ?? "Couldn't load.");
          setPhase("error");
        }
      }
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function linkAndLoad() {
    setPhase("linking");
    setError("");
    try {
      const { data: linkData, error: linkErr } = await supabase.functions.invoke("link-instructor", {
        body: {},
      });
      if (linkErr || linkData?.error) {
        throw new Error(linkData?.error ?? linkErr?.message ?? "Couldn't find your instructor record.");
      }
      // Fetch the full instructor row for profile fields (RLS self-read).
      // link-instructor only returns id/org/name/email; profile needs phone,
      // photo_url, shirt_size, CPR, etc.
      const { data: full } = await supabase
        .from("instructors")
        .select("id, first_name, last_name, preferred_name, email, phone, photo_url, shirt_size, first_aid_cpr_url, first_aid_cpr_expires_at, contractor_tier")
        .eq("id", linkData.instructor_id)
        .maybeSingle();
      setInstructor({ ...linkData, ...(full ?? {}) });
      await Promise.all([loadAssignments(linkData.instructor_id), loadCycles(linkData)]);
      setPhase("ready");
    } catch (err) {
      setError(err.message ?? "Couldn't link your account.");
      setPhase("error");
    }
  }

  // Re-fetch the instructor row (used after Profile saves changes so the
  // schedule view reflects updated avatar / preferred name without a full
  // page reload).
  async function refetchInstructor() {
    if (!instructor?.instructor_id && !instructor?.id) return;
    const id = instructor.instructor_id ?? instructor.id;
    const { data: full } = await supabase
      .from("instructors")
      .select("id, first_name, last_name, preferred_name, email, phone, photo_url, shirt_size, first_aid_cpr_url, first_aid_cpr_expires_at, contractor_tier")
      .eq("id", id)
      .maybeSingle();
    if (full) setInstructor((cur) => ({ ...cur, ...full }));
  }

  async function loadAssignments(instructorId) {
    // Per amended spec §2.2: filter to active cycles + non-terminal statuses.
    // `published_at IS NOT NULL` already excludes 'proposed'; we additionally
    // exclude 'withdrawn'/'declined' so admin-removed rows don't linger on
    // the instructor's schedule. Cycle filter excludes archived prior-term
    // assignments (matters once FA26 lands; SU26-only today).
    const { data, error: aErr } = await supabase
      .from("camp_assignments")
      .select("id, status, role, distance_bonus_cents, flags, change_request_message, instructor_response_at, camp_session_id, camp_sessions(id, location_name, week_num, session_type, curriculum_name, starts_on, ends_on, start_time, end_time, class_days, cycle_id, scheduling_cycles:cycle_id(status)), instructor_offer_messages(id, sender_role, sender_instructor_id, message, created_at)")
      .eq("instructor_id", instructorId)
      .not("published_at", "is", null)
      .in("status", ["published", "change_requested", "confirmed"])
      .order("camp_sessions(starts_on)", { ascending: true });
    if (aErr) throw aErr;
    const filtered = (data ?? []).filter(
      (a) => a.camp_sessions?.scheduling_cycles?.status !== "archived"
    );
    setAssignments(filtered);
  }

  // Load any open cycles (not archived) for this instructor's org plus a flag
  // for whether they've already filled out their availability for each. Used
  // to surface "Set up your availability" / "Update availability" banners.
  async function loadCycles(loadedInstructor) {
    if (!loadedInstructor?.organization_id || !loadedInstructor?.instructor_id) return;
    // Only surface cycles where the admin has actually opened the survey to
    // instructors. NULL availability_survey_opened_at = admin hasn't released
    // it yet, so the portal stays quiet about that cycle.
    const { data: cycleRows, error: cErr } = await supabase
      .from("scheduling_cycles")
      .select("id, name, cycle_type, starts_on, ends_on, weeks, status, availability_survey_opened_at, survey_deadline")
      .eq("organization_id", loadedInstructor.organization_id)
      .not("availability_survey_opened_at", "is", null)
      .order("starts_on", { ascending: true });
    if (cErr) {
      console.warn("Couldn't load cycles for availability survey:", cErr);
      return;
    }
    const ids = (cycleRows ?? []).map((c) => c.id);
    let submittedMap = {};
    if (ids.length > 0) {
      const { data: availRows } = await supabase
        .from("instructor_availability")
        .select("cycle_id, submitted_at")
        .eq("instructor_id", loadedInstructor.instructor_id)
        .in("cycle_id", ids);
      for (const r of availRows ?? []) submittedMap[r.cycle_id] = r.submitted_at;
    }
    setCycles((cycleRows ?? []).map((c) => ({
      ...c,
      submitted_at: submittedMap[c.id] ?? null,
    })));
  }

  async function handleSignIn(e) {
    e.preventDefault();
    if (!email) return;
    setSendBusy(true);
    setSendMsg("");
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("auth-send-magic-link", {
        body: {
          email,
          redirect_to: `${window.location.origin}/j2s/instructor`,
          context: "instructor",
        },
      });
      if (fnErr) throw fnErr;
      if (data?.error) throw new Error(data.error);
      setSendMsg(`Check ${email} for your sign-in link.`);
    } catch (err) {
      setError(err.message ?? "Couldn't send the link. Try again.");
    } finally {
      setSendBusy(false);
    }
  }

  async function handleGoogle() {
    setSendBusy(true);
    setError("");
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/j2s/instructor` },
    });
    if (err) {
      setError(err.message);
      setSendBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    setInstructor(null);
    setAssignments([]);
    setPhase("login");
  }

  // Chunk F: Accept + Request Change now route through respond-to-assignment.
  // Direct UPDATE on camp_assignments is being removed once this UI ships —
  // the edge function is the sole instructor write path going forward.
  async function handleAccept(assignment) {
    setActingOn(assignment.id);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "respond-to-assignment",
        { body: { camp_assignment_id: assignment.id, action: "accept" } }
      );
      if (fnErr || data?.error) {
        // already_confirmed is treated as success — admin or another tab
        // beat us to it. Refetch and move on.
        if (data?.error === "already_confirmed") {
          await loadAssignments(instructor.instructor_id);
          return;
        }
        if (data?.error === "assignment_closed" || data?.error === "forbidden") {
          // Admin withdrew it (or reassigned). Quiet refetch so the stale
          // card disappears with a small note.
          setError("That assignment is no longer available — your coordinator may have made a change.");
          await loadAssignments(instructor.instructor_id);
          return;
        }
        throw new Error(data?.error || fnErr?.message || "Couldn't accept.");
      }
      await loadAssignments(instructor.instructor_id);
    } catch (err) {
      setError(err.message ?? "Couldn't accept.");
    } finally {
      setActingOn(null);
    }
  }

  async function submitChangeRequest() {
    if (!changeFor || !changeText.trim()) return;
    setActingOn(changeFor.id);
    setError("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke(
        "respond-to-assignment",
        {
          body: {
            camp_assignment_id: changeFor.id,
            action: "request_change",
            message: changeText.trim(),
          },
        }
      );
      if (fnErr || data?.error) {
        if (data?.error === "already_confirmed") {
          // Stale tab — they confirmed in another tab, then tried to
          // request change here. Treat as "actually you already accepted."
          setError("You already accepted this — refresh and you'll see it confirmed.");
          setChangeFor(null);
          setChangeText("");
          await loadAssignments(instructor.instructor_id);
          return;
        }
        if (data?.error === "assignment_closed" || data?.error === "forbidden") {
          setError("That assignment is no longer available — your coordinator may have made a change.");
          setChangeFor(null);
          setChangeText("");
          await loadAssignments(instructor.instructor_id);
          return;
        }
        throw new Error(data?.error || fnErr?.message || "Couldn't send your request.");
      }
      setChangeFor(null);
      setChangeText("");
      await loadAssignments(instructor.instructor_id);
    } catch (err) {
      setError(err.message ?? "Couldn't send your request.");
    } finally {
      setActingOn(null);
    }
  }

  if (phase === "loading" || phase === "linking") {
    return <Shell><div style={{ color: MUTED, fontSize: 14, padding: 24 }}>Loading…</div></Shell>;
  }

  if (phase === "login") {
    return (
      <Shell>
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: 28, maxWidth: 400 }}>
          <h1 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 700, color: PLUM }}>Instructor sign in</h1>
          <p style={{ margin: "0 0 18px", color: MUTED, fontSize: 14 }}>Sign in to view your schedule and respond to offers.</p>

          <button
            type="button"
            onClick={handleGoogle}
            disabled={sendBusy}
            style={{
              width: "100%",
              padding: "10px 14px",
              background: "#fff",
              color: INK,
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: sendBusy ? "wait" : "pointer",
              opacity: sendBusy ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <GoogleG />
            Continue with Google
          </button>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            margin: "0 0 16px",
            color: MUTED,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}>
            <span style={{ flex: 1, height: 1, background: RULE }} />
            or
            <span style={{ flex: 1, height: 1, background: RULE }} />
          </div>

          <form onSubmit={handleSignIn}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              style={{
                width: "100%",
                padding: "10px 12px",
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                fontSize: 14,
                fontFamily: "inherit",
                background: "#fff",
                color: INK,
                boxSizing: "border-box",
              }}
            />
            <button
              type="submit"
              disabled={sendBusy || !email}
              style={{
                marginTop: 12,
                width: "100%",
                padding: "10px 14px",
                background: PLUM,
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: sendBusy ? "wait" : "pointer",
                opacity: sendBusy ? 0.7 : 1,
              }}
            >
              {sendBusy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
          {sendMsg && (
            <div style={{ marginTop: 14, padding: 10, borderRadius: 6, background: `${OK_GREEN}1A`, color: OK_GREEN, fontSize: 13 }}>{sendMsg}</div>
          )}
          {error && (
            <div style={{ marginTop: 14, padding: 10, borderRadius: 6, background: `${CORAL}1A`, color: CORAL, fontSize: 13 }}>{error}</div>
          )}
        </div>
      </Shell>
    );
  }

  if (phase === "error") {
    return (
      <Shell>
        <div style={{ background: "#fff", border: `1px solid ${CORAL}`, borderRadius: 10, padding: 28, maxWidth: 500 }}>
          <h1 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 700, color: INK }}>We couldn't load your schedule</h1>
          <p style={{ color: MUTED, fontSize: 14, margin: "0 0 16px", lineHeight: 1.5 }}>{error}</p>
          <button type="button" onClick={signOut} style={{ padding: "8px 14px", background: "transparent", color: PLUM, border: `1px solid ${PLUM}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
            Sign out and try again
          </button>
        </div>
      </Shell>
    );
  }

  // ready
  const totalCount = assignments.length;
  // Amended spec §2.1: 'published' and 'change_requested' both go in the
  // "Needs your response" section. The change_requested cards retain their
  // message-thread display and disable Request Change until admin replies.
  const needsResponse = assignments.filter(
    (a) => a.status === "published" || a.status === "change_requested"
  );
  const accepted = assignments.filter((a) => a.status === "confirmed" && a.instructor_response_at);

  // Cycles that are open + the instructor hasn't filled out availability yet,
  // or has but might want to update. We surface a banner per cycle.
  const editingCycle = editingCycleId ? cycles.find((c) => c.id === editingCycleId) : null;
  const needsSurvey = cycles.filter((c) => !c.submitted_at);
  const updatableSurveys = cycles.filter((c) => !!c.submitted_at && c.status !== "archived");

  // While editing availability for a cycle, hide the assignment list entirely.
  if (editingCycle) {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        {impersonating && (
          <div style={{
            background: `${GOLD}1F`,
            border: `1px solid ${GOLD}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 14,
            fontSize: 13,
            color: INK,
            lineHeight: 1.5,
          }}>
            <strong>Admin preview</strong> — saving will write to <em>{impersonating.asEmail}</em>'s availability.
          </div>
        )}
        <InstructorAvailabilityForm
          instructor={instructor}
          cycle={editingCycle}
          onSaved={async () => {
            setEditingCycleId(null);
            await loadCycles(instructor);
          }}
          onCancel={() => setEditingCycleId(null)}
        />
      </Shell>
    );
  }

  if (view === "profile") {
    return (
      <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
        <InstructorProfile
          instructor={{ ...instructor, id: instructor.id ?? instructor.instructor_id }}
          onBack={() => setView("schedule")}
          onSaved={refetchInstructor}
        />
      </Shell>
    );
  }

  return (
    <Shell instructorName={displayFirstName(instructor)} onSignOut={signOut}>
      {impersonating && (
        <div style={{
          background: `${GOLD}1F`,
          border: `1px solid ${GOLD}`,
          borderRadius: 8,
          padding: "10px 14px",
          marginBottom: 14,
          fontSize: 13,
          color: INK,
          lineHeight: 1.5,
        }}>
          <strong>Admin preview</strong> — you're signed in as <em>{impersonating.signedInEmail}</em> and viewing <em>{impersonating.asEmail}</em>'s portal. Accept and Request change actions will fire on this instructor's behalf.
        </div>
      )}
      <header style={{ marginBottom: 18, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          {instructor.photo_url && (
            <img
              src={avatarUrl(instructor.photo_url)}
              alt=""
              style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0 }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: INK, letterSpacing: -0.3 }}>
              Hi {displayFirstName(instructor)} 👋
            </h1>
            <p style={{ color: MUTED, margin: "4px 0 0", fontSize: 14 }}>
              You have {totalCount} camp{totalCount === 1 ? "" : "s"} on your schedule
              {pending.length > 0 && ` · ${pending.length} awaiting your response`}.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setView("profile")}
          style={{
            background: "transparent",
            border: `1px solid ${PLUM}`,
            color: PLUM,
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 12,
            fontWeight: 600,
            fontFamily: "inherit",
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          My profile →
        </button>
      </header>

      {error && (
        <div style={{ background: `${CORAL}1F`, border: `1px solid ${CORAL}`, color: CORAL, padding: 12, borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
          {error}
        </div>
      )}

      {needsSurvey.length > 0 && (
        <div style={{ marginBottom: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          {needsSurvey.map((c) => (
            <SurveyBanner
              key={c.id}
              cycle={c}
              onStart={() => setEditingCycleId(c.id)}
            />
          ))}
        </div>
      )}

      {needsResponse.length > 0 && (
        <Section title="Needs your response">
          {needsResponse.map((a) => (
            <AssignmentCard
              key={a.id}
              assignment={a}
              messages={a.instructor_offer_messages || []}
              busy={actingOn === a.id}
              onAccept={() => handleAccept(a)}
              onRequestChange={() => { setChangeFor(a); setChangeText(""); }}
            />
          ))}
        </Section>
      )}

      {accepted.length > 0 && (
        <Section title="Confirmed schedule">
          {accepted.map((a) => <AssignmentCard key={a.id} assignment={a} readOnly />)}
        </Section>
      )}

      {totalCount === 0 && needsSurvey.length === 0 && (
        <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 10, padding: 28, color: MUTED, textAlign: "center" }}>
          No schedule yet. Your admin will email you when it's ready.
        </div>
      )}

      {updatableSurveys.length > 0 && (
        <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
            Your availability
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {updatableSurveys.map((c) => (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 13, color: INK }}>
                <span>
                  {cycleLabel(c)} <span style={{ color: MUTED }}>· submitted {fmtShort(c.submitted_at?.slice(0, 10))}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setEditingCycleId(c.id)}
                  style={{ background: "transparent", color: PLUM, border: `1px solid ${PLUM}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}
                >
                  Update availability
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {changeFor && (
        <ChangeRequestDialog
          assignment={changeFor}
          value={changeText}
          onChange={setChangeText}
          busy={actingOn === changeFor.id}
          onSubmit={submitChangeRequest}
          onClose={() => { setChangeFor(null); setChangeText(""); }}
        />
      )}
    </Shell>
  );
}

function cycleLabel(cycle) {
  if (!cycle?.name) return "Cycle";
  const m = /^(SU|FA|WI|SP)(\d{2})$/.exec(cycle.name);
  if (!m) return cycle.name;
  const terms = { SU: "Summer", FA: "Fall", WI: "Winter", SP: "Spring" };
  return `${terms[m[1]]} 20${m[2]}`;
}

function SurveyBanner({ cycle, onStart }) {
  const title = cycleLabel(cycle);
  return (
    <div style={{
      background: `${GOLD}1F`,
      border: `1px solid ${GOLD}`,
      borderRadius: 10,
      padding: "14px 16px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      flexWrap: "wrap",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: PLUM, textTransform: "uppercase", letterSpacing: 0.6 }}>
          New: set up your availability
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: INK, marginTop: 2 }}>
          Tell us when you can work this {title}
        </div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>
          {fmtShort(cycle.starts_on)} – {fmtShort(cycle.ends_on)} · ~2 minutes
          {cycle.survey_deadline && (
            <> · <span style={{ color: CORAL, fontWeight: 600 }}>please submit by {fmtShort(cycle.survey_deadline.slice(0, 10))}</span></>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onStart}
        style={{
          padding: "9px 14px",
          background: PLUM,
          color: "#fff",
          border: "none",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          fontFamily: "inherit",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        Start
      </button>
    </div>
  );
}

function Shell({ children, instructorName, onSignOut }) {
  return (
    <div style={{
      minHeight: "100vh",
      background: CHALK,
      fontFamily: "'Space Grotesk', system-ui, sans-serif",
      color: INK,
      padding: "32px 16px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontWeight: 800, fontSize: 22, color: PLUM, letterSpacing: -0.3 }}>Enrops</span>
            <span style={{ fontSize: 13, color: MUTED }}>Instructor portal</span>
          </div>
          {instructorName && onSignOut && (
            <button type="button" onClick={onSignOut} style={{ background: "transparent", border: `1px solid ${PLUM}`, color: PLUM, borderRadius: 6, padding: "5px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer" }}>
              Sign out
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>
        {title}
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function AssignmentCard({ assignment, messages = [], busy, onAccept, onRequestChange, readOnly }) {
  const s = assignment.camp_sessions;
  if (!s) return null;
  const role = assignment.role === "developing" ? "Developing" : "Lead";
  const statusColor =
    assignment.status === "confirmed" ? OK_GREEN :
    assignment.status === "change_requested" ? GOLD :
    PLUM;
  const statusLabel =
    assignment.status === "confirmed" ? "Confirmed ✓" :
    assignment.status === "change_requested" ? "Change requested — waiting on admin" :
    "Awaiting your response";

  // Per amended spec §4.4: when status is change_requested, look at the
  // newest message in the thread. If it's from admin (sender_role='admin'),
  // the instructor's "Request change" button re-enables — they can send
  // another change request OR accept the original offer. If the newest
  // message is the instructor's own (or there's no admin reply yet), the
  // Request Change button is disabled.
  const sortedMsgs = [...messages].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
  const latestMsg = sortedMsgs[0];
  const awaitingAdminReply =
    assignment.status === "change_requested" &&
    latestMsg?.sender_role === "instructor";
  const requestChangeDisabled = busy || awaitingAdminReply;

  return (
    <div style={{
      background: "#fff",
      border: `1px solid ${RULE}`,
      borderLeft: `3px solid ${statusColor}`,
      borderRadius: 8,
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK, lineHeight: 1.3 }}>
            {s.curriculum_name} <span style={{ fontWeight: 400, color: MUTED, fontSize: 12, marginLeft: 4 }}>· {role}</span>
          </div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.4 }}>
            Week {s.week_num} · {fmtShort(s.starts_on)} – {fmtShort(s.ends_on)}<br />
            {s.location_name} · {titleCase(s.session_type)} {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
          </div>
        </div>
        <span style={{ fontSize: 11, color: statusColor, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap", textAlign: "right", maxWidth: 140 }}>
          {statusLabel}
        </span>
      </div>

      {assignment.distance_bonus_cents ? (
        <div style={{ fontSize: 13, color: PLUM, fontWeight: 600 }}>
          + {dollars(assignment.distance_bonus_cents)} distance bonus
        </div>
      ) : null}

      {/* Message thread renders on change_requested cards. Read-only on
          instructor side; admin replies via offer-message-reply elsewhere. */}
      {assignment.status === "change_requested" && messages.length > 0 && (
        <div style={{ marginTop: 4, padding: 10, background: `${GOLD}10`, border: `1px solid ${GOLD}`, borderRadius: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
            Messages
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {[...messages]
              .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
              .map((m) => (
                <div key={m.id} style={{ fontSize: 13, color: INK, lineHeight: 1.4 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: m.sender_role === "admin" ? PLUM : MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginRight: 6 }}>
                    {m.sender_role === "admin" ? "Admin" : "You"}
                  </span>
                  {m.message}
                </div>
              ))}
          </div>
        </div>
      )}

      {!readOnly && (
        <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            style={{
              padding: "8px 14px",
              background: PLUM,
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: busy ? "wait" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Saving…" : "Accept"}
          </button>
          <button
            type="button"
            onClick={onRequestChange}
            disabled={requestChangeDisabled}
            title={awaitingAdminReply ? "You already requested a change — wait for your coordinator to reply, then you can send another." : ""}
            style={{
              padding: "8px 14px",
              background: "transparent",
              color: PLUM,
              border: `1px solid ${PLUM}`,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              fontFamily: "inherit",
              cursor: requestChangeDisabled ? "not-allowed" : "pointer",
              opacity: requestChangeDisabled ? 0.5 : 1,
            }}
          >
            {assignment.status === "change_requested" ? "Send another change request" : "Request change"}
          </button>
        </div>
      )}
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  );
}

function ChangeRequestDialog({ assignment, value, onChange, busy, onSubmit, onClose }) {
  const s = assignment.camp_sessions;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        width: "100%",
        maxWidth: 480,
      }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${RULE}` }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
            Request change
          </div>
          <h2 style={{ margin: "4px 0 0", fontSize: 17, fontWeight: 700, color: INK }}>
            {s?.curriculum_name}
          </h2>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>
            Week {s?.week_num} · {s?.location_name}
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: INK, textTransform: "uppercase", letterSpacing: 0.5, display: "block", marginBottom: 6 }}>
            Tell your admin why
          </label>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="e.g., I can't do this week — my kids are at a different camp."
            rows={4}
            style={{
              width: "100%",
              padding: "10px 12px",
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              fontSize: 14,
              fontFamily: "inherit",
              color: INK,
              background: "#fff",
              boxSizing: "border-box",
              resize: "vertical",
            }}
          />
          <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>
            Your admin will see your message and either reassign this camp or reply.
          </div>
        </div>
        <div style={{ padding: "0 20px 20px", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={{ padding: "8px 14px", background: "transparent", color: MUTED, border: `1px solid ${RULE}`, borderRadius: 6, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
            Cancel
          </button>
          <button type="button" onClick={onSubmit} disabled={busy || !value.trim()} style={{ padding: "8px 14px", background: PLUM, color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, fontFamily: "inherit", cursor: busy ? "wait" : "pointer", opacity: (busy || !value.trim()) ? 0.6 : 1 }}>
            {busy ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  );
}
