// Pure pieces of ennie-help, split out so the Deno test can import them
// without starting the server.
import { SECTIONS } from "./guides.generated.ts";

// The ONE spelling of the no-answer reply. The page shows "Send to the enrops
// team" under it. Jessica's wording, 11/24.
export const NO_ANSWER =
  "I don't see that in the guides yet. Want a person to help? We'll email you back as soon as we can.";

export type Source = { id: string; title: string; guide: string; label: string };

// Turn the model's JSON into what the page shows. An answer with no section we
// can link is NOT an answer: the rule is that every answer names its guide
// section, so it falls back to the person offer.
export function shapeReply(raw: unknown): { answered: boolean; answer: string; sources: Source[] } {
  const r = (raw ?? {}) as { answered?: unknown; answer?: unknown; sources?: unknown };
  const ids = Array.isArray(r.sources)
    ? [...new Set(
      r.sources
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim().replace(/^\{?#?/, "").replace(/\}$/, "")),
    )]
    : [];
  const sources = ids
    .filter((id) => Object.prototype.hasOwnProperty.call(SECTIONS, id))
    .map((id) => ({ id, ...SECTIONS[id] }));
  const text = typeof r.answer === "string" ? r.answer.trim() : "";
  const answered = r.answered === true && text.length > 0 && sources.length > 0;
  return { answered, answer: answered ? text : NO_ANSWER, sources: answered ? sources : [] };
}
