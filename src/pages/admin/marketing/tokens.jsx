// Shared design tokens for the marketing module (used by marketing-v2/*).
// The marketing v1 directory was removed in commit 388522e but the v2 files
// still import their colors from here. Restoring as a single-purpose tokens
// file -- not bringing back any of the v1 UI.

// Enrops brand
export const PURPLE = "#1C004F";   // deep plum — headings
export const BRIGHT = "#5847C9";   // indigo — primary actions (sampled from Figma)
export const VIOLET = "#8C88FF";
export const INK = "#1a1a1a";
export const MUTED = "#6b6b6b";
export const RULE = "#e2dfd5";

// Status colors (used in marketing-v2 question / schedule / draft surfaces)
export const OK = "#4e914e";       // soft green (matches existing time-saved pills)
export const INFO = "#2c5d9b";     // muted blue for informational states
export const WARN = "#b8770b";     // amber for "needs attention" callouts
