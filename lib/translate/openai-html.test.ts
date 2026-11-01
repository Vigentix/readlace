import { AuthRequiredError, AuthUnavailableError } from "@/lib/run-errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_PREFIX,
  PREF_PREFIX,
  TRANSLATION_CONCURRENCY,
} from "@/lib/translation";
import {
  createOpenAIHtmlTranslator,
  savedOpenAiFallbackKey,
  savedOpenAiTranslationKey,
  type OpenAIRecordSourceMap,
  type OpenAIRequestUsage,
  type OpenAITranslationMap,
} from "./openai-html";
import { createOpenAiCompleter } from "@/shared/openai-completer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const getManyCalls: string[][] = [];
  const setManyCalls: Record<string, string>[] = [];
  return {
    data,
    getManyCalls,
    setManyCalls,
    async get(key: string) {
      return data.get(key);
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async getMany(keys: string[]) {
      getManyCalls.push([...keys]);
      return Object.fromEntries(
        keys.flatMap((key) => {
          const value = data.get(key);
          return value === undefined ? [] : [[key, value]];
        }),
      );
    },
    async setMany(entries: Record<string, string>) {
      setManyCalls.push({ ...entries });
      Object.entries(entries).forEach(([key, value]) => data.set(key, value));
    },
    async getAll() {
      return Object.fromEntries(data);
    },
    async remove(keys: string[]) {
      keys.forEach((key) => data.delete(key));
    },
  };
}

function translated(
  sources: OpenAITranslationMap,
  value: (source: string, id: string) => string = (source) =>
    `translated:${source}`,
) {
  return Object.fromEntries(
    Object.entries(sources).map(([id, source]) => [id, value(source, id)]),
  );
}

function translator(
  completeHtml: (
    sources: OpenAITranslationMap,
    sourceLanguages: OpenAIRecordSourceMap,
  ) => Promise<OpenAITranslationMap>,
  storage = memoryStorage(),
  getApiKey: () => Promise<string> = async () => "sk-test",
) {
  return createOpenAIHtmlTranslator({
    completeHtml: async (sources, sourceLanguages) =>
      completeHtml(sources, sourceLanguages),
    storage,
    getApiKey,
  });
}

