// scheduleExtract — parse the model's reply (from extract-schedule-details) into
// the same row shape the spreadsheet path produces, so both feed the identical
// review UI + import-class-schedule commit path. Pure: no network/SDK — the edge
// fn does the Claude call, this just turns its text into clean rows, and deno
// tests cover it.
//
// The model is asked for a JSON array of class rows. Real replies sometimes wrap
// it in ```json fences or add prose; we strip to the outermost array before
// parsing, then keep only our known keys (ignore anything extra the model adds).

import type { IncomingScheduleRow } from "./scheduleNormalize.ts";

// Keys we accept off a model row. Anything else is dropped — the model can't
// smuggle an organization_id or source in (those are stamped server-side).
const ROW_KEYS: (keyof IncomingScheduleRow)[] = [
  "title", "day_of_week", "start_time", "end_time", "location_text",
  "instructor_name", "instructor_email", "age_min", "age_max", "capacity", "notes",
];

function coerceCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") { const s = v.trim(); return s === "" ? null : s; }
  return null; // objects/arrays/bools aren't valid cell values here
}

// Pull the outermost [...] out of a possibly-fenced, possibly-chatty reply.
// Returns the raw JSON array string, or null if there's no array at all.
function extractArrayText(raw: string): string | null {
  let s = raw.trim();
  // Strip a leading ```json / ``` fence and a trailing ``` if present.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

export class ScheduleExtractError extends Error {}

// Parse the model reply into rows. Throws ScheduleExtractError when there is no
// usable array (so the caller can show a friendly "couldn't read the schedule"
// message). An empty array is a valid result (no classes found) and returns [].
export function parseScheduleRows(rawModelText: string): IncomingScheduleRow[] {
  if (!rawModelText || !rawModelText.trim()) {
    throw new ScheduleExtractError("The AI returned an empty response.");
  }
  const arrText = extractArrayText(rawModelText);
  if (arrText === null) {
    throw new ScheduleExtractError("The AI didn't return a schedule we could read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrText);
  } catch (e) {
    throw new ScheduleExtractError(
      `The AI returned something we couldn't parse: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ScheduleExtractError("The AI didn't return a list of classes.");
  }
  const rows: IncomingScheduleRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const row: IncomingScheduleRow = {};
    for (const k of ROW_KEYS) row[k] = coerceCell(rec[k]);
    // Skip wholly-empty objects the model may emit.
    if (Object.values(row).some((v) => v !== null)) rows.push(row);
  }
  return rows;
}
