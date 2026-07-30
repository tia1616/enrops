// src/lib/useAdChoice.js
// One subscription to "the advertising choice changed", shared by every surface
// that displays it.
//
// WHY A SHARED HOOK RATHER THAN THE LISTENERS INLINE: there are two surfaces
// showing this state - the notice bar and the /do-not-sell page - and the first
// version wired the listeners into only one of them. The page whose entire job
// is telling you the truth about this setting was the one left showing a stale
// answer after you changed it in another tab. Two copies of a subscription is
// how that happens; one copy is how it stops.
//
// Any NEW surface that reads hasOptedOut / hasMadeAdChoice / isPixelActive must
// call this too, or it will render an answer that was true when it mounted.

import { useEffect, useState } from 'react';
import { AD_CHOICE_EVENT } from './metaPixel.js';

/**
 * Re-renders the caller whenever the advertising choice changes, in this tab or
 * another one. Returns a counter purely so React has something to diff; callers
 * should ignore the value and simply re-read whatever they need from metaPixel.
 *
 * Two listeners because there are two ways the choice can change:
 *   - same tab: the choice page or the notice bar, via the module's own event
 *   - another tab: localStorage, via 'storage', which by spec fires ONLY in
 *     other tabs and so can never cover the same-tab case on its own
 */
export function useAdChoiceSignal() {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const sync = () => setVersion((n) => n + 1);
    window.addEventListener(AD_CHOICE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(AD_CHOICE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return version;
}
