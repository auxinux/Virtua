import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  // The first test of a run pays Vite's cold compile (over 30 s on a laptop).
  timeout: 90_000,
  use: { locale: "fr-CA", baseURL: "http://127.0.0.1:1420", viewport: { width: 1440, height: 1000 } },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:1420", reuseExistingServer: false },
});
