import type { TranslationRejectionReason } from "@/lib/translate/translation-diagnostics";

export interface SavedTranslationStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  getMany(keys: string[]): Promise<Record<string, string>>;
  setMany(entries: Record<string, string>): Promise<void>;
  getAll(): Promise<Record<string, string>>;
  remove(keys: string[]): Promise<void>;
}

export interface HtmlTranslateFailure {
  index: number;
  scope: "record" | "run";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface HtmlTranslateResult {
  cacheableResults?: string[][];
  results: string[][];
  failures: HtmlTranslateFailure[];
  diagnostics?: ProviderDiagnostics;
}

export interface ProviderDiagnostics {
  records: number;
  sourceCharacters: number;
  requestCount: number;
  queueMs: number;
  requestMs: number;
  rejectedCount: number;
  rejectionReasons: Partial<Record<TranslationRejectionReason, number>>;
  localCacheHits: number;
  localCacheMisses: number;
  localCacheInvalid: number;
  providerAccepted: number;
  providerRejected: number;
  storageReadCalls: number;
  storageWriteCalls: number;
  storageReadMs: number;
  storageWriteMs: number;
}

const MAX_RETRY_AFTER_MS = 30_000;

function errorRecord(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

function retryAfterMs(headers: unknown) {
  const value =
    typeof Headers !== "undefined" && headers instanceof Headers
      ? headers.get("retry-after")
      : Object.entries(errorRecord(headers)).find(
          ([name]) => name.toLowerCase() === "retry-after",
        )?.[1];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(delay)));
}

export function toHtmlTranslateFailure(
  index: number,
  error: unknown,
): HtmlTranslateFailure {
  const outer = errorRecord(error);
  const detail = errorRecord(outer.lastError ?? outer.cause ?? error);
  const response = errorRecord(detail.response);
  const statusValue =
    detail.statusCode ?? detail.status ?? response.status ?? outer.statusCode;
  const status = typeof statusValue === "number" ? statusValue : undefined;
  const name =
    typeof detail.name === "string"
      ? detail.name
      : error instanceof Error
        ? error.name
        : "";
  const explicitRetryable = detail.retryable ?? detail.isRetryable;
  const retryable =
    typeof explicitRetryable === "boolean"
      ? explicitRetryable
      : name.startsWith("AI_Invalid") || name === "AI_LoadAPIKeyError"
        ? false
        : status === undefined ||
          status === 408 ||
          status === 429 ||
          (status >= 500 && status <= 599);
  const explicitDelay = detail.retryAfterMs;
  const delay =
    typeof explicitDelay === "number" && Number.isFinite(explicitDelay)
      ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(explicitDelay)))
      : retryAfterMs(detail.responseHeaders ?? response.headers);
  return {
    index,
    scope: retryable ? "record" : "run",
    message:
      error instanceof Error ? error.message : "Translation provider error",
    retryable,
    ...(retryable && delay !== undefined ? { retryAfterMs: delay } : {}),
  };
}
