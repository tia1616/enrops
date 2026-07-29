// PlacesAutocomplete — Google Places-backed typeahead for venue names.
//
// Goal: replace the manual "type school name + go look up the address +
// type it again" workflow with one click. Operator types "Ainsworth"; the
// dropdown shows "Ainsworth Elementary School — 2825 NE 19th Ave, Portland,
// OR 97212"; selecting it auto-fills the linked Address field.
//
// Activation: only fires when VITE_GOOGLE_MAPS_API_KEY is set on the
// Netlify env. Without the key, falls back to a plain <input> — the form
// keeps working exactly as it did before the integration shipped.
//
// Cost / safety: the API key is restricted by HTTP referrer (enrops.com +
// localhost) so it can't be reused off-platform. Each Places autocomplete
// session costs ~$0.017; each geocode is free via the address_components
// returned in the same call. $200/month free credit on Maps Platform.
//
// Behavior on select:
//   onSelect({ name, address }) — both are strings; never null.
//   "name"    = the Place's name (e.g. "Ainsworth Elementary School")
//   "address" = formatted_address (e.g. "2825 NE 19th Ave, Portland, OR 97212")
//
// Notes:
// - Components: restricted to US for the alpha (every founding tenant is
//   US-based). Drop restriction later when international tenants land.
// - The script tag is injected once per page-lifetime and cached on window
//   so opening multiple modals doesn't reload it.
//
// WHICH GOOGLE API THIS USES (changed 2026-07-28)
// Built on `google.maps.places.PlaceAutocompleteElement`, NOT the legacy
// `places.Autocomplete` class. Google deprecated the legacy class on
// 2026-03-01 and — the part that actually bites — it is NOT AVAILABLE AT ALL
// on API keys or GCP projects created after March 2025. The old widget kept
// working only because this key predates that, so a routine key rotation would
// have silently killed address lookup on every venue surface at once.
//
// The element is a WEB COMPONENT with a CLOSED shadow root, which drives three
// things below that would otherwise look arbitrary:
//   1. It renders its own <input>; we cannot pass React a ref to it. So the
//      component mounts the element imperatively and syncs `value` both ways.
//   2. It cannot be styled from outside except through the ::part() hooks
//      Google exposes. The caller's `style` goes on the HOST, and ::part(input)
//      is stripped bare so the host's border/padding/radius is what you see —
//      that is what keeps the four call sites looking identical.
//   3. `input` events are composed, so they DO cross the shadow boundary and
//      still drive onChange. Verified in the browser, not assumed: typing into
//      a mounted element fires `input` on the host and updates host.value.
// Selection fires `gmp-select` carrying `placePrediction`; `.toPlace()` +
// `fetchFields` gives displayName / formattedAddress.

import { useEffect, useRef, useState } from 'react';

