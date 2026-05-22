import React from 'react';

// Converts bare http/https URLs in a string into clickable <a> tags.
// Used by the wizard's policy/ack rendering (Screens 4, 5, 6) so links
// embedded in legal_documents.body_text (the mandatory reporter course
// URL, photo-release opt-out URL, etc.) are clickable.
//
// Strips trailing punctuation that's commonly attached to a URL in prose
// (period, comma, semicolon, closing paren) so "see https://example.com."
// renders as a clickable link plus the period, not a broken link.
export function linkifyText(text) {
  const urlRegex = /(https?:\/\/[^\s)]+)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    let url = match[0];
    let trailing = '';
    while (/[.,;:)]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-neutral-900 underline underline-offset-2 hover:text-neutral-700"
      >
        {url}
      </a>
    );
    if (trailing) parts.push(trailing);
    lastIndex = urlRegex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : text;
}
