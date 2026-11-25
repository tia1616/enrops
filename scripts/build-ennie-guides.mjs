// Writes supabase/functions/ennie-help/guides.generated.ts from the provider
// guides. Run after editing any file in src/content/guides; guides.test.mjs
// fails until you do.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnnieGuides, renderGeneratedModule } from "../src/lib/ennieGuides.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const GUIDES_DIR = join(root, "src", "content", "guides");
export const OUT_FILE = join(root, "supabase", "functions", "ennie-help", "guides.generated.ts");

export function readGuideFiles(dir = GUIDES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

export function generate() {
  return renderGeneratedModule(buildEnnieGuides(readGuideFiles()));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUT_FILE, generate());
  console.log(`wrote ${OUT_FILE}`);
}