// The element renders its dropdown inside its own shadow root rather than
// appending `.pac-container` to document.body the way the legacy widget did,
// so the old z-index hoist is gone. What IS still needed: the host must sit
// above this app's modals (z-index 200), and the inner input must be stripped
// of Google's chrome so the caller's own field styling is what shows.
// Injected once per page-lifetime.
let cssInjected = false;
function ensurePacCss() {
  if (cssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = [
    'gmp-place-autocomplete[data-enrops]{display:block;position:relative;z-index:10001;}',
    // Strip the element's own box so the HOST carries the border/padding/radius
    // the caller passed. Without this you get a box inside a box.
    'gmp-place-autocomplete[data-enrops]::part(input){',
    'width:100%;box-sizing:border-box;border:none;outline:none;background:transparent;',
    'font:inherit;color:inherit;padding:0;margin:0;min-width:0;}',
    // Take the prediction list OUT OF FLOW. Measured, not guessed: mounting the
    // element inside a 200px `overflow-y:auto` panel (the shape of
    // AddSchoolModal and the LocationsList drawer) and typing "Ainsworth" grew
    // that panel's scrollHeight by 292px while the host stayed 48px -- the list
    // renders in-flow, so inside those two surfaces it would be clipped at the
    // panel edge and scroll the modal instead of overlaying it. The legacy
    // widget avoided this by appending .pac-container to document.body; this
    // element has no such escape hatch, and z-index cannot defeat an ancestor's
    // overflow clip. position:fixed can, with the coordinates fed in from JS
    // (see positionList) because ::part cannot read the host's geometry itself.
    'gmp-place-autocomplete[data-enrops]::part(prediction-list){',
    'position:fixed;z-index:10002;',
    'top:var(--enrops-pac-top,auto);left:var(--enrops-pac-left,auto);width:var(--enrops-pac-width,auto);}',
  ].join('');
  document.head.appendChild(style);
  cssInjected = true;
}

// How long we wait for Google before treating the load as failed. The failure
// this closes: the loader only settles on script `load` or `error`. A request
// that HANGS (captive portal, a proxy that black-holes maps.googleapis.com, a
// dead tunnel) fires neither, so the promise never settles, neither .then nor
// .catch runs, and the field sits there promising "we'll find the place"
// forever while doing nothing -- the same looks-dead failure this component was
// fixed for, just a slower door.
//
// 15s, not 8s: the Maps bootstrap plus importLibrary('places') can genuinely
// exceed 8s on congested wifi or 3G, and a timeout that fires while the load is
// still healthy turns a slow success into a reported failure. The caller also
// retries once (see the component below), so a late arrival still gets picked
// up rather than being lost for the life of the mount.
const LOOKUP_TIMEOUT_MS = 15000;

let loaderPromise = null;
export function loadGoogleMaps(apiKey) {
  if (loaderPromise) return loaderPromise;
  if (typeof window !== 'undefined' && window.google?.maps?.places?.Autocomplete) {
    loaderPromise = Promise.resolve(window.google);
    return loaderPromise;
  }
  loaderPromise = new Promise((rawResolve, rawReject) => {
    // Settle guard + timeout. Everything below settles through these two so a
    // request that HANGS (captive portal, a proxy that black-holes
    // maps.googleapis.com) still ends -- script.onload/onerror never fire in
    // that case, so without this the promise never settles and every consumer
    // waits forever: the typeahead keeps promising "we'll find the place", and
    // FindMissingAddressesModal sits on its elapsed counter with no end.
    let settled = false;
    let timer = setTimeout(() => {
      timer = null;
      if (!settled) { settled = true; rawReject(new Error('gmaps load timed out')); }
    }, LOOKUP_TIMEOUT_MS);
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const resolve = (v) => { if (settled) return; settled = true; clearTimer(); rawResolve(v); };
    const reject = (e) => { if (settled) return; settled = true; clearTimer(); rawReject(e); };
    if (typeof document === 'undefined') return reject(new Error('no document'));
    // Helper: wait for the places library to actually be ready. With
    // loading=async (Google's new recommended pattern), `script.onload`
    // fires before libraries finish loading — `google.maps.places` is
    // briefly undefined. Either await importLibrary('places') (new API)
    // or fall back to polling for the legacy global, then resolve.
    const afterScriptLoad = async () => {
      const g = window.google;
      try {
        if (g?.maps?.importLibrary) {
          await g.maps.importLibrary('places');
        } else {
          // Older API path — poll briefly until the places namespace appears.
          const started = performance?.now?.() ?? 0;
          while (!(g?.maps?.places?.Autocomplete)) {
            if (((performance?.now?.() ?? 0) - started) > 5000) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        resolve(window.google);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    const existing = document.querySelector('script[data-enrops-gmaps]');
    if (existing) {
      if (window.google?.maps) {
        afterScriptLoad();
      } else {
        existing.addEventListener('load', afterScriptLoad, { once: true });
        existing.addEventListener('error', () => {
          // Genuinely dead: `error` has fired, so this tag will never fire
          // either event again and a later attempt must not wait on it.
          existing.remove();
          reject(new Error('gmaps load failed'));
        }, { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&loading=async&v=weekly`;
    script.async = true;
    script.defer = true;
    script.dataset.enropsGmaps = 'true';
    script.onload = afterScriptLoad;
    script.onerror = () => {
      // Same reasoning as the `existing` branch: a tag that has fired `error`
      // is a corpse, so take it out of the DOM here -- at the one moment we
      // know the fetch is over -- rather than blindly on any failure.
      script.remove();
      reject(new Error('gmaps load failed'));
    };
    document.head.appendChild(script);
  });
  // A failed load used to be cached for the life of the page: loaderPromise
  // stayed a rejected promise, so every later mount and every reopen of the
  // bulk-address modal failed instantly even after the network came back, with
  // no way short of a reload. Drop the cache on failure so the next attempt
  // genuinely retries.
  // Deliberately does NOT touch the <script> tag. Removing an element does not
  // abort a fetch that has already begun, so tearing it down on a TIMEOUT left
  // a live request running with nothing pointing at it: the next attempt found
  // no tag, injected a second Maps bootstrap, and both eventually executed --
  // "You have included the Google Maps JavaScript API multiple times on this
  // page." Leaving a timed-out tag alone is strictly better, because the retry
  // takes the `existing` branch and its listeners catch the late arrival. Only
  // the two `error` handlers above remove a tag, and only once its fetch is
  // provably finished.
  loaderPromise.catch(() => { loaderPromise = null; });
  return loaderPromise;
}

// ONE definition of what we say about the lookup, imported by all four
// surfaces. They had already drifted -- VenueEditor said "the school or venue"
// while LocationsList and QuickProgramBuilder said "the place" -- which is how
// four screens end up describing the same feature four ways.
export const PLACES_HINT_READY =
  "Start typing — we'll find the place and fill in the address for you. Or just type the name.";
export const PLACES_HINT_UNAVAILABLE =
  "Address lookup isn't available right now — type the name and address in yourself.";

// Both branches are stated for the state that selects them: `unavailable` is
// true only when there is no key or Google actually refused/timed out, and in
// that state the field genuinely is a plain text box the operator must fill in.
export function PlacesLookupHint({ enabled = true, down = false, style }) {
  const unavailable = !enabled || down;
  return (
    <span style={{ color: unavailable ? '#8a6d1f' : undefined, ...style }}>
      {unavailable ? PLACES_HINT_UNAVAILABLE : PLACES_HINT_READY}
    </span>
  );
}

export default function PlacesAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder,
  style,
  disabled,
  autoFocus,
  id,
  // Forwarded to the underlying input. Exists because swapping a plain <input>
  // for this component silently dropped a caller's maxLength, leaving a field
  // that used to be capped writing unbounded values to a `text` column.
  maxLength,
  // Called with true when the lookup cannot run, so the CALLER can say so.
  // Optional: callers that omit it behave exactly as before.
  //
  // Why this exists: the component degrades to a plain <input> on any failure
  // (no key configured, referrer not allowed on this domain, quota, offline)
  // and used to do it with nothing but a console.warn. To an operator that is
  // indistinguishable from a broken feature -- they type a real school and no
  // address appears, with no clue whether it is loading, wrong, or off. Silent
  // fallback is the "looks dead" bug class; the field still works for typing,
  // but we have to SAY the lookup is unavailable.
  onLookupUnavailable,
}) {
  const hostRef = useRef(null);   // wrapper we mount the web component into
  const elRef = useRef(null);     // the <gmp-place-autocomplete> itself
  const fallbackRef = useRef(null); // the plain input shown until it mounts
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  // Whether the web component is actually in the DOM and usable. Until it is,
  // the operator gets a real <input> -- see the render for why that matters.
  const [elementReady, setElementReady] = useState(false);

  // Refresh the captured onSelect/onChange without rebuilding the element —
  // stored on a ref so the listener closures read the latest values.
  const handlersRef = useRef({ onChange, onSelect });
  useEffect(() => {
    handlersRef.current = { onChange, onSelect };
  }, [onChange, onSelect]);

  // The LATEST value, for the mount path to seed from. The mount effect only
  // runs on [apiKey], so reading `value` from its closure meant a change that
  // landed while Google was still loading (up to 15s on a cold load) was
  // silently discarded -- switching which location you were editing mid-load
  // left the old name in the box while the draft held the new one.
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);

  useEffect(() => {
    // No key configured for this environment. Previously returned in silence.
    if (!apiKey) { onLookupUnavailable?.(true); return undefined; }
    if (!hostRef.current) return undefined;
    ensurePacCss();
    let cancelled = false;
    let el = null;
    let cleanupPosition = null;

    const attach = async (google) => {
      // The element ships in the `places` library; importLibrary is the only
      // supported way to reach it and is idempotent once loaded.
      const { PlaceAutocompleteElement } = await google.maps.importLibrary('places');
      if (cancelled || !hostRef.current) return;

      // No includedPrimaryTypes: the legacy widget asked for
      // ['establishment','geocode'] to cover "a named place OR an address",
      // which is exactly what the new element returns by DEFAULT. Constraining
      // it here would narrow results, not preserve them.
      el = new PlaceAutocompleteElement({
        includedRegionCodes: ['us'],
        ...(maxLength ? { maxlength: maxLength } : {}),
      });
      el.dataset.enrops = 'true';
      if (id) el.id = id;
      if (placeholder) el.placeholder = placeholder;
      if (disabled) el.disabled = true;
      // Seed from the ref, not the closure, and carry over anything the
      // operator already typed into the fallback input while Google loaded.
      el.value = fallbackRef.current?.value || (valueRef.current ?? '');

      // ::part() can restyle the prediction list but cannot know where the host
      // is, so feed it coordinates. Kept in sync on the three things that move
      // it: typing (the list opens), any ancestor scrolling, and a resize.
      const positionList = () => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--enrops-pac-top', `${r.bottom}px`);
        el.style.setProperty('--enrops-pac-left', `${r.left}px`);
        el.style.setProperty('--enrops-pac-width', `${r.width}px`);
      };
      positionList();
      // Capture phase: the scroll happens on the modal/drawer, not on window,
      // and non-capturing window listeners never see those.
      window.addEventListener('scroll', positionList, true);
      window.addEventListener('resize', positionList);
      cleanupPosition = () => {
        window.removeEventListener('scroll', positionList, true);
        window.removeEventListener('resize', positionList);
      };

      el.addEventListener('input', () => {
        positionList();
        // Composed event: it crosses the closed shadow boundary, so this is how
        // the caller's controlled `value` keeps up with typing. Load-bearing —
        // QuickProgramBuilder gates its Save button on the typed name.
        handlersRef.current.onChange?.(el.value);
      });

      el.addEventListener('gmp-select', async (event) => {
        try {
          const place = await event.placePrediction.toPlace();
          await place.fetchFields({ fields: ['displayName', 'formattedAddress'] });
          const name = place.displayName || el.value || '';
          const address = place.formattedAddress || '';
          // Same contract as before: never hand the caller a blank address.
          if (!address) return;
          handlersRef.current.onChange?.(name);
          handlersRef.current.onSelect?.({ name, address });
        } catch (e) {
          if (typeof console !== 'undefined') console.warn('[PlacesAutocomplete] select failed:', e?.message ?? e);
        }
      });

      hostRef.current.appendChild(el);
      elRef.current = el;
      setElementReady(true);
      // Only take focus if the operator has not moved on. This runs after an
      // async load that can take 15s, so an unconditional focus() could yank
      // the caret out of the Address field mid-word. Focusing the fallback
      // input counts as "still here" -- that IS this field.
      if (autoFocus) {
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        const stillHere = !active || active === document.body || active === fallbackRef.current;
        if (stillHere) { try { el.focus(); } catch (_e) { /* noop */ } }
      }
      onLookupUnavailable?.(false);
    };

    const tryLoad = (isRetry) => loadGoogleMaps(apiKey)
      .then(attach)
      .catch((err) => {
        if (cancelled) return undefined;
        if (typeof console !== 'undefined') console.warn('[PlacesAutocomplete] disabled:', err?.message ?? err);
        // Google refused (referrer not allowed for this domain is the usual one
        // on a non-production host), or the script could not load. Tell the caller.
        onLookupUnavailable?.(true);
        // A TIMEOUT is the one failure where the work may still be in flight:
        // loadGoogleMaps left the <script> in the DOM and dropped its cache, so
        // a second attempt attaches to that same tag and resolves when it lands.
        // Without this the operator keeps a plain box for the life of the mount
        // even though Google arrived a second later; with it, attach() runs and
        // flips the hint back to ready. Once only -- a real outage must settle.
        if (!isRetry && /timed out/i.test(err?.message ?? '')) return tryLoad(true);
        return undefined;
      });
    tryLoad(false);

    return () => {
      cancelled = true;
      try { cleanupPosition?.(); } catch (_e) { /* noop */ }
      try { el?.remove(); } catch (_e) { /* noop */ }
      elRef.current = null;
      setElementReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Push caller-driven value changes into the element (e.g. applyPlace filling
  // the name after a selection, or a form reset). Guarded on inequality so we
  // never clobber the caret while the operator is typing.
  useEffect(() => {
    const el = elRef.current;
    if (el && (value ?? '') !== el.value) el.value = value ?? '';
  }, [value]);

  // Keep the element's own props in sync without rebuilding it.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (placeholder != null) el.placeholder = placeholder;
    el.disabled = !!disabled;
  }, [placeholder, disabled]);

  // THERE IS ALWAYS A TYPEABLE FIELD. The first cut of this migration rendered
  // only the host div when a key was present, so any Google failure -- offline,
  // referrer refused, quota, or our own 15s timeout -- left an EMPTY BOX the
  // operator could not type into, while all four surfaces told them to "type
  // the name and address in yourself". The legacy widget never had that hole:
  // it was a real <input> that merely lost its typeahead. With a location now
  // REQUIRED to create a program, that regression could have stopped a lean
  // operator from creating a class by any route at all.
  //
  // So the plain input renders until the element is confirmed mounted, and the
  // host div renders ALWAYS -- attach() has nowhere to append otherwise. Only
  // one of them is visible at a time.
  const showFallback = !apiKey || !elementReady;

  return (
    <>
      {apiKey && (
        // The caller's `style` goes on the HOST: the element's own input is
        // stripped bare by ::part(input), so the border/padding/radius the four
        // surfaces pass is what the operator sees, as with the legacy widget.
        <div ref={hostRef} style={showFallback ? { display: 'none' } : style} />
      )}
      {showFallback && (
        <input
          ref={fallbackRef}
          // Safe to carry the id: showFallback is false the moment the element
          // mounts, so the two never exist at once and a <label htmlFor> always
          // has exactly one target.
          id={id}
          type="text"
          value={value ?? ''}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          maxLength={maxLength}
          autoComplete="off"
          style={style}
        />
      )}
    </>
  );
}
