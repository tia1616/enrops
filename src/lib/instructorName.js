// Display helpers for instructor names.
//
// Rule of thumb: anywhere a human reads an instructor's name day-to-day —
// schedule, emails, internal admin UI — use preferred_name when populated,
// else fall back to first_name. Legal surfaces (contractor agreement,
// tax forms) keep using first_name + last_name directly.
//
// Example: Rebecca / Bo — first_name='Rebecca', preferred_name='Bo'. The
// schedule and offer emails should say "Bo"; the signed agreement says
// "Rebecca". One column, two contexts.

export function displayFirstName(instructor, fallback = 'there') {
  if (!instructor) return fallback;
  const preferred = instructor.preferred_name?.trim?.();
  if (preferred) return preferred;
  return instructor.first_name || fallback;
}

export function displayFullName(instructor) {
  if (!instructor) return '';
  const first = displayFirstName(instructor, '');
  const last = instructor.last_name || '';
  return `${first} ${last}`.trim();
}
