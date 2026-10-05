/**
 * ARI Console - Capgemini brand theme.
 *
 * Colour values are taken from Capgemini's live "Zodiak" design system
 * (capgemini.com, Oct 2026): the Capgemini blue scale, neutrals, and the
 * green / orange / red / peacock scales. Navy (#1D365A) is Zodiak's primary
 * action colour; azure (#0058AB) and active blue (#3573C0) mark state.
 * Swap values here, not in components.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}", "!./src/legacy/**"],
  theme: {
    extend: {
      colors: {
        app: "#F4F6F9",                                   // zodiak neutral-100
        surface: { DEFAULT: "#FFFFFF", sunken: "#F8FAFC", hover: "#F1F4F7" },
        line: { DEFAULT: "#E6E9ED", strong: "#C7CCD3" }, // neutral-250 / -350
        fg: { DEFAULT: "#171A22", 2: "#474C56", 3: "#636977" },
        // Capgemini blue. 500 is the navy used for primary actions and links.
        primary: {
          50: "#EFF0F4", 100: "#DFE1EB", 200: "#8EA6D5", 300: "#5685C6", 400: "#3573C0",
          500: "#1D365A", 600: "#121A38", 700: "#070A16",
        },
        azure: { DEFAULT: "#0058AB", 400: "#3573C0", 300: "#5685C6", 50: "#EAF1FA" },
        ink: { DEFAULT: "#121A38", 800: "#1D365A", 700: "#1C4076", 950: "#070A16" },
        // AI accents: Capgemini peacock / teal. 500 holds 6.6:1 with white text.
        ai: { 50: "#E8F6F4", 100: "#C9EFE9", 300: "#72E7D6", 400: "#00AE9D", 500: "#29656F", 600: "#1F4F57" },
        good: { DEFAULT: "#1E5631", bg: "#E7F6EB" },     // green-800 on green-100
        warn: { DEFAULT: "#8A5A00", bg: "#FFF4DE" },
        serious: { DEFAULT: "#743C0B", bg: "#FDEBE0" },  // orange-900
        bad: { DEFAULT: "#9E0029", bg: "#FBF2F3" },      // red-800 on red-50
        info: { DEFAULT: "#0058AB", bg: "#EAF1FA" },
        mute: { DEFAULT: "#474C56", bg: "#EEF1F5" },
        // Legacy dark-theme tokens (src/legacy), kept so those files still build if restored.
        brand: { 400: "#818cf8", 500: "#6366f1", 600: "#4f46e5" },
      },
      fontFamily: {
        // Ubuntu is Capgemini's typeface. Figures use Inter for tabular alignment (see .num).
        sans: ["Ubuntu", "ui-sans-serif", "system-ui", "sans-serif"],
        figures: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: { "2xs": ["0.6875rem", { lineHeight: "1rem" }] },
      // Ubuntu has no 600 weight; without this, "semibold" renders as bold.
      fontWeight: { semibold: "500" },
      borderRadius: { xl: "10px" },
      boxShadow: {
        card: "0 1px 2px rgba(18, 26, 56, 0.05)",
        pop: "0 18px 44px -14px rgba(18, 26, 56, 0.30)",
        ring: "0 0 0 3px rgba(0, 88, 171, 0.22)",
      },
    },
  },
  plugins: [],
};