describe("OpenAI compact-map translator", () => {
  it("caches backend Google-fallback records in the chain namespace and reports their provenance", async () => {
    const storage = memoryStorage();
    const html = createOpenAIHtmlTranslator({
      completeHtml: async (sources, _routes, _target, _usage, onProvenance) => {
        onProvenance?.(
          Object.fromEntries(
            Object.entries(sources).map(([id, source]) => [
              id,
              source === "請求管理" ? "google" : "openai",
            ]),
          ),
        );
        return translated(sources, (source) =>
          source === "請求管理" ? "Quản lý hóa đơn" : "Xin chào",
        );
      },
      storage,
      getApiKey: async () => "backend",
    });
    const deferred = await html.translateHtml(
      [["こんにちは"], ["請求管理"]],
      "vi",
      { deferCache: true },
    );
    expect(deferred.results).toEqual([["Xin chào"], ["Quản lý hóa đơn"]]);
    expect(deferred.provenance).toEqual([[undefined], ["google"]]);
    expect(storage.setManyCalls).toEqual([]);

    const direct = await html.translateText(["請求管理"], "en");
    expect(direct.provenance).toEqual(["google"]);
    expect(
      storage.data.get(await savedOpenAiFallbackKey("en", "請求管理", "ja")),
    ).toBe(JSON.stringify({ t: "Quản lý hóa đơn", p: "google" }));
    expect(
      storage.data.has(await savedOpenAiTranslationKey("en", "請求管理", "ja")),
    ).toBe(false);
  });

  it("defers page primary persistence until retained acceptance, preserving the primary namespace and warm reuse", async () => {
    const storage = memoryStorage();
    const provider = vi.fn(async () => ({
      r0: "Xin chào",
      r1: "Không áp dụng",
    }));
    const html = translator(provider, storage);
    const sources = [["こんにちは"], ["Hidden primary source"]];
    const result = await html.translateHtml(sources, "vi", {
      deferCache: true,
      sourceLanguageHint: "en",
    });
    expect(result.results).toEqual([["Xin chào"], ["Không áp dụng"]]);
    expect(result.cacheableResults).toEqual(result.results);
    expect(result.diagnostics.storageWriteCalls).toBe(0);
    expect(storage.setManyCalls).toEqual([]);
    const metrics = { storageWriteCalls: 0, storageWriteMs: 0 };
    expect(
      await html.cacheAcceptedHtml(
        [sources[0]!],
        [result.results[0]!],
        "vi",
        { sourceLanguageHint: "en" },
        metrics,
      ),
    ).toBe(1);
    expect(metrics.storageWriteCalls).toBe(1);
    expect(
      storage.data.get(
        await savedOpenAiTranslationKey("vi", "こんにちは", "ja"),
      ),
    ).toBe(JSON.stringify({ t: "Xin chào" }));
    expect(
      storage.data.has(
        await savedOpenAiTranslationKey("vi", "Hidden primary source", "en"),
      ),
    ).toBe(false);
    const warm = await html.translateHtml([sources[0]!], "vi", {
      deferCache: true,
      sourceLanguageHint: "en",
    });
    expect(warm.results).toEqual([["Xin chào"]]);
    expect(warm.cacheableResults).toEqual([[""]]);
    expect(warm.diagnostics.localCacheHits).toBe(1);
    expect(provider).toHaveBeenCalledOnce();
    expect(await html.cacheAcceptedHtml([["Hello"]], [[]], "vi")).toBe(0);
  });

  it("never flags primary/chain cache hits or deterministic slots as cacheable OpenAI primaries", async () => {
    const storage = memoryStorage({
      [await savedOpenAiTranslationKey("vi", "こんにちは", "ja")]:
        JSON.stringify({ t: "Xin chào" }),
      [await savedOpenAiFallbackKey("vi", "世界", "ja")]: JSON.stringify({
        t: "Thế giới",
        p: "google",
      }),
    });
    const provider = vi.fn(async () => ({}));
    const result = await translator(provider, storage).translateHtml(
      [["こんにちは", "世界", "123"]],
      "vi",
      { deferCache: true },
    );
    expect(result.results).toEqual([["Xin chào", "Thế giới", "123"]]);
    expect(result.cacheableResults).toEqual([["", "", ""]]);
    expect(result.diagnostics.chainCacheHits).toBe(1);
    expect(provider).not.toHaveBeenCalled();
    expect(storage.setManyCalls).toEqual([]);
  });

  it("serves only saved translations on the on-device path and leaves misses unresolved for native", async () => {
    const storage = memoryStorage({
      [await savedOpenAiTranslationKey("vi", "こんにちは", "ja")]:
        JSON.stringify({ t: "Xin chào" }),
      [await savedOpenAiFallbackKey("vi", "世界", "ja")]: JSON.stringify({
        t: "Thế giới",
        p: "browser-native",
      }),
    });
    const provider = vi.fn(async () => ({}));
    const result = await translator(provider, storage).translateHtml(
      [["こんにちは", "世界"], ["未翻訳"]],
      "vi",
      { deferCache: true, cacheOnly: true },
    );
    expect(provider).not.toHaveBeenCalled();
    expect(result.results).toEqual([["Xin chào", "Thế giới"], []]);
    expect(result.failures).toEqual([
      {
        index: 1,
        scope: "record",
        message: "Not sent to the backend: on-device path",
        retryable: false,
      },
    ]);
    expect(result.diagnostics).toMatchObject({
      records: 0,
      sourceCharacters: 0,
      requestCount: 0,
      localCacheHits: 2,
      chainCacheHits: 1,
      localCacheMisses: 1,
    });
    expect(storage.setManyCalls).toEqual([]);
  });

  it("does not persist an accepted primary acknowledgement retired during hashing", async () => {
    const storage = memoryStorage();
    const html = translator(async () => ({}), storage);
    const commit = html.cacheAcceptedHtml(
      [["こんにちは"]],
      [["Xin chào"]],
      "vi",
    );
    html.invalidatePendingWork();
    expect(await commit).toBe(0);
    expect(storage.setManyCalls).toEqual([]);
  });

  it("uses one strict primary map and maps every returned node", async () => {
    const calls: {
      sources: OpenAITranslationMap;
      sourceLanguages: OpenAIRecordSourceMap;
    }[] = [];
    const openai = translator(async (sources, sourceLanguages) => {
      calls.push({ sources, sourceLanguages });
      return { r0: "Xin ", r1: "chào" };
    });
    const result = await openai.translateHtml([["Hello ", "world"]], "vi", {
      sourceLanguageHint: "en",
    });

    expect(calls).toEqual([
      {
        sources: { r0: "Hello ", r1: "world" },
        sourceLanguages: { r0: "en", r1: "en" },
      },
    ]);
    expect(JSON.stringify(calls[0]?.sources)).toBe(
      '{"r0":"Hello ","r1":"world"}',
    );
    expect(result).toMatchObject({
      results: [["Xin ", "chào"]],
      failures: [],
    });
  });

  it("uses accepted record cache v10 and ignores v9 arrays and unrelated data", async () => {
    const currentKey = await savedOpenAiTranslationKey("vi", "Hello");
    const v9Key = currentKey
      .replace(":v10:record:", ":v9:")
      .replace(/:[^:]+$/, ":legacy");
    const googleKey = `${CACHE_PREFIX}google:auto:vi:keep`;
    const preferenceKey = `${PREF_PREFIX}example.com`;
    const storage = memoryStorage({
      [v9Key]: JSON.stringify([{ t: "Hello" }]),
      [googleKey]: "google",
      [preferenceKey]: "enabled",
    });
    let calls = 0;
    const openai = translator(async (sources) => {
      calls += 1;
      return translated(sources, () => "Xin chào");
    }, storage);

    await openai.translateHtml([["Hello"]], "vi");
    await openai.translateHtml([["Hello"]], "vi");

    expect(calls).toBe(1);
    expect(currentKey).toContain(":v10:record:gpt-5-nano:auto:vi:");
    expect(storage.data.get(v9Key)).toBeDefined();
    expect(storage.data.get(googleKey)).toBe("google");
    expect(storage.data.get(preferenceKey)).toBe("enabled");
    expect(storage.data.get(currentKey)).toContain("Xin chào");
  });

  it("uses the exact independent chain key and prefers OpenAI v10", async () => {
    const openAiKey = await savedOpenAiTranslationKey("en", "請求", "ja");
    const chainKey = await savedOpenAiFallbackKey("en", "請求", "ja");
    const storage = memoryStorage({
      [openAiKey]: JSON.stringify({ t: "OpenAI invoice" }),
      [chainKey]: JSON.stringify({ t: "Google invoice", p: "google" }),
    });
    let calls = 0;
    const openai = translator(async () => {
      calls += 1;
      return {};
    }, storage);

    const result = await openai.translateHtml([["請求"]], "en");

    expect(chainKey).toMatch(
      /^translationCache:chain:v1:openai-google-native:ja:en:[\da-f]{40}$/,
    );
    expect(chainKey).not.toBe(openAiKey);
    expect(storage.getManyCalls).toEqual([[openAiKey, chainKey]]);
    expect(result).toMatchObject({
      results: [["OpenAI invoice"]],
      failures: [],
      diagnostics: {
        records: 0,
        requestCount: 0,
        localCacheHits: 1,
        chainCacheHits: 0,
      },
    });
    expect(calls).toBe(0);
  });

  it.each(["google", "browser-native"] as const)(
    "reuses a validated %s chain entry without provider budget",
    async (provenance) => {
      const chainKey = await savedOpenAiFallbackKey("en", "請求", "ja");
      const storage = memoryStorage({
        [chainKey]: JSON.stringify({ t: "Invoice", p: provenance }),
      });
      let calls = 0;
      const openai = translator(async () => {
        calls += 1;
        return {};
      }, storage);

      const result = await openai.translateHtml([["請求"]], "en");

      expect(result).toMatchObject({
        results: [["Invoice"]],
        failures: [],
        diagnostics: {
          records: 0,
          sourceCharacters: 0,
          requestCount: 0,
          localCacheHits: 1,
          localCacheMisses: 0,
          chainCacheHits: 1,
        },
      });
      expect(calls).toBe(0);
    },
  );

  it.each([
    ["invalid provenance", { t: "Invoice", p: "openai" }],
    ["source-identical text", { t: "請求", p: "google" }],
  ])("rejects %s chain entries locally", async (_name, entry) => {
    const chainKey = await savedOpenAiFallbackKey("en", "請求", "ja");
    const storage = memoryStorage({ [chainKey]: JSON.stringify(entry) });
    let calls = 0;
    const openai = translator(async () => {
      calls += 1;
      return { r0: "Invoice" };
    }, storage);

    const result = await openai.translateHtml([["請求"]], "en");

    expect(result.results).toEqual([["Invoice"]]);
    expect(result.diagnostics).toMatchObject({
      localCacheHits: 0,
      localCacheMisses: 1,
      localCacheInvalid: 1,
      chainCacheHits: 0,
      requestCount: 1,
    });
    expect(calls).toBe(1);
  });

  it("caches only locally accepted fallback matrices with provenance", async () => {
    const storage = memoryStorage();
    let calls = 0;
    const openai = translator(async () => {
      calls += 1;
      return {};
    }, storage);
    const acceptedKey = await savedOpenAiFallbackKey("en", "請求", "ja");
    const rejectedKey = await savedOpenAiFallbackKey("en", "領収書", "ja");

    await expect(
      openai.cacheFallbackTranslations(
        [["請求", "領収書"]],
        [["Invoice", "領収書"]],
        "en",
        { sourceLanguageHint: "ja" },
        "google",
      ),
    ).resolves.toBe(1);

    expect(storage.data.get(acceptedKey)).toBe(
      JSON.stringify({ t: "Invoice", p: "google" }),
    );
    expect(storage.data.has(rejectedKey)).toBe(false);
    await expect(
      openai.translateHtml([["請求"]], "en", { sourceLanguageHint: "ja" }),
    ).resolves.toMatchObject({
      results: [["Invoice"]],
      diagnostics: { chainCacheHits: 1, requestCount: 0 },
    });
    expect(calls).toBe(0);
  });

  it("fails closed on malformed fallback writes and storage failure", async () => {
    const storage = memoryStorage();
    const openai = translator(async () => ({}), storage);

    await expect(
      openai.cacheFallbackTranslations(
        [["請求"]],
        [[]],
        "en",
        { sourceLanguageHint: "ja" },
        "browser-native",
      ),
    ).resolves.toBe(0);
    expect(storage.setManyCalls).toEqual([]);

    storage.setMany = async () => {
      throw new Error("quota");
    };
    await expect(
      openai.cacheFallbackTranslations(
        [["請求"]],
        [["Invoice"]],
        "en",
        { sourceLanguageHint: "ja" },
        "browser-native",
      ),
    ).resolves.toBe(0);
  });

  it("isolates cache and warm reruns by normalized source hint", async () => {
    const storage = memoryStorage();
    const routes: string[] = [];
    const openai = translator(async (sources, sourceLanguages) => {
      routes.push(...Object.values(sourceLanguages));
      return translated(
        sources,
        () => `請求書-${Object.values(sourceLanguages)[0]}`,
      );
    }, storage);

    const en = await openai.translateHtml([["Invoice"]], "ja", {
      sourceLanguageHint: "en",
    });
    const vi = await openai.translateHtml([["Invoice"]], "ja", {
      sourceLanguageHint: "vi",
    });
    const enWarm = await openai.translateHtml([["Invoice"]], "ja", {
      sourceLanguageHint: "en",
    });

    expect(routes).toEqual(["en", "vi"]);
    expect(en.results).toEqual([["請求書-en"]]);
    expect(vi.results).toEqual([["請求書-vi"]]);
    expect(enWarm.results).toEqual(en.results);
    expect(enWarm.failures).toEqual(en.failures);
    expect(enWarm.diagnostics.requestCount).toBe(0);
    const keys = [...storage.data.keys()].filter((key) =>
      key.startsWith(`${CACHE_PREFIX}openai:v10:record:`),
    );
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.includes(":en:ja:"))).toBe(true);
    expect(keys.some((key) => key.includes(":vi:ja:"))).toBe(true);
  });

  it("does not deduplicate overlapping work with different record routes", async () => {
    const routes: string[] = [];
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothStarted = () => undefined as void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const openai = translator(async (sources, sourceLanguages) => {
      routes.push(...Object.values(sourceLanguages));
      if (routes.length === 2) bothStarted();
      await gate;
      return translated(sources, () => "請求書");
    });

    const en = openai.translateHtml([["Invoice"]], "ja", {
      sourceLanguageHint: "en",
    });
    const vi = openai.translateHtml([["Invoice"]], "ja", {
      sourceLanguageHint: "vi",
    });
    await started;
    release();
    await Promise.all([en, vi]);

    expect(routes.sort()).toEqual(["en", "vi"]);
  });

  it("normalizes an absent source hint to auto", async () => {
    const explicit = await savedOpenAiTranslationKey("vi", "Hello");
    const undefinedHint = await savedOpenAiTranslationKey(
      "vi",
      "Hello",
      undefined,
    );

    expect(explicit).toBe(undefinedHint);
    expect(explicit).toContain(":gpt-5-nano:auto:vi:");
  });

  it.each([
    ["structural", { r0: "Hello translated" }],
    ["quality", { r0: "Hello translated", r1: "請求" }],
  ])(
    "retains accepted siblings and fails %s slots after one pass",
    async (_kind, output) => {
      const calls: OpenAITranslationMap[] = [];
      const openai = translator(async (sources) => {
        calls.push(sources);
        return output;
      });

      const result = await openai.translateHtml([["Hello"], ["請求"]], "en");

      expect(calls).toEqual([{ r0: "Hello", r1: "請求" }]);
      expect(result).toMatchObject({
        results: [["Hello translated"], []],
        failures: [
          {
            index: 1,
            scope: "record",
            message: "Invalid provider response: unresolved translation",
            retryable: false,
          },
        ],
      });
    },
  );

  it("bulk-caches accepted siblings and fans duplicate records to every owner", async () => {
    const storage = memoryStorage();
    const calls: OpenAITranslationMap[] = [];
    const routes: OpenAIRecordSourceMap[] = [];
    const openai = translator(async (sources, sourceLanguages) => {
      calls.push(sources);
      routes.push(sourceLanguages);
      return { r0: "Hello translated", r1: "請求" };
    }, storage);

    const cold = await openai.translateHtml(
      [["Hello", "Hello"], ["請求"]],
      "en",
    );
    const warm = await openai.translateHtml([["Hello"], ["Hello"]], "en");

    expect(calls).toEqual([{ r0: "Hello", r1: "請求" }]);
    expect(routes).toEqual([{ r0: "auto", r1: "ja" }]);
    expect(cold.results).toEqual([
      ["Hello translated", "Hello translated"],
      [],
    ]);
    expect(cold.failures).toHaveLength(1);
    expect(cold.diagnostics).toMatchObject({
      records: 2,
      localCacheHits: 0,
      localCacheMisses: 2,
      providerAccepted: 1,
      providerRejected: 1,
      storageReadCalls: 1,
      storageWriteCalls: 1,
    });
    expect(warm).toMatchObject({
      results: [["Hello translated"], ["Hello translated"]],
      failures: [],
      diagnostics: {
        records: 0,
        sourceCharacters: 0,
        requestCount: 0,
        localCacheHits: 1,
        localCacheMisses: 0,
        storageReadCalls: 1,
        storageWriteCalls: 0,
      },
    });
    expect(storage.getManyCalls).toHaveLength(2);
    expect(storage.getManyCalls[0]).toHaveLength(4);
    expect(storage.getManyCalls[1]).toHaveLength(2);
    expect(storage.setManyCalls).toHaveLength(1);
    expect(Object.keys(storage.setManyCalls[0] ?? {})).toHaveLength(1);
  });

  it("treats bulk storage read and write failures as non-fatal", async () => {
    const storage = memoryStorage();
    storage.getMany = async () => {
      throw new Error("read unavailable");
    };
    storage.setMany = async () => {
      throw new Error("quota");
    };
    let calls = 0;
    const openai = translator(async (sources) => {
      calls += 1;
      return translated(sources, () => "Xin chào");
    }, storage);

    const first = await openai.translateHtml([["Hello"]], "vi");
    const second = await openai.translateHtml([["Hello"]], "vi");

    expect(first).toMatchObject({ results: [["Xin chào"]], failures: [] });
    expect(second).toMatchObject({ results: [["Xin chào"]], failures: [] });
    expect(calls).toBe(2);
    expect(storage.data.size).toBe(0);
  });

  it.each([
    ["missing key", {}],
    ["empty value", { r0: "" }],
    ["unknown key", { r0: "Invoice", unexpected: "Billing" }],
    ["numeric key", { 0: "Invoice" }],
    ["legacy array", [{ id: "r0", t: "Invoice" }]],
  ])("rejects %s after exactly one provider call", async (_name, invalid) => {
    let calls = 0;
    const openai = translator(async () => {
      calls += 1;
      return invalid as unknown as OpenAITranslationMap;
    });

    const result = await openai.translateHtml([["請求"]], "en");

    expect(calls).toBe(1);
    expect(result.results).toEqual([[]]);
    expect(result.failures[0]).toMatchObject({
      index: 0,
      scope: "record",
      retryable: false,
    });
  });

  it("does not cache unresolved copied source output", async () => {
    let calls = 0;
    const openai = translator(async (sources) => {
      calls += 1;
      return sources;
    });

    const first = await openai.translateHtml([["請求"]], "en");
    const second = await openai.translateHtml([["請求"]], "en");

    expect(first.failures).toHaveLength(1);
    expect(second.failures).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it.each([
    ["English to Vietnamese", "Invoice", "vi", "en"],
    ["Vietnamese to English", "Hóa đơn", "en", "vi"],
    ["English to Japanese", "Invoice", "ja", "en"],
  ] as const)(
    "rejects copied %s output after one request",
    async (_label, source, target, sourceLanguageHint) => {
      let calls = 0;
      const storage = memoryStorage();
      const openai = translator(async (sources) => {
        calls += 1;
        return { ...sources };
      }, storage);

      const result = await openai.translateHtml([[source]], target, {
        sourceLanguageHint,
      });

      expect(result.results).toEqual([[]]);
      expect(result.failures).toHaveLength(1);
      expect(calls).toBe(1);
      expect(storage.data.size).toBe(0);
    },
  );

  it("accepts and caches identical output for a trusted same-target source", async () => {
    let calls = 0;
    const openai = translator(async (sources) => {
      calls += 1;
      return { ...sources };
    });

    const first = await openai.translateHtml([["Hóa đơn"]], "vi", {
      sourceLanguageHint: "vi",
    });
    const warm = await openai.translateHtml([["Hóa đơn"]], "vi", {
      sourceLanguageHint: "vi",
    });

    expect(first).toMatchObject({ results: [["Hóa đơn"]], failures: [] });
    expect(warm.results).toEqual(first.results);
    expect(warm.failures).toEqual(first.failures);
    expect(warm.diagnostics.requestCount).toBe(0);
    expect(calls).toBe(1);
  });

  it("routes an English record on a trusted Japanese page through auto", async () => {
    let calls = 0;
    const routes: OpenAIRecordSourceMap[] = [];
    const openai = translator(async (sources, sourceLanguages) => {
      calls += 1;
      routes.push(sourceLanguages);
      return translated(sources, () => "Billing statement");
    });

    const result = await openai.translateHtml([["Invoice"]], "en", {
      sourceLanguageHint: "ja",
    });

    expect(result).toMatchObject({
      results: [["Billing statement"]],
      failures: [],
    });
    expect(routes).toEqual([{ r0: "auto" }]);
    expect(calls).toBe(1);
  });

  it("revalidates v10 record entries with their pinned source route", async () => {
    const key = await savedOpenAiTranslationKey("vi", "Invoice", "en");
    const storage = memoryStorage({
      [key]: JSON.stringify({ t: "Invoice" }),
    });
    let calls = 0;
    const openai = translator(async () => {
      calls += 1;
      return { r0: "Hóa đơn" };
    }, storage);

    const result = await openai.translateHtml([["Invoice"]], "vi", {
      sourceLanguageHint: "en",
    });

    expect(result).toMatchObject({ results: [["Hóa đơn"]], failures: [] });
    expect(result.diagnostics).toMatchObject({
      localCacheHits: 0,
      localCacheMisses: 1,
      localCacheInvalid: 1,
      requestCount: 1,
    });
    expect(calls).toBe(1);
    expect(storage.data.get(key)).toContain("Hóa đơn");
  });

  it("keeps deterministic unchanged values local", async () => {
    let calls = 0;
    const storage = memoryStorage();
    const openai = translator(async () => {
      calls += 1;
      return {};
    }, storage);
    const sources = [
      ["hello@example.com"],
      ["https://example.com"],
      ["INV-2048"],
      ["<strong>"],
      ["value => value"],
    ];

    const first = await openai.translateHtml(sources, "vi");
    const second = await openai.translateHtml(sources, "vi");

    expect(first.results).toEqual(sources);
    expect(second.failures).toEqual([]);
    expect(calls).toBe(0);
    expect(first.diagnostics).toMatchObject({
      records: 0,
      sourceCharacters: 0,
      requestCount: 0,
      storageReadCalls: 0,
      storageWriteCalls: 0,
    });
    expect(storage.getManyCalls).toEqual([]);
    expect(storage.setManyCalls).toEqual([]);
  });

  it("keeps formatted currency, percentages, and dates local but sends words", async () => {
    const calls: OpenAITranslationMap[] = [];
    const openai = translator(async (sources) => {
      calls.push(sources);
      return translated(sources, () => "Tổng ¥1,000");
    });
    const formatted = [
      ["¥1,000"],
      ["-￥6,314,462"],
      ["$1,234.50"],
      ["€ 1.234,56"],
      ["12.5%"],
      ["2026/08/25"],
    ];

    const local = await openai.translateHtml(formatted, "vi");
    const withWords = await openai.translateHtml([["Total ¥1,000"]], "vi");

    expect(local).toMatchObject({ results: formatted, failures: [] });
    expect(calls).toEqual([{ r0: "Total ¥1,000" }]);
    expect(withWords).toMatchObject({
      results: [["Tổng ¥1,000"]],
      failures: [],
    });
  });

  it("packs no more than 128 records or 8,000 raw source characters", async () => {
    const maps: OpenAITranslationMap[] = [];
    const openai = translator(async (sources) => {
      maps.push(sources);
      return translated(sources);
    });
    const records = Array.from({ length: 130 }, (_, index) => [
      `label-${index}-${"x".repeat(20)}`,
    ]);

    const result = await openai.translateHtml(records, "vi");

    expect(result.failures).toEqual([]);
    expect(maps.map((map) => Object.keys(map).length)).toEqual([128, 2]);
    expect(
      maps.every(
        (map) =>
          Object.values(map).reduce((sum, source) => sum + source.length, 0) <=
          8_000,
      ),
    ).toBe(true);

    maps.length = 0;
    await openai.translateHtml(
      [[`left-${"x".repeat(4_100)}`], [`right-${"y".repeat(4_100)}`]],
      "en",
    );
    expect(maps).toHaveLength(2);
    expect(
      maps.every(
        (map) =>
          Object.values(map).reduce((sum, source) => sum + source.length, 0) <=
          8_000,
      ),
    ).toBe(true);

    maps.length = 0;
    const escaped = '\\"'.repeat(1_900);
    await openai.translateHtml([[`${escaped}a`], [`${escaped}b`]], "vi");
    expect(maps).toHaveLength(1);
    expect(JSON.stringify(maps[0]).length).toBeGreaterThan(8_000);
    expect(
      Object.values(maps[0] ?? {}).reduce(
        (sum, source) => sum + source.length,
        0,
      ),
    ).toBeLessThanOrEqual(8_000);
  });

  it("keeps one production content envelope in one internal request and reports aggregate usage", async () => {
    let calls = 0;
    const openai = createOpenAIHtmlTranslator({
      completeHtml: async (sources, _routes, _target, onUsage) => {
        calls += 1;
        onUsage?.({
          inputTokens: 120,
          outputTokens: 80,
          reasoningTokens: 4,
          cachedInputTokens: 30,
        });
        return translated(sources);
      },
      storage: memoryStorage(),
      getApiKey: async () => "sk-test",
    });
    const contentEnvelope = Array.from({ length: 128 }, (_, index) => [
      `label-${index}`,
    ]);

    const result = await openai.translateHtml(contentEnvelope, "vi");

    expect(calls).toBe(1);
    expect(result.diagnostics).toMatchObject({
      records: 128,
      requestCount: 1,
      rejectedCount: 0,
      rejectionReasons: {},
      inputTokens: 120,
      outputTokens: 80,
      reasoningTokens: 4,
      cachedInputTokens: 30,
    });
    expect(result.diagnostics.queueMs).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.requestMs).toBeGreaterThanOrEqual(0);
  });

  it("traces direct multi-pack completion but waits for every sibling", async () => {
    const completionOrder: number[] = [];
    let call = 0;
    let releaseFirst = () => undefined as void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const openai = translator(async (sources) => {
      const index = call++;
      if (index === 0) await firstGate;
      completionOrder.push(index);
      return translated(sources);
    });
    let settled = false;
    const request = openai
      .translateHtml(
        Array.from({ length: 130 }, (_, index) => [`record-${index}`]),
        "vi",
      )
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.waitFor(() => expect(completionOrder).toEqual([1]));
    expect(settled).toBe(false);
    releaseFirst();
    const result = await request;

    expect(completionOrder).toEqual([1, 0]);
    expect(result.diagnostics.requestCount).toBe(2);
  });

  it("fails an oversized source without violating the hard ceiling", async () => {
    let calls = 0;
    const openai = translator(async (sources) => {
      calls += 1;
      return translated(sources);
    });

    const result = await openai.translateHtml([["x".repeat(8_001)]], "vi");

    expect(calls).toBe(0);
    expect(result.failures[0]).toMatchObject({
      index: 0,
      scope: "record",
      retryable: false,
    });
  });

  it("deduplicates in-flight work and uses the configured provider cap", async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const openai = translator(async (sources) => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return translated(sources);
    });

    await Promise.all([
      ...Array.from({ length: TRANSLATION_CONCURRENCY + 1 }, (_, index) =>
        openai.translateHtml([[`source-${index}`]], "vi"),
      ),
      openai.translateHtml([["source-0"]], "vi"),
    ]);

    expect(maximum).toBe(TRANSLATION_CONCURRENCY);
    expect(calls).toBe(TRANSLATION_CONCURRENCY + 1);
  });

  it("preserves missing-key, Retry-After, and clear-generation behavior", async () => {
    const missing = translator(
      async () => ({}),
      memoryStorage(),
      async () => "",
    );
    await expect(
      missing.translateHtml([["Hello"]], "vi"),
    ).resolves.toMatchObject({
      failures: [{ index: 0, scope: "run", retryable: false }],
    });

    const limited = translator(async () => {
      throw Object.assign(new Error("rate limited"), {
        statusCode: 429,
        responseHeaders: { "retry-after": "45" },
      });
    });
    await expect(
      limited.translateHtml([["Hello"]], "vi"),
    ).resolves.toMatchObject({
      failures: [
        {
          index: 0,
          scope: "record",
          retryable: true,
          retryAfterMs: 30_000,
        },
      ],
    });

    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const googleKey = `${CACHE_PREFIX}google:auto:vi:keep`;
    const chainKey = await savedOpenAiFallbackKey("vi", "Hello", "en");
    const storage = memoryStorage({
      [googleKey]: "google",
      [chainKey]: JSON.stringify({ t: "Xin chào", p: "google" }),
    });
    const pending = translator(async (sources) => {
      await gate;
      return translated(sources);
    }, storage);
    const request = pending.translateHtml([["Hello"]], "vi");
    await pending.clearSavedTranslations();
    release();
    await request;
    // Legacy client-selected Google entries are cleared with the chain.
    expect(storage.data.has(googleKey)).toBe(false);
    expect(storage.data.has(chainKey)).toBe(false);
    expect(
      [...storage.data.keys()].some((key) => key.includes("openai:")),
    ).toBe(false);
  });
});

