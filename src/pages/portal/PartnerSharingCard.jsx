// One-time permission card at the top of the instructor portal. Shown until the
// instructor agrees that their provider may share their record with partner
// organizations (see 20261019a_instructor_partner_sharing.sql).
//
// THE PORTAL, NOT THE WIZARD. Everyone who onboarded before 2026-10-19 has
// finished the wizard and will never see it again, and every new instructor
// lands here the moment they finish it. So this one card reaches both, instead
// of a wizard line for new people plus a second prompt for the existing team.
//
// REQUIRED, SO THERE IS NO "NOT NOW". The card stays until they agree. It does
// not block the rest of the portal: they still need their schedule today, and
// the partner portal shows "permission pending" for anyone who has not agreed.
//
// AN ADMIN PREVIEW NEVER AGREES. The database function binds to the signed-in
// user, so an admin previewing someone's portal could not record it anyway;
// the card says so instead of offering a button that would do nothing.
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { PARTNER_SHARING_VERSION, partnerSharingText } from "../../lib/partnerSharing.js";

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const BRIGHT = "#5847C9";
const VIOLET = "#8C88FF";
const CORAL = "#D9694F";
const OK_GREEN = "#3a7c3a";

export default function PartnerSharingCard({ instructorId, organizationId, orgName, previewOnly }) {
  // "loading" | "needed" | "agreed" | "hidden"
  const [state, setState] = useState("loading");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!instructorId) return;
    let cancelled = false;
    setState("loading");
    setChecked(false);
    setError("");
    (async () => {
      const { data, error: readErr } = await supabase
        .from("instructors")
        .select("partner_sharing_agreed_at")
        .eq("id", instructorId)
        .maybeSingle();
      if (cancelled) return;
      // A failed read hides the card rather than nagging someone who may have
      // already agreed. Nothing is lost: it shows again on the next visit, and
      // the partner portal still reads the real column.
      if (readErr || !data) {
        setState("hidden");
        return;
      }
      setState(data.partner_sharing_agreed_at ? "hidden" : "needed");
    })();
    return () => {
      cancelled = true;
    };
  }, [instructorId]);

  async function agree() {
    setSaving(true);
    setError("");
    const { data, error: rpcErr } = await supabase.rpc("agree_partner_sharing", {
      p_organization_id: organizationId,
      p_version: PARTNER_SHARING_VERSION,
    });
    setSaving(false);
    if (rpcErr) {
      setError("That didn't save. Please try again, or contact your Program Manager if it keeps happening.");
      return;
    }
    // false = no active instructor record for this sign-in at this business.
    // Retrying cannot fix that, so don't invite it.
    if (data !== true) {
      setError("We couldn't find an active instructor record for you here. Please contact your Program Manager.");
      return;
    }
    setState("agreed");
  }

  if (state === "loading" || state === "hidden") return null;

  if (state === "agreed") {
    return (
      <div role="status" style={{ ...box, borderColor: OK_GREEN, background: "#3a7c3a14" }}>
        <strong style={{ color: OK_GREEN }}>Thank you.</strong> Your permission is saved.
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ fontWeight: 700, color: INK, marginBottom: 6 }}>One quick permission</div>
      {previewOnly ? (
        <>
          <p style={para}>{partnerSharingText(orgName)}</p>
          <p style={{ ...para, color: MUTED, marginBottom: 0 }}>
            Admin preview: only the instructor can agree to this, from their own portal.
          </p>
        </>
      ) : (
        <>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
            />
            <span style={para}>{partnerSharingText(orgName)}</span>
          </label>
          <button
            type="button"
            onClick={agree}
            disabled={!checked || saving}
            style={{
              marginTop: 10,
              background: checked && !saving ? BRIGHT : "#c9c6ee",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "9px 16px",
              fontSize: 14,
              fontWeight: 600,
              cursor: checked && !saving ? "pointer" : "default",
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {error && (
            <div role="alert" style={{ marginTop: 8, fontSize: 13, color: CORAL }}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// "Sharing with partners" on the instructor's Profile: where the wording's "I
// can stop this at any time" is made true. Stopping clears the agreement
// (stop_partner_sharing, 20261022a); partners then see In review, "Waiting on
// this instructor's consent", and the card above returns on the schedule page,
// which is the ONE place to agree. This section never offers a second Agree.
export function PartnerSharingStatus({ instructorId, organizationId, previewOnly }) {
  // "loading" | "failed" | "sharing" | "not_sharing"
  const [state, setState] = useState("loading");
  const [agreedAt, setAgreedAt] = useState(null);
  const [stoppedAt, setStoppedAt] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!instructorId) return;
    let cancelled = false;
    (async () => {
      const { data, error: readErr } = await supabase
        .from("instructors")
        .select("partner_sharing_agreed_at, partner_sharing_stopped_at")
        .eq("id", instructorId)
        .maybeSingle();
      if (cancelled) return;
      if (readErr || !data) {
        setState("failed");
        return;
      }
      setAgreedAt(data.partner_sharing_agreed_at);
      setStoppedAt(data.partner_sharing_stopped_at);
      setState(data.partner_sharing_agreed_at ? "sharing" : "not_sharing");
    })();
    return () => {
      cancelled = true;
    };
  }, [instructorId]);

  async function stop() {
    setSaving(true);
    setError("");
    const { data, error: rpcErr } = await supabase.rpc("stop_partner_sharing", {
      p_organization_id: organizationId,
    });
    setSaving(false);
    if (rpcErr) {
      setError("That didn't save, so you are still sharing. Please try again, or contact your Program Manager.");
      return;
    }
    if (data !== true) {
      setError("We couldn't find your instructor record here, so nothing changed. Please contact your Program Manager.");
      return;
    }
    setConfirming(false);
    setAgreedAt(null);
    setStoppedAt(new Date().toISOString());
    setState("not_sharing");
  }

  if (state === "loading") return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #e2dfd5", borderRadius: 8, padding: 16, marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 }}>
        Sharing with partners
      </div>
      {state === "failed" && (
        <p style={{ ...para, color: MUTED }}>We couldn't load this right now. Please refresh to try again.</p>
      )}
      {state === "not_sharing" && (
        <p style={para}>
          {stoppedAt ? `You stopped sharing on ${fmtDay(stoppedAt)}. ` : "You haven't given permission yet. "}
          The schools and programs where you teach see your screening as In review. To share again, use the
          permission card at the top of your schedule.
        </p>
      )}
      {state === "sharing" && (
        <>
          <p style={para}>
            You agreed on {fmtDay(agreedAt)} to share your record with the schools and programs where you teach.
            You can stop at any time.
          </p>
          {previewOnly ? (
            <p style={{ ...para, color: MUTED, marginBottom: 0 }}>
              Admin preview: only the instructor can stop sharing, from their own portal.
            </p>
          ) : !confirming ? (
            <button type="button" onClick={() => setConfirming(true)} style={secondaryBtn}>
              Stop sharing
            </button>
          ) : (
            <div role="alert" style={{ marginTop: 8, padding: "10px 12px", border: `1px solid ${CORAL}`, borderRadius: 8, background: `${CORAL}0F` }}>
              <p style={para}>
                Stop sharing? The schools and programs where you teach will see your screening as In review, and
                no longer see your contact details, until you agree again.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                <button
                  type="button"
                  onClick={stop}
                  disabled={saving}
                  style={{ ...secondaryBtn, background: CORAL, borderColor: CORAL, color: "#fff", cursor: saving ? "default" : "pointer" }}
                >
                  {saving ? "Stopping..." : "Yes, stop sharing"}
                </button>
                <button type="button" onClick={() => { setConfirming(false); setError(""); }} disabled={saving} style={secondaryBtn}>
                  Keep sharing
                </button>
              </div>
            </div>
          )}
          {error && (
            <div role="alert" style={{ marginTop: 8, fontSize: 13, color: CORAL }}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function fmtDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const secondaryBtn = {
  marginTop: 4,
  background: "#fff",
  color: INK,
  border: "1px solid #c9c6ee",
  borderRadius: 8,
  padding: "8px 14px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const box = {
  border: `1px solid ${VIOLET}`,
  background: `${VIOLET}14`,
  borderRadius: 10,
  padding: "12px 14px",
  marginBottom: 14,
  fontSize: 14,
  color: INK,
  lineHeight: 1.5,
};

const para = { margin: "0 0 4px", fontSize: 14, color: INK, lineHeight: 1.5 };
