/**
 * Engines the backend may route a translation stage through. The client never
 * chooses one; it only receives per-record provenance.
 */
export const TRANSLATION_ENGINES = ["openai", "google"] as const;
export type TranslationEngine = (typeof TRANSLATION_ENGINES)[number];

export const TARGET_LANGUAGES = ["en", "vi", "ja"] as const;
export type ApiTargetLanguage = (typeof TARGET_LANGUAGES)[number];
export type ApiSourceLanguage = ApiTargetLanguage | "auto";

export const TRANSLATION_STAGE_PATH = "/v1/translation-stages";
/**
 * Every extension request carries its manifest version here so the backend
 * can enforce `MIN_EXTENSION_VERSION` (ADR 0016).
 */
export const EXTENSION_VERSION_HEADER = "x-readlace-extension-version";
/** HTTP status for `CLIENT_UPDATE_REQUIRED`; never 401 or 429 (auth codes). */
export const CLIENT_UPDATE_REQUIRED_STATUS = 426;
export const TRANSLATION_STAGE_MAX_RECORDS = 128;
export const TRANSLATION_STAGE_MAX_SOURCE_CHARACTERS = 8_000;
export const MAX_HTTP_BODY_BYTES = 65_536;
export const PROVIDER_CONCURRENCY = 2;
export const PROVIDER_QUEUE_LIMIT = 2;
export const PROVIDER_GLOBAL_CONCURRENCY = 4;
export const PROVIDER_GLOBAL_QUEUE_LIMIT = 4;
/** Bound for one engine request (one OpenAI attempt or one Google call). */
export const PROVIDER_STAGE_TIMEOUT_MS = 30_000;
/** Bound for one routed stage: queue admission, OpenAI attempts and Google. */
export const TRANSLATION_STAGE_DEADLINE_MS = 60_000;
export const MIN_PASSWORD_CHARACTERS = 12;
export const MAX_PASSWORD_CHARACTERS = 128;
export const ACCOUNT_PASSWORD_LENGTH_MESSAGE =
  "Password must be between 12 and 128 characters";

export const API_ERROR_CODES = [
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "AUTH_REPLAY_DETECTED",
  "ACCOUNT_EXISTS",
  "ACCOUNT_NOT_FOUND",
  "INVALID_PASSWORD",
  "PROVISIONING_DISABLED",
  "PROVISIONING_FORBIDDEN",
  "PAYLOAD_TOO_LARGE",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "CLIENT_UPDATE_REQUIRED",
  "HANDOFF_INVALID",
  "ENTITLEMENT_REQUIRED",
  "ALREADY_SUBSCRIBED",
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type RequestValidationErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_EMAIL"
  | "INVALID_PASSWORD"
  | "PASSWORD_LENGTH"
  | "PROVIDER_PAYLOAD_TOO_LARGE";

export class RequestValidationError extends Error {
  constructor(
    readonly code: RequestValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RequestValidationError";
  }
}

/**
 * Counts that travel with `QUOTA_EXHAUSTED` (ADR 0011): source characters
 * used in the current quota window, its hard cap, and when the window
 * resets. Counts only, never content.
 */
export interface QuotaErrorDetails {
  used: number;
  limit: number;
  resetsAt: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
  } & Partial<QuotaErrorDetails>;
}

export interface AuthLoginRequest {
  email: string;
  password: string;
}

export interface AuthRefreshRequest {
  refreshToken: string;
}

/** Web sign-in handoff exchange (ADR 0012). */
export const AUTH_HANDOFF_PATH = "/v1/auth/handoff";
/** 32 random bytes, base64url without padding. */
export const HANDOFF_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AuthHandoffRequest {
  code: string;
}

export function isHandoffCode(value: unknown): value is string {
  return typeof value === "string" && HANDOFF_CODE_PATTERN.test(value);
}

