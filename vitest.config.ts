import { defineConfig } from "vitest/config";

/**
 * vitest.config.ts — one runner for every workspace.
 *
 * Tests import engine/mcp-server SOURCE (../src/...), not dist, so they run
 * without a build and fail on the code you just edited, not the code you built
 * ten minutes ago. Vite resolves the `.js`-suffixed imports in TS sources to
 * their `.ts` files automatically.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
