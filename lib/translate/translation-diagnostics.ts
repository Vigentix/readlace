import type { SavedTranslationStore } from "./provider-result";

export const TRANSLATION_DIAGNOSTICS_STORAGE_KEY = "translation-diagnostics:v2";

const STORAGE_VERSION = 2;
const MAX_RUNS = 20;

export const TRANSLATION_PROVIDERS = [
  "google",
  "openai",
  "browser-native",
] as const;

export const TRANSLATION_REJECTION_REASONS = [
  "empty",
  "source-identical",
  "invalid-response",
  "provider-error",
  "native-unavailable",
  "stale",
  "detached",
] as const;

export type TranslationProvider = (typeof TRANSLATION_PROVIDERS)[number];
export type TranslationRejectionReason =
  (typeof TRANSLATION_REJECTION_REASONS)[number];

export interface TranslationRunSummary {
  readonly provider: TranslationProvider;
  readonly records: number;
  readonly sourceCharacters: number;
  readonly requestCount: number;
  readonly queueMs: number;
  readonly requestMs: number;
  readonly firstCommitMs: number;
  readonly completeMs: number;
  readonly rejectedCount: number;
  readonly discoveredRecords: number;
  readonly eligibleRecords: number;
  readonly attemptedRecords: number;
  readonly deterministicRecords: number;
  readonly localCacheHits: number;
  readonly localCacheMisses: number;
  readonly localCacheInvalid: number;
  readonly chainCacheHits: number;
  readonly providerAccepted: number;
  readonly providerRejected: number;
  readonly googleFallbackAttempted: number;
  readonly googleFallbackAccepted: number;
  readonly nativeAttempted: number;
  readonly nativeAccepted: number;
  readonly storageReadCalls: number;
  readonly storageWriteCalls: number;
  readonly storageReadMs: number;
  readonly storageWriteMs: number;
  readonly maxViewportDispatchMs: number;
  readonly maxViewportCommitMs: number;
  readonly rejectionReasons: Readonly<
    Partial<Record<TranslationRejectionReason, number>>
  >;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cachedInputTokens?: number;
}

interface StoredDiagnostics {
  version: typeof STORAGE_VERSION;
  runs: TranslationRunSummary[];
}

const providerSet = new Set<string>(TRANSLATION_PROVIDERS);
const rejectionReasonSet = new Set<string>(TRANSLATION_REJECTION_REASONS);
const recordRunQueues = new WeakMap<SavedTranslationStore, Promise<void>>();
const summaryKeys = new Set([
  "provider",
  "records",
  "sourceCharacters",
  "requestCount",
  "queueMs",
  "requestMs",
  "firstCommitMs",
  "completeMs",
  "rejectedCount",
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
  "rejectionReasons",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseSummary(value: unknown): TranslationRunSummary | undefined {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !summaryKeys.has(key)) ||
    typeof value.provider !== "string" ||
    !providerSet.has(value.provider) ||
    !isCount(value.records) ||
    !isCount(value.sourceCharacters) ||
    !isCount(value.requestCount) ||
    !isDuration(value.queueMs) ||
    !isDuration(value.requestMs) ||
    !isDuration(value.firstCommitMs) ||
    !isDuration(value.completeMs) ||
    !isCount(value.rejectedCount) ||
    !isCount(value.discoveredRecords) ||
    !isCount(value.eligibleRecords) ||
    !isCount(value.attemptedRecords) ||
    !isCount(value.deterministicRecords) ||
    !isCount(value.localCacheHits) ||
    !isCount(value.localCacheMisses) ||
    !isCount(value.localCacheInvalid) ||
    !isCount(value.chainCacheHits) ||
    !isCount(value.providerAccepted) ||
    !isCount(value.providerRejected) ||
    !isCount(value.googleFallbackAttempted) ||
    !isCount(value.googleFallbackAccepted) ||
    !isCount(value.nativeAttempted) ||
    !isCount(value.nativeAccepted) ||
    !isCount(value.storageReadCalls) ||
    !isCount(value.storageWriteCalls) ||
    !isDuration(value.storageReadMs) ||
    !isDuration(value.storageWriteMs) ||
    !isDuration(value.maxViewportDispatchMs) ||
    !isDuration(value.maxViewportCommitMs) ||
    !isObject(value.rejectionReasons) ||
    Object.entries(value.rejectionReasons).some(
      ([reason, count]) => !rejectionReasonSet.has(reason) || !isCount(count),
    ) ||
    (value.inputTokens !== undefined && !isCount(value.inputTokens)) ||
    (value.outputTokens !== undefined && !isCount(value.outputTokens)) ||
    (value.reasoningTokens !== undefined && !isCount(value.reasoningTokens)) ||
    (value.cachedInputTokens !== undefined && !isCount(value.cachedInputTokens))
  ) {
    return undefined;
  }

  return value as unknown as TranslationRunSummary;
}

