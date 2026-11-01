import { routeTranslationStage } from "@/shared/engine-router";
import {
  createOpenAiCompleter,
  type OpenAIRecordSourceMap,
  type OpenAIRequestUsage,
  type OpenAITranslationMap,
} from "@/shared/openai-completer";
import { runOpenAIStage, type OpenAICompleter } from "@/shared/openai-stage";
import {
  TRANSLATION_STAGE_DEADLINE_MS,
  type ApiTargetLanguage,
} from "@/shared/translation-api";
import type { BackendProvenanceMap } from "@/lib/translate/openai-html";

export interface ByokCredentials {
  apiKey: string;
  model: string;
}

export interface ByokStageDependencies {
  /** Read fresh for every stage, so a removed or changed key applies at once. */
  readCredentials(): Promise<ByokCredentials | undefined>;
  createCompleter?(apiKey: string, model: string): OpenAICompleter;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** OpenAI refused the key itself (401/403); later work can step down. */
  onKeyRejected?(status: 401 | 403): void;
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * One translation stage run in the extension background with the user's own
 * OpenAI key (ADR 0020). It reuses the backend's router, so the per-record
 * ceiling stays `3 OpenAI` inside a stage before the on-device stage; there
 * is no Google fallback. Records it cannot translate come back empty. The key
 * never leaves this function except in the request to OpenAI.
 */
export function createByokStage(deps: ByokStageDependencies) {
  const createCompleter =
    deps.createCompleter ??
    ((apiKey: string, model: string) =>
      createOpenAiCompleter(apiKey, globalThis.fetch.bind(globalThis), model));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? abortableSleep;
  return async (
    sources: OpenAITranslationMap,
    sourceLanguages: OpenAIRecordSourceMap,
    targetLanguage: ApiTargetLanguage,
    onUsage?: (usage: OpenAIRequestUsage) => void,
    onProvenance?: (provenance: BackendProvenanceMap) => void,
  ): Promise<OpenAITranslationMap> => {
    const ids = Object.keys(sources);
    const unresolved = () => Object.fromEntries(ids.map((id) => [id, ""]));
    const credentials = await deps.readCredentials();
    if (!credentials || !ids.length) return unresolved();
    const complete = createCompleter(credentials.apiKey, credentials.model);
    let rejected = false;
    let runFailure: number | undefined;
    const response = await routeTranslationStage(
      {
        targetLanguage,
        sources: [ids.map((id) => sources[id]!)],
        sourceRoutes: [ids.map((id) => sourceLanguages[id]!)],
      },
      {
        openAi: async (request, signal) => {
          const stage = await runOpenAIStage(
            credentials.apiKey,
            request,
            signal,
            complete,
          );
          const failure = stage.failures[0];
          const status = failure?.status;
          if (status === 401 || status === 403) {
            if (!rejected) {
              rejected = true;
              deps.onKeyRejected?.(status);
            }
          } else if (failure && !failure.retryable) runFailure = status ?? 0;
          return stage;
        },
        now,
        sleep,
      },
      new AbortController().signal,
      now() + TRANSLATION_STAGE_DEADLINE_MS,
    );
    // A rejected key leaves the records unresolved for the on-device stage,
    // like a refused plan did. Any other non-retryable provider error (a bad
    // request, an unknown model) ends the run, as a failed stage did.
    if (runFailure !== undefined)
      throw Object.assign(
        new Error(
          runFailure
            ? `Translation provider failed (${runFailure})`
            : "Translation provider failed",
        ),
        { status: runFailure, retryable: false },
      );
    const { diagnostics } = response;
    onUsage?.({
      ...(diagnostics.inputTokens === undefined
        ? {}
        : { inputTokens: diagnostics.inputTokens }),
      ...(diagnostics.outputTokens === undefined
        ? {}
        : { outputTokens: diagnostics.outputTokens }),
      ...(diagnostics.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: diagnostics.reasoningTokens }),
      ...(diagnostics.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: diagnostics.cachedInputTokens }),
    });
    const provenance: BackendProvenanceMap = {};
    ids.forEach((id, index) => {
      if (response.provenance?.[0]?.[index] === "openai")
        provenance[id] = "openai";
    });
    onProvenance?.(provenance);
    return Object.fromEntries(
      ids.map((id, index) => [id, response.results[0]?.[index] ?? ""]),
    );
  };
}
