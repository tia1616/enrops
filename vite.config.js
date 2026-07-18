import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' = we show a "new version" toast and the user taps to update.
      // Never auto-reloads mid-session — instructors may be in the middle of
      // accepting an assignment or admins in the middle of a long form.
      registerType: 'prompt',

      // Generated icons + favicon ship from public/, no extra includeAssets
      // needed beyond the favicon.svg (workbox precaches the build output
      // automatically).
      includeAssets: ['favicon.svg', 'enrops-pwa-source.svg'],

      manifest: {
        // `id` + `start_url` together let Chrome treat this as ONE app across
        // versions. Without `id`, Chrome's "Install app" can split into
        // "Create shortcut" because it can't confidently identify the PWA
        // as a single installable thing.
        id: '/',
        name: 'Enrops',
        short_name: 'Enrops',
        description: 'Enrichment operations — registration, scheduling, contractor portal.',
        start_url: '/',
        scope: '/',
        // `display_override` is the modern way to express display preference;
        // browsers fall back to `display` for older clients. Listing
        // window-controls-overlay first is harmless on phones (they only
        // honor standalone) and unlocks the cleanest desktop install.
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'portrait',
        // theme_color = Android's status bar tint when the PWA is open.
        // background_color = splash screen behind the icon. Both pulled from
        // the Enrops Brand Guidelines (May 2026).
        theme_color: '#1C004F',
        background_color: '#FBFBFB',
        // Helps the OS file the app under the right category and improves
        // Chrome's installability score.
        categories: ['productivity', 'business', 'education'],
        // `any` icons satisfy the standard install criterion; `maskable`
        // covers Android's adaptive-icon shapes without cropping. We mark
        // 512x512 as both purposes so Chrome counts it for either check.
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Chrome's installability check requires the SW to respond to a
        // navigation fetch for start_url. Setting navigateFallback makes
        // workbox claim all SPA routes and serve index.html from cache —
        // without this Chrome flags the site as only "shortcut-able", not
        // fully installable, and shows both "Install" and "Create shortcut"
        // side-by-side in the menu.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/auth\//,                 // auth callback paths
          /^\/api\//,                  // any future server functions
          /\.(?:supabase\.co|stripe\.com)/,
        ],
        // Bump precache size cap so the agreement PDF chunk (~1.5 MB) and
        // heic2any chunk (~1.4 MB) get cached on first visit. Without this
        // the SW skips files >2 MB and instructors hit the network on
        // every reload.
        //
        // 5 MiB, not 3. workbox FAILS THE BUILD (not just warns) when an asset
        // exceeds this, and the main bundle had crept to ~3.14 MB - inside 2 KB
        // of the old 3 MiB cap. A local build came in ~14 KB smaller than
        // Netlify's and passed, so the prod build broke while every local gate
        // stayed green. The headroom is deliberate: it must not sit one small
        // dependency away from a red prod build again.
        //
        // The real fix is code-splitting the 3 MB main bundle (vite already
        // warns about it on every build); tracked separately.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // Take control of open clients as soon as the SW activates so the
        // first install qualifies on the first page load, not the second.
        clientsClaim: true,
        skipWaiting: false,           // we still want the update toast UX
      },

      // Dev: disabled so HMR works normally. We test PWA via `npm run build
      // && npm run preview`.
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
