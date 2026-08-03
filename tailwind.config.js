/** @type {import('tailwindcss').Config} */

// Nemo AI — premium dark SaaS, per NEMO_AI_SPEC §3 (MANDATORY design system).
// Page bg #0A0D1C (NOT pure black), panels #10162E, glass cards, violet→blue→cyan
// brand gradient, Inter typography, soft dark shadows + subtle violet glow.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // --- Spec core tokens (§3) ---
        bg: 'rgb(var(--color-bg) / <alpha-value>)', // page background
        panel: 'rgb(var(--color-panel) / <alpha-value>)', // panels, sidebar, topbar
        card: 'rgb(var(--color-card) / <alpha-value>)', // glass card surface
        text: 'rgb(var(--color-text) / <alpha-value>)', // primary text
        muted: 'rgb(var(--color-muted) / <alpha-value>)', // secondary text
        violet: '#8B7CF8', // gradient start / primary accent
        blue: '#5B7CF6', // gradient mid
        cyan: '#22D3EE', // gradient end / accent
        teal: '#13C5B4', // success
        amber: '#F59F00', // warning / status
        danger: '#F2545B',

        // --- Accent aliases used across app pages ---
        ice: 'rgb(var(--color-ice) / <alpha-value>)', // light text + hairline border base
        cobalt: '#5B7CF6', // accent (blue)
        orange: '#F59F00', // warm accent (amber)

        // --- Legacy / August token names remapped onto the dark system,
        //     so existing components cascade without per-file rewrites ---
        cream: 'rgb(var(--color-bg) / <alpha-value>)', // page bg
        ink: 'rgb(var(--color-ice) / <alpha-value>)', // light text / hairline border base
        indigo: '#8B7CF8', // -> violet (primary accent)
        forest: '#13C5B4', // -> teal (success)
        ember: '#F59F00', // -> amber (warning)
        blossom: '#22D3EE', // -> cyan
        petal: '#5B7CF6', // -> blue
        lavender: 'rgba(255,255,255,0.14)', // hairline border
        stone: 'rgb(var(--color-muted) / <alpha-value>)', // -> muted text
        fog: 'rgb(var(--color-fog) / <alpha-value>)', // dimmer muted text
        infoblue: 'rgba(91,124,246,0.16)', // soft info chip bg
        midnight: 'rgb(var(--color-midnight) / <alpha-value>)', // text on info chips
        meadow: '#13C5B4',

        // Atlantic surface names remapped to dark
        void: 'rgb(var(--color-bg) / <alpha-value>)',
        carbon: 'rgb(var(--color-panel) / <alpha-value>)',
        graphite: 'rgb(var(--color-panel) / <alpha-value>)',
        slate: 'rgb(var(--color-panel) / <alpha-value>)',
        iron: 'rgb(var(--color-muted) / <alpha-value>)',
        steel: 'rgb(var(--color-fog) / <alpha-value>)',
      },
      fontFamily: {
        // Inter everywhere (spec §3). `serif` aliases to Inter so any leftover
        // `font-serif` class still renders the spec font, never a system serif.
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderColor: {
        DEFAULT: 'rgba(255,255,255,0.09)', // spec --border
      },
      maxWidth: {
        container: '1180px',
      },
      borderRadius: {
        lg: '0.625rem', // 10
        xl: '0.75rem', // 12 — buttons (spec)
        '2xl': '1rem', // 16 — cards
        '3xl': '1.25rem', // 20 — large cards
        pill: '9999px', // avatars / pills
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg,#8B7CF8 0%,#5B7CF6 45%,#22D3EE 100%)',
        'brand-radial': 'radial-gradient(60% 60% at 50% 0%, rgba(139,124,248,0.22) 0%, transparent 70%)',
      },
      boxShadow: {
        // soft dark shadows + subtle violet glow (spec §3)
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 24px 48px -28px rgba(0,0,0,0.75)',
        soft: '0 12px 28px -20px rgba(0,0,0,0.7)',
        btn: '0 10px 30px -10px rgba(91,124,246,0.55)',
        lg: '0 30px 60px -30px rgba(0,0,0,0.8)',
        glow: '0 0 0 3px rgba(139,124,248,0.28)',
      },
      keyframes: {
        fadeInUp: { '0%': { opacity: '0', transform: 'translateY(10px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        typing: { '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.4' }, '30%': { transform: 'translateY(-3px)', opacity: '1' } },
        floaty: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        marquee: { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
      },
      animation: {
        fadeInUp: 'fadeInUp 0.5s ease-out both',
        fadeIn: 'fadeIn 0.45s ease-out both',
        typing: 'typing 1.2s ease-in-out infinite',
        floaty: 'floaty 6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s infinite',
        marquee: 'marquee 30s linear infinite',
      },
    },
  },
  plugins: [],
}
