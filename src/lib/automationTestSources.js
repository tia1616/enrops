// Which real camps and classes an automation's test/preview picker may offer.
//
// Pulled out of AutomationEditor so the rule can be tested without a browser or
// a login. The bug it exists for: welcome_camp's picker offered ONLY
// camp_sessions rows, so once a camp became a program with class_days set, the
// camps an operator can actually build were invisible in the picker. The copy
// was being approved against legacy summer-camp data while the code path that
// really sends was never rendered.
import { isCampProgram } from "./programSchedule.js";

// Short, friendly date for picker labels (e.g. "Jun 17, 2026"). Falls back to
// the raw value if it isn't a parseable ISO date.
export function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function suffix(locationName, date) {
  return `${locationName ? ` — ${locationName}` : ""}${date ? ` (${shortDate(date)})` : ""}`;
}

/**
 * Build the picker's options.
 *
 * @param sourceType "camps" | "afterschool" | "both" | null — from the template
 * @param campSessions legacy camp_sessions rows (the 51 SU26 camps and history)
 * @param programs     programs rows; a camp is one with class_days set
 *
 * A program is filed by isCampProgram, the single definition shared with the
 * cron resolvers and the SQL session walk — NOT by a class_days IS NULL test,
 * which disagrees on an empty array.
 */
export function buildTestSources(sourceType, campSessions, programs) {
  if (!sourceType) return [];
  const sources = [];

  if (sourceType === "camps" || sourceType === "both") {
    for (const c of campSessions ?? []) {
      sources.push({
        value: `camp:${c.id}`,
        label: `Camp · ${c.curriculum_name ?? "Untitled"}${suffix(c.location_name, c.starts_on)}`,
      });
    }
  }

  for (const p of programs ?? []) {
    const camp = isCampProgram(p);
    // A camps-only template never offers a class, and vice versa; "both" offers
    // everything. This is what makes a camp-as-program reachable at all.
    if (camp && sourceType === "afterschool") continue;
    if (!camp && sourceType === "camps") continue;
    sources.push({
      value: `program:${p.id}`,
      label: `${camp ? "Camp" : "After-school"} · ${p.curriculum ?? "Untitled"}${suffix(p.program_locations?.name, p.first_session_date)}`,
    });
  }

  return sources;
}
