// plainTextHalf - which plain-text body a marketing email sends.
//
// THE BUG THIS CLOSES: the Marketing editor, the template editor and the
// campaign drafter all saved `body_text = stripHtml(body_html)`, which deletes
// every tag, collapses ALL whitespace to single spaces and drops link URLs. The
// send path trusted that stored text, so every plain-text reader got one run-on
// paragraph with no links ("Hi Ana, Winter classes start ... Register now").
//
// ONE SOURCE: the plain text is derived FROM the rendered HTML (htmlToPlainText
// keeps paragraph breaks and writes `words (url)` for links). A stored body_text
// is honoured only when somebody really wrote it by hand, which shows as line
// breaks; the collapsed output of the old editors never has any.
import { htmlToPlainText } from "./familyEmailHtml.ts";

/** True when the HTML has structure (2+ paragraph or line breaks) that a
 *  stored text with no newline at all has necessarily flattened. */
function htmlHasStructure(html: string): boolean {
  return (html.match(/<\/p>|<br\s*\/?>|<\/li>/gi) ?? []).length >= 2;
}

export function chooseBodyText(
  storedText: string | null | undefined,
  renderedInnerHtml: string,
  renderStored: (t: string) => string,
): string {
  const stored = (storedText ?? "").trim();
  const flattened = stored !== "" && !stored.includes("\n") && htmlHasStructure(renderedInnerHtml);
  if (stored === "" || flattened) return htmlToPlainText(renderedInnerHtml);
  return renderStored(stored);
}
