import { AuthRequiredError, AuthUnavailableError } from "@/lib/run-errors";
import {
  CACHE_PREFIX,
  TRANSLATION_CONCURRENCY,
  type TargetLanguage,
} from "@/lib/translation";
import type {
  HtmlTranslateFailure,
  HtmlTranslateResult,
  ProviderDiagnostics,
  SavedTranslationStore,
} from "@/lib/translate/provider-result";
import { toHtmlTranslateFailure } from "@/lib/translate/provider-result";
import {
  assessProviderTranslation,
  isDeterministicTranslationValue,
} from "@/lib/translate/format-guards";
import {
  resolveRecordSourceLanguage,
  type RecordSourceLanguage,
} from "@/lib/translate/page-language";
import type { TranslationRejectionReason } from "@/lib/translate/translation-diagnostics";

/** Model in saved OpenAI keys when the caller names none (ADR 0020). */
const DEFAULT_MODEL = "gpt-5-nano";
const CACHE_VERSION = "v10";
const FALLBACK_CACHE_PREFIX = `${CACHE_PREFIX}chain:v1:openai-google-native:`;
/** Written by builds with a client-selected Google provider; only cleared now. */
const LEGACY_GOOGLE_CACHE_PREFIX = `${CACHE_PREFIX}google:`;
const MAX_BATCH_RECORDS = 128;
/** Raw source-string characters per OpenAI request. */
const MAX_BATCH_CHARACTERS = 8000;
/** Shared by every request made through one translator instance. */
const MAX_IN_FLIGHT = TRANSLATION_CONCURRENCY;

export type OpenAITranslationMap = Record<string, string>;
export type OpenAIRecordSourceMap = Record<string, RecordSourceLanguage>;
export type OpenAIFallbackProvenance = "google" | "browser-native";
/** Engine reported by the backend router for one record. */
export type BackendRecordProvenance = "openai" | "google";
export type BackendProvenanceMap = Record<string, BackendRecordProvenance>;

export interface OpenAITranslateOptions {
  deferCache?: boolean;
  sourceLanguageHint?: TargetLanguage;
  /**
   * On-device path (Free, or a refused backend; ADR 0014): read the saved
   * translations only. Cache misses make no backend stage and come back as
   * non-retryable unresolved records for the on-device stage.
   */
  cacheOnly?: boolean;
}

