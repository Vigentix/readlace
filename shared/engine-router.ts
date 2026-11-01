import {
  PROVIDER_STAGE_TIMEOUT_MS,
  sourceCharacters,
  sourceRecords,
  type ApiSourceLanguage,
  type ProviderStageDiagnostics,
  type ProviderStageFailure,
  type ProviderStageResponse,
  type TranslationEngine,
  type TranslationStageRequest,
  type TranslationStageResponse,
} from "./translation-api.js";

/** Characters a fallback engine may still spend in the current period. */
export interface FallbackBudget {
  /** Reserves `characters`, or returns false when they do not fit. */
  reserve(characters: number): Promise<boolean>;
  /** Returns unbilled characters from an earlier reservation. */
  release(characters: number): Promise<void>;
}

/** Per record per routed stage: at most this many OpenAI attempts. */
export const OPENAI_MAX_ATTEMPTS = 3;
/** Delays before the second and third OpenAI attempts without `Retry-After`. */
export const OPENAI_RETRY_DELAYS_MS = [500, 1_500] as const;
export const MAX_RETRY_AFTER_MS = 30_000;
/** OpenAI attempts and retry waits stop this long before the stage deadline. */
export const GOOGLE_FALLBACK_RESERVE_MS = 10_000;

export type EngineStage = (
  request: TranslationStageRequest,
  signal: AbortSignal,
) => Promise<ProviderStageResponse>;

/**
 * The hosted backend passes a budget-capped Google fallback (ADR 0014). The
 * bring-your-own-key extension passes none (ADR 0020): OpenAI attempts may
 * then use the whole stage deadline, and unresolved records go straight to
 * the client's on-device stage.
 */
export type EngineRouterDependencies = {
  openAi: EngineStage;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
} & (
  | { google: EngineStage; googleBudget: FallbackBudget }
  | { google?: undefined; googleBudget?: undefined }
);

interface RecordState {
  row: number;
  column: number;
  source: string;
  route: ApiSourceLanguage;
  value?: string;
  engine?: TranslationEngine;
}

/**
 * Server-side quality miss: an empty value, or the unchanged source when the
 * record's route is not already the target. The client still runs its full
 * local validation on every accepted value.
 */
function qualityMiss(
  record: RecordState,
  value: string | undefined,
  request: TranslationStageRequest,
) {
  return (
    !value?.trim() ||
    (record.route !== request.targetLanguage &&
      value.trim() === record.source.trim())
  );
}

function subRequest(
  request: TranslationStageRequest,
  records: RecordState[],
): TranslationStageRequest {
  return {
    targetLanguage: request.targetLanguage,
    ...(request.sourceLanguageHint === undefined
      ? {}
      : { sourceLanguageHint: request.sourceLanguageHint }),
    sources: [records.map((record) => record.source)],
    sourceRoutes: [records.map((record) => record.route)],
  };
}

function boundedSignal(signal: AbortSignal, ms: number) {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, Math.min(PROVIDER_STAGE_TIMEOUT_MS, ms))),
  ]);
}

function addUsage(
  total: ProviderStageDiagnostics,
  next: ProviderStageDiagnostics,
) {
  for (const key of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedInputTokens",
  ] as const)
    if (next[key] !== undefined) total[key] = (total[key] ?? 0) + next[key];
}

/**
 * Routes one stage through OpenAI, retrying failed or quality-missed records,
 * then sends the still-unresolved records once to the official Google Cloud
 * Translation API while the monthly budget allows. Nothing here stores or logs
 * source or result text.
 */
