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

let loaderPromise = null;
export function loadGoogleMaps(apiKey) {
  if (loaderPromise) return loaderPromise;
  if (typeof window !== 'undefined' && window.google?.maps?.places?.Autocomplete) {
    loaderPromise = Promise.resolve(window.google);
    return loaderPromise;
  }
  loaderPromise = new Promise((resolve, reject) => {
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
  return loaderPromise;
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
}) {
  const inputRef = useRef(null);
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    if (!apiKey || !inputRef.current) return undefined;
    ensurePacCss();
    let autocomplete;
    let listener;
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((google) => {
        if (cancelled || !inputRef.current) return;
        autocomplete = new google.maps.places.Autocomplete(inputRef.current, {
          types: ['establishment', 'geocode'],
          componentRestrictions: { country: 'us' },
          fields: ['name', 'formatted_address'],
        });
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