export interface OpenAIProviderDiagnostics extends ProviderDiagnostics {
  chainCacheHits: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface OpenAIRequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface OpenAIHtmlTranslateResult extends HtmlTranslateResult {
  diagnostics: OpenAIProviderDiagnostics;
  /**
   * Aligned with `results`: `"google"` where the backend's Google fallback
   * produced a fresh accepted value. Those values belong to the recovery
   * chain cache, never the OpenAI namespace.
   */
  provenance: ("google" | undefined)[][];
}

export interface OpenAIHtmlDependencies {
  completeHtml: (
    sources: OpenAITranslationMap,
    sourceLanguages: OpenAIRecordSourceMap,
    targetLanguage: TargetLanguage,
    onUsage?: (usage: OpenAIRequestUsage) => void,
    onProvenance?: (provenance: BackendProvenanceMap) => void,
  ) => Promise<OpenAITranslationMap>;
  storage: SavedTranslationStore;
  getApiKey: () => Promise<string>;
  /**
   * The user's chosen model (ADR 0020). Saved OpenAI translations are scoped
   * by it, so another model never reuses them; the recovery chain is not.
   */
  model?: () => string;
}

function fixString(text: string) {
  return text.replaceAll("\u200b", " ");
}

async function digestSha1(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function savedOpenAiTranslationKeys(
  targetLanguage: TargetLanguage,
  normalizedSource: string,
  sourceLanguage: RecordSourceLanguage = "auto",
  model = DEFAULT_MODEL,
) {
  return digestSha1(normalizedSource).then((hash) => ({
    openAi: `${CACHE_PREFIX}openai:${CACHE_VERSION}:record:${model}:${sourceLanguage}:${targetLanguage}:${hash}`,
    fallback: `${FALLBACK_CACHE_PREFIX}${sourceLanguage}:${targetLanguage}:${hash}`,
  }));
}

export function savedOpenAiTranslationKey(
  targetLanguage: TargetLanguage,
  normalizedSource: string,
  sourceLanguage: RecordSourceLanguage = "auto",
  model = DEFAULT_MODEL,
) {
  return savedOpenAiTranslationKeys(
    targetLanguage,
    normalizedSource,
    sourceLanguage,
    model,
  ).then(({ openAi }) => openAi);
}

export function savedOpenAiFallbackKey(
  targetLanguage: TargetLanguage,
  normalizedSource: string,
  sourceLanguage: RecordSourceLanguage = "auto",
): Promise<string> {
  return savedOpenAiTranslationKeys(
    targetLanguage,
    normalizedSource,
    sourceLanguage,
  ).then(({ fallback }) => fallback);
}

interface AcceptedEntry {
  t: string;
}

interface OpenAIFallbackEntry extends AcceptedEntry {
  p: OpenAIFallbackProvenance;
}

interface RecordJob {
  source: string;
  sourceLanguage: RecordSourceLanguage;
  cacheKey: string;
  fallbackCacheKey: string;
  wait: Promise<void>;
  resolve: () => void;
  value?: AcceptedEntry;
  cacheable?: boolean;
  provenance?: "google";
  failure?: Omit<HtmlTranslateFailure, "index">;
  error?: unknown;
}

interface RecordOwner {
  pieceIndex: number;
  nodeIndex: number;
  job: RecordJob;
}

function validationHint(sourceLanguage: RecordSourceLanguage) {
  return sourceLanguage === "auto" ? undefined : sourceLanguage;
}

function validateMap(
  output: unknown,
  expected: OpenAITranslationMap,
  sourceLanguages: OpenAIRecordSourceMap,
  targetLanguage: TargetLanguage,
) {
  const record =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : undefined;
  const expectedIds = Object.keys(expected);
  if (record && Object.keys(record).some((id) => !Object.hasOwn(expected, id)))
    return {
      valid: new Map<string, AcceptedEntry>(),
      unresolved: expectedIds,
      rejected: new Map(
        expectedIds.map((id) => [id, "invalid-response"] as const),
      ),
    };
  const valid = new Map<string, AcceptedEntry>();
  const rejected = new Map<string, TranslationRejectionReason>();
  for (const [id, source] of Object.entries(expected)) {
    const translated = record?.[id];
    if (typeof translated !== "string") {
      rejected.set(id, "invalid-response");
      continue;
    }
    if (!translated.trim()) {
      rejected.set(id, "empty");
      continue;
    }
    const assessment = assessProviderTranslation(
      source,
      translated,
      targetLanguage,
      validationHint(sourceLanguages[id] ?? "auto"),
    );
    if (assessment.status !== "accepted") {
      rejected.set(id, assessment.reason);
      continue;
    }
    valid.set(id, { t: assessment.text });
  }
  return {
    valid,
    unresolved: expectedIds.filter((id) => !valid.has(id)),
    rejected,
  };
}

function parseCache(
  value: string,
  source: string,
  targetLanguage: TargetLanguage,
  sourceLanguage: RecordSourceLanguage,
) {
  try {
    const cached = JSON.parse(value) as unknown;
    if (!cached || typeof cached !== "object" || Array.isArray(cached))
      return undefined;
    const translated = (cached as Partial<AcceptedEntry>).t;
    if (typeof translated !== "string") return undefined;
    const assessment = assessProviderTranslation(
      source,
      translated,
      targetLanguage,
      validationHint(sourceLanguage),
    );
    return assessment.status === "accepted"
      ? { t: assessment.text }
      : undefined;
  } catch {
    return undefined;
  }
}

function parseFallbackCache(
  value: string,
  source: string,
  targetLanguage: TargetLanguage,
  sourceLanguage: RecordSourceLanguage,
) {
  try {
    const cached = JSON.parse(value) as Partial<OpenAIFallbackEntry>;
    if (
      !cached ||
      typeof cached !== "object" ||
      Array.isArray(cached) ||
      typeof cached.t !== "string" ||
      (cached.p !== "google" && cached.p !== "browser-native")
    )
      return undefined;
    const assessment = assessProviderTranslation(
      source,
      cached.t,
      targetLanguage,
      validationHint(sourceLanguage),
    );
    return assessment.status === "accepted"
      ? { t: assessment.text, p: cached.p }
      : undefined;
  } catch {
    return undefined;
  }
}

function recordId(index: number) {
  return `r${index}`;
}

function sourceMap(records: RecordJob[]) {
  return Object.fromEntries(
    records.map((record, index) => [recordId(index), record.source]),
  );
}

function sourceLanguageMap(records: RecordJob[]) {
  return Object.fromEntries(
    records.map((record, index) => [recordId(index), record.sourceLanguage]),
  );
}

function packRecords(records: RecordJob[]) {
  const batches: RecordJob[][] = [];
  const oversized: RecordJob[] = [];
  let current: RecordJob[] = [];
  let currentCharacters = 0;
  for (const record of records) {
    if (
      current.length &&
      (current.length >= MAX_BATCH_RECORDS ||
        currentCharacters + record.source.length > MAX_BATCH_CHARACTERS)
    ) {
      batches.push(current);
      current = [];
      currentCharacters = 0;
    }
    if (record.source.length > MAX_BATCH_CHARACTERS) {
      oversized.push(record);
      continue;
    }
    current.push(record);
    currentCharacters += record.source.length;
  }
  if (current.length) batches.push(current);
  return { batches, oversized };
}

export function createOpenAIHtmlTranslator(deps: OpenAIHtmlDependencies) {
  let generation = 0;
  let cacheGeneration = 0;
  let active = 0;
  const queued: (() => void)[] = [];
  const inFlight = new Map<string, RecordJob>();
  const cancellations = new Set<() => void>();
  const withPendingWork = async <T>(
    work: (check: (error?: unknown) => void) => Promise<T>,
  ) => {
    const currentGeneration = generation;
    let terminalError: unknown;
    let cancel = () => undefined as void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new AuthRequiredError());
    });
    cancellations.add(cancel);
    const check = (error?: unknown) => {
      if (currentGeneration !== generation) throw new AuthRequiredError();
      if (
        error instanceof AuthRequiredError ||
        error instanceof AuthUnavailableError
      )
        terminalError = error;
      if (terminalError) throw terminalError;
    };
    try {
      return await Promise.race([cancelled, work(check)]);
    } finally {
      cancellations.delete(cancel);
    }
  };
  const invalidatePendingWork = () => {
    generation += 1;
    cacheGeneration += 1;
    cancellations.forEach((cancel) => cancel());
    inFlight.forEach((job) => job.resolve());
    inFlight.clear();
  };

  const withRequestSlot = async <T>(
    work: () => Promise<T>,
    check: (error?: unknown) => void,
  ) => {
    if (active >= MAX_IN_FLIGHT)
      await new Promise<void>((resolve) => queued.push(resolve));
    else active += 1;
    try {
      check();
      const result = await work();
      check();
      return result;
    } catch (error) {
      check(error);
      throw error;
    } finally {
      const next = queued.shift();
      if (next) next();
      else active -= 1;
    }
  };
  const complete = async (
    sources: OpenAITranslationMap,
    sourceLanguages: OpenAIRecordSourceMap,
    targetLanguage: TargetLanguage,
    diagnostics: OpenAIProviderDiagnostics,
    check: (error?: unknown) => void,
    onProvenance: (provenance: BackendProvenanceMap) => void,
  ) => {
    const queuedAt = performance.now();
    return withRequestSlot(async () => {
      const requestStartedAt = performance.now();
      diagnostics.queueMs += requestStartedAt - queuedAt;
      diagnostics.requestCount += 1;
      try {
        return await deps.completeHtml(
          sources,
          sourceLanguages,
          targetLanguage,
          (usage) => {
            if (usage.inputTokens !== undefined)
              diagnostics.inputTokens =
                (diagnostics.inputTokens ?? 0) + usage.inputTokens;
            if (usage.outputTokens !== undefined)
              diagnostics.outputTokens =
                (diagnostics.outputTokens ?? 0) + usage.outputTokens;
            if (usage.reasoningTokens !== undefined)
              diagnostics.reasoningTokens =
                (diagnostics.reasoningTokens ?? 0) + usage.reasoningTokens;
            if (usage.cachedInputTokens !== undefined)
              diagnostics.cachedInputTokens =
                (diagnostics.cachedInputTokens ?? 0) + usage.cachedInputTokens;
          },
          onProvenance,
        );
      } finally {
        diagnostics.requestMs += performance.now() - requestStartedAt;
      }
    }, check);
  };

  const requestFailure = (error: unknown) => {
    const failure = toHtmlTranslateFailure(0, error);
    return {
      scope: failure.scope,
      message: failure.message,
      retryable: failure.retryable,
      ...(failure.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: failure.retryAfterMs }),
    } satisfies Omit<HtmlTranslateFailure, "index">;
  };

  const cacheAccepted = async (
    sourceArray2d: string[][],
    translatedArray2d: string[][],
    targetLanguage: TargetLanguage,
    options: OpenAITranslateOptions,
    provenance?: OpenAIFallbackProvenance,
    diagnostics?: Pick<
      ProviderDiagnostics,
      "storageWriteCalls" | "storageWriteMs"
    >,
  ): Promise<number> => {
    const currentGeneration = cacheGeneration;
    if (
      sourceArray2d.length !== translatedArray2d.length ||
      sourceArray2d.some(
        (sources, index) =>
          !Array.isArray(sources) ||
          !Array.isArray(translatedArray2d[index]) ||
          sources.length !== translatedArray2d[index]!.length,
      )
    )
      return 0;
    const entries: Record<string, string> = {};
    for (const [pieceIndex, sources] of sourceArray2d.entries()) {
      for (const [nodeIndex, source] of sources.entries()) {
        const translated = translatedArray2d[pieceIndex]![nodeIndex];
        if (typeof source !== "string" || typeof translated !== "string")
          return 0;
        const normalized = fixString(source);
        if (isDeterministicTranslationValue(normalized)) continue;
        const sourceLanguage = resolveRecordSourceLanguage(
          normalized,
          options.sourceLanguageHint,
        );
        const assessment = assessProviderTranslation(
          normalized,
          translated,
          targetLanguage,
          validationHint(sourceLanguage),
        );
        if (assessment.status !== "accepted") continue;
        const key = provenance
          ? await savedOpenAiFallbackKey(
              targetLanguage,
              normalized,
              sourceLanguage,
            )
          : await savedOpenAiTranslationKey(
              targetLanguage,
              normalized,
              sourceLanguage,
              deps.model?.(),
            );
        entries[key] = JSON.stringify({
          t: assessment.text,
          ...(provenance ? { p: provenance } : {}),
        } satisfies AcceptedEntry);
      }
    }
    const saved = Object.keys(entries).length;
    if (!saved || currentGeneration !== cacheGeneration) return 0;
    const writeStartedAt = performance.now();
    if (diagnostics) diagnostics.storageWriteCalls += 1;
    try {
      await deps.storage.setMany(entries);
      return currentGeneration === cacheGeneration ? saved : 0;
    } catch {
      return 0;
    } finally {
      if (diagnostics)
        diagnostics.storageWriteMs += performance.now() - writeStartedAt;
    }
  };

  return {
    invalidatePendingWork,
    async translateHtml(
      sourceArray2d: string[][],
      targetLanguage: TargetLanguage,
      options: OpenAITranslateOptions = {},
    ): Promise<OpenAIHtmlTranslateResult> {
      return withPendingWork(async (check) => {
        const owned: RecordJob[] = [];
        try {
          const currentGeneration = cacheGeneration;
          const results: string[][] = sourceArray2d.map(() => []);
          const cacheableResults = sourceArray2d.map((row) =>
            row.map(() => ""),
          );
          const provenance = sourceArray2d.map((row) =>
            row.map(() => undefined as "google" | undefined),
          );
          const values = sourceArray2d.map((nodes) =>
            nodes.map((source) => {
              const normalized = fixString(source);
              return isDeterministicTranslationValue(normalized)
                ? normalized
                : undefined;
            }),
          );
          const diagnostics: OpenAIProviderDiagnostics = {
            records: 0,
            sourceCharacters: 0,
            requestCount: 0,
            queueMs: 0,
            requestMs: 0,
            rejectedCount: 0,
            rejectionReasons: {},
            localCacheHits: 0,
            localCacheMisses: 0,
            localCacheInvalid: 0,
            chainCacheHits: 0,
            providerAccepted: 0,
            providerRejected: 0,
            storageReadCalls: 0,
            storageWriteCalls: 0,
            storageReadMs: 0,
            storageWriteMs: 0,
          };
          const reject = (reason: TranslationRejectionReason, count = 1) => {
            if (count <= 0) return;
            diagnostics.rejectedCount += count;
            diagnostics.rejectionReasons[reason] =
              (diagnostics.rejectionReasons[reason] ?? 0) + count;
          };
          const candidates = await Promise.all(
            sourceArray2d.flatMap((nodes, pieceIndex) =>
              nodes.flatMap((source, nodeIndex) => {
                const normalized = fixString(source);
                if (isDeterministicTranslationValue(normalized)) return [];
                const sourceLanguage = resolveRecordSourceLanguage(
                  normalized,
                  options.sourceLanguageHint,
                );
                return [
                  savedOpenAiTranslationKeys(
                    targetLanguage,
                    normalized,
                    sourceLanguage,
                    deps.model?.(),
                  ).then(
                    ({ openAi: cacheKey, fallback: fallbackCacheKey }) => ({
                      pieceIndex,
                      nodeIndex,
                      source: normalized,
                      sourceLanguage,
                      cacheKey,
                      fallbackCacheKey,
                    }),
                  ),
                ];
              }),
            ),
          );
          check();
          const owners: RecordOwner[] = [];
          for (const candidate of candidates) {
            let job = inFlight.get(candidate.cacheKey);
            if (!job) {
              let resolve = () => undefined as void;
              job = {
                source: candidate.source,
                sourceLanguage: candidate.sourceLanguage,
                cacheKey: candidate.cacheKey,
                fallbackCacheKey: candidate.fallbackCacheKey,
                wait: new Promise<void>((done) => {
                  resolve = done;
                }),
                resolve,
              };
              inFlight.set(candidate.cacheKey, job);
              owned.push(job);
            }
            owners.push({
              pieceIndex: candidate.pieceIndex,
              nodeIndex: candidate.nodeIndex,
              job,
            });
          }

          let cached: Record<string, string> = {};
          if (owned.length) {
            const readStartedAt = performance.now();
            diagnostics.storageReadCalls += 1;
            try {
              cached = await deps.storage.getMany(
                owned.flatMap((job) => [job.cacheKey, job.fallbackCacheKey]),
              );
            } catch {
              cached = {};
            } finally {
              diagnostics.storageReadMs += performance.now() - readStartedAt;
            }
          }
          check();
          const pending: RecordJob[] = [];
          for (const job of owned) {
            const value = cached[job.cacheKey];
            const openAiAccepted = value
              ? parseCache(
                  value,
                  job.source,
                  targetLanguage,
                  job.sourceLanguage,
                )
              : undefined;
            if (value !== undefined && !openAiAccepted)
              diagnostics.localCacheInvalid += 1;
            const fallbackValue = cached[job.fallbackCacheKey];
            const fallbackAccepted = openAiAccepted
              ? undefined
              : fallbackValue
                ? parseFallbackCache(
                    fallbackValue,
                    job.source,
                    targetLanguage,
                    job.sourceLanguage,
                  )
                : undefined;
            if (
              !openAiAccepted &&
              fallbackValue !== undefined &&
              !fallbackAccepted
            )
              diagnostics.localCacheInvalid += 1;
            const accepted = openAiAccepted ?? fallbackAccepted;
            if (accepted) {
              diagnostics.localCacheHits += 1;
              if (fallbackAccepted) diagnostics.chainCacheHits += 1;
              job.value = accepted;
              if (inFlight.get(job.cacheKey) === job)
                inFlight.delete(job.cacheKey);
              job.resolve();
            } else {
              diagnostics.localCacheMisses += 1;
              pending.push(job);
            }
          }

          if (options.cacheOnly) {
            pending.forEach((job) => {
              job.failure = {
                scope: "record",
                message: "Not sent to the backend: on-device path",
                retryable: false,
              };
              if (inFlight.get(job.cacheKey) === job)
                inFlight.delete(job.cacheKey);
              job.resolve();
            });
            pending.length = 0;
          }
          diagnostics.records = pending.length;
          diagnostics.sourceCharacters = pending.reduce(
            (total, job) => total + job.source.length,
            0,
          );
          if (pending.length) {
            const apiKey = (await deps.getApiKey()).trim();
            check();
            if (!apiKey) {
              reject("provider-error", pending.length);
              diagnostics.providerRejected += pending.length;
              pending.forEach((job) => {
                job.failure = {
                  scope: "run",
                  message: "OpenAI API key is missing",
                  retryable: false,
                };
              });
            } else {
              const { batches, oversized } = packRecords(pending);
              reject("invalid-response", oversized.length);
              diagnostics.providerRejected += oversized.length;
              oversized.forEach((job) => {
                job.failure = {
                  scope: "record",
                  message:
                    "OpenAI source record exceeds the 8,000-character limit",
                  retryable: false,
                };
              });
              await Promise.all(
                batches.map(async (batch) => {
                  const sources = sourceMap(batch);
                  const sourceLanguages = sourceLanguageMap(batch);
                  let provenance: BackendProvenanceMap = {};
                  try {
                    const checked = validateMap(
                      await complete(
                        sources,
                        sourceLanguages,
                        targetLanguage,
                        diagnostics,
                        check,
                        (value) => {
                          provenance = value;
                        },
                      ),
                      sources,
                      sourceLanguages,
                      targetLanguage,
                    );
                    check();
                    for (const reason of checked.rejected.values())
                      reject(reason);
                    diagnostics.providerAccepted += checked.valid.size;
                    diagnostics.providerRejected += checked.rejected.size;
                    for (const [id, value] of checked.valid) {
                      const job = batch[Number(id.slice(1))];
                      if (job) {
                        job.value = value;
                        job.cacheable = true;
                        if (provenance[id] === "google")
                          job.provenance = "google";
                      }
                    }
                    for (const id of checked.unresolved) {
                      const job = batch[Number(id.slice(1))];
                      if (job)
                        // The backend stage already applied the OpenAI retry
                        // policy and its Google fallback; the record goes
                        // straight to the on-device stage.
                        job.failure = {
                          scope: "record",
                          message:
                            "Invalid provider response: unresolved translation",
                          retryable: false,
                        };
                    }
                  } catch (error) {
                    check(error);
                    const failure = requestFailure(error);
                    reject("provider-error", batch.length);
                    diagnostics.providerRejected += batch.length;
                    batch.forEach((job) => {
                      job.failure = failure;
                    });
                  }
                }),
              );
              check();
              const accepted = Object.fromEntries(
                pending.flatMap((job) =>
                  !job.value
                    ? []
                    : job.provenance
                      ? [
                          [
                            job.fallbackCacheKey,
                            JSON.stringify({
                              ...job.value,
                              p: job.provenance,
                            } satisfies OpenAIFallbackEntry),
                          ],
                        ]
                      : [[job.cacheKey, JSON.stringify(job.value)]],
                ),
              );
              if (
                !options.deferCache &&
                currentGeneration === cacheGeneration &&
                Object.keys(accepted).length > 0
              ) {
                const writeStartedAt = performance.now();
                diagnostics.storageWriteCalls += 1;
                try {
                  await deps.storage.setMany(accepted);
                } catch {
                  // Accepted DOM results survive storage failures; only reuse is lost.
                } finally {
                  diagnostics.storageWriteMs +=
                    performance.now() - writeStartedAt;
                }
              }
            }
            pending.forEach((job) => {
              if (inFlight.get(job.cacheKey) === job)
                inFlight.delete(job.cacheKey);
              job.resolve();
            });
          }

          await Promise.all(owners.map(({ job }) => job.wait));
          check();
          for (const job of owners.map(({ job }) => job)) {
            if (job.error) throw job.error;
          }
          const failureByPiece = new Map<
            number,
            Omit<HtmlTranslateFailure, "index">
          >();
          for (const { pieceIndex, nodeIndex, job } of owners) {
            if (job.value) {
              values[pieceIndex]![nodeIndex] = job.value.t;
              if (job.cacheable) {
                cacheableResults[pieceIndex]![nodeIndex] = job.value.t;
                provenance[pieceIndex]![nodeIndex] = job.provenance;
              }
            } else if (job.failure && !failureByPiece.has(pieceIndex))
              failureByPiece.set(pieceIndex, job.failure);
          }
          values.forEach((piece, index) => {
            if (piece.some((value) => value !== undefined))
              results[index] = piece.map((value) => value ?? "");
          });
          return {
            ...(options.deferCache ? { cacheableResults } : {}),
            results,
            provenance,
            failures: [...failureByPiece].map(([index, failure]) => ({
              index,
              ...failure,
            })),
            diagnostics,
          };
        } catch (error) {
          owned.forEach((job) => {
            job.error = error;
          });
          throw error;
        } finally {
          owned.forEach((job) => {
            if (inFlight.get(job.cacheKey) === job)
              inFlight.delete(job.cacheKey);
            job.resolve();
          });
        }
      });
    },
    async translateText(
      texts: string[],
      targetLanguage: TargetLanguage,
      options?: OpenAITranslateOptions,
    ) {
      const result = await this.translateHtml(
        texts.map((text) => [text]),
        targetLanguage,
        options,
      );
      return {
        results: result.results.map((nodes) => nodes[0] ?? ""),
        provenance: result.provenance.map((nodes) => nodes[0]),
        failures: result.failures,
        diagnostics: result.diagnostics,
      };
    },
    async cacheAcceptedHtml(
      sources: string[][],
      results: string[][],
      targetLanguage: TargetLanguage,
      options: OpenAITranslateOptions = {},
      diagnostics?: Pick<
        ProviderDiagnostics,
        "storageWriteCalls" | "storageWriteMs"
      >,
    ) {
      return cacheAccepted(
        sources,
        results,
        targetLanguage,
        options,
        undefined,
        diagnostics,
      );
    },
    async cacheFallbackTranslations(
      sources: string[][],
      results: string[][],
      targetLanguage: TargetLanguage,
      options: OpenAITranslateOptions = {},
      provenance: OpenAIFallbackProvenance,
    ) {
      if (provenance !== "google" && provenance !== "browser-native") return 0;
      return cacheAccepted(
        sources,
        results,
        targetLanguage,
        options,
        provenance,
      );
    },
    async clearSavedTranslations() {
      cacheGeneration += 1;
      inFlight.clear();
      const all = await deps.storage.getAll();
      const keys = Object.keys(all).filter(
        (key) =>
          key.startsWith(`${CACHE_PREFIX}openai:`) ||
          key.startsWith(FALLBACK_CACHE_PREFIX) ||
          key.startsWith(LEGACY_GOOGLE_CACHE_PREFIX),
      );
      if (keys.length) await deps.storage.remove(keys);
      return {
        removed: keys.length,
        bytes: keys.reduce(
          (total, key) => total + JSON.stringify(all[key] ?? "").length,
          0,
        ),
      };
    },
  };
}
