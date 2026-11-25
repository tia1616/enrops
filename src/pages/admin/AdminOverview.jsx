// src/pages/admin/AdminOverview.jsx
//
// /admin. There is NO dashboard here any more (Jessica, 2026-11-25: "can we also
// just delete the overview screen? i never look at it"). On that date only
// Journey to STEAM could see it - every other provider is on the lean nav, which
// already hid it and sent them to Programs. So Programs is everybody's home now.
//
// ONE THING SURVIVES, on purpose: a brand-new lean provider with no program yet
// still lands on the single "Build your first program" prompt (Arielle's "first
// screen shows exactly one prompt, nothing else visible"). Removing it would drop a
// new signup onto an empty Programs page instead.
//
// The removed dashboard (Today / Week / Month views, wins strip, "important today"
// alerts, agenda, term checklist, time-saved pill) is in git history before
// 2026-11-25 if any part of it is ever wanted back.

import { useEffect, useState } from "react";
import { Link, Navigate, useOutletContext } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import Ennie from "../../components/Ennie";

const BRIGHT = "#5847C9";
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";

export default function AdminOverview() {
  const { org } = useOutletContext() ?? {};
  const isLean = org?.instructor_pay_model === "enrops_platform";
  const [programCount, setProgramCount] = useState(null); // null = loading

  useEffect(() => {
    if (!org?.id || !isLean) return;
    let cancelled = false;
    (async () => {
      const { count, error } = await supabase
        .from("programs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", org.id);
      // A failed count is NOT "no programs": that would show an established
      // provider the first-run prompt. Fail toward Programs.
      if (!cancelled) setProgramCount(error ? 1 : (count ?? 0));
    })();
    return () => { cancelled = true; };
  }, [org?.id, isLean]);

  if (!isLean) return <Navigate to="/admin/programs" replace />;
  if (programCount === null) {
    return <div style={{ padding: 40, textAlign: "center", color: MUTED }}>Loading…</div>;
  }
  if (programCount === 0) return <FirstRunPrompt orgName={org?.name} />;
  return <Navigate to="/admin/programs" replace />;
}

// First-run prompt for a lean op with no program yet - one CTA into the builder.
function FirstRunPrompt({ orgName }) {
  return (
    <div style={{ maxWidth: 520, margin: "40px auto", textAlign: "center", padding: "0 16px" }}>
      <Ennie state="idle" framed={false} size={120} />
      <h1 style={{ fontSize: 24, fontWeight: 700, color: INK, margin: "8px 0" }}>
        Build your first program and get your link
      </h1>
      <p style={{ color: MUTED, fontSize: 15, lineHeight: 1.6, margin: "0 0 24px" }}>
        Name it, set a price, pick a day. You'll get a shareable registration link the
        moment you save{orgName ? ` — welcome, ${orgName}` : ""}.
      </p>
      <Link
        to="/admin/programs/quick-new"
        style={{ display: "inline-block", padding: "13px 26px", background: BRIGHT, color: "#fff", borderRadius: 10, fontSize: 15, fontWeight: 700, textDecoration: "none" }}
      >
        Build your first program →
      </Link>
    </div>
  );
}
