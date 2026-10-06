// Which price tier a program sits in.
//
// programs.price_tier has existed since the original pricing work and has never
// had a control: the live values were set by hand in SQL. It gets one now because
// the early-bird rule reads it -- the after-school pricing sheet has no early bird
// for preschool, and a rule keyed on a field nobody can set is a rule that can
// never fire.
//
// Shown only to organisations that run term-wide early-bird pricing (the same
// `instructor_pay_model !== 'enrops_platform'` gate the Discounts card uses for
// its early-bird section). The tier NAMES are after-school pricing-sheet terms,
// so putting them in front of an organisation that has no tiers would be asking
// a question with no meaning for them.

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

// Must stay in step with the programs_price_tier_check constraint
// (migration 20261006a). A value not in this list fails the save at the database.
export const PRICE_TIERS = [
  { value: "standard", label: "Standard" },
  { value: "coding_robotics", label: "Coding & robotics" },
  { value: "preschool", label: "Preschool" },
];

// Renders the control only, with no caption of its own: every caller already sits
// inside its form's own labelled field wrapper, and a second <label> nested in
// that one is invalid markup whose real symptom is a caption that activates the
// wrong control when clicked.
export default function PriceTierField({ value, onChange, disabled, id = "price-tier" }) {
  return (
    <div>
      <select
        id={id}
        value={value || "standard"}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%", padding: "10px 12px", border: `1.5px solid ${RULE}`,
          borderRadius: 8, fontSize: 14, color: INK, background: "#fff",
          fontFamily: "inherit", boxSizing: "border-box",
        }}
      >
        {PRICE_TIERS.map((t) => (
          <option key={t.value} value={t.value}>{t.label}</option>
        ))}
      </select>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
        Preschool classes are left out of term-wide early-bird pricing.
      </div>
    </div>
  );
}
