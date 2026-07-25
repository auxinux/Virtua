import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          950: "rgb(var(--surface-950) / <alpha-value>)",
          900: "rgb(var(--surface-900) / <alpha-value>)",
          800: "rgb(var(--surface-800) / <alpha-value>)",
          700: "rgb(var(--surface-700) / <alpha-value>)",
          600: "rgb(var(--surface-600) / <alpha-value>)",
          500: "rgb(var(--surface-500) / <alpha-value>)",
          400: "rgb(var(--surface-400) / <alpha-value>)",
        },
        text: {
          100: "rgb(var(--text-100) / <alpha-value>)",
          200: "rgb(var(--text-200) / <alpha-value>)",
          300: "rgb(var(--text-300) / <alpha-value>)",
          400: "rgb(var(--text-400) / <alpha-value>)",
          500: "rgb(var(--text-500) / <alpha-value>)",
        },
        accent: {
          blue: "#2384e8",
          "blue-hover": "#1c76d0",
          "blue-light": "#3a94ec",
        },
        state: {
          running: "#40c057",
          stopped: "#fa5252",
          paused: "#fab005",
          frozen: "#74c0fc",
          degraded: "#ff6b6b",
          rebuilding: "#ffd43b",
        },
      },
      fontFamily: {
        sans: ["Space Grotesk", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      fontSize: {
        "2xs": "0.6875rem",
        xs: "0.8125rem",
        sm: "0.875rem",
      },
      animation: {
        "spin-slow": "spin 3s linear infinite",
        pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "fade-in": "fadeIn 0.2s ease-in-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
