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
// - If the API call fails (offline, quota, etc.) we silently fall back to
//   a regular input — never block typing.

import { useEffect, useRef } from 'react';

// Google's Places dropdown attaches a div with class `.pac-container` to
// document.body. Inside modals (z-index 200 in this app), the dropdown
// sometimes renders behind the modal backdrop. Lift it above everything.
// Injected once per page-lifetime.
let cssInjected = false;
function ensurePacCss() {
  if (cssInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = '.pac-container{z-index:10001 !important;}';
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
const LOOKUP_TIMEOUT_MS = 8000;

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
        existing.addEventListener('error', () => reject(new Error('gmaps load failed')), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&loading=async&v=weekly`;
    script.async = true;
    script.defer = true;
    script.dataset.enropsGmaps = 'true';
    script.onload = afterScriptLoad;
    script.onerror = () => reject(new Error('gmaps load failed'));
    document.head.appendChild(script);
  });
  // A failed load used to be cached for the life of the page: loaderPromise
  // stayed a rejected promise, so every later mount and every reopen of the
  // bulk-address modal failed instantly even after the network came back, with
  // no way short of a reload. Drop the cache on failure so the next attempt
  // genuinely retries.
  loaderPromise.catch(() => {
    loaderPromise = null;
    // And drop the dead <script> with it. A tag that already fired `error` (or
    // hung) will never fire either event again, so leaving it in the DOM sends
    // the retry down the `existing` branch to wait on a corpse -- it would burn
    // the full timeout and fail every time, making the retry cosmetic. If the
    // script did load and the failure came later, window.google is already set
    // and the early-return above short-circuits before we ever look for a tag.
    if (typeof document !== 'undefined') {
      document.querySelector('script[data-enrops-gmaps]')?.remove();
    }
  });
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
  const inputRef = useRef(null);
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    // No key configured for this environment. Previously returned in silence.
    if (!apiKey) { onLookupUnavailable?.(true); return undefined; }
    if (!inputRef.current) return undefined;
    ensurePacCss();
    let autocomplete;
    let listener;
    let cancelled = false;
    // No timer here on purpose: loadGoogleMaps owns the timeout, so a hang
    // arrives as a rejection in .catch below like any other failure, and every
    // consumer of the loader gets the same behaviour from one place.
    loadGoogleMaps(apiKey)
      .then((google) => {
        if (cancelled || !inputRef.current) return;
        autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
          types: ['establishment', 'geocode'],
          componentRestrictions: { country: 'us' },
          fields: ['name', 'formatted_address'],
        });
        onLookupUnavailable?.(false);
        listener = autocomplete.addListener('place_changed', () => {
          const place = autocomplete.getPlace();
          if (!place) return;
          const name = place.name || (inputRef.current?.value ?? '');
          const address = place.formatted_address || '';
          if (!address) return;
          // Read latest handlers via the ref so we don't have to rebuild
          // Autocomplete every render.
          const { onSelect: latestOnSelect } = handlersRef.current;
          latestOnSelect?.({ name, address });
        });
      })
      .catch((err) => {
        if (typeof console !== 'undefined') console.warn('[PlacesAutocomplete] disabled:', err?.message ?? err);
        // Google refused (referrer not allowed for this domain is the usual one
        // on a non-production host), or the script could not load. Tell the caller.
        if (!cancelled) onLookupUnavailable?.(true);
      });
    return () => {
      cancelled = true;
      try { listener?.remove(); } catch (_e) { /* noop */ }
    };
  }, [apiKey]);

  // Refresh the captured onSelect/onChange in the listener without rebuilding
  // the Autocomplete instance — store on ref so the listener closure can read
  // the latest values without re-binding.
  const handlersRef = useRef({ onChange, onSelect });
  useEffect(() => {
    handlersRef.current = { onChange, onSelect };
  }, [onChange, onSelect]);

  return (
    <input
      ref={inputRef}
      id={id}
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      autoComplete="off"
      style={style}
    />
  );
}
