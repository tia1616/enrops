// The instructor portal header's one-line summary of what's on their schedule.
//
// Lives in lib rather than inline in InstructorPortal.jsx so it can be tested:
// it is four cases and two plural rules, and the version it replaces got three
// of the four wrong.
//
// The old expression had TWO branches for FOUR cases and fell through to
// "camps". An after-school provider with nothing assigned was told "You have 0
// camps on your schedule" — wrong noun, wrong tense — and a provider running
// both was told all of it was camps. Being called a camp provider is how a
// tenant learns the product was built for somebody else, so each kind is now
// named for what it is.
//
// Returns "" for an empty schedule, deliberately: the empty-state card directly
// below the header already says "No schedule yet. Your admin will email you when
// it's ready." Rendering a "you have nothing" line above it is that sentence
// twice.
export function scheduleCountLine(classCount, campCount, awaitingCount) {
  const classes = Number(classCount) || 0;
  const camps = Number(campCount) || 0;
  const awaiting = Number(awaitingCount) || 0;

  const parts = [];
  if (classes > 0) parts.push(`${classes} ${classes === 1 ? 'class' : 'classes'}`);
  if (camps > 0) parts.push(`${camps} ${camps === 1 ? 'camp' : 'camps'}`);
  if (parts.length === 0) return '';

  // "awaiting" counts a subset of what `parts` just described, so it can only
  // appear alongside them — never on its own line for an empty schedule.
  const tail = awaiting > 0 ? ` · ${awaiting} awaiting your response` : '';
  return `You have ${parts.join(' and ')} on your schedule${tail}.`;
}
