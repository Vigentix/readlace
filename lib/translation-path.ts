/**
 * Where a translation runs (ADR 0020):
 * - `provider`: the user's own provider key (a translation stage in the
 *   background), then the on-device recovery stage;
 * - `native`: on-device only (cache hits still apply);
 * - `unavailable`: nothing can translate here (no usable key and no
 *   on-device support).
 */
export type TranslationPath = "provider" | "native" | "unavailable";

/**
 * Which engine a translation starts from. A future hosted offer adds
 * `"hosted"` here without changing the translation flow.
 */
export type EngineSource = "byok-openai" | "on-device";

/**
 * On-device Translator support where translation runs:
 * - `unsupported`: no Translator API (not Chrome 138+ desktop);
 * - `unavailable`: the API exists but this language pair cannot translate;
 * - `downloadable` / `downloading` / `available`: the pair can translate;
 * - `unknown`: the API exists and the pair has not been checked yet.
 */
export type NativeTranslationAvailability =
  | "unsupported"
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available"
  | "unknown";

const NATIVE_CAPABLE: ReadonlySet<NativeTranslationAvailability> = new Set([
  "downloadable",
  "downloading",
  "available",
  "unknown",
]);

export interface EngineState {
  /** A key is saved for the active provider. */
  keyConfigured: boolean;
  /** The provider refused the saved key (401/403) since it was saved. */
  keyRejected: boolean;
}

/** Pure engine-source selector: a saved, accepted key wins. */
export function chooseEngineSource(state: EngineState): EngineSource {
  return state.keyConfigured && !state.keyRejected
    ? "byok-openai"
    : "on-device";
}

/** Pure client path selector over the engine source and native support. */
export function chooseTranslationPath(
  engineSource: EngineSource,
  nativeAvailability: NativeTranslationAvailability,
): TranslationPath {
  if (engineSource === "byok-openai") return "provider";
  return NATIVE_CAPABLE.has(nativeAvailability) ? "native" : "unavailable";
}

/** Whether the path selector needs native availability for this source. */
export function translationPathNeedsNative(engineSource: EngineSource) {
  return chooseTranslationPath(engineSource, "available") !== "provider";
}

export function isTranslationPath(value: unknown): value is TranslationPath {
  return value === "provider" || value === "native" || value === "unavailable";
}

/**
 * Feature detection for the on-device Translator API (Chrome 138+ desktop).
 * Installed-runtime capability evidence still governs any success claim.
 */
export function onDeviceTranslatorSupported(scope: object = globalThis) {
  const factory = (scope as { Translator?: { create?: unknown } }).Translator;
  return typeof factory?.create === "function";
}
