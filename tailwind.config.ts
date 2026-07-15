import type { Config } from "tailwindcss";

// Neutral (slate) and subtle-accent (compass 50/100) colors are driven by CSS
// variables so the whole UI can flip between light and dark via a single
// `data-theme` attribute — see src/app/globals.css for the two palettes. The
// channel (`R G B`) format keeps Tailwind's `/opacity` modifiers working.
const v = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // `surface` replaces bare `bg-white` cards/inputs so they can darken;
        // bare `white`/`text-white` stays literal for accent chips & buttons.
        surface: v("--surface"),
        canvas: v("--canvas"),
        // Neutral ramp — same class names as Tailwind's slate, now themeable.
        slate: {
          50: v("--slate-50"),
          100: v("--slate-100"),
          200: v("--slate-200"),
          300: v("--slate-300"),
          400: v("--slate-400"),
          500: v("--slate-500"),
          600: v("--slate-600"),
          700: v("--slate-700"),
          800: v("--slate-800"),
          900: v("--slate-900"),
          950: v("--slate-950"),
        },
        compass: {
          // The whole accent ramp is variable-driven: 50/100 follow the
          // light/dark theme, and every step can be re-tinted at runtime from
          // the workspace accent color (Settings → Workspace). Defaults in
          // globals.css are the hand-tuned ramp around #2e75bd.
          50: v("--compass-50"),
          100: v("--compass-100"),
          200: v("--compass-200"),
          300: v("--compass-300"),
          400: v("--compass-400"),
          500: v("--compass-500"),
          600: v("--compass-600"),
          700: v("--compass-700"),
          800: v("--compass-800"),
          900: v("--compass-900"),
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
