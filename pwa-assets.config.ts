// Config for @vite-pwa/assets-generator.
// Run with: npx pwa-assets-generator
//
// Source SVG lives at public/enrops-pwa-source.svg. Outputs go to public/
// alongside it. Generated PNGs are checked into git (they're tiny and
// rebuilding them on every CI run is wasteful — only regenerate when the
// source SVG changes).

import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: {
      // 10% padding so Android's adaptive-icon mask doesn't crop the "e".
      // Background matches the SVG's Deep Purple.
      padding: 0.1,
      resizeOptions: { background: '#1C004F', fit: 'contain' },
      sizes: [512],
    },
  },
  headLinkOptions: {
    // We're injecting these tags ourselves in index.html so the generator
    // doesn't need to rewrite our HTML.
    preset: '2023',
  },
  images: ['public/enrops-pwa-source.svg'],
});
