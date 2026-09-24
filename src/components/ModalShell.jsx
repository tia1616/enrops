// The admin modal frame: scrim, centred card, title bar with a close button, and
// a scrolling body. Lifted verbatim out of Schedule.jsx on 2026-09-24 when the
// camp form needed it too.
//
// It lives here rather than being imported from Schedule.jsx because that would
// be a cycle - Schedule.jsx imports the camp form, and the camp form would import
// Schedule.jsx back. A cycle between two modules that both define components at
// module scope is the module-init version of the TDZ crash: whichever side
// evaluates second reads the other's binding before it is assigned, and every
// render of that page throws. Copying the frame into a second file instead would
// be the other failure - two spellings of one modal, drifting apart.
//
// The colours are inlined for the same reason they are inlined in every admin
// page: there is no shared token module in this codebase yet, and introducing one
// as a side effect of a camp form is not the change anyone asked for.
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";

export default function ModalShell({ title, children, onClose, maxWidth = 480 }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        padding: 16,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%",
        maxWidth,
        maxHeight: "90vh",
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 12,
        boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        <div style={{
          padding: "14px 20px",
          borderBottom: `1px solid ${RULE}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          background: "#fff",
        }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: INK }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", fontSize: 22, color: MUTED, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
