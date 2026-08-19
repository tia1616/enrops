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
//
// ROLE: owner/admin only, and that is not cosmetic. This notice renders on the
// Comms surfaces, which are gated on "send" — a tier that INCLUDES staff — but
// its only action is a link to /admin/email-sender, which is gated on
// "settings" (owner/admin). Showing it to staff means telling someone to fix
// something the next click refuses to let them fix: they land on "Settings
// isn't available for your role". A nudge nobody can act on is worse than no
// nudge, so it is hidden for roles that cannot reach the destination.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../../../lib/supabase.js";
import { usePermissions } from "../../../lib/permissions";
import { BRIGHT, INK, MUTED, RULE } from "../marketing/tokens.jsx";

export default function SenderSetupNotice({ orgId }) {
  // Start false so the banner never flashes before we know the real state.
  const [needsSetup, setNeedsSetup] = useState(false);
  // Separate from needsSetup on purpose. "hasn't chosen a reply-to" and "replies
  // land nowhere useful" are different facts and the copy for them is different:
  // one is a suggestion, the other is a problem. Folding them together is what
  // made this notice tell providers something untrue about their own email.
  const [repliesReachThem, setRepliesReachThem] = useState(true);
  const perm = usePermissions();

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    (async () => {
      // organizations.email is read too, NOT just org_branding.email_reply_to.
      // Reading only the latter made this notice say "replies go to a default
      // address — not your inbox" to every org that had never opened the Email
      // sender page, including ones whose account email IS what replies resolve
      // to and does reach them. That was flatly untrue for The Ukulele Project,
      // and it contradicted /admin/email-sender, which showed that org its own
      // address with no warning at all. Same cascade as _shared/orgBrand.ts
      // resolveReplyTo(), so the nudge and the destination agree.
      const [brandingRes, orgRes] = await Promise.all([
        supabase.from("org_branding").select("email_reply_to").eq("organization_id", orgId).maybeSingle(),
        supabase.from("organizations").select("email").eq("id", orgId).maybeSingle(),
      ]);
      // On error, stay silent rather than show a banner we're unsure about.
      if (!cancelled && !brandingRes.error && !orgRes.error) {
        const hasBranding = ((brandingRes.data?.email_reply_to ?? "").trim()).length > 0;
        const hasOrgEmail = ((orgRes.data?.email ?? "").trim()).length > 0;
        setNeedsSetup(!hasBranding);
        setRepliesReachThem(hasBranding || hasOrgEmail);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  // Two separate questions, deliberately not folded together: needsSetup is
  // "is this true", canManageSettings is "can THIS reader do anything about it".
  if (!needsSetup || !perm.canManageSettings) return null;

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
          {repliesReachThem
            ? "Family replies currently go to your account email. Choose where you'd like them instead."
            : "Right now, when a family replies to your emails it goes to a default address — not your inbox."}
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
