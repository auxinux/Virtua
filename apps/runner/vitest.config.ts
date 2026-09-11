import { defineConfig } from "vitest/config";

// Local config so this workspace does not inherit the repo-root one (whose
// project paths are resolved relative to the root).
export default defineConfig({
  test: { name: "runner", environment: "node", include: ["src/**/*.test.ts"] },
});