function parseRuns(raw: string | undefined): TranslationRunSummary[] {
  if (!raw) return [];
  try {
    const stored: unknown = JSON.parse(raw);
    if (
      !isObject(stored) ||
      stored.version !== STORAGE_VERSION ||
      !Array.isArray(stored.runs)
    ) {
      return [];
    }
    return stored.runs.flatMap((run) => {
      const parsed = parseSummary(run);
      return parsed ? [parsed] : [];
    });
  } catch {
    return [];
  }
}

function copySummary(summary: TranslationRunSummary): TranslationRunSummary {
  const parsed = parseSummary({
    provider: summary.provider,
    records: summary.records,
    sourceCharacters: summary.sourceCharacters,
    requestCount: summary.requestCount,
    queueMs: summary.queueMs,
    requestMs: summary.requestMs,
    firstCommitMs: summary.firstCommitMs,
    completeMs: summary.completeMs,
    rejectedCount: summary.rejectedCount,
    discoveredRecords: summary.discoveredRecords,
    eligibleRecords: summary.eligibleRecords,
    attemptedRecords: summary.attemptedRecords,
    deterministicRecords: summary.deterministicRecords,
    localCacheHits: summary.localCacheHits,
    localCacheMisses: summary.localCacheMisses,
    localCacheInvalid: summary.localCacheInvalid,
    chainCacheHits: summary.chainCacheHits,
    providerAccepted: summary.providerAccepted,
    providerRejected: summary.providerRejected,
    googleFallbackAttempted: summary.googleFallbackAttempted,
    googleFallbackAccepted: summary.googleFallbackAccepted,
    nativeAttempted: summary.nativeAttempted,
    nativeAccepted: summary.nativeAccepted,
    storageReadCalls: summary.storageReadCalls,
    storageWriteCalls: summary.storageWriteCalls,
    storageReadMs: summary.storageReadMs,
    storageWriteMs: summary.storageWriteMs,
    maxViewportDispatchMs: summary.maxViewportDispatchMs,
    maxViewportCommitMs: summary.maxViewportCommitMs,
    rejectionReasons: Object.fromEntries(
      TRANSLATION_REJECTION_REASONS.flatMap((reason) => {
        const count = summary.rejectionReasons[reason];
        return count === undefined ? [] : [[reason, count]];
      }),
    ),
    ...(summary.inputTokens === undefined
      ? {}
      : { inputTokens: summary.inputTokens }),
    ...(summary.outputTokens === undefined
      ? {}
      : { outputTokens: summary.outputTokens }),
    ...(summary.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: summary.reasoningTokens }),
    ...(summary.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: summary.cachedInputTokens }),
  });
  if (!parsed) throw new TypeError("Invalid translation run summary");
  return parsed;
}

export function recordRun(
  storage: SavedTranslationStore,
  summary: TranslationRunSummary,
): Promise<void> {
  const previous = recordRunQueues.get(storage) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const runs = parseRuns(
        await storage.get(TRANSLATION_DIAGNOSTICS_STORAGE_KEY),
      );
      runs.push(copySummary(summary));
      const stored: StoredDiagnostics = {
        version: STORAGE_VERSION,
        runs: runs.slice(-MAX_RUNS),
      };
      await storage.set(
        TRANSLATION_DIAGNOSTICS_STORAGE_KEY,
        JSON.stringify(stored),
      );
    });
  recordRunQueues.set(storage, current);
  return current.finally(() => {
    if (recordRunQueues.get(storage) === current)
      recordRunQueues.delete(storage);
  });
}

export async function listRuns(
  storage: SavedTranslationStore,
): Promise<TranslationRunSummary[]> {
  return parseRuns(
    await storage.get(TRANSLATION_DIAGNOSTICS_STORAGE_KEY),
  ).slice(-MAX_RUNS);
}

export async function clearRuns(storage: SavedTranslationStore): Promise<void> {
  await storage.remove([TRANSLATION_DIAGNOSTICS_STORAGE_KEY]);
}
