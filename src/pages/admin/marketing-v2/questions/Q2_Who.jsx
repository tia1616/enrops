// Q2_Who — audience picker. UI is simple in chunk 05 (state-only); real
// dropdowns populated from program_locations + segments come in chunk 06/07.
// State shape matches the deployed marketing-draft-campaign's WhoInput union:
//   { audience: 'parents' | 'partners' | 'instructors', filter: {...} }

import QuestionStep from "../QuestionStep.jsx";
import { PLUM, RULE, INK, MUTED, WARN } from "../../marketing/tokens.jsx";

const AUDIENCES = [
  {
    key: "parents",
    label: "Parents",
    helper: "Past, current, or all participants. By school, area, segment, or one family.",
    disabled: false,
  },
  {
    key: "partners",
    label: "Partner orgs",
    helper: "Schools, parks & rec, churches, libraries.",
    disabled: true,
  },
  {
    key: "instructors",
    label: "Instructors",
    helper: "All active, by tier, or specific people.",
    disabled: true,
  },
];

const PARENT_SCOPES = [
  { value: "master_list", label: "Master list (everyone)" },
  { value: "school", label: "A specific school…" },
  { value: "area", label: "An area…" },
  { value: "segment", label: "A saved segment…" },
  { value: "person", label: "Just one person…" },
];

export default function Q2_Who({ inputs, setField, onNext, onBack, canNext }) {
  const who = inputs.who;

  function setAudience(audience) {
    if (audience === "parents") {
      setField("who", { audience: "parents", filter: { type: "master_list" } });
    } else {
      // partners/instructors are coming soon; store a stub the backend rejects (501)
      setField("who", { audience, filter: {} });
    }
  }

  function setParentsScope(type) {
    const next = { ...who.filter, type };
    // Reset detail when scope changes
    if (type === "master_list") {
      setField("who", { audience: "parents", filter: { type: "master_list" } });
      return;
    }
    if (type === "school") next.school_ids = [];
    if (type === "area") next.area = "";
    if (type === "segment") next.segments = [];
    if (type === "person") next.text = "";
    setField("who", { audience: "parents", filter: next });
  }

  return (
    <QuestionStep
      title="Who's this going to?"
      helper="Pick an audience and narrow from there."
      onNext={onNext}
      onBack={onBack}
      canNext={canNext}
    >
      <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8, overflow: "hidden" }}>
        {AUDIENCES.map((a, i) => (
          <label
            key={a.key}
            style={{
              display: "flex", alignItems: "flex-start", gap: 10, padding: 12,
              borderTop: i === 0 ? "none" : `1px solid ${RULE}`,
              cursor: a.disabled ? "not-allowed" : "pointer",
              opacity: a.disabled ? 0.55 : 1,
              background: who.audience === a.key ? "#faf7ed" : "#fff",
            }}
          >
            <input
              type="radio"
              name="audience"
              checked={who.audience === a.key}
              onChange={() => !a.disabled && setAudience(a.key)}
              disabled={a.disabled}
              style={{ marginTop: 3 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontWeight: 600, color: INK }}>{a.label}</span>
                {a.disabled && (
                  <span style={{ fontSize: 10, padding: "2px 6px", background: "#FAEEDA", color: WARN, borderRadius: 999, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    Coming soon
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>{a.helper}</div>
            </div>
          </label>
        ))}
      </div>

      {who.audience === "parents" && (
        <div style={{ background: "#faf7ed", border: `1px solid #ece1bf`, borderRadius: 8, padding: 14, marginTop: 12 }}>
          <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 600, color: PLUM, textTransform: "uppercase", letterSpacing: 0.6 }}>
            Narrow it down
          </p>
          <label style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Scope</label>
          <select
            value={who.filter?.type ?? "master_list"}
            onChange={(e) => setParentsScope(e.target.value)}
            style={{
              width: "100%", padding: "8px 10px", border: `1px solid ${RULE}`, borderRadius: 5,
              background: "#fff", fontSize: 13, fontFamily: "inherit", color: INK,
            }}
          >
            {PARENT_SCOPES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <p style={{ margin: "8px 0 0", fontSize: 12, color: MUTED }}>
            {who.filter?.type === "master_list" ? "All parents on your master list will be included." : "The full multi-select list (schools / areas / segments / people) lands in chunk 3.6.06."}
          </p>
        </div>
      )}
    </QuestionStep>
  );
}
