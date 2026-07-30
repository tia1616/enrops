// src/lib/metaPixel.js
// Meta pixel for enrops, per Darren's app-events spec (2026-07-30).
//
// THREE EVENTS, fired at completion and never at screen-open:
//   CompleteRegistration (standard) - an enrops account + org is created
//   StripeConnected      (custom)   - the operator can actually take money
//   WorkflowCreated      (custom)   - a program is saved LIVE (every save,
//                                     Jessica's call; not first-only, not drafts)
//
// WHY THIS IS A MODULE AND NOT THE RAW SNIPPET IN index.html, which is what the
// spec asks for:
//   1. We must not load at all when the browser sends Global Privacy Control, or
//      when the visitor has opted out. That decision has to happen BEFORE fbq
//      exists, so something has to run first. A bare snippet cannot.
//   2. enrops is a single-page app. The snippet's one PageView fires on the
//      first document load and never again, so every in-app navigation would go
//      unrecorded. AnalyticsBridge sends them on route change instead.
//   3. The dataset id comes from VITE_META_PIXEL_ID rather than being baked in,
//      so STAGING DOES NOT POLLUTE THE REAL DATASET. Unset means this file does
//      nothing at all, which is the default everywhere until deliberately set.
// The bootstrap below is byte-for-byte the behaviour of the spec's snippet.
//
// OPT-OUT, NOT OPT-IN. enrops operates in the US, where CCPA/CPRA and OCPA are
// opt-out regimes: measurement may run until the person declines. This is the
// standard model and it is what the published cookie disclosure describes.
// Global Privacy Control is the exception - honoring it is not optional, and a
// GPC signal means we never load, no banner required.

const PIXEL_ID = import.meta.env.VITE_META_PIXEL_ID;
const OPT_OUT_KEY = 'enrops.meta.optout';

/**
 * Fired on this window whenever the advertising choice changes. Exported so the
 * notice bar and the choice page listen for the same string rather than each
 * hardcoding it - a typo on one side would fail silently, which is the whole
 * bug class this event exists to close.
 */
export const AD_CHOICE_EVENT = 'enrops:adchoice';

let loaded = false;
let suppressed = false; // opted out or GPC - never send, even if fbq exists

/**
 * Browser-level Do Not Sell/Share signal. Legally binding in CA + OR.
 *
 * Exported because the choice page must be able to say "your browser already
 * told us, there is nothing for you to do here" rather than offering a toggle
 * that the signal would override anyway.
 */
export function hasGpcSignal() {
  try {
    return navigator.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

// THREE states, not two, and the difference matters:
//   null -> no choice made yet. Measurement RUNS (US opt-out regime) and the
//           notice is shown so the person can decline.
//   '0'  -> explicitly accepted. Measurement runs and the notice stays shut.
//   '1'  -> declined. Measurement never loads.
// Storing '0' rather than deleting the key is what separates "accepted" from
// "never asked". Deleting it would re-show the notice to someone who had
// already dismissed it, on every new tab, forever.

/** Persisted opt-out. Wrapped because Safari private mode throws on access. */
export function hasOptedOut() {
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Has this person answered the advertising notice at all?
 *
 * Drives whether the notice is shown. Deliberately separate from hasOptedOut():
 * "declined" and "not asked yet" both mean "not opted in", but only one of them
 * should put a bar on the screen.
 */
export function hasMadeAdChoice() {
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) !== null;
  } catch {
    // Storage unavailable: treat as answered. A notice that cannot remember the
    // answer would reappear on every page load, which is worse than not asking.
    return true;
  }
}

/**
 * Whether measurement is running right now. Drives the opt-out control's label,
 * so it must describe what IS, never what the control would do.
 *
 * hasOptedOut() is re-read on EVERY call rather than trusted from `suppressed`.
 * `suppressed` is per module instance, so it only knows about opt-outs that
 * happened in THIS tab since IT loaded. localStorage is shared across tabs, so
 * an operator who opts out in one tab would otherwise keep sending events from
 * every tab they already had open until each was reloaded.
 */
export function isPixelActive() {
  return Boolean(PIXEL_ID) && loaded && !suppressed && !hasOptedOut();
}

/** True when a dataset id is configured at all. Nothing to offer without one. */
export function isPixelConfigured() {
  return Boolean(PIXEL_ID);
}

/** The spec's bootstrap, unchanged in behaviour. */
function bootstrap() {
  /* eslint-disable */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};
  if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
  n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];
  s.parentNode.insertBefore(t,s)}(window,document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  // MUST come before init. Without it the pixel silently collects far more than
  // the three events we asked for, and more than our published disclosure
  // describes.
  //
  // Found by firing a test event and READING THE BEACON, not by reading docs:
  // every button click was sending cd[buttonText] and buttonFeatures.innerText,
  // i.e. the literal label of whatever was clicked, plus form metadata and the
  // page title. On a global pixel that reaches inside the operator app and the
  // family-facing registration pages. A button reading "Remove <child> from
  // roster" would have sent that child's name to Meta.
  //
  // autoConfig false disables Automatic Advanced Matching and automatic event
  // collection. The three events in the spec are explicit track/trackCustom
  // calls and are unaffected.
  //
  // DO NOT REMOVE without re-reading a live beacon. The failure is silent: the
  // events we want keep working either way, so nothing looks broken.
  window.fbq('set', 'autoConfig', false, PIXEL_ID);
  window.fbq('init', PIXEL_ID);
  loaded = true;
}

