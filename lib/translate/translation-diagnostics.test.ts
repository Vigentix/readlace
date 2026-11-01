import { describe, expect, it } from "vitest";
import {
  clearRuns,
  listRuns,
  recordRun,
  TRANSLATION_DIAGNOSTICS_STORAGE_KEY,
  type TranslationRunSummary,
} from "./translation-diagnostics";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const operations = { get: 0, set: 0, remove: 0 };
  return {
    data,
    operations,
    async get(key: string) {
      operations.get += 1;
      return data.get(key);
    },
    async set(key: string, value: string) {
      operations.set += 1;
      data.set(key, value);
    },
    async getMany(keys: string[]) {
      return Object.fromEntries(
        keys.flatMap((key) => (data.has(key) ? [[key, data.get(key)!]] : [])),
      );
    },
    async setMany(entries: Record<string, string>) {
      Object.entries(entries).forEach(([key, value]) => data.set(key, value));
    },
    async getAll() {
      return Object.fromEntries(data);
    },
    async remove(keys: string[]) {
      operations.remove += 1;
      keys.forEach((key) => data.delete(key));
    },
  };
}

function summary(records: number): TranslationRunSummary {
  return {
    provider: "openai",
    records,
    sourceCharacters: records * 10,
    requestCount: 2,
    queueMs: 3,
    requestMs: 4.5,
    firstCommitMs: 6,
    completeMs: 9,
    rejectedCount: 1,
    discoveredRecords: records + 2,
    eligibleRecords: records + 1,
    attemptedRecords: records,
    deterministicRecords: 1,
    localCacheHits: 2,
    localCacheMisses: 3,
    localCacheInvalid: 1,
    chainCacheHits: 1,
    providerAccepted: records,
    providerRejected: 1,
    googleFallbackAttempted: 2,
    googleFallbackAccepted: 1,
    nativeAttempted: 1,
    nativeAccepted: 1,
    storageReadCalls: 1,
    storageWriteCalls: 1,
    storageReadMs: 1.5,
    storageWriteMs: 2.5,
    maxViewportDispatchMs: 300,
    maxViewportCommitMs: 600,
    rejectionReasons: { "source-identical": 1 },
    inputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 2,
    cachedInputTokens: 8,
  };
}

describe("translation diagnostics", () => {
  it("keeps the newest 20 summaries in insertion order", async () => {
    const storage = memoryStorage();

    for (let index = 1; index <= 21; index += 1) {
      await recordRun(storage, summary(index));
    }

    const runs = await listRuns(storage);
    expect(runs).toHaveLength(20);
    expect(runs.map((run) => run.records)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 2),
    );
  });

  it("serializes concurrent appends without exceeding the 20-run bound", async () => {
    const storage = memoryStorage({
      [TRANSLATION_DIAGNOSTICS_STORAGE_KEY]: JSON.stringify({
        version: 2,
        runs: Array.from({ length: 19 }, (_, index) => summary(index + 1)),
      }),
    });
    const originalSet = storage.set.bind(storage);
    let releaseFirstSet!: () => void;
    let firstSetStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirstSet = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstSetStarted = resolve;
    });
    let delayNextSet = true;
    storage.set = async (key: string, value: string) => {
      if (delayNextSet) {
        delayNextSet = false;
        firstSetStarted();
        await release;
      }
      await originalSet(key, value);
    };

    const first = recordRun(storage, summary(20));
    await started;
    const second = recordRun(storage, summary(21));
    await Promise.resolve();
    releaseFirstSet();
    await Promise.all([first, second]);

    const runs = await listRuns(storage);
    expect(runs).toHaveLength(20);
    expect(runs.map((run) => run.records)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 2),
    );
  });

  it("serializes only the explicit aggregate allowlist", async () => {
    const storage = memoryStorage();
    const unsafe = Object.assign(summary(1), {
      text: "secret page text",
      url: "https://private.example/path",
      hostname: "private.example",
      payload: { source: "secret" },
      rawResponse: "secret response",
      headers: { authorization: "Bearer secret" },
      credential: "secret-key",
      metadata: { candidate: "secret" },
    });

    await recordRun(storage, unsafe);

    const raw = storage.data.get(TRANSLATION_DIAGNOSTICS_STORAGE_KEY) ?? "";
    const parsed = JSON.parse(raw) as {
      version: number;
      runs: Record<string, unknown>[];
    };
    expect(parsed.version).toBe(2);
    expect(Object.keys(parsed.runs[0]!).sort()).toEqual(
      [
        "completeMs",
        "discoveredRecords",
        "eligibleRecords",
        "attemptedRecords",
        "deterministicRecords",
        "localCacheHits",
        "localCacheMisses",
        "localCacheInvalid",
        "chainCacheHits",
        "providerAccepted",
        "providerRejected",
        "googleFallbackAttempted",
        "googleFallbackAccepted",
        "nativeAttempted",
        "nativeAccepted",
        "storageReadCalls",
        "storageWriteCalls",
        "storageReadMs",
        "storageWriteMs",
        "maxViewportDispatchMs",
        "maxViewportCommitMs",
        "firstCommitMs",
        "inputTokens",
        "outputTokens",
        "provider",
        "queueMs",
        "reasoningTokens",
        "cachedInputTokens",
        "records",
        "rejectedCount",
        "rejectionReasons",
        "requestCount",
        "requestMs",
        "sourceCharacters",
      ].sort(),
    );
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("private.example");
  });

  it("recovers from corrupt entries and version mismatches", async () => {
    const valid = summary(3);
    const corruptStorage = memoryStorage({
      [TRANSLATION_DIAGNOSTICS_STORAGE_KEY]: JSON.stringify({
        version: 2,
        runs: [valid, { ...valid, url: "https://private.example" }, null],
      }),
    });
    const oldStorage = memoryStorage({
      [TRANSLATION_DIAGNOSTICS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        runs: [valid],
      }),
    });
    const invalidJsonStorage = memoryStorage({
      [TRANSLATION_DIAGNOSTICS_STORAGE_KEY]: "not-json",
    });

    await expect(listRuns(corruptStorage)).resolves.toEqual([valid]);
    await expect(listRuns(oldStorage)).resolves.toEqual([]);
    await expect(listRuns(invalidJsonStorage)).resolves.toEqual([]);

    await recordRun(oldStorage, summary(4));
    await expect(listRuns(oldStorage)).resolves.toEqual([summary(4)]);
  });

  it("uses one read and write per append, one read per list, and one remove per clear", async () => {
    const storage = memoryStorage();

    await recordRun(storage, summary(1));
    expect(storage.operations).toEqual({ get: 1, set: 1, remove: 0 });

    await listRuns(storage);
    expect(storage.operations).toEqual({ get: 2, set: 1, remove: 0 });

    await clearRuns(storage);
    expect(storage.operations).toEqual({ get: 2, set: 1, remove: 1 });
    await expect(listRuns(storage)).resolves.toEqual([]);
  });

  it("rejects invalid aggregate values without writing", async () => {
    const storage = memoryStorage();

    await expect(
      recordRun(storage, { ...summary(1), localCacheHits: -1 }),
    ).rejects.toThrow("Invalid translation run summary");
    expect(storage.operations.set).toBe(0);
  });
});
