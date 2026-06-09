// /admin/curricula
// Lists curricula grouped by status: Draft / Extracted / Published.
// Multi-tenant: queries scoped by the caller's organization_id (provided by
// AdminLayout via outlet context). RLS also enforces this at the DB level.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { CAPABILITY_ICONS, deriveOrgStatesForCurriculum, isCapabilityUnlocked, CapabilityDetailModal } from "./capabilityHelpers.jsx";

const PURPLE = "#1C004F";   // deep plum — headings
const BRIGHT = "#6857E1";   // bright indigo — primary actions (sampled from Figma)
const VIOLET = "#8C88FF";
const GOLD_SOFT = "rgba(207, 177, 47, 0.13)";
const GOLD_BORDER = "rgba(207, 177, 47, 0.55)";
const CREAM = "#FBFBFB";
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
  // curriculum_id -> count of programs + camp_sessions pointing at this row
  const [scheduledCounts, setScheduledCounts] = useState({});
  // capability_definitions rows (global table, 14 rows seeded in Chunk 3.5)
  const [capabilities, setCapabilities] = useState([]);
  // Click-detail modal state: { capability, unlocked } | null
  const [capabilityModalConfig, setCapabilityModalConfig] = useState(null);
  // Client-side name search (J2S has ~13 curricula; a client filter is plenty).
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      const [
        { data, error: qErr },
        { data: flagRows },
        { data: docRows },
        { data: progRows },
        { data: campRows },
        { data: capRows },
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
        supabase
          .from("programs")
          .select("curriculum_id")
          .eq("organization_id", org.id)
          .not("curriculum_id", "is", null),
        supabase
          .from("camp_sessions")
          .select("curriculum_id")
          .eq("organization_id", org.id)
          .not("curriculum_id", "is", null),
        supabase
          .from("capability_definitions")
          .select("slug, display_name, category, short_description, required_states, required_states_human, icon_name, display_order")
          .eq("is_available", true)
          .order("display_order", { ascending: true }),
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
      const sched = {};
      for (const r of progRows ?? []) {
        sched[r.curriculum_id] = (sched[r.curriculum_id] ?? 0) + 1;
      }
      for (const r of campRows ?? []) {
        sched[r.curriculum_id] = (sched[r.curriculum_id] ?? 0) + 1;
      }
      setScheduledCounts(sched);
      setCapabilities(capRows ?? []);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [org?.id]);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? curricula.filter((c) => (c.name ?? "").toLowerCase().includes(q))
    : curricula;
  const grouped = STATUS_GROUPS.map((g) => ({
    ...g,
    items: filtered.filter((c) => c.status === g.key),
  }));

  // Delete a curriculum (any status):
  //   1. confirm with operator -- stronger warning for published (will unlink
  //      any linked programs + camp_sessions, those go back to free-text)
  //   2. fetch curriculum_documents storage paths for cleanup (cascade doesn't
  //      extend to storage)
  //   3. UPDATE programs SET curriculum_id=NULL WHERE curriculum_id=this
  //      (programs FK is ON DELETE NO ACTION so we have to unlink first;
  //      camp_sessions FK is ON DELETE SET NULL so it cleans itself)
  //   4. call Storage API to remove the files
  //   5. DELETE the curricula row -- cascade clears curriculum_sessions /
  //      curriculum_extracted_fields / curriculum_documents
  //   6. drop from local list
  const [deleting, setDeleting] = useState(null); // curriculum id being deleted
  async function deleteCurriculum(c) {
    let linkedProgCount = 0;
    let linkedCampCount = 0;
    if (c.status === "published") {
      const [{ count: pc }, { count: cc }] = await Promise.all([
        supabase.from("programs").select("id", { count: "exact", head: true }).eq("curriculum_id", c.id),
        supabase.from("camp_sessions").select("id", { count: "exact", head: true }).eq("curriculum_id", c.id),
      ]);
      linkedProgCount = pc ?? 0;
      linkedCampCount = cc ?? 0;
    }
    const linkedTotal = linkedProgCount + linkedCampCount;
    const baseMsg = `Delete "${c.name}"?\n\nThis removes the curriculum, all its sessions, extracted fields, and any uploaded documents. This can't be undone.`;
    const linkMsg = linkedTotal > 0
      ? `\n\nThis curriculum is currently linked to ${linkedProgCount} program${linkedProgCount === 1 ? "" : "s"} and ${linkedCampCount} camp session${linkedCampCount === 1 ? "" : "s"}. They'll be unlinked (their free-text curriculum name stays) but not deleted.`
      : "";
    if (!window.confirm(baseMsg + linkMsg)) return;
    setDeleting(c.id);
    try {
      const { data: docs } = await supabase
        .from("curriculum_documents")
        .select("storage_path")
        .eq("curriculum_id", c.id);
      const paths = (docs ?? []).map((d) => d.storage_path).filter(Boolean);

      // Unlink programs first (FK is NO ACTION, would block the delete).
      // camp_sessions FK is SET NULL so it handles itself on cascade.
      if (linkedProgCount > 0 || c.status === "published") {
        const { error: unlinkErr } = await supabase
          .from("programs")
          .update({ curriculum_id: null })
          .eq("curriculum_id", c.id);
        if (unlinkErr) {
          alert(`Couldn't unlink programs: ${unlinkErr.message}`);
          setDeleting(null);
          return;
        }
      }

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
          <h1 style={{ margin: 0, color: PURPLE, fontSize: 26, fontWeight: 700 }}>Curricula</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            Your library of curricula. Add a new one, then schedule it into a term when you're ready.
          </div>
        </div>
        <Link to="/admin/curricula/new" style={primaryBtn}>+ New curriculum</Link>
      </div>

      {!loading && !error && curricula.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search curricula…"
            style={searchInput}
          />
        </div>
      )}

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

      {!loading && !error && curricula.length > 0 && filtered.length === 0 && (
        <div style={{ color: MUTED, fontSize: 14, padding: 16 }}>
          No curricula match “{search}”.
        </div>
      )}

      {capabilityModalConfig && (
        <CapabilityDetailModal
          capability={capabilityModalConfig.capability}
          unlocked={capabilityModalConfig.unlocked}
          onClose={() => setCapabilityModalConfig(null)}
        />
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
                scheduledCount={scheduledCounts[c.id] ?? 0}
                capabilities={capabilities}
                onCapabilityClick={(cap, unlocked) => setCapabilityModalConfig({ capability: cap, unlocked })}
                onDelete={() => deleteCurriculum(c)}
                deleting={deleting === c.id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CurriculumCard({ curriculum: c, flagCount = 0, hasDoc = false, scheduledCount = 0, capabilities = [], onCapabilityClick, onDelete, deleting = false }) {
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
              title={`${flagCount} field${flagCount === 1 ? "" : "s"} Enni isn't sure about`}
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
        {ageLabel} · {sessionsLabel} · {formatLabel}
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
      // Backfilled drafts (no document) get two CTAs:
      //   - "Upload curriculum doc" (primary) attaches a doc and runs
      //     extraction to populate fields automatically
      //   - "Edit details" (secondary) for manual entry without a doc
      // Drafts that already have a doc are mid-extraction and resume.
      return hasDoc
        ? [{ to: `/admin/curricula/${c.id}/extracting`, label: "Resume extraction →", primary: true }]
        : [
            { to: `/admin/curricula/${c.id}/review`, label: "Edit details", primary: false },
            { to: `/admin/curricula/new?attach_to=${c.id}`, label: "Upload doc →", primary: true },
          ];
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
    extracted: { bg: `${VIOLET}33`, color: "#7a5a00", label: "Extracted" },
    published: { bg: `${PURPLE}1a`, color: PURPLE, label: "Published" },
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
  background: BRIGHT,
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
  borderRadius: 12,
  padding: 16,
  boxShadow: "0 1px 2px rgba(28, 0, 79, 0.04)",
};

const searchInput = {
  width: "100%",
  maxWidth: 420,
  padding: "10px 14px",
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  fontSize: 14,
  fontFamily: "inherit",
  background: "#fff",
  color: INK,
  boxSizing: "border-box",
};

const cardCtaPrimary = {
  padding: "7px 12px",
  background: BRIGHT,
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
  color: BRIGHT,
  border: `1px solid ${BRIGHT}`,
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
