import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify("test") },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { name: "vdm-ui", environment: "jsdom", globals: true, css: false, include: ["src/**/*.test.{ts,tsx}"] },
});
