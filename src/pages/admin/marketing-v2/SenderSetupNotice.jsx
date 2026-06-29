// SenderSetupNotice — nudges an operator to set their reply-to email so family
// replies land in THEIR inbox instead of the platform default.
//
// Sending always works (the from-address resolves server-side to the tenant's
// own verified domain, or a per-tenant address on the verified platform domain
// — see _shared/orgBrand.ts). This notice is only about REPLIES: until the org
// sets org_branding.email_reply_to, a family that hits "reply" reaches a default
// address, not the provider. Shown on the Family Comms surfaces until set.
//
// Multi-tenant: scoped to the passed org id. No hardcoded tenant.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";

export default function SenderSetupNotice({ orgId }) {
  // Start false so the banner never flashes before we know the real state.
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("org_branding")
        .select("email_reply_to")
        .eq("organization_id", orgId)
        .maybeSingle();
      // On error, stay silent rather than show a banner we're unsure about.
      if (!cancelled && !error) {
        setNeedsSetup(((data?.email_reply_to ?? "").trim()).length === 0);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  if (!needsSetup) return null;

  return (
    <div
      role="note"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        background: "#faf9ff",
        border: `1px solid ${RULE}`,
        borderRadius: 10,
        padding: "12px 16px",
        marginBottom: 20,
      }}
    >
      <span style={{ fontSize: 13.5, color: INK, lineHeight: 1.5 }}>
        📨 <strong>Set your reply-to email.</strong>{" "}
        <span style={{ color: MUTED }}>
          Right now, when a family replies to your emails it goes to a default address — not your inbox.
        </span>
      </span>
      <Link
        to="/admin/email-sender"
        style={{
          flexShrink: 0,
          padding: "8px 14px",
          background: BRIGHT,
          color: "#fff",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Set up email sender →
      </Link>
    </div>
  );
}