/**
 * Called once from main.jsx. Silent no-op when unconfigured, opted out, or GPC.
 * Deliberately does NOT send the first PageView - AnalyticsBridge owns every
 * PageView so there is exactly one place that decides when one is sent. Sending
 * one here too would double-count the landing page.
 */
export function initMetaPixel() {
  if (!PIXEL_ID || loaded) return;
  if (hasGpcSignal() || hasOptedOut()) {
    suppressed = true;
    return;
  }
  bootstrap();
}

/** SPA navigation. */
export function pixelPageview() {
  if (!isPixelActive()) return;
  window.fbq('track', 'PageView');
}

/** Standard event (the spec uses this for CompleteRegistration). */
export function pixelTrack(event, params) {
  if (!isPixelActive()) return;
  // Passing undefined rather than {} when there is nothing to attach: an empty
  // custom-data object still shows up in Events Manager and makes every event
  // look like it carried data it did not.
  if (params) window.fbq('track', event, params);
  else window.fbq('track', event);
}

/** Custom event (StripeConnected, WorkflowCreated). */
export function pixelTrackCustom(event) {
  if (!isPixelActive()) return;
  window.fbq('trackCustom', event);
}

/**
 * Do Not Sell or Share. Persists the choice and stops sending immediately.
 *
 * fbq cannot be unloaded once the script is on the page, so `consent/revoke` is
 * what actually stops Meta processing; `suppressed` then stops us calling fbq at
 * all. Both, because either alone leaves a gap: revoke without the flag still
 * queues calls, and the flag without revoke leaves Meta holding what it already
 * has. On the next page load initMetaPixel sees the stored choice and never
 * bootstraps in the first place.
 */
export function optOutOfPixel() {
  try {
    window.localStorage.setItem(OPT_OUT_KEY, '1');
  } catch {
    // Private mode: the choice cannot persist past this page. Still honour it
    // for this session rather than pretending the click did nothing.
  }
  suppressed = true;
  if (loaded && window.fbq) window.fbq('consent', 'revoke');
  clearMetaCookies();
  announceChoice();
}

/**
 * Tell the rest of the app the choice changed.
 *
 * The notice bar lives outside the route tree, so it is mounted once for the
 * app's whole lifetime and SPA navigation never remounts it. Without this, a
 * visitor who took the bar's own footer link to /do-not-sell and opted out
 * there came back to find the bar still asking - and answering it would have
 * overwritten the choice they had just made.
 */
function announceChoice() {
  try {
    window.dispatchEvent(new Event(AD_CHOICE_EVENT));
  } catch {
    // CustomEvent unavailable in some embedded webviews. The stored choice is
    // already correct; only the live UI update is lost.
  }
}

/**
 * Delete the advertising identifiers Meta already wrote.
 *
 * Stopping further sends is not the whole of an opt-out: `_fbp` is a first-party
 * identifier for this person that Meta set on our own domain, and leaving it in
 * place means the identifier outlives the choice to opt out. `_fbc` is the same
 * for click attribution when a visitor arrives with an fbclid.
 *
 * Meta writes these on the registrable domain (.enrops.com), not the exact host,
 * and a cookie can only be deleted by a matching domain+path, so this walks the
 * host's parent domains rather than guessing one. Deleting a cookie that does
 * not exist is a no-op, so over-covering is free and under-covering is silent.
 */
