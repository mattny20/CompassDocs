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
          // Subtle blue tints double as surfaces, so they follow the theme…
          50: v("--compass-50"),
          100: v("--compass-100"),
          // …while the saturated brand blues stay constant across themes.
          200: "#bcd3ff",
          300: "#8eb6ff",
          400: "#598eff",
          500: "#3366f2",
          600: "#2148d8",
          700: "#1c39ae",
          800: "#1d3389",
          900: "#1e306d",
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