describe("OpenAI compact structured completer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes one HTTP request when OpenAI returns a retryable error", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('{"error":{"message":"temporary"}}', {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const complete = createOpenAiCompleter("sk-test");

    await expect(
      complete({ r0: "請求" }, { r0: "ja" }, "en"),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses exact required maps, locked model, and trusted strict context", async () => {
    const bodies: Record<string, unknown>[] = [];
    const usages: OpenAIRequestUsage[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        text?: { format?: { schema?: { required?: string[] } } };
      };
      bodies.push(body as Record<string, unknown>);
      const required = body.text?.format?.schema?.required ?? [];
      const output = Object.fromEntries(
        required.map((id) => [id, `translated:${id}`]),
      );
      return new Response(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5-nano-2025-08-07",
          output: [
            {
              id: "msg_test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  annotations: [],
                  logprobs: [],
                  text: JSON.stringify(output),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 8,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const complete = createOpenAiCompleter("sk-test");

    for (const count of [1, 24, 128]) {
      const sources = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `r${index}`,
          `source-${index}`,
        ]),
      );
      await expect(
        complete(
          sources,
          Object.fromEntries(
            Object.keys(sources).map((id, index) => [
              id,
              index === 0 ? "ja" : "en",
            ]),
          ),
          "en",
          (usage) => usages.push(usage),
        ),
      ).resolves.toEqual(
        Object.fromEntries(
          Object.keys(sources).map((id) => [id, `translated:${id}`]),
        ),
      );
    }

    for (const [index, count] of [1, 24, 128].entries()) {
      const body = bodies[index] as {
        model?: string;
        reasoning?: { effort?: string };
        text?: {
          format?: {
            type?: string;
            schema?: {
              properties?: Record<string, unknown>;
              required?: string[];
              additionalProperties?: boolean;
            };
          };
        };
        input?: unknown;
      };
      const schema = body.text?.format?.schema;
      const expectedIds = Array.from(
        { length: count },
        (_, item) => `r${item}`,
      );
      expect(body.model).toBe("gpt-5-nano");
      expect(body).toHaveProperty("service_tier", "default");
      expect(body.reasoning?.effort).toBe("minimal");
      expect(body.text?.format?.type).toBe("json_schema");
      expect(Object.keys(schema?.properties ?? {})).toEqual(expectedIds);
      expect(schema?.required).toEqual(expectedIds);
      expect(schema?.additionalProperties).toBe(false);
      expect(JSON.stringify(schema)).not.toContain('"items"');
      const input = JSON.stringify(body.input);
      expect(input).toContain('Source routes JSON: {\\"r0\\":\\"ja\\"');
      if (count > 1) expect(input).toContain('\\"r1\\":\\"en\\"');
      expect(input).toContain("Target language: English");
      expect(input.indexOf("Translate every map value")).toBeLessThan(
        input.indexOf("Source routes JSON"),
      );
      expect(input.indexOf("Source routes JSON")).toBeLessThan(
        input.indexOf("Input JSON"),
      );
      expect(input).toContain("Return exactly one translated string");
      expect(input).toContain("output must not equal the input");
      expect(input).toContain("Never return source-route labels");
      expect(input).toContain(
        'Example JSON: {\\"r0\\":\\"請求管理\\"} -> {\\"r0\\":\\"Invoice management\\"}',
      );
    }
    expect(usages).toEqual(
      Array.from({ length: 3 }, () => ({
        inputTokens: 10,
        outputTokens: 8,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      })),
    );
    expect(JSON.stringify(bodies)).not.toContain("Correction pass");
  });
});

