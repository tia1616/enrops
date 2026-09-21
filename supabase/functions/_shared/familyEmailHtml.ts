// familyEmailHtml - the HTML half of an operator-written message to families.
//
// WHY THIS EXISTS, and it is not a style upgrade. Until now `sendFamilyEmails`
// posted ONLY a `text` body to Resend, so every formatting mark an operator
// typed arrived as literal characters. Measured on prod 2026-09-21: of The
// Ukulele Project's 33 Message-families sends in eight days, 17 carried
// `**bold**` and 15 carried `[words](url)` - 230 of 405 emails went out with
// visible asterisks, and a class safety notice sent the portal sign-in link to
// 29 families as `[enrops.com/...](http://enrops.com/...)`. The operator had
// typed the EXACT notation `bodyEditorUtils.editableToHtml` already understands;
// this was the one send surface never wired to it.
//
// DELIBERATELY NOT the marketing shell, and the difference is compliance, not
// taste. `marketing-touchpoint-send`'s `wrapInEmailShell` renders an unsubscribe
// link, a CAN-SPAM postal address and the org signature block, because a campaign
// is bulk promotional mail to a list. A class message is an operational notice to
// the families of ONE class a child is enrolled in - it must not offer to
// unsubscribe them from a safety update. Two shells, two jobs; this is a
// divergence on purpose, not a copy that drifted.
//
// `htmlToPlainText` IS the same job as that function's private `stripHtmlToText`,
// and the duplication is recorded rather than hidden: `marketing-touchpoint-send`
// currently differs between main and staging (another chat's unreleased work), so
// editing it to import from here would drag that work toward prod. When that file
// is next level across both branches, point it here and delete its copy.
import { esc } from './escapeHtml.ts';

/**
 * Plain-text alternative derived FROM the HTML, never from the operator's raw
 * editable text. That ordering is the whole fix: the raw text is what carries
 * `**bold**`, so a text half taken from it would still show asterisks to every
 * plain-text reader - the exact defect, surviving in the half nobody looks at.
 *
 * An HTML-only email is also penalised by spam filters, so this is not optional.
 */
export function htmlToPlainText(html: string): string {
  return String(html ?? '')
    // A link must survive as something a reader can actually use. Tags are
    // stripped below, so an <a> would otherwise collapse to bare words with the
    // destination silently deleted - worse than the markdown it replaced.
    .replace(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, inner) => {
        const words = String(inner).replace(/<[^>]+>/g, '').trim();
        // "click here (https://...)" is noise when the words ARE the address,
        // which is how most operators write a link.
        if (!words) return String(href);
        return words === href ? words : `${words} (${href})`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // LAST, so an escaped "&amp;lt;" does not decode twice into a real tag.
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The test warning, as WORDS, so the HTML banner and the plain-text half cannot
 *  drift into saying two different things about the same email. */
export const FAMILY_TEST_NOTICE =
  'This is a test. No family has received it. This is exactly what they will see.';

/** The footer sentence, in one place for the same reason. Empty when we have no
 *  org name - a footer is not worth a defensive fallback string. */
export function familyMessageFooterLine(
  opts: { orgName?: string | null; programName?: string | null },
): string {
  const orgName = (opts.orgName || '').trim();
  if (!orgName) return '';
  const programName = (opts.programName || '').trim();
  const about = programName ? ` about ${programName}` : '';
  return `Sent by ${orgName}${about}. Reply to this email to reach them.`;
}

export interface FamilyMessageShellOptions {
  orgName: string;
  /** The class this went out about. Shown in the footer so a parent on several
   *  classes can tell which one a message belongs to. */
  programName?: string | null;
  /** Marks a test send in the body itself, not only the subject - an operator
   *  forwarding a test to a colleague must not be able to pass it off as the
   *  real thing by accident. */
  isTest?: boolean;
}

/**
 * Wraps the operator's rendered HTML in a minimal, mobile-safe email shell.
 *
 * No logo and no signature block on purpose: both are owned by the branding
 * work that is still mid-build across ~18 senders, and inventing a second
 * spelling of either here is how that job gets harder. This shell is type,
 * width and a footer saying who sent it and about what.
 */
export function renderFamilyMessageHtml(
  innerHtml: string,
  opts: FamilyMessageShellOptions,
): string {
  const orgName = (opts.orgName || '').trim();

  const testBanner = opts.isTest
    ? `<div style="background:#fdf6e3;border:1px solid #ecdca6;border-radius:6px;padding:10px 12px;margin-bottom:18px;font-size:13px;color:#8a6d1f;">
${esc(FAMILY_TEST_NOTICE)}
</div>`
    : '';

  const footer = esc(familyMessageFooterLine(opts));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(orgName)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.55;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">
<div style="background:#ffffff;border-radius:10px;padding:28px 26px;box-shadow:0 1px 3px rgba(0,0,0,0.05);font-size:15px;">
${testBanner}${innerHtml}
</div>
${footer ? `<div style="margin-top:16px;padding:0 12px;font-size:11px;color:#6b7280;line-height:1.6;text-align:center;">${footer}</div>` : ''}
</div>
</body>
</html>`;
}
