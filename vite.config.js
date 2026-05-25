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
        name: 'Enrops',
        short_name: 'Enrops',
        description: 'Enrichment operations — registration, scheduling, contractor portal.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#691D39',
        background_color: '#EAEADD',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Default precache. Don't intercept Supabase calls (the SW would
        // serve stale schedule data and break magic-link auth callbacks).
        navigateFallbackDenylist: [
          /^\/auth\//,                 // auth callback paths
          /^\/api\//,                  // any future server functions
          /\.(?:supabase\.co|stripe\.com)/,
        ],
        // Bump precache size cap so the agreement PDF chunk (~1.5 MB) and
        // heic2any chunk (~1.4 MB) get cached on first visit. Without this
        // the SW skips files >2 MB and instructors hit the network on
        // every reload.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        // Skip the SW while iframe-previewing the dev build so HMR isn't
        // intercepted.
        cleanupOutdatedCaches: true,
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
