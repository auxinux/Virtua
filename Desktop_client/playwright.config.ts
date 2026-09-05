import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: { locale: "fr-CA", baseURL: "http://127.0.0.1:1420", viewport: { width: 1440, height: 1000 } },
  webServer: { command: "npm run dev", url: "http://127.0.0.1:1420", reuseExistingServer: false },
});
