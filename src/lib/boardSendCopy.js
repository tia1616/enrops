// src/lib/boardSendCopy.js
// Shared resolver for the operator's saved default copy for a board send.
//
// Board sends (the availability survey and class offers) let the operator edit a
// lead paragraph before sending from the Schedule board. The saved default for
// that paragraph is authored in Comms > Automations > Instructors and stored as
// HTML on the Automations override (automations.body_override, keyed by
// automation_templates.key). The board's intro textareas are plain text, so we
// strip the HTML to plain text when seeding them.
//
// This was copy-pasted inline four times (survey + offer, on the camp and
// after-school boards). Extracted here so the transform lives in one place.
// Behaviour is intentionally byte-identical to the previous inline blocks.

// HTML -> plain text for the intro textareas. Kept exactly as the boards did it
// inline, so the seeded copy does not change.
export function htmlToPlainIntro(html) {
  return String(html)
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").trim();
}

// Returns the operator's saved default intro for a board send, as plain text.
// templateKey is the automation_templates.key ('availability_survey' |
// 'assignment_offer'). Returns "" when the operator hasn't saved a default, when
// the template/override rows are missing, or on any error — this is non-critical
// glue and callers fall back to org_survey_config / the edge fn's built-in copy.
export async function resolveBoardSendIntro(supabase, organizationId, templateKey) {
  try {
    const { data: tpl } = await supabase
      .from("automation_templates").select("id").eq("key", templateKey).maybeSingle();
    if (!tpl?.id) return "";
    const { data: auto } = await supabase
      .from("automations").select("body_override")
      .eq("organization_id", organizationId).eq("template_id", tpl.id).maybeSingle();
    if (!auto?.body_override) return "";
    return htmlToPlainIntro(auto.body_override);
  } catch {
    return "";
  }
}
