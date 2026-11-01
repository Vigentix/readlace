import type { TargetLanguage } from "@/lib/translation";
import { assessProviderTranslation } from "@/lib/translate/format-guards";

/**
 * In-flight `translate()` calls per prepared language pair. One prepared
 * session is reused across records, requests, frames and tabs; pipelining a
 * few calls removes the per-record round trip that made large pages slow
 * without unbounded fan-out into the on-device model (ADR 0014).
 */
export const NATIVE_TRANSLATE_CONCURRENCY = 4;

export type NativeRecoveryAvailability =
  "unavailable" | "downloadable" | "downloading" | "available";

export interface NativeRecoveryProgress {
  phase: "checking" | "downloading" | "ready";
  loaded?: number;
  total?: number;
}

export type NativeRecoveryResult =
  | { status: "accepted"; text: string }
  | { status: "unavailable" | "quality-miss" | "error"; reason: string };

export interface NativeTranslatorSession {
  translate(text: string, signal: AbortSignal): Promise<NativeRecoveryResult>;
  destroy(): void;
}

export interface PrepareNativeTranslatorMessage {
  type: "PREPARE_NATIVE_TRANSLATOR";
  sourceLanguage: TargetLanguage;
  targetLanguage: TargetLanguage;
}

export interface TranslateNativeTextMessage {
  type: "TRANSLATE_NATIVE_TEXT";
  runId: number;
  sourceLanguage: TargetLanguage;
  targetLanguage: TargetLanguage;
  texts: string[];
}

export interface QueryNativeTranslatorProgressMessage {
  type: "QUERY_NATIVE_TRANSLATOR_PROGRESS";
  sourceLanguage: TargetLanguage;
  targetLanguage: TargetLanguage;
}

export interface CancelNativeTranslationMessage {
  type: "CANCEL_NATIVE_TRANSLATION";
  runId: number;
}

export interface NativeTranslatorStatus {
  availability: NativeRecoveryAvailability;
  ready: boolean;
  progress: NativeRecoveryProgress;
}

export interface TranslateNativeTextResponse {
  runId: number;
  results: NativeRecoveryResult[];
}

interface TranslatorMonitor {
  addEventListener(
    type: "downloadprogress",
    listener: (event: { loaded: number; total: number }) => void,
  ): void;
}

