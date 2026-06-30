// AnnouncementBanner — shows the latest active row from platform_announcements
// at the top of the admin shell. Data-driven so Jessica can announce features /
// updates by adding a row (no code change). Dismissal is per-announcement and
// client-side (localStorage by id) — a dismissed banner stays gone, but a NEW
// announcement reappears.
//
// Global (Enrops -> all tenants). Empty/none -> renders nothing.

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const PURPLE = "#1C004F";
const RULE = "#e2dfd5";
const MUTED = "#6b6b6b";

// variant -> banner palette
const VARIANTS = {
  info:    { bg: "#F2F0FF", border: "#cfc8f5", accent: "#5847C9" }, // lavender / indigo
  success: { bg: "#E9F8EF", border: "#bfe6cd", accent: "#1f7a3d" }, // mint
  warning: { bg: "#FFF7E0", border: "#f0e2a8", accent: "#8a6d00" }, // amber
};

const DISMISS_KEY = "enrops_dismissed_announcements";

function getDismissed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

// Only render a CTA link for safe schemes — these rows are global, so a single
// `javascript:` URL would be stored XSS across every tenant's admin.
function isSafeHref(u) {
  return typeof u === "string" && (/^https:\/\//i.test(u) || u.startsWith("/"));
}

export default function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from("platform_announcements")
        .select("id, title, body, cta_label, cta_url, variant")
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!mounted || error || !data) return;
      if (getDismissed().includes(data.id)) return; // already dismissed
      setAnnouncement(data);
    })();
    return () => { mounted = false; };
  }, []);

  function dismiss() {
    if (!announcement) return;
    try {
      const next = Array.from(new Set([...getDismissed(), announcement.id]));
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch (_e) { /* noop */ }
    setAnnouncement(null);
  }

  if (!announcement) return null;

  const v = VARIANTS[announcement.variant] || VARIANTS.info;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        background: v.bg,
        border: `1px solid ${v.border}`,
        borderRadius: 12,
        padding: "14px 16px",
        marginBottom: 22,
        fontFamily: "'Poppins', system-ui, sans-serif",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: PURPLE }}>
          {announcement.title}
        </div>
        {announcement.body && (
          <p style={{ fontSize: 13.5, color: "#3a3340", lineHeight: 1.5, margin: "4px 0 0" }}>
            {announcement.body}
          </p>
        )}
        {announcement.cta_label && isSafeHref(announcement.cta_url) && (
          <a
            href={announcement.cta_url}
            target={/^https:\/\//i.test(announcement.cta_url) ? "_blank" : undefined}
            rel="noopener noreferrer"
            style={{
              display: "inline-block",
              marginTop: 10,
              fontSize: 13,
              fontWeight: 600,
              color: v.accent,
              textDecoration: "none",
            }}
          >
            {announcement.cta_label} →
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss announcement"
        title="Dismiss"
        style={{
          flexShrink: 0,
          background: "transparent",
          border: "none",
          color: MUTED,
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
          padding: 2,
        }}
      >
        ×
      </button>
    </div>
  );
}
