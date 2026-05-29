/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // J2S brand (parent-facing surfaces only — register / login / dashboard / home)
        // Per the Journey to STEAM Brandboard.
        j2s: {
          purple: '#674EE8',
          'purple-dark': '#4430AC',
          'purple-soft': '#EDE9FE',
          orange: '#F8A638',
          'orange-dark': '#E85B37',
          ink: '#1A1530',
        },
        // Enrops brand (admin, contractor portal, contractor onboarding,
        // marketing landing — everything that's not parent-facing).
        // Per the Enrops Brand Guidelines (May 2026). Earlier this codebase
        // used "plum #691D39 + gold #CFB12F" under the enrops namespace —
        // those were misapplied placeholders, not the real palette.
        enrops: {
          purple: '#1C004F',           // Deep Purple — primary dark
          'purple-dark': '#0D0024',    // hover / focus
          'deep-violet': '#6857E1',    // Deep Violet — brand-mark variant
          violet: '#8C88FF',           // Vivid Violet — accent
          'violet-soft': '#F2F0FF',    // Soft Lilac — bg tints, hover
          mint: '#26D687',             // Mint Green — success
          pink: '#F16BF1',             // Bright Pink — warning / hot
          yellow: '#F8F068',           // Soft Yellow — info
          cream: '#FBFBFB',            // Cream — page background
          ink: '#1C0E15',              // body text (deliberately dark)
        },
      },
      fontFamily: {
        // J2S parent surfaces
        titan: ['"Titan One"', 'ui-sans-serif', 'system-ui'],
        nunito: ['"Nunito Sans"', 'ui-sans-serif', 'system-ui'],
        // Enrops surfaces
        poppins: ['Poppins', 'ui-sans-serif', 'system-ui'],
        // Legacy alias — still referenced by some files; resolves to Poppins
        // so the visual treatment lands even if a stale class slips through.
        grotesk: ['Poppins', 'ui-sans-serif', 'system-ui'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(28, 0, 79, 0.04), 0 8px 24px rgba(28, 0, 79, 0.06)',
        pop: '0 2px 4px rgba(26, 21, 48, 0.06), 0 16px 40px rgba(103, 78, 232, 0.18)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