interface BrowserTranslatorSession {
  translate(text: string, options: { signal: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface BrowserTranslatorFactory {
  availability(options: {
    sourceLanguage: TargetLanguage;
    targetLanguage: TargetLanguage;
  }): Promise<NativeRecoveryAvailability>;
  create(options: {
    sourceLanguage: TargetLanguage;
    targetLanguage: TargetLanguage;
    signal: AbortSignal;
    monitor(monitor: TranslatorMonitor): void;
  }): Promise<BrowserTranslatorSession>;
}

type TranslatorGlobal = typeof globalThis & {
  Translator?: BrowserTranslatorFactory;
};

interface NativeHostPair {
  sourceLanguage: TargetLanguage;
  targetLanguage: TargetLanguage;
  availability: NativeRecoveryAvailability;
  progress: NativeRecoveryProgress;
  preparation: Promise<NativeTranslatorSession | null>;
  session?: NativeTranslatorSession;
  active: number;
  waiting: (() => void)[];
}

export interface NativeTranslatorHostOptions {
  /**
   * Preparation progress for a pair, including first-use language-pack
   * download progress. Carries no page text.
   */
  onProgress?: (
    sourceLanguage: TargetLanguage,
    targetLanguage: TargetLanguage,
    progress: NativeRecoveryProgress,
  ) => void;
}

export function createNativeTranslatorHost(
  options: NativeTranslatorHostOptions = {},
) {
  const pairs = new Map<string, NativeHostPair>();
  const requests = new Map<
    string,
    { ownerKey: string; controller: AbortController }
  >();
  const requestByOwner = new Map<string, string>();
  const pairKey = (source: TargetLanguage, target: TargetLanguage) =>
    `${source}:${target}`;
  const unavailable = (): NativeTranslatorStatus => ({
    availability: "unavailable",
    ready: false,
    progress: { phase: "checking" },
  });
  const status = (pair: NativeHostPair): NativeTranslatorStatus => ({
    availability: pair.availability,
    ready: Boolean(pair.session),
    progress: pair.progress,
  });
  const cancel = (requestKey: string) => {
    const request = requests.get(requestKey);
    if (!request) return false;
    requests.delete(requestKey);
    if (requestByOwner.get(request.ownerKey) === requestKey)
      requestByOwner.delete(request.ownerKey);
    request.controller.abort();
    return true;
  };

  const acquire = (pair: NativeHostPair, signal: AbortSignal) => {
    if (pair.active < NATIVE_TRANSLATE_CONCURRENCY) {
      pair.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      // An aborted waiter takes its slot only to release it immediately.
      const abort = () => {
        const index = pair.waiting.indexOf(start);
        if (index < 0) return;
        pair.waiting.splice(index, 1);
        pair.active += 1;
        resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      pair.waiting.push(start);
    });
  };
  const release = (pair: NativeHostPair) => {
    const next = pair.waiting.shift();
    if (next) next();
    else pair.active = Math.max(0, pair.active - 1);
  };

  return {
    async prepare(
      message: PrepareNativeTranslatorMessage,
    ): Promise<NativeTranslatorStatus> {
      const key = pairKey(message.sourceLanguage, message.targetLanguage);
      const current = pairs.get(key);
      if (current) {
        await current.preparation;
        return status(current);
      }
      const controller = new AbortController();
      const pair: NativeHostPair = {
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
        availability: "downloading",
        progress: { phase: "checking" },
        preparation: Promise.resolve(null),
        active: 0,
        waiting: [],
      };
      pairs.set(key, pair);
      pair.preparation = prepareNativeTranslator(
        message.sourceLanguage,
        message.targetLanguage,
        (progress) => {
          pair.progress = progress;
          options.onProgress?.(
            message.sourceLanguage,
            message.targetLanguage,
            progress,
          );
        },
        controller.signal,
      ).then((session) => {
        pair.session = session ?? undefined;
        pair.availability = session ? "available" : "unavailable";
        return session;
      });
      await pair.preparation;
      return status(pair);
    },

    query(message: QueryNativeTranslatorProgressMessage) {
      const pair = pairs.get(
        pairKey(message.sourceLanguage, message.targetLanguage),
      );
      return pair ? status(pair) : unavailable();
    },

    async translate(
      requestKey: string,
      ownerKey: string,
      message: TranslateNativeTextMessage,
    ): Promise<TranslateNativeTextResponse> {
      const pair = pairs.get(
        pairKey(message.sourceLanguage, message.targetLanguage),
      );
      if (!pair) {
        return {
          runId: message.runId,
          results: message.texts.map(() => ({
            status: "unavailable",
            reason: "session-not-ready",
          })),
        };
      }

      const previous = requestByOwner.get(ownerKey);
      if (previous && previous !== requestKey) cancel(previous);
      let request = requests.get(requestKey);
      if (!request) {
        request = { ownerKey, controller: new AbortController() };
        requests.set(requestKey, request);
        requestByOwner.set(ownerKey, requestKey);
      }

      const session = await pair.preparation;
      if (!session || request.controller.signal.aborted) {
        return {
          runId: message.runId,
          results: message.texts.map(() => ({
            status: "unavailable",
            reason: session ? "aborted" : "session-not-ready",
          })),
        };
      }

      // Pipelined, order-preserving: up to NATIVE_TRANSLATE_CONCURRENCY calls
      // share the pair's one prepared session across every request.
      const { signal } = request.controller;
      const results: NativeRecoveryResult[] = message.texts.map(() => ({
        status: "error",
        reason: "aborted",
      }));
      let next = 0;
      const worker = async () => {
        while (next < message.texts.length) {
          const index = next++;
          if (signal.aborted) continue;
          await acquire(pair, signal);
          try {
            if (!signal.aborted)
              results[index] = await session.translate(
                message.texts[index]!,
                signal,
              );
          } finally {
            release(pair);
          }
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              NATIVE_TRANSLATE_CONCURRENCY,
              message.texts.length,
            ),
          },
          worker,
        ),
      );
      return { runId: message.runId, results };
    },

    cancel,
    clearOwner(ownerKey: string) {
      const requestKey = requestByOwner.get(ownerKey);
      if (requestKey) cancel(requestKey);
    },
  };
}

export async function prepareNativeTranslator(
  sourceLanguage: TargetLanguage,
  targetLanguage: TargetLanguage,
  onProgress: (progress: NativeRecoveryProgress) => void,
  signal: AbortSignal,
): Promise<NativeTranslatorSession | null> {
  if (signal.aborted) return null;
  onProgress({ phase: "checking" });

  const factory = (globalThis as TranslatorGlobal).Translator;
  if (!factory) return null;

  const pair = { sourceLanguage, targetLanguage };
  try {
    const availability = await factory.availability(pair);
    if (signal.aborted || availability === "unavailable") return null;
    if (availability !== "available") {
      onProgress({ phase: "downloading" });
    }

    const createController = new AbortController();
    let settleAborted: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let lastDownloadProgress = "";
    const aborted = new Promise<null>((resolve) => {
      settleAborted = () => resolve(null);
    });
    const abortCreate = () => {
      createController.abort();
      settleAborted?.();
    };
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        onProgress({ phase: "checking" });
        abortCreate();
      }, 30_000);
    };
    signal.addEventListener("abort", abortCreate, { once: true });
    armWatchdog();

    const creation = factory
      .create({
        ...pair,
        signal: createController.signal,
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", ({ loaded, total }) => {
            if (signal.aborted) return;
            const progress = `${loaded}:${total}`;
            if (progress === lastDownloadProgress) return;
            lastDownloadProgress = progress;
            onProgress({ phase: "downloading", loaded, total });
            armWatchdog();
          });
        },
      })
      .then((translator) => {
        if (!createController.signal.aborted) return translator;
        translator.destroy();
        return null;
      });
    let translator: BrowserTranslatorSession | null;
    try {
      translator = await Promise.race([creation, aborted]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
    if (!translator) return null;
    if (signal.aborted) {
      translator.destroy();
      return null;
    }

    let destroyed = false;
    signal.addEventListener(
      "abort",
      () => {
        destroyed = true;
      },
      { once: true },
    );
    onProgress({ phase: "ready" });

    return {
      async translate(text, translateSignal) {
        if (destroyed) {
          return { status: "unavailable", reason: "session-destroyed" };
        }
        if (translateSignal.aborted) {
          return { status: "error", reason: "aborted" };
        }
        try {
          const candidate = await translator.translate(text, {
            signal: translateSignal,
          });
          if (translateSignal.aborted) {
            return { status: "error", reason: "aborted" };
          }
          if (!candidate.trim()) {
            return { status: "quality-miss", reason: "empty" };
          }
          return assessProviderTranslation(
            text,
            candidate,
            targetLanguage,
            sourceLanguage,
          );
        } catch {
          return {
            status: "error",
            reason: translateSignal.aborted ? "aborted" : "translation-failed",
          };
        }
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        translator.destroy();
      },
    };
  } catch {
    return null;
  }
}
