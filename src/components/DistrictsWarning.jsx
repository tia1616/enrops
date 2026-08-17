// The "we could not load your districts" warning, rendered NEXT TO THE PICKER it is
// about rather than in a page banner.
//
// WHY THIS COMPONENT EXISTS AT ALL. The warning was added in three places on
// 2026-08-17 (LocationsList, SchoolsList, ProgramWizardNew) and all three put it in
// page flow - and every surface that actually contains a District picker is a FIXED
// FULL-VIEWPORT OVERLAY sitting on top of that flow:
//
//   LocationsList  drawer            position:fixed; inset:0; zIndex:80
//   SchoolDetailDrawer                                        zIndex:90
//   AddSchoolModal                                            zIndex:200
//
// So the message existed, was correctly un-gated, and was invisible at the exact
// moment it mattered - behind the scrim, while the operator stared at an empty
// required District dropdown. Un-gating a message is not the same as showing it
// (/code-review 2026-08-17, second round: the fix for the fix was wrong too).
//
// ONE component, four callers, so the next change cannot land in three of them.
// Callers keep their page-level banner as well: that one is right when no overlay is
// open, and this one is right when one is.
export default function DistrictsWarning({ message }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        marginTop: 6,
        background: "#fbeaea",
        border: "1px solid #D9694F",
        borderRadius: 6,
        padding: "8px 10px",
        color: "#7a2a2a",
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      {message}
    </div>
  );
}
