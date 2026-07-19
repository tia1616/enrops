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
        // Precache size cap. READ THIS BEFORE CHANGING IT.
        //
        // workbox FAILS THE BUILD (not just warns) when any asset exceeds this
        // value. On 2026-07-18 that took prod down for ~25 min: the cap was
        // 3 MiB and the main bundle had crept to 3.14 MB, landing within 2 KB
        // of it. The local build came out ~14 KB smaller than Netlify's, so
        // every local gate stayed green while the prod build went red and
        // Netlify silently kept serving the previous deploy.
        //
        // Two things changed since:
        //   1. The app is route-split (see App.jsx), so the main chunk is
        //      ~516 kB instead of 3.14 MB. The old runaway is gone.
        //   2. A CI job builds on a clean `npm ci` (.github/workflows), so a
        //      cap breach fails a PR instead of a production deploy.
        //
        // With that in place the 5 MiB emergency headroom is no longer earning
        // its keep, so this is back to the workbox default of 2 MiB. Current
        // largest asset is agreementPdf at ~1.46 MB, leaving ~600 kB (~40%)
        // of real margin.
        //
        // If this ever fails the build, the fix is to split the offending
        // chunk, NOT to raise the number. Raising it is what let the main
        // bundle grow unnoticed to 3.14 MB in the first place.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
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
    rollupOptions: {
      output: {
        // Split the long-lived vendor code out of the app chunk. These change
        // only when we bump a dependency, so pulling them out means a normal
        // app deploy doesn't invalidate ~200 kB of framework the browser
        // already has cached.
        //
        // React, react-dom and react-router ship as ONE chunk on purpose:
        // they have interdependent module-init order, and splitting them into
        // separate chunks is a well-known way to get a "Cannot read properties
        // of undefined" at startup depending on which loads first.
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
});
