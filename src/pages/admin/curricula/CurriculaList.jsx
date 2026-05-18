// /admin/curricula
// Lists curricula grouped by status: Draft / Extracted / Published.
// Multi-tenant: queries scoped by the caller's organization_id (provided by
// AdminLayout via outlet context). RLS also enforces this at the DB level.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const GOLD_SOFT = "rgba(207, 177, 47, 0.13)";
const GOLD_BORDER = "rgba(207, 177, 47, 0.55)";
const CHALK = "#EAEADD";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

const STATUS_GROUPS = [
  { key: "draft", label: "Draft" },
  { key: "extracted", label: "Extracted" },
  { key: "published", label: "Published" },
];

export default function CurriculaList() {
  const { org } = useOutletContext();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [curricula, setCurricula] = useState([]);
  // curriculum_id -> count of low-confidence-not-yet-approved extracted_fields
  const [flagCounts, setFlagCounts] = useState({});
  // Set of curriculum_ids that have at least one uploaded document. Used to
  // pick the right Draft CTA — backfilled drafts (no docs) route to Edit,
  // upload-in-progress drafts route to Resume extraction.
  const [docsByCurriculumId, setDocsByCurriculumId] = useState(new Set());

  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      const [
        { data, error: qErr },
        { data: flagRows },
        { data: docRows },
      ] = await Promise.all([
        supabase
          .from("curricula")
          .select("id, name, age_range_min, age_range_max, grade_min, grade_max, format, session_count, status, updated_at")
          .eq("organization_id", org.id)
          .order("updated_at", { ascending: false }),
        supabase
          .from("curriculum_extracted_fields")
          .select("curriculum_id")
          .eq("organization_id", org.id)
          .lt("confidence", 0.7)
          .eq("human_approved", false),
        supabase
          .from("curriculum_documents")
          .select("curriculum_id")
          .eq("organization_id", org.id),
      ]);
      if (!mounted) return;
      if (qErr) {
        setError(qErr.message);
      } else {
        setCurricula(data ?? []);
      }
      const counts = {};
      for (const r of flagRows ?? []) {
        counts[r.curriculum_id] = (counts[r.curriculum_id] ?? 0) + 1;
      }
      setFlagCounts(counts);
      setDocsByCurriculumId(new Set((docRows ?? []).map((r) => r.curriculum_id)));
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [org?.id]);

  const grouped = STATUS_GROUPS.map((g) => ({
    ...g,
    items: curricula.filter((c) => c.status === g.key),
  }));

  // Delete a draft / extracted curriculum:
  //   1. confirm with operator
  //   2. fetch the curriculum_documents storage_paths so we can clean storage
  //      (Postgres cascade doesn't extend to storage objects)
  //   3. call Storage API to remove the files
  //   4. DELETE the curricula row — cascade clears curriculum_sessions /
  //      curriculum_extracted_fields / curriculum_documents
  //   5. drop from local list
  // Published curricula are linked to programs + camp_sessions; deletion via
  // the card is intentionally not supported (would break those FKs).
  const [deleting, setDeleting] = useState(null); // curriculum id being deleted
  async function deleteCurriculum(c) {
    if (c.status === "published") return;
    if (!window.confirm(`Delete "${c.name}"?\n\nThis removes the curriculum, all its sessions, and any uploaded documents. This can't be undone.`)) return;
    setDeleting(c.id);
    try {
      const { data: docs } = await supabase
        .from("curriculum_documents")
        .select("storage_path")
        .eq("curriculum_id", c.id);
      const paths = (docs ?? []).map((d) => d.storage_path).filter(Boolean);
      if (paths.length > 0) {
        const { error: stErr } = await supabase.storage.from("curriculum-documents").remove(paths);
        if (stErr) console.warn("storage remove failed (continuing with row delete):", stErr.message);
      }
      const { error: delErr } = await supabase.from("curricula").delete().eq("id", c.id);
      if (delErr) {
        alert(`Couldn't delete: ${delErr.message}`);
        setDeleting(null);
        return;
      }
      setCurricula((rows) => rows.filter((r) => r.id !== c.id));
      setFlagCounts((m) => {
        const next = { ...m };
        delete next[c.id];
        return next;
      });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, color: PLUM, fontSize: 26, fontWeight: 700 }}>Curricula</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            Your library of curricula. Add a new one, then schedule it into a term when you're ready.
          </div>
        </div>
        <Link to="/admin/curricula/new" style={primaryBtn}>+ New curriculum</Link>
      </div>

      {loading && <div style={{ color: MUTED, padding: 12 }}>Loading…</div>}
      {error && (
        <div style={errorBox}>Could not load curricula: {error}</div>
      )}

      {!loading && !error && curricula.length === 0 && (
        <div style={{ ...emptyState }}>
          <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>No curricula yet.</div>
          <div style={{ color: MUTED, fontSize: 14, marginBottom: 16 }}>
            Drop a lesson plan or curriculum guide and we'll set up everything around it — registration page, marketing flyer, parent emails, instructor portal — automatically.
          </div>
          <Link to="/admin/curricula/new" style={primaryBtn}>+ Add your first curriculum</Link>
        </div>
      )}

      {!loading && !error && grouped.map((group) => group.items.length > 0 && (
        <div key={group.key} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            {group.label} <span style={{ color: RULE, fontWeight: 400 }}>· {group.items.length}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {group.items.map((c) => (
              <CurriculumCard
                key={c.id}
                curriculum={c}
                flagCount={flagCounts[c.id] ?? 0}
                hasDoc={docsByCurriculumId.has(c.id)}
                onDelete={c.status !== "published" ? () => deleteCurriculum(c) : undefined}
                deleting={deleting === c.id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CurriculumCard({ curriculum: c, flagCount = 0, hasDoc = false, onDelete, deleting = false }) {
  // Camp curricula use ages; afterschool uses grades. Show whichever is populated.
  const ageLabel = c.age_range_min != null && c.age_range_max != null
    ? `Ages ${c.age_range_min}–${c.age_range_max}`
    : c.grade_min != null && c.grade_max != null
    ? `Grades ${gradeLabel(c.grade_min)}–${gradeLabel(c.grade_max)}`
    : "Age/grade not set";
  const sessionsLabel = c.session_count ? `${c.session_count} session${c.session_count === 1 ? "" : "s"}` : "Sessions not set";
  const formatLabel = c.format === "summer_camp" ? "Summer camp" : c.format === "afterschool" ? "Afterschool" : c.format ? "Other" : "Format not set";

  const cta = ctaForStatus(c, hasDoc);
  // Tag only fires on Extracted cards — for Draft the operator hasn't reviewed
  // yet (expected); for Published the review has happened already.
  const showNeedsReview = c.status === "extracted" && flagCount > 0;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600, color: INK, fontSize: 15, lineHeight: 1.3 }}>{c.name}</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <StatusBadge status={c.status} />
          {showNeedsReview && (
            <span
              title={`${flagCount} field${flagCount === 1 ? "" : "s"} Dora isn't sure about`}
              style={{
                background: GOLD_SOFT,
                color: "#7a5a00",
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 7px",
                borderRadius: 9,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                border: `1px solid ${GOLD_BORDER}`,
                whiteSpace: "nowrap",
              }}
            >
              Needs your review · {flagCount}
            </span>
          )}
        </div>
      </div>
      <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
        {ageLabel}<br />
        {sessionsLabel}<br />
        {formatLabel}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        {cta.map((item, i) => (
          <Link key={i} to={item.to} style={item.primary ? cardCtaPrimary : cardCtaSecondary}>{item.label}</Link>
        ))}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            title="Delete this curriculum"
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              color: deleting ? MUTED : "#a13a3a",
              cursor: deleting ? "wait" : "pointer",
              fontSize: 16,
              padding: "6px 8px",
              opacity: deleting ? 0.5 : 0.7,
              lineHeight: 1,
            }}
          >
            {deleting ? "…" : "🗑"}
          </button>
        )}
      </div>
    </div>
  );
}