describe("openai session generation", () => {
  it.each([new AuthRequiredError(), new AuthUnavailableError()])(
    "preserves terminal $code for owners and deduplicated callers",
    async (error) => {
      const storage = memoryStorage();
      const gate = deferred<OpenAITranslationMap>();
      const stage = vi.fn(() => gate.promise);
      const html = translator(stage, storage);
      const owner = expect(html.translateHtml([["Hello"]], "vi")).rejects.toBe(
        error,
      );
      await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
      const joined = expect(html.translateText(["Hello"], "vi")).rejects.toBe(
        error,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.reject(error);
      await Promise.all([owner, joined]);
      expect(stage).toHaveBeenCalledTimes(1);
      expect(storage.setManyCalls).toEqual([]);
    },
  );

  it("settles old owners and queue, then preserves a new same-key job and saved cache", async () => {
    const storage = memoryStorage({ keep: "saved value" });
    const gates: ReturnType<typeof deferred<OpenAITranslationMap>>[] = [];
    const stage = vi.fn(() => {
      const gate = deferred<OpenAITranslationMap>();
      gates.push(gate);
      return gate.promise;
    });
    const html = translator(stage, storage);
    const old = ["Hello", "World", "Queued"].map((source) =>
      expect(html.translateHtml([[source]], "vi")).rejects.toBeInstanceOf(
        AuthRequiredError,
      ),
    );
    await vi.waitFor(() => {
      expect(stage).toHaveBeenCalledTimes(2);
      expect(storage.getManyCalls).toHaveLength(3);
    });
    const duplicate = expect(
      html.translateHtml([["Hello"]], "vi"),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    html.invalidatePendingWork();
    await Promise.all([...old, duplicate]);
    const fresh = html.translateHtml([["Hello"]], "vi");
    await vi.waitFor(() => expect(storage.getManyCalls).toHaveLength(4));
    gates[0]!.resolve({ r0: "Current translation" });
    await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(3));
    gates[1]!.resolve({ r0: "Current translation" });
    const joined = html.translateHtml([["Hello"]], "vi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    gates[2]!.resolve({ r0: "Current translation" });
    for (const response of await Promise.all([fresh, joined]))
      expect(response.results).toEqual([["Current translation"]]);
    expect(stage).toHaveBeenCalledTimes(3);
    expect(storage.setManyCalls).toHaveLength(1);
    expect(storage.data.get("keep")).toBe("saved value");
  });

  it("retires a delayed cache lookup before dispatch and keeps fresh dedup ownership", async () => {
    const storage = memoryStorage();
    const reads = [
      deferred<Record<string, string>>(),
      deferred<Record<string, string>>(),
    ];
    const getMany = vi
      .spyOn(storage, "getMany")
      .mockImplementationOnce(() => reads[0]!.promise)
      .mockImplementationOnce(() => reads[1]!.promise);
    const stage = vi.fn(async () => ({ r0: "Current translation" }));
    const html = translator(stage, storage);
    const old = expect(
      html.translateHtml([["Hello"]], "vi"),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    await vi.waitFor(() => expect(getMany).toHaveBeenCalledTimes(1));
    html.invalidatePendingWork();
    await old;
    const fresh = html.translateHtml([["Hello"]], "vi");
    await vi.waitFor(() => expect(getMany).toHaveBeenCalledTimes(2));
    reads[0]!.resolve({});
    const joined = html.translateHtml([["Hello"]], "vi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    reads[1]!.resolve({});
    await Promise.all([fresh, joined]);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(getMany).toHaveBeenCalledTimes(2);
  });

  it("blocks queued sibling batches immediately after terminal auth", async () => {
    const storage = memoryStorage();
    const stage = vi.fn(async () => {
      throw new AuthUnavailableError();
    });
    const html = translator(stage, storage);
    const sources = ["a", "b", "c"].map((letter) => letter.repeat(5000));
    await expect(html.translateHtml([sources], "vi")).rejects.toBeInstanceOf(
      AuthUnavailableError,
    );
    expect(stage).toHaveBeenCalledTimes(2);
    expect(storage.setManyCalls).toEqual([]);
  });

  it("does not publish a translation whose cache write was already pending at invalidation", async () => {
    const storage = memoryStorage();
    const write = deferred<void>();
    const setMany = vi
      .spyOn(storage, "setMany")
      .mockImplementation(async () => write.promise);
    const stage = vi.fn(async () => ({ r0: "Current translation" }));
    const html = translator(stage, storage);
    const old = expect(
      html.translateHtml([["Hello"]], "vi"),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    await vi.waitFor(() => expect(setMany).toHaveBeenCalledTimes(1));
    html.invalidatePendingWork();
    await old;
    write.resolve();
    expect(setMany).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch after invalidation during credential preparation", async () => {
    const key = deferred<string>();
    const getApiKey = vi.fn(() => key.promise);
    const stage = vi.fn(async () => ({}));
    const html = translator(stage, memoryStorage(), getApiKey);
    const old = expect(
      html.translateHtml([["Hello"]], "vi"),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    await vi.waitFor(() => expect(getApiKey).toHaveBeenCalledTimes(1));
    html.invalidatePendingWork();
    await old;
    key.resolve("key");
    await Promise.resolve();
    expect(stage).not.toHaveBeenCalled();
  });

  it("starts no accepted-cache write after invalidation during key hashing", async () => {
    const storage = memoryStorage();
    const html = translator(
      vi.fn(async () => ({})),
      storage,
    );
    const save = html.cacheFallbackTranslations(
      [["Hello"]],
      [["Xin chào"]],
      "vi",
      {},
      "google",
    );
    html.invalidatePendingWork();
    await expect(save).resolves.toBe(0);
    expect(storage.setManyCalls).toEqual([]);
  });

  it("reports no accepted-cache success after an already-started write is invalidated", async () => {
    const storage = memoryStorage();
    const write = deferred<void>();
    const setMany = vi
      .spyOn(storage, "setMany")
      .mockImplementation(() => write.promise);
    const html = translator(
      vi.fn(async () => ({})),
      storage,
    );
    const save = html.cacheFallbackTranslations(
      [["Hello"]],
      [["Xin chào"]],
      "vi",
      {},
      "google",
    );
    await vi.waitFor(() => expect(setMany).toHaveBeenCalledTimes(1));
    html.invalidatePendingWork();
    write.resolve();
    await expect(save).resolves.toBe(0);
    expect(setMany).toHaveBeenCalledTimes(1);
  });
});

describe("saved OpenAI translations per model (ADR 0020)", () => {
  it("scopes the OpenAI namespace by model but not the recovery chain", async () => {
    const nano = await savedOpenAiTranslationKey("vi", "請求管理", "ja");
    const mini = await savedOpenAiTranslationKey(
      "vi",
      "請求管理",
      "ja",
      "gpt-5-mini",
    );
    expect(nano).toContain(":gpt-5-nano:");
    expect(mini).toContain(":gpt-5-mini:");
    expect(mini).not.toBe(nano);
  });

  it("reads and writes saved translations under the chosen model", async () => {
    const storage = memoryStorage();
    let model = "gpt-5-mini";
    const completeHtml = vi.fn(async (sources: Record<string, string>) =>
      Object.fromEntries(Object.keys(sources).map((id) => [id, "Quản lý"])),
    );
    const html = createOpenAIHtmlTranslator({
      completeHtml,
      storage,
      getApiKey: async () => "configured",
      model: () => model,
    });
    await html.translateText(["請求管理"], "vi");
    expect(
      storage.data.has(
        await savedOpenAiTranslationKey("vi", "請求管理", "ja", "gpt-5-mini"),
      ),
    ).toBe(true);
    // The same model reuses the saved value with no provider call.
    await html.translateText(["請求管理"], "vi");
    expect(completeHtml).toHaveBeenCalledTimes(1);
    // Another model misses it and asks the provider again.
    model = "gpt-5";
    await html.translateText(["請求管理"], "vi");
    expect(completeHtml).toHaveBeenCalledTimes(2);
  });
});
