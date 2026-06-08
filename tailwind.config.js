/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // J2S brand (parent-facing surfaces only — register / login / dashboard / home).
        // These tokens resolve from CSS variables whose defaults ARE the J2S
        // Brandboard values (set in index.css :root), so J2S renders exactly as
        // before everywhere. The Enrops public shell (non-J2S tenants) overrides
        // the variables to the Enrops palette, so a tenant like Cascade gets
        // Enrops-branded parent pages without touching any of the 180+ class uses.
        j2s: {
          purple: 'rgb(var(--j2s-purple) / <alpha-value>)',
          'purple-dark': 'rgb(var(--j2s-purple-dark) / <alpha-value>)',
          'purple-soft': 'rgb(var(--j2s-purple-soft) / <alpha-value>)',
          orange: 'rgb(var(--j2s-orange) / <alpha-value>)',
          'orange-dark': 'rgb(var(--j2s-orange-dark) / <alpha-value>)',
          ink: 'rgb(var(--j2s-ink) / <alpha-value>)',
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
        // J2S parent surfaces — variable-driven so the Enrops public shell can
        // swap them to Poppins for non-J2S tenants (default = J2S fonts, set in
        // index.css :root). J2S is unchanged.
        titan: ['var(--brand-display)', 'ui-sans-serif', 'system-ui'],
        nunito: ['var(--brand-body)', 'ui-sans-serif', 'system-ui'],
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