function gradeLabel(n) {
  if (n === 0) return "K";
  if (n < 0) return `Pre-K${n < -1 ? n + 1 : ""}`;
  return String(n);
}

function ctaForStatus(c, hasDoc = false) {
  switch (c.status) {
    case "draft":
      // Backfilled drafts (no document) can't resume extraction — route them
      // to the editable review screen instead, where the operator can fill
      // fields manually. Drafts with a document mid-flight still resume.
      return hasDoc
        ? [{ to: `/admin/curricula/${c.id}/extracting`, label: "Resume extraction →", primary: true }]
        : [{ to: `/admin/curricula/${c.id}/review`, label: "Edit details →", primary: true }];
    case "extracted":
      return [{ to: `/admin/curricula/${c.id}/review`, label: "Review and publish →", primary: true }];
    case "published":
      return [
        { to: `/admin/curricula/${c.id}/edit`, label: "Edit", primary: false },
        { to: `/admin/curricula/${c.id}/schedule`, label: "Schedule a term", primary: true },
      ];
    default:
      return [];
  }
}

function StatusBadge({ status }) {
  const map = {
    draft: { bg: "#f7f6ef", color: MUTED, label: "Draft" },
    extracted: { bg: `${GOLD}33`, color: "#7a5a00", label: "Extracted" },
    published: { bg: `${PLUM}1a`, color: PLUM, label: "Published" },
  };
  const s = map[status] ?? map.draft;
  return (
    <span style={{
      background: s.bg, color: s.color, fontSize: 11, fontWeight: 600,
      padding: "3px 8px", borderRadius: 10, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap",
    }}>
      {s.label}
    </span>
  );
}

const primaryBtn = {
  display: "inline-block",
  padding: "9px 16px",
  background: PLUM,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  textDecoration: "none",
  cursor: "pointer",
};

const cardStyle = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: 14,
};

const cardCtaPrimary = {
  padding: "7px 12px",
  background: PLUM,
  color: "#fff",
  border: "none",
  borderRadius: 5,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
};

const cardCtaSecondary = {
  padding: "7px 12px",
  background: "transparent",
  color: PLUM,
  border: `1px solid ${PLUM}`,
  borderRadius: 5,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
};

const errorBox = {
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  padding: 12,
  fontSize: 13,
};

const emptyState = {
  background: PANEL,
  border: `1px dashed ${RULE}`,
  borderRadius: 8,
  padding: 28,
  textAlign: "center",
};
