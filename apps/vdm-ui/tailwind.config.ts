import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        vdm: {
          bg: "#0d1117",
          surface: "#161b22",
          surfaceHover: "#1c2128",
          border: "#30363d",
          borderHover: "#484f58",
          text: "#e6edf3",
          textMuted: "#8b949e",
          accent: "#1f6feb",
          accentHover: "#388bfd",
          success: "#3fb950",
          warning: "#d29922",
          danger: "#f85149",
          online: "#3fb950",
          offline: "#f85149",
          unknown: "#8b949e",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
