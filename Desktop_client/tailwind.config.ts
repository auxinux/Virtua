import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        virtua: {
          bg: "#0b0f14",
          panel: "#141a22",
          panelHover: "#1b232e",
          border: "#2d3744",
          text: "#edf2f7",
          muted: "#96a3b3",
          accent: "#2384e8",
          accentSoft: "#14365b",
          green: "#37b26c",
          yellow: "#d49b24",
          red: "#ed5f5f",
          cyan: "#29b6c7",
        },
      },
      boxShadow: {
        panel: "0 12px 30px rgba(0, 0, 0, 0.22)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