export async function routeTranslationStage(
  request: TranslationStageRequest,
  deps: EngineRouterDependencies,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<TranslationStageResponse> {
  const startedAt = deps.now();
  const records: RecordState[] = request.sources.flatMap((row, rowIndex) =>
    row.map((source, columnIndex) => ({
      row: rowIndex,
      column: columnIndex,
      source,
      route: request.sourceRoutes[rowIndex]![columnIndex]!,
    })),
  );
  const diagnostics: ProviderStageDiagnostics = {
    records: sourceRecords(request.sources),
    sourceCharacters: sourceCharacters(request.sources),
    requestCount: 0,
    requestMs: 0,
    openAiRequestCount: 0,
    googleRequestCount: 0,
    googleSourceCharacters: 0,
  };
  const openAiCutoff =
    deadlineAt - (deps.google ? GOOGLE_FALLBACK_RESERVE_MS : 0);
  let pending = records;
  let retryAfterMs: number | undefined;
  for (
    let attempt = 1;
    attempt <= OPENAI_MAX_ATTEMPTS && pending.length && !signal.aborted;
    attempt += 1
  ) {
    if (attempt > 1) {
      const delay = Math.min(
        MAX_RETRY_AFTER_MS,
        Math.max(0, retryAfterMs ?? OPENAI_RETRY_DELAYS_MS[attempt - 2] ?? 0),
      );
      if (deps.now() + delay >= openAiCutoff) break;
      try {
        await deps.sleep(delay, signal);
      } catch {
        break;
      }
    }
    const remaining = openAiCutoff - deps.now();
    if (remaining <= 0) break;
    const response = await deps.openAi(
      subRequest(request, pending),
      boundedSignal(signal, remaining),
    );
    diagnostics.requestCount += response.diagnostics.requestCount;
    diagnostics.openAiRequestCount! += response.diagnostics.requestCount;
    addUsage(diagnostics, response.diagnostics);
    const failure: ProviderStageFailure | undefined = response.failures.find(
      (entry) => entry.index === 0,
    );
    retryAfterMs = failure?.retryAfterMs;
    const next: RecordState[] = [];
    pending.forEach((record, index) => {
      if (failure) {
        if (failure.retryable) next.push(record);
        return;
      }
      const value = response.results[0]?.[index];
      if (qualityMiss(record, value, request)) next.push(record);
      else {
        record.value = value!;
        record.engine = "openai";
      }
    });
    pending = next;
  }

  const unresolved = records.filter((record) => !record.engine);
  const googleCharacters = unresolved.reduce(
    (total, record) => total + record.source.length,
    0,
  );
  const googleRemaining = deadlineAt - deps.now();
  if (
    deps.google &&
    unresolved.length &&
    googleRemaining > 0 &&
    !signal.aborted
  ) {
    if (await deps.googleBudget.reserve(googleCharacters)) {
      let billed = 0;
      try {
        const response = await deps.google(
          subRequest(request, unresolved),
          boundedSignal(signal, googleRemaining),
        );
        billed = response.diagnostics.googleSourceCharacters ?? 0;
        diagnostics.requestCount += response.diagnostics.requestCount;
        diagnostics.googleRequestCount! += response.diagnostics.requestCount;
        diagnostics.googleSourceCharacters! += billed;
        unresolved.forEach((record, index) => {
          const value = response.results[0]?.[index];
          if (qualityMiss(record, value, request)) return;
          record.value = value!;
          record.engine = "google";
        });
      } catch {
        // Google fallback failure is never retried; the client keeps on-device.
      } finally {
        await deps.googleBudget.release(googleCharacters - billed);
      }
    } else diagnostics.googleBudgetExhausted = true;
  }

  const results = request.sources.map((row) => row.map(() => ""));
  const provenance = request.sources.map((row) =>
    row.map(() => null as TranslationEngine | null),
  );
  const unresolvedRows = new Set<number>();
  for (const record of records) {
    if (record.engine && record.value !== undefined) {
      results[record.row]![record.column] = record.value;
      provenance[record.row]![record.column] = record.engine;
    } else unresolvedRows.add(record.row);
  }
  diagnostics.requestMs = deps.now() - startedAt;
  return {
    results,
    provenance,
    failures: [...unresolvedRows].map((index) => ({
      index,
      scope: "record" as const,
      message: "Translation unavailable",
      retryable: false,
    })),
    diagnostics,
  };
}
