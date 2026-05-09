/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // J2S brand (parent-facing)
        j2s: {
          purple: '#674EE8',
          'purple-dark': '#4430AC',
          'purple-soft': '#EDE9FE',
          orange: '#F8A638',
          'orange-dark': '#E85B37',
          ink: '#1A1530',
        },
        // Enrops brand (operator/admin)
        enrops: {
          plum: '#691D39',
          'plum-dark': '#4C1429',
          gold: '#CFB12F',
          chalk: '#EAEADD',
          ink: '#1C0E15',
        },
      },
      fontFamily: {
        // J2S
        titan: ['"Titan One"', 'ui-sans-serif', 'system-ui'],
        nunito: ['"Nunito Sans"', 'ui-sans-serif', 'system-ui'],
        // Enrops
        grotesk: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(26, 21, 48, 0.04), 0 8px 24px rgba(26, 21, 48, 0.06)',
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
