// /admin/curricula
// Lists curricula grouped by status: Draft / Extracted / Published.
// Multi-tenant: queries scoped by the caller's organization_id (provided by
// AdminLayout via outlet context). RLS also enforces this at the DB level.

import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
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

  useEffect(() => {
    if (!org?.id) return;
    let mounted = true;
    (async () => {
      setLoading(true);
      const { data, error: qErr } = await supabase
        .from("curricula")
        .select("id, name, age_range_min, age_range_max, grade_min, grade_max, format, session_count, status, updated_at")
        .eq("organization_id", org.id)
        .order("updated_at", { ascending: false });
      if (!mounted) return;
      if (qErr) {
        setError(qErr.message);
      } else {
        setCurricula(data ?? []);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [org?.id]);

  const grouped = STATUS_GROUPS.map((g) => ({
    ...g,
    items: curricula.filter((c) => c.status === g.key),
  }));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
        <div>
          <h1 style={{ margin: 0, color: PLUM, fontSize: 26, fontWeight: 700 }}>Curricula</h1>
          <div style={{ color: MUTED, fontSize: 13, marginTop: 4 }}>
            Your library of curricula. Add a new one, then schedule it into a term when you're ready.
          </div>
        </div>
        <span style={{ ...primaryBtn, background: "#c8c4b7", cursor: "default" }} title="Onboarding flow ships in Chunk 2 of the new spec">+ New curriculum</span>
      </div>

      {loading && <div style={{ color: MUTED, padding: 12 }}>Loading…</div>}
      {error && (
        <div style={errorBox}>Could not load curricula: {error}</div>
      )}

      {!loading && !error && curricula.length === 0 && (
        <div style={{ ...emptyState }}>
          <div style={{ fontWeight: 600, color: INK, marginBottom: 6 }}>No curricula yet.</div>
          <div style={{ color: MUTED, fontSize: 14 }}>
            The upload-first onboarding flow is being rebuilt as part of Chunk 2. Come back after that ships and you'll be able to drop in a curriculum doc.
          </div>
        </div>
      )}

      {!loading && !error && grouped.map((group) => group.items.length > 0 && (
        <div key={group.key} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
            {group.label} <span style={{ color: RULE, fontWeight: 400 }}>· {group.items.length}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {group.items.map((c) => (
              <CurriculumCard key={c.id} curriculum={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CurriculumCard({ curriculum: c }) {
  // Camp curricula use ages; afterschool uses grades. Show whichever is populated.
  const ageLabel = c.age_range_min != null && c.age_range_max != null
    ? `Ages ${c.age_range_min}–${c.age_range_max}`
    : c.grade_min != null && c.grade_max != null
    ? `Grades ${gradeLabel(c.grade_min)}–${gradeLabel(c.grade_max)}`
    : "Age/grade not set";
  const sessionsLabel = c.session_count ? `${c.session_count} session${c.session_count === 1 ? "" : "s"}` : "Sessions not set";
  const formatLabel = c.format === "summer_camp" ? "Summer camp" : c.format === "afterschool" ? "Afterschool" : c.format ? "Other" : "Format not set";

  const cta = ctaForStatus(c);

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600, color: INK, fontSize: 15, lineHeight: 1.3 }}>{c.name}</div>
        <StatusBadge status={c.status} />
      </div>
      <div style={{ color: MUTED, fontSize: 13, lineHeight: 1.5 }}>
        {ageLabel}<br />
        {sessionsLabel}<br />
        {formatLabel}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
        {cta.map((item, i) => (
          <Link key={i} to={item.to} style={item.primary ? cardCtaPrimary : cardCtaSecondary}>{item.label}</Link>
        ))}
      </div>
    </div>
  );
}

function gradeLabel(n) {
  if (n === 0) return "K";
  if (n < 0) return `Pre-K${n < -1 ? n + 1 : ""}`;
  return String(n);
}

function ctaForStatus(c) {
  switch (c.status) {
    case "draft":
      return [{ to: `/admin/curricula/${c.id}/extracting`, label: "Resume extraction →", primary: true }];
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
