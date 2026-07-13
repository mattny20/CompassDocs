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
          // Ramp centered on the brand blue (#2e75bd) at step 600.
          200: "#b3d3ec",
          300: "#82b4e0",
          400: "#5093d0",
          500: "#3a80c6",
          600: "#2e75bd",
          700: "#275f99",
          800: "#234f7c",
          900: "#204264",
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
