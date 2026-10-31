import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Values live in index.css (one set per theme, see theme.ts).
        virtua: {
          bg: "rgb(var(--v-bg) / <alpha-value>)",
          sidebar: "rgb(var(--v-sidebar) / <alpha-value>)",
          panel: "rgb(var(--v-panel) / <alpha-value>)",
          panelHover: "rgb(var(--v-panel-hover) / <alpha-value>)",
          border: "rgb(var(--v-border) / <alpha-value>)",
          text: "rgb(var(--v-text) / <alpha-value>)",
          muted: "rgb(var(--v-muted) / <alpha-value>)",
          accent: "rgb(var(--v-accent) / <alpha-value>)",
          accentSoft: "rgb(var(--v-accent-soft) / <alpha-value>)",
          onAccent: "rgb(var(--v-on-accent) / <alpha-value>)",
          green: "rgb(var(--v-green) / <alpha-value>)",
          yellow: "rgb(var(--v-yellow) / <alpha-value>)",
          red: "rgb(var(--v-red) / <alpha-value>)",
          cyan: "rgb(var(--v-cyan) / <alpha-value>)",
          shade: "rgb(var(--v-shade) / <alpha-value>)",
          inset: "rgb(var(--v-inset) / <alpha-value>)",
        },
      },
      boxShadow: {
        panel: "var(--v-shadow)",
      },
      fontFamily: {
        sans: ["var(--v-font)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
