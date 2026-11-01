// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  OPENAI_MAX_ATTEMPTS,
  routeTranslationStage,
  type EngineStage,
} from "./engine-router";
import type {
  ProviderStageResponse,
  TranslationStageRequest,
} from "./translation-api";

const request: TranslationStageRequest = {
  targetLanguage: "en",
  sources: [["こんにちは", "請求管理"]],
  sourceRoutes: [["ja", "ja"]],
};

function response(
  values: string[],
  extra: Partial<ProviderStageResponse> = {},
): ProviderStageResponse {
  return {
    results: [values],
    failures: [],
    diagnostics: {
      records: values.length,
      sourceCharacters: 0,
      requestCount: 1,
      requestMs: 0,
    },
    ...extra,
  };
}

describe("routeTranslationStage without a Google fallback (ADR 0020)", () => {
  it("retries quality misses on OpenAI only and leaves the rest unresolved", async () => {
    const openAi = vi.fn<EngineStage>(async (stage) =>
      response(stage.sources[0]!.map(() => "")),
    );
    openAi.mockResolvedValueOnce(response(["Hello", ""]));
    const result = await routeTranslationStage(
      request,
      { openAi, now: () => 0, sleep: async () => undefined },
      new AbortController().signal,
      60_000,
    );
    expect(openAi).toHaveBeenCalledTimes(OPENAI_MAX_ATTEMPTS);
    expect(result.results).toEqual([["Hello", ""]]);
    expect(result.provenance).toEqual([["openai", null]]);
    expect(result.diagnostics.googleRequestCount).toBe(0);
  });

  it("gives OpenAI the whole deadline when no Google reserve is needed", async () => {
    let clock = 0;
    const openAi = vi.fn<EngineStage>(async () => {
      clock = 55_000;
      return response(["", ""]);
    });
    await routeTranslationStage(
      request,
      { openAi, now: () => clock, sleep: async () => undefined },
      new AbortController().signal,
      60_000,
    );
    // With a 10s Google reserve the cutoff would be 50s and stop at one attempt.
    expect(openAi).toHaveBeenCalledTimes(OPENAI_MAX_ATTEMPTS);
  });

  it("does not retry a non-retryable failure such as a rejected key", async () => {
    const openAi = vi.fn<EngineStage>(async () =>
      response(["", ""], {
        failures: [
          {
            index: 0,
            scope: "run",
            message: "Translation provider failed (401)",
            retryable: false,
            status: 401,
          },
        ],
      }),
    );
    const result = await routeTranslationStage(
      request,
      { openAi, now: () => 0, sleep: async () => undefined },
      new AbortController().signal,
      60_000,
    );
    expect(openAi).toHaveBeenCalledTimes(1);
    expect(result.results).toEqual([["", ""]]);
  });
});