function clearMetaCookies() {
  try {
    const host = window.location.hostname;
    const parts = host.split('.');
    const domains = [null, host];
    for (let i = 0; i < parts.length - 1; i += 1) {
      domains.push(`.${parts.slice(i).join('.')}`);
    }
    for (const name of ['_fbp', '_fbc']) {
      for (const domain of domains) {
        document.cookie =
          `${name}=; Max-Age=0; path=/` + (domain ? `; domain=${domain}` : '');
      }
    }
  } catch {
    // Cookie access can throw in hardened/embedded contexts. The opt-out itself
    // has already taken effect; failing to tidy up must not undo it.
  }
}

// ---------------------------------------------------------------------------
// The three events from the spec.
//
// Named functions rather than raw strings at the call sites, so an event name
// exists in exactly one place. A typo'd 'WorkflowCreated' would not throw, would
// not show up in any test, and would simply never appear in Meta - the silent
// failure class. Call sites also read as what happened, not as analytics.
// ---------------------------------------------------------------------------

/**
 * An enrops account + organization was created. Standard event, per the spec.
 *
 * The spec's UTM section: "If carrying it through to the CompleteRegistration
 * call is easy, do that; if not, storing it on the record is enough." It is
 * easy, so the ad that produced this signup rides along as custom data and
 * Darren can segment on it in Events Manager without joining to our database.
 *
 * It is ALSO stored server-side by record_signup_attribution, deliberately.
 * These are not redundant: the pixel copy is lost whenever someone opts out, is
 * running an ad blocker, or arrives on a browser Meta cannot match, while the
 * database copy survives all of that. The database is the source of truth for
 * "which ad produced this operator"; the pixel copy exists only so Meta's own
 * reporting can break conversions down.
 *
 * @param {string|null} [utmContent]
 */
export function pixelCompleteRegistration(utmContent) {
  pixelTrack('CompleteRegistration', utmContent ? { utm_content: utmContent } : undefined);
}

/**
 * The operator's Stripe account reached the state where it can actually take
 * money. Deliberately NOT "returned from Stripe" - connected and able-to-charge
 * are different states, and only the second one is worth a conversion.
 */
export function pixelStripeConnected() {
  pixelTrackCustom('StripeConnected');
}

/**
 * A customer-facing registration workflow was saved live.
 *
 * Fires on EVERY such save, not just an operator's first (Jessica's call,
 * 2026-07-30). Does not fire for drafts: a draft is not customer-facing, which
 * is the wording the spec uses. An operator building a term's worth of classes
 * will therefore fire this many times.
 *
 * PARTNER-RUN PROGRAMS COUNT (Jessica's call, 2026-07-30). A program with
 * runs_own_registration = true sends families to the operator's own external
 * registration URL, so enrops runs no checkout for it. Code review flagged that
 * as a false conversion; the decision is that it still counts, because the
 * operator has published a live customer-facing listing through enrops either
 * way. Do NOT add a runs_own_registration guard here without asking - it would
 * silently change what the conversion means partway through a campaign.
 */
export function pixelWorkflowCreated() {
  pixelTrackCustom('WorkflowCreated');
}

/** Reverse an earlier opt-out. */
export function optInToPixel() {
  // Same guard as initMetaPixel, and for the same reason. Without it, clicking
  // "allow" in an environment with no dataset id would still inject
  // fbevents.js and call fbq('init', undefined) — loading Meta's script on
  // staging, which is configured with no pixel precisely so it cannot reach the
  // real dataset. isPixelActive() would still be false, so nothing would look
  // broken while the script sat on the page.
  if (!PIXEL_ID) return;
  try {
    // '0', NOT removeItem. Deleting the key would reset this person to "never
    // asked" and the notice would reappear on their next visit, having just
    // been answered.
    window.localStorage.setItem(OPT_OUT_KEY, '0');
  } catch {
    /* choice cannot persist; honour it for this session anyway */
  }
  // GPC outranks a click. Someone sending GPC while clicking "allow" is a
  // contradiction, and the law says the signal wins.
  if (hasGpcSignal()) return;
  suppressed = false;
  if (!loaded) bootstrap();
  else if (window.fbq) window.fbq('consent', 'grant');
  announceChoice();
}
