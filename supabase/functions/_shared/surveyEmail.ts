// Shared helpers for the availability-survey emails (afterschool + camps).
// Keeps the intro-rendering + escaping identical across both send functions.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render the editable intro (already resolved to its default when blank) as the
// inner HTML of a single <p>. Newlines become <br/> — we never emit nested <p>
// tags, which would be invalid inside the caller's <p> wrapper.
export function introParagraphHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br/>');
}