export interface AuthTokenResponse {
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

export interface AuthUserResponse {
  authenticated: true;
  user: {
    id: string;
    email: string;
  };
  /**
   * Plan snapshot (ADR 0011/0013). Untrusted on the client: validate with
   * `parseEntitlementSnapshot` before use.
   */
  entitlement?: unknown;
  /**
   * Quota usage in the current window (trial/Pro only). Untrusted on the
   * client: validate with `parseQuotaUsage` before use.
   */
  usage?: unknown;
}

export type CreateAccountRequest = AuthLoginRequest;

export type ResetAccountPasswordRequest = AuthLoginRequest;

export interface AccountResponse {
  id: string;
  email: string;
  status: "active" | "disabled";
  createdAt: string;
}

export interface TranslationStageRequest {
  targetLanguage: ApiTargetLanguage;
  sourceLanguageHint?: ApiTargetLanguage;
  sources: string[][];
  sourceRoutes: ApiSourceLanguage[][];
}

export interface ProviderStageFailure {
  index: number;
  scope: "record" | "run";
  message: string;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}

export interface ProviderStageDiagnostics {
  records: number;
  sourceCharacters: number;
  requestCount: number;
  requestMs: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  /** Routed stages only: engine cost inputs for unit economics. */
  openAiRequestCount?: number;
  googleRequestCount?: number;
  googleSourceCharacters?: number;
  googleBudgetExhausted?: boolean;
}

/** One engine request's aligned outcome inside the backend router. */
export interface ProviderStageResponse {
  results: string[][];
  failures: ProviderStageFailure[];
  diagnostics: ProviderStageDiagnostics;
}

/**
 * A routed stage. `provenance` is aligned with `results`: the engine that
 * produced an accepted value, or `null` for an unresolved record.
 */
export interface TranslationStageResponse extends ProviderStageResponse {
  provenance: (TranslationEngine | null)[][];
}

export function isTranslationEngine(
  value: unknown,
): value is TranslationEngine {
  return (
    typeof value === "string" &&
    TRANSLATION_ENGINES.includes(value as TranslationEngine)
  );
}

export function isApiTargetLanguage(
  value: unknown,
): value is ApiTargetLanguage {
  return (
    typeof value === "string" &&
    TARGET_LANGUAGES.includes(value as ApiTargetLanguage)
  );
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: QuotaErrorDetails,
): ApiErrorBody {
  return { error: { code, message, ...details } };
}

export function normalizeAccountEmail(value: unknown): string {
  if (typeof value !== "string")
    throw new RequestValidationError("INVALID_EMAIL", "Invalid email");
  const email = value.trim().toLowerCase();
  const separator = email.indexOf("@");
  if (
    email.length < 3 ||
    email.length > 320 ||
    /\s/.test(email) ||
    separator < 1 ||
    separator !== email.lastIndexOf("@") ||
    separator === email.length - 1
  )
    throw new RequestValidationError("INVALID_EMAIL", "Invalid email");
  return email;
}

export function validateAccountPassword(value: unknown): string {
  if (typeof value !== "string")
    throw new RequestValidationError("INVALID_PASSWORD", "Invalid password");
  const length = Array.from(value).length;
  if (length < MIN_PASSWORD_CHARACTERS || length > MAX_PASSWORD_CHARACTERS)
    throw new RequestValidationError(
      "PASSWORD_LENGTH",
      ACCOUNT_PASSWORD_LENGTH_MESSAGE,
    );
  return value;
}

export function parseAuthLoginRequest(value: unknown): AuthLoginRequest {
  if (!value || typeof value !== "object")
    throw new RequestValidationError("INVALID_REQUEST", "Invalid request");
  const candidate = value as Record<string, unknown>;
  return {
    email: normalizeAccountEmail(candidate.email),
    password: validateAccountPassword(candidate.password),
  };
}

export const parseCreateAccountRequest = parseAuthLoginRequest;

export const parseResetAccountPasswordRequest = parseAuthLoginRequest;

export function isStringMatrix(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length > 0 &&
        row.every((entry) => typeof entry === "string"),
    )
  );
}

export function isSourceRouteMatrix(
  value: unknown,
  sources: string[][],
): value is ApiSourceLanguage[][] {
  return (
    Array.isArray(value) &&
    value.length === sources.length &&
    value.every(
      (row, rowIndex) =>
        Array.isArray(row) &&
        row.length === sources[rowIndex]?.length &&
        row.every((entry) => entry === "auto" || isApiTargetLanguage(entry)),
    )
  );
}

export function sourceCharacters(sources: string[][]): number {
  return sources.reduce(
    (total, row) =>
      total + row.reduce((rowTotal, value) => rowTotal + value.length, 0),
    0,
  );
}

export function sourceRecords(sources: string[][]): number {
  return sources.reduce((total, row) => total + row.length, 0);
}

const TRANSLATION_STAGE_REQUEST_KEYS = new Set([
  "targetLanguage",
  "sourceLanguageHint",
  "sources",
  "sourceRoutes",
]);

/**
 * Parses a routed stage request. Unknown keys, including any engine or
 * provider choice, are rejected: the backend owns engine routing.
 */
export function parseTranslationStageRequest(
  value: unknown,
): TranslationStageRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestValidationError("INVALID_REQUEST", "Invalid request");
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).some(
      (key) => !TRANSLATION_STAGE_REQUEST_KEYS.has(key),
    ) ||
    !isApiTargetLanguage(candidate.targetLanguage) ||
    (candidate.sourceLanguageHint !== undefined &&
      !isApiTargetLanguage(candidate.sourceLanguageHint)) ||
    !isStringMatrix(candidate.sources) ||
    !isSourceRouteMatrix(candidate.sourceRoutes, candidate.sources)
  )
    throw new RequestValidationError("INVALID_REQUEST", "Invalid request");
  const records = sourceRecords(candidate.sources);
  const characters = sourceCharacters(candidate.sources);
  if (
    records > TRANSLATION_STAGE_MAX_RECORDS ||
    characters > TRANSLATION_STAGE_MAX_SOURCE_CHARACTERS
  )
    throw new RequestValidationError(
      "PROVIDER_PAYLOAD_TOO_LARGE",
      "Payload exceeds provider limits",
    );
  return {
    targetLanguage: candidate.targetLanguage,
    ...(candidate.sourceLanguageHint === undefined
      ? {}
      : { sourceLanguageHint: candidate.sourceLanguageHint }),
    sources: candidate.sources,
    sourceRoutes: candidate.sourceRoutes,
  };
}
