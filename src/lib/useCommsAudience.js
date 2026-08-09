// useCommsAudience — the one place the Comms audience filter is resolved.
//
// WHY THIS EXISTS: the clamp + selectAudience pair was copied into all three
// Comms tabs (Contacts, Automations, Templates). Six near-identical blocks
// across three files meant changing the fallback, or how ?audience= is written,
// was three edits — and a fourth Comms surface that rendered AudienceSwitcher
// and forgot the clamp would silently reproduce the empty-list bug the clamp
// exists to prevent. AudienceSwitcher's header codified that contract as a
// COMMENT ("Every caller here does that") rather than enforcing it.
//
// House precedent for a hook in lib/: permissions.js exports pure
// getPermissions(role) alongside usePermissions(), which reads outlet context.
// useAdChoice.js, useUserRoles.js and useViewportClamp.js are the same shape.
//
// Also fixes the stale-URL half: the old clamp corrected what it RENDERED but
// never corrected the address bar, so a lean operator opening a pre-gate
// bookmark kept ?audience=instructors in the URL, in history, and in anything
// they re-shared, while Families rendered. Now the URL is rewritten to match
// what is actually on screen, so the two can never disagree.

import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { commsAudiencesFor } from "./entitlements.js";

/**
 * @param org the org row from the admin outlet context
 * @returns { audience, allowedAudiences, selectAudience }
 *
 * `audience` is always a value this org may actually see. The default audience
 * is the FIRST allowed one rather than a hardcoded "families", so an org whose
 * allowed list ever omits families cannot land on a value it isn't permitted.
 */
export function useCommsAudience(org) {
  const [params, setParams] = useSearchParams();

  const allowedAudiences = commsAudiencesFor(org);
  const fallback = allowedAudiences[0];
  const requested = params.get("audience");
  const audience = allowedAudiences.includes(requested) ? requested : fallback;

  // Round-trip the URL when it asked for something this org can't have. Runs in
  // an effect, not during render, because setParams triggers a navigation.
  // `replace` so a corrected address doesn't add a history entry the operator
  // has to press Back through twice.
  useEffect(() => {
    if (requested === null && audience === fallback) return; // clean default, nothing to write
    if (requested === audience) return;                      // already agrees
    const next = new URLSearchParams(params);
    if (audience === fallback) next.delete("audience");
    else next.set("audience", audience);
    setParams(next, { replace: true });
    // params is a stable-enough dep via `requested`; including the object itself
    // would re-run on every unrelated query-string change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, audience, fallback]);

  function selectAudience(a) {
    if (!allowedAudiences.includes(a)) return; // never write an audience we'd clamp away
    const next = new URLSearchParams(params);
    if (a === fallback) next.delete("audience");
    else next.set("audience", a);
    setParams(next, { replace: true });
  }

  return { audience, allowedAudiences, selectAudience };
}
