import { defineConfig } from "@playwright/test";

export const TIMING_SENSITIVE = /@provider-latency|@openai-performance/;

export function createPlaywrightConfig(env: NodeJS.ProcessEnv) {
  const liveOpenAIBenchmark = env.RUN_LIVE_OPENAI_BENCHMARK === "1";

  return defineConfig({
    testDir: ".",
    testMatch: ["e2e/**/*.spec.ts", "tests/e2e/**/*.spec.ts"],
    globalSetup: "./e2e/global-setup.ts",
    fullyParallel: true,
    forbidOnly: !!env.CI,
    retries: liveOpenAIBenchmark ? 0 : env.CI ? 2 : 0,
    workers: env.CI ? 1 : undefined,
    reporter: "html",
    use: {
      trace: liveOpenAIBenchmark ? "off" : "on-first-retry",
    },
    // Timing-sensitive specs (latency and throughput budgets) live in their own
    // project. `pnpm test:e2e` runs it as a second phase with one worker, after
    // the main project, so CPU contention from parallel extension windows cannot
    // skew their measurements. Their assertions are unchanged. (No project
    // `dependencies`: that would re-run the whole main project whenever a file
    // filter selects a timing spec.)
    projects: [
      { name: "chromium", grepInvert: TIMING_SENSITIVE },
      {
        name: "chromium-timing",
        grep: TIMING_SENSITIVE,
        fullyParallel: false,
      },
    ],
  });
}

export default createPlaywrightConfig(process.env);
