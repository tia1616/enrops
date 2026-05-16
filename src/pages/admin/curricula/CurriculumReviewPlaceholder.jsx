// /admin/curricula/:id/review
// Placeholder for the Chunk 3 review screen. Today: shows what we extracted
// (read-only) and links back to the library. Chunk 3 will replace this with
// the real review surface (editable fields + Curriculum hat agent asking
// follow-ups for low-confidence fields + publish action).

import { useEffect, useState } from "react";
import { Link, useParams, useOutletContext } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";

const PLUM = "#691D39";
const GOLD = "#CFB12F";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const RULE = "#e2dfd5";
const PANEL = "#fff";

export default function CurriculumReviewPlaceholder() {
  const { id: curriculumId } = useParams();
  const { org } = useOutletContext();
  const [loading, setLoading] = useState(true);
  const [curriculum, setCurriculum] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!curriculumId || !org?.id) return;
    let mounted = true;
    (async () => {
      const [{ data: curRow, error: curErr }, { data: sessRows, error: sessErr }] = await Promise.all([
        supabase
          .from("curricula")
          .select("id, name, short_description, age_range_min, age_range_max, session_count, format, themes, status")
          .eq("id", curriculumId)
          .maybeSingle(),
        supabase
          .from("curriculum_sessions")
          .select("session_number, title, description")
          .eq("curriculum_id", curriculumId)
          .order("session_number"),
      ]);
      if (!mounted) return;
      if (curErr || !curRow) {
        setError(curErr?.message || "Curriculum not found.");
      } else {
        setCurriculum(curRow);
        setSessions(sessRows ?? []);
      }
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, [curriculumId, org?.id]);

  if (loading) return <div style={{ color: MUTED, padding: 24 }}>Loading…</div>;
  if (error) return <div style={errorBox}>{error}</div>;

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
        <Link to="/admin/curricula" style={{ color: MUTED, textDecoration: "none" }}>Curricula</Link>
        <span style={{ margin: "0 8px" }}>›</span>
        <span>{curriculum.name}</span>
        <span style={{ margin: "0 8px" }}>›</span>
        <span>Review</span>
      </div>

      <div style={banner}>
        <strong style={{ color: PLUM }}>Coming next:</strong> the full review screen with editable fields and Curriculum hat follow-up questions lands in the next build phase. For now, here's a read-only look at what we extracted.
      </div>

      <h1 style={{ margin: "16px 0 4px", color: PLUM, fontSize: 26, fontWeight: 700 }}>
        {curriculum.name}
      </h1>
      <div style={{ color: MUTED, fontSize: 13, marginBottom: 22 }}>
        Status: <span style={{ color: INK, fontWeight: 600 }}>{curriculum.status}</span>
        {curriculum.format && <> · {curriculum.format.replace("_", " ")}</>}
        {curriculum.session_count && <> · {curriculum.session_count} sessions</>}
        {curriculum.age_range_min != null && curriculum.age_range_max != null && (
          <> · Ages {curriculum.age_range_min}–{curriculum.age_range_max}</>
        )}
      </div>

      {curriculum.short_description && (
        <div style={card}>
          <div style={cardLabel}>Short description</div>
          <div style={{ fontSize: 14, lineHeight: 1.5, color: INK }}>{curriculum.short_description}</div>
        </div>
      )}

      {Array.isArray(curriculum.themes) && curriculum.themes.length > 0 && (
        <div style={card}>
          <div style={cardLabel}>Themes</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {curriculum.themes.map((t) => (
              <span key={t} style={pill}>{t}</span>
            ))}
          </div>
        </div>
      )}

      {sessions.length > 0 && (
        <div style={card}>
          <div style={cardLabel}>Sessions ({sessions.length})</div>
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, color: INK, fontSize: 14 }}>
            {sessions.map((s) => (
              <li key={s.session_number} style={{ marginBottom: 6 }}>
                <strong>{s.title || "Untitled"}</strong>
                {s.description && <span style={{ color: MUTED }}> — {s.description}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <Link to="/admin/curricula" style={primaryBtn}>← Back to Curricula</Link>
      </div>
    </div>
  );
}

const banner = {
  background: "rgba(207, 177, 47, 0.15)",
  borderLeft: `3px solid ${GOLD}`,
  borderRadius: 4,
  padding: "12px 14px",
  fontSize: 13,
  lineHeight: 1.5,
  color: INK,
};

const card = {
  background: PANEL,
  border: `1px solid ${RULE}`,
  borderRadius: 8,
  padding: 16,
  marginBottom: 14,
};
const cardLabel = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};
const pill = {
  background: "#f7f6ef",
  color: INK,
  fontSize: 12,
  fontWeight: 600,
  padding: "4px 10px",
  borderRadius: 12,
  border: `1px solid ${RULE}`,
};
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
};
const errorBox = {
  background: "#fff5f5",
  border: "1px solid #f0c4c4",
  color: "#7a1a1a",
  borderRadius: 4,
  padding: 12,
  fontSize: 13,
};
