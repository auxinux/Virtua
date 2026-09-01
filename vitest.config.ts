import { defineConfig } from "vitest/config";

/**
 * Root test configuration so `npx vitest run <paths>` works from the repo root
 * across every workspace. The VDM UI needs jsdom + the React plugin + the `@`
 * alias, so it is referenced through its own config rather than duplicated
 * here; the Node-side packages run bare. Without this, root-level runs picked
 * up no config at all and the UI suites failed on unresolved `@/…` imports.
 */
export default defineConfig({
  test: {
    projects: [
      "apps/vdm-ui",
      {
        test: {
          name: "node",
          environment: "node",
          include: ["apps/api/src/**/*.test.ts", "apps/vdm/src/**/*.test.ts", "apps/runner/src/**/*.test.ts", "packages/shared/src/**/*.test.ts"],
        },
      },
    ],
  },
});
