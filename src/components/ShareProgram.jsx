// Share affordance for a single program: the registration deep link + QR for
// that one class. Thin wrapper over the generic <ShareLink> — all the copy/QR/
// download logic lives there.
//
// Used in three spots: the program list's expanded panel, the roster page
// header, and the wizard success screen.
//
// Guardrail: a program only has a working public link once it's published
// (status === "open"). Drafts show a "publish first" message instead of a
// dead URL — eat-the-cooking, the link we hand over actually resolves.

import ShareLink from "./ShareLink.jsx";
import { buildRegUrl } from "../lib/regLinks.js";

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
  const isPublished = program?.status === "open";
  const url = slug ? buildRegUrl(slug, program?.id) : "";

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
