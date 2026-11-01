import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { verifyDeterministicBuild } from "./e2e/global-setup";
import { createPlaywrightConfig, TIMING_SENSITIVE } from "./playwright.config";
import wxtConfig from "./wxt.config";

describe("Playwright configuration", () => {
  test("isolates timing-sensitive specs in their own serial project", () => {
    const projects = createPlaywrightConfig({}).projects ?? [];
    const main = projects.find((project) => project.name === "chromium");
    const timing = projects.find(
      (project) => project.name === "chromium-timing",
    );

    expect(main?.grepInvert).toBe(TIMING_SENSITIVE);
    expect(timing?.grep).toBe(TIMING_SENSITIVE);
    expect(timing?.fullyParallel).toBe(false);
    expect(timing?.dependencies).toBeUndefined();
    expect(
      TIMING_SENSITIVE.test("@record-cache-performance @provider-latency x"),
    ).toBe(true);
    expect(TIMING_SENSITIVE.test("@openai-performance y")).toBe(true);
    expect(TIMING_SENSITIVE.test("@deterministic z")).toBe(false);
  });

  test("disables paid retries and traces for the live OpenAI benchmark under CI", () => {
    const live = createPlaywrightConfig({
      CI: "1",
      RUN_LIVE_OPENAI_BENCHMARK: "1",
    });
    const normal = createPlaywrightConfig({ CI: "1" });

    expect(live.retries).toBe(0);
    expect(live.use?.trace).toBe("off");
    expect(normal.retries).toBe(2);
    expect(normal.use?.trace).toBe("on-first-retry");
  });

  test.each(["chrome", "firefox"])(
    "disallows incognito in the %s manifest",
    async (browser) => {
      const createManifest = wxtConfig.manifest;
      expect(createManifest).toBeTypeOf("function");
      if (typeof createManifest !== "function") return;

      const manifest = await createManifest({
        browser,
        command: "build",
        manifestVersion: 3,
        mode: "production",
      });

      expect(manifest.incognito).toBe("not_allowed");
    },
  );

  test("fails fast unless the e2e build includes the Workspace Reader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "readlace-e2e-build-"));
    const build = (sidePanel: boolean) =>
      writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify(
          sidePanel ? { side_panel: { default_path: "/reader.html" } } : {},
        ),
      );
    try {
      await build(false);
      await expect(verifyDeterministicBuild(dir, {})).rejects.toThrow(
        "the Workspace Reader is not configured",
      );
      await expect(
        verifyDeterministicBuild(dir, { RUN_LIVE_PROVIDER_FALLBACK: "1" }),
      ).resolves.toBeUndefined();
      await build(true);
      await expect(verifyDeterministicBuild(dir, {})).resolves.toBeUndefined();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("runs the deterministic build check before any spec", () => {
    expect(createPlaywrightConfig({}).globalSetup).toBe(
      "./e2e/global-setup.ts",
    );
  });
});
