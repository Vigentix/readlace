import type {
  ProviderStageFailure,
  ProviderStageResponse,
  TranslationStageRequest,
} from "./translation-api.js";
import { sourceCharacters, sourceRecords } from "./translation-api.js";
import {
  createOpenAiCompleter,
  type OpenAIRecordSourceMap,
  type OpenAIRequestUsage,
  type OpenAITranslationMap,
} from "./openai-completer.js";
import { retryAfterMs, retryableStatus } from "./provider-error.js";

export type OpenAICompleter = ReturnType<typeof createOpenAiCompleter>;

function failureForRows(
  rowCount: number,
  error: unknown,
): ProviderStageFailure[] {
  const candidate = error as {
    name?: unknown;
    statusCode?: unknown;
    status?: unknown;
    isRetryable?: unknown;
    responseHeaders?: unknown;
  };
  const status = Number(candidate.statusCode ?? candidate.status ?? 0);
  const aborted =
    candidate.name === "AbortError" || candidate.name === "TimeoutError";
  const retryable =
    candidate.isRetryable === true || aborted || retryableStatus(status);
  const message = status
    ? `Translation provider failed (${status})`
    : "Translation provider failed";
  const headers =
    candidate.responseHeaders && typeof candidate.responseHeaders === "object"
      ? new Headers(
          Object.entries(candidate.responseHeaders).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const delay = retryable && headers ? retryAfterMs(headers) : undefined;
  return Array.from({ length: rowCount }, (_, index) => ({
    index,
    scope: "run" as const,
    message,
    retryable,
    ...(status ? { status } : {}),
    ...(delay === undefined ? {} : { retryAfterMs: delay }),
  }));
}

export async function runOpenAIStage(
  key: string,
  request: TranslationStageRequest,
  signal: AbortSignal,
  complete: OpenAICompleter = createOpenAiCompleter(key),
): Promise<ProviderStageResponse> {
  const startedAt = performance.now();
  const values: OpenAITranslationMap = {};
  const routes: OpenAIRecordSourceMap = {};
  const owners: { row: number; column: number; id: string }[] = [];
  request.sources.forEach((row, rowIndex) =>
    row.forEach((value, columnIndex) => {
      const id = `r${owners.length}`;
      values[id] = value;
      routes[id] = request.sourceRoutes[rowIndex]![columnIndex]!;
      owners.push({ row: rowIndex, column: columnIndex, id });
    }),
  );
  const results = request.sources.map((row) => row.map(() => ""));
  let usage: OpenAIRequestUsage = {};
  try {
    const translated = await complete(
      values,
      routes,
      request.targetLanguage,
      (value) => {
        usage = value;
      },
      signal,
    );
    owners.forEach(({ row, column, id }) => {
      results[row]![column] = translated[id] ?? "";
    });
    return {
      results,
      failures: [],
      diagnostics: {
        records: sourceRecords(request.sources),
        sourceCharacters: sourceCharacters(request.sources),
        requestCount: 1,
        requestMs: performance.now() - startedAt,
        openAiRequestCount: 1,
        ...usage,
      },
    };
  } catch (error) {
    return {
      results,
      failures: failureForRows(request.sources.length, error),
      diagnostics: {
        records: sourceRecords(request.sources),
        sourceCharacters: sourceCharacters(request.sources),
        requestCount: 1,
        requestMs: performance.now() - startedAt,
        openAiRequestCount: 1,
      },
    };
  }
}
