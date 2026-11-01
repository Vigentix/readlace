import { describe, expect, it } from "vitest";
import {
  buildDiagnosticsReport,
  type DiagnosticsInput,
} from "./diagnostics-report";
import type { TranslationRunSummary } from "@/lib/translate/translation-diagnostics";

const KEY = ["sk", "proj", "diagnostics0123456789abcdefgh"].join("-");

const run = {
  provider: "openai",
  records: 12,
  sourceCharacters: 340,
  requestCount: 2,
  queueMs: 1,
  requestMs: 900,
  firstCommitMs: 400,
  completeMs: 1200,
  rejectedCount: 1,
  discoveredRecords: 20,
  eligibleRecords: 15,
  attemptedRecords: 12,
  deterministicRecords: 0,
  localCacheHits: 3,
  localCacheMisses: 9,
  localCacheInvalid: 0,
  chainCacheHits: 0,
  providerAccepted: 11,
  providerRejected: 1,
  googleFallbackAttempted: 0,
  googleFallbackAccepted: 0,
  nativeAttempted: 1,
  nativeAccepted: 1,
  storageReadCalls: 1,
  storageWriteCalls: 1,
  storageReadMs: 2,
  storageWriteMs: 3,
  maxViewportDispatchMs: 5,
  maxViewportCommitMs: 6,
  rejectionReasons: { empty: 1 },
  inputTokens: 100,
  outputTokens: 40,
} satisfies TranslationRunSummary;

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    extensionVersion: "0.1.0",
    userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
    uiLocale: "vi",
    engine: {
      source: "byok-openai",
      provider: "openai",
      model: "gpt-5-mini",
      keyConfigured: true,
      keyRejected: false,
    },
    onDeviceTranslation: "supported",
    sheetsReader: false,
    workspaceReader: true,
    runs: [run],
    now: new Date("2026-11-01T10:00:00.000Z"),
    ...overrides,
  };
}

describe("buildDiagnosticsReport", () => {
  it("reports the environment, engine and recent run counts", () => {
    expect(buildDiagnosticsReport(input())).toEqual({
      readlaceDiagnostics: 1,
      generatedAt: "2026-11-01T10:00:00.000Z",
      extensionVersion: "0.1.0",
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      uiLocale: "vi",
      engine: {
        source: "byok-openai",
        provider: "openai",
        model: "gpt-5-mini",
        keyConfigured: true,
        keyRejected: false,
      },
      onDeviceTranslation: "supported",
      sheetsReader: false,
      workspaceReader: true,
      recentRuns: [
        expect.objectContaining({
          provider: "openai",
          records: 12,
          sourceCharacters: 340,
          rejectionReasons: { empty: 1 },
          inputTokens: 100,
        }),
      ],
    });
  });

  it("copies only known fields, so a key or page text can never slip in", () => {
    const leaky = {
      ...input(),
      apiKey: KEY,
      engine: { ...input().engine, apiKey: KEY, maskedKey: "sk-…efgh" },
      runs: [
        { ...run, url: "https://intranet.example/secret", text: "Bí mật" },
      ],
    } as unknown as DiagnosticsInput;
    const text = JSON.stringify(buildDiagnosticsReport(leaky));
    for (const forbidden of [KEY, "sk-…efgh", "intranet", "Bí mật"])
      expect(text).not.toContain(forbidden);
  });

  it("keeps at most the last 20 runs", () => {
    const runs = Array.from({ length: 30 }, (_, index) => ({
      ...run,
      records: index,
    }));
    const report = buildDiagnosticsReport(input({ runs }));
    expect(report.recentRuns).toHaveLength(20);
    expect(report.recentRuns[0]!.records).toBe(10);
  });
});
