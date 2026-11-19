// The provider guides, loaded at build time. README.md is the authoring guide,
// not a guide, so it is left out.
import { parseGuide, sortGuides } from "./guideParse.js";

const raw = import.meta.glob("../content/guides/*.md", { query: "?raw", import: "default", eager: true });

export const GUIDES = sortGuides(
  Object.entries(raw)
    .filter(([path]) => !path.endsWith("/README.md"))
    .map(([path, text]) => parseGuide(text, path.split("/").pop()))
);
