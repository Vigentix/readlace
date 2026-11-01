import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  resolve: {
    alias: {
      "#shared": fileURLToPath(new URL("./shared", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    mockReset: true,
    restoreMocks: true,
    // Bound worker CPU/memory contention for HTTP and crypto integration tests.
    maxWorkers: 4,
    exclude: [
      ...configDefaults.exclude,
      ".output/**",
      ".wxt/**",
      ".scratch/**",
      "e2e/**",
      "tests/e2e/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
    ],
  },
});
