// Share affordance for a single program. Thin wrapper over the generic
// <ShareLink> — all the copy/QR/download logic lives there.
//
// Two cases:
//   - Native (we run checkout): share the catalog deep link
//     (/<slug>?program=<id>), which lands families on that class's card. Only
//     once published (status === "open") — drafts show a "publish first" note.
//   - Partner-run: families register on the PARTNER's own site, so the share
//     link is their external_registration_url, not our catalog. If they haven't
//     given us a link, there's nothing to share yet.

import ShareLink from "./ShareLink.jsx";
import { buildProgramShareUrl } from "../lib/regLinks.js";

const INK = "#1a1a1a";
const AMBER = "#a16207";

function fileSlug(name) {
  const s = (name || "program")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "program";
}

export default function ShareProgram({ slug, program, align = "right" }) {
  const isPartnerRun = !!program?.runs_own_registration;
  const externalUrl = program?.external_registration_url || "";

  // Partner-run: share the partner's own registration link.
  if (isPartnerRun) {
    return (
      <ShareLink
        url={externalUrl}
        align={align}
        disabled={!externalUrl}
        panelTitle="Partner's registration link"
        description="Families register on your partner's site — share this link or QR."
        qrFileBase={`register-${fileSlug(program?.curriculum)}`}
        disabledNode={
          <div style={{ fontSize: 13, color: INK, lineHeight: 1.55 }}>
            <strong style={{ color: AMBER }}>No link yet.</strong> This program
            registers on your partner's site. Add their registration link in the
            program's settings and it'll show here to share.
          </div>
        }
      />
    );
  }

  // Native (we run checkout): catalog deep link, once published.
  const isPublished = program?.status === "open";
  const url = slug ? buildProgramShareUrl(slug, program?.id) : "";
  return (
    <ShareLink
      url={url}
      align={align}
      disabled={!isPublished}
      panelTitle="Registration link"
      description="Put it on a flyer, in an email, or in an ad — families scan to register."
      qrFileBase={`register-${fileSlug(program?.curriculum)}`}
      disabledNode={
        <div style={{ fontSize: 13, color: INK, lineHeight: 1.55 }}>
          <strong style={{ color: AMBER }}>Not live yet.</strong> Publish this
          program first and you'll get a shareable registration link and QR code
          here. Families can only sign up once it's open.
        </div>
      }
    />
  );
}
