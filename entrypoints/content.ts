import "@/assets/content.css";
import {
  TARGET_LANGUAGES,
  TRANSLATION_CONCURRENCY,
  type TargetLanguage,
} from "@/lib/translation";
import type {
  HtmlTranslateFailure,
  ProviderDiagnostics,
} from "@/lib/translate/provider-result";
import type { OpenAIFallbackProvenance } from "@/lib/translate/openai-html";
import type {
  NativeRecoveryProgress,
  NativeRecoveryResult,
} from "@/lib/translate/browser-native";
import {
  TRANSLATION_REJECTION_REASONS,
  type TranslationRejectionReason,
  type TranslationRunSummary,
} from "@/lib/translate/translation-diagnostics";
import {
  readHtmlLang,
  resolveRecordSourceLanguage,
  settlePageTranslationState,
  type PageTranslationState,
} from "@/lib/translate/page-language";
import { isDeterministicTranslationValue } from "@/lib/translate/format-guards";
import {
  isTranslationPath,
  type TranslationPath,
} from "@/lib/translation-path";
import {
  BASELINE_MARKER_CLASS,
  BASELINE_MARKER_TAG,
  ELLIPSIS_CLASS,
  type LayoutApplicationResult,
  type LayoutCapacityPolicy,
  type LayoutConstraint,
  type RectSnapshot,
  applyLayoutConstraint,
  captureLayoutConstraint,
  layoutProtectedGeometryMatchesBaseline,
  rawTranslationMatchesBaseline,
  rebaselineLayoutConstraint,
  releaseLayoutWrapper,
  recaptureLayoutConstraint,
  unwrapLayoutConstraint,
} from "@/lib/translate/layout-ellipsis";
import {
  attributeIsInViewport,
  createTranslationCollector,
  pieceIsInViewport,
  translationLane,
  type TranslateAttribute,
  type TranslatePiece,
  type TranslationCollector,
  type TranslationLane,
} from "@/lib/translate/pieces";

const MAX_PROVIDER_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1_500] as const;
const MAX_RETRY_DELAY_MS = 30_000;

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  main(ctx) {
    interface RestoreNode {
      node: Text;
      originalText: string;
      translatedText: string;
      wrapper: HTMLElement | null;
      constraint: LayoutConstraint | null;
      lastAppliedHostRect: RectSnapshot | null;
    }
    type TranslationRecord = TranslatePiece | TranslateAttribute;
    interface ActiveRunDiagnostics extends ProviderDiagnostics {
      runId: number;
      startedAt: number;
      firstCommitAt?: number;
      discoveredRecords: number;
      eligibleRecords: number;
      attemptedRecords: number;
      deterministicRecords: number;
      chainCacheHits: number;
      googleFallbackAttempted: number;
      googleFallbackAccepted: number;
      nativeAttempted: number;
      nativeAccepted: number;
      maxViewportDispatchMs: number;
      maxViewportCommitMs: number;
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    }
    let state: PageTranslationState = "original";
    let targetLanguage: TargetLanguage = "en";
    let appliedTarget: TargetLanguage | undefined;
    /** A run is active; the background routes its engines (ADR 0020). */
    let translationActive = false;
    /**
     * Path chosen by the background selector for this run (ADR 0020):
     * without a usable provider key a run is `native` (saved translations,
     * then on-device per record); `unavailable` makes no on-device attempt.
     * Updated from each response.
     */
    let translationPath: TranslationPath = "provider";
    let sourceLanguageHint: TargetLanguage | undefined;
    let runId = 0;
    let startToken = 0;
    let pieces: TranslatePiece[] = [];
    let attributes: TranslateAttribute[] = [];
    const nodesToRestore = new Map<Text, RestoreNode>();
    interface DeferredResult {
      piece: TranslatePiece;
      runId: number;
      target: TargetLanguage;
      parent: ParentNode | null;
      source: string;
      text: string;
      cacheable: boolean;
      provenance?: OpenAIFallbackProvenance;
    }
    const deferredResults = new Map<Text, DeferredResult>();
    const deferredPieces = new Map<TranslatePiece, Set<Text>>();
    let deferredApplyRun: number | undefined;
    let deferredScanCursor = 0;
    let originalPageTitle: string | undefined;
    let translatedPageTitle: string | undefined;
    let translatedPageTitleNode: HTMLTitleElement | undefined;
    let titlePendingRun: number | undefined;
    let runDiagnostics: ActiveRunDiagnostics | undefined;
    let routineTimer: number | undefined;
    let observer: MutationObserver | undefined;
    const addedNodes: Node[] = [];
    const removedNodes: Node[] = [];
    const collectors: {
      collector: TranslationCollector;
      initial: boolean;
    }[] = [];
    let initialCollectionDone = false;
    let collectorPumpRun: number | undefined;
    const laneQueues: Record<TranslationLane, TranslationRecord[]> = {
      priority: [],
      bulk: [],
    };
    const laneScanCursors: Record<TranslationLane, number> = {
      priority: 0,
      bulk: 0,
    };
    const laneScanRemaining: Record<TranslationLane, number> = {
      priority: 0,
      bulk: 0,
    };
    let selectionLaneIndex: 0 | 1 = 0;
    let selectionContinuationRun: number | undefined;
    const activeContentBatches = new Map<number, number>();
    const attempted = new Set<TranslationRecord>();
    const attemptCounts = new Map<TranslationRecord, number>();
    const retryNotBefore = new Map<TranslationRecord, number>();
    const initialCohort = new Set<TranslationRecord>();
    const generationCohort = new Set<TranslationRecord>();
    const eligibleThisRun = new Set<TranslationRecord>();
    const attemptedThisRun = new Set<TranslationRecord>();
    const eligibleObservedAt = new Map<TranslationRecord, number>();
    const dispatchStartedAt = new Map<TranslationRecord, number>();
    let runFailed = false;
    let authError: "auth-required" | "auth-unavailable" | undefined;
    let nativeRecoveryPending = 0;
    const nativeRecoveryUnavailablePairs = new Set<string>();
    let nativeRecoveryProgress: NativeRecoveryProgress | undefined;
    let runCompletion:
      | {
          runId: number;
          resolve: (state: PageTranslationState) => void;
        }
      | undefined;
    let cancelPendingStart: (() => void) | undefined;
    const terminalStateWaiters = new Set<() => void>();
    const extensionWrites = new WeakSet<Text>();
    const isTopFrame = window === window.top;

    const hostRect = (host: Element): RectSnapshot => {
      const { x, y, width, height } = host.getBoundingClientRect();
      return { x: x + window.scrollX, y: y + window.scrollY, width, height };
    };

    const visibleHostRect = (host: Element): RectSnapshot | null => {
      if (!host.isConnected) return null;
      const style = getComputedStyle(host);
      if (
        style.display === "none" ||
        style.visibility !== "visible" ||
        style.getPropertyValue("content-visibility") === "hidden"
      )
        return null;
      const rect = hostRect(host);
      return rect.width > 0 && rect.height > 0 ? rect : null;
    };

    const hostRectChanged = (left: RectSnapshot, right: RectSnapshot) =>
      Math.abs(left.x - right.x) > 1 ||
      Math.abs(left.y - right.y) > 1 ||
      Math.abs(left.width - right.width) > 1 ||
      Math.abs(left.height - right.height) > 1;

    const keepTranslatedRaw = (
      item: RestoreNode,
      constraint: LayoutConstraint,
    ) => {
      unwrapLayoutConstraint(item.node);
      constraint.wrapper = null;
      constraint.selectedCandidate = null;
      extensionWrites.add(item.node);
      item.node.data = item.translatedText;
      queueMicrotask(() => extensionWrites.delete(item.node));
      item.wrapper = null;
      item.constraint = null;
      item.lastAppliedHostRect = null;
    };

    const applyTranslatedLayout = (
      item: RestoreNode,
      constraint: LayoutConstraint,
      capacityPolicy: LayoutCapacityPolicy = "largest-safe",
    ) => {
      extensionWrites.add(item.node);
      const result: LayoutApplicationResult = applyLayoutConstraint(
        constraint,
        item.translatedText,
        1,
        capacityPolicy,
      );
      queueMicrotask(() => extensionWrites.delete(item.node));
      item.wrapper = result.wrapper;
      item.lastAppliedHostRect = visibleHostRect(constraint.host);
      return result;
    };

    const retainedTranslation = (item: RestoreNode) =>
      item.node.isConnected &&
      item.node.data === item.translatedText &&
      (item.wrapper
        ? item.node.parentElement === item.wrapper
        : !item.node.parentElement?.classList.contains(ELLIPSIS_CLASS));

    const yieldToMain = () => {
      const scheduler = (
        globalThis as typeof globalThis & {
          scheduler?: { yield?: () => Promise<void> };
        }
      ).scheduler;
      return scheduler?.yield
        ? scheduler.yield()
        : new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    };

    const activeBatchCount = (currentRun: number) =>
      activeContentBatches.get(currentRun) ?? 0;

    const reserveBatch = (currentRun: number) =>
      activeContentBatches.set(currentRun, activeBatchCount(currentRun) + 1);

    const releaseBatch = (currentRun: number) => {
      const remaining = Math.max(0, activeBatchCount(currentRun) - 1);
      if (remaining) activeContentBatches.set(currentRun, remaining);
      else activeContentBatches.delete(currentRun);
    };

    const addRunRejection = (
      currentRun: number,
      reason: TranslationRejectionReason,
      count = 1,
    ) => {
      const diagnostics = runDiagnostics;
      if (diagnostics?.runId !== currentRun || count <= 0) return;
      diagnostics.rejectedCount += count;
      diagnostics.rejectionReasons[reason] =
        (diagnostics.rejectionReasons[reason] ?? 0) + count;
    };

    const mergeProviderDiagnostics = (
      currentRun: number,
      value: Partial<ProviderDiagnostics & TranslationRunSummary> | undefined,
    ) => {
      const diagnostics = runDiagnostics;
      if (diagnostics?.runId !== currentRun || !value) return;
      diagnostics.records += value.records ?? 0;
      diagnostics.sourceCharacters += value.sourceCharacters ?? 0;
      diagnostics.requestCount += value.requestCount ?? 0;
      diagnostics.queueMs += value.queueMs ?? 0;
      diagnostics.requestMs += value.requestMs ?? 0;
      for (const reason of TRANSLATION_REJECTION_REASONS)
        addRunRejection(
          currentRun,
          reason,
          value.rejectionReasons?.[reason] ?? 0,
        );
      if (value.inputTokens !== undefined)
        diagnostics.inputTokens =
          (diagnostics.inputTokens ?? 0) + value.inputTokens;
      if (value.outputTokens !== undefined)
        diagnostics.outputTokens =
          (diagnostics.outputTokens ?? 0) + value.outputTokens;
      if (value.reasoningTokens !== undefined)
        diagnostics.reasoningTokens =
          (diagnostics.reasoningTokens ?? 0) + value.reasoningTokens;
      const counters = [
        "localCacheHits",
        "localCacheMisses",
        "localCacheInvalid",
        "chainCacheHits",
        "providerAccepted",
        "providerRejected",
        "storageReadCalls",
        "storageWriteCalls",
      ] as const;
      for (const field of counters) diagnostics[field] += value[field] ?? 0;
      const timings = ["storageReadMs", "storageWriteMs"] as const;
      for (const field of timings) diagnostics[field] += value[field] ?? 0;
      diagnostics.maxViewportDispatchMs = Math.max(
        diagnostics.maxViewportDispatchMs,
        value.maxViewportDispatchMs ?? 0,
      );
      diagnostics.maxViewportCommitMs = Math.max(
        diagnostics.maxViewportCommitMs,
        value.maxViewportCommitMs ?? 0,
      );
      if (value.cachedInputTokens !== undefined)
        diagnostics.cachedInputTokens =
          (diagnostics.cachedInputTokens ?? 0) + value.cachedInputTokens;
    };

    const markFirstCommit = (currentRun: number) => {
      const diagnostics = runDiagnostics;
      if (
        diagnostics?.runId === currentRun &&
        diagnostics.firstCommitAt === undefined
      )
        diagnostics.firstCommitAt = performance.now();
    };

    const markCommitted = (
      currentRun: number,
      records: TranslationRecord[],
      committed: boolean[],
    ) => {
      const diagnostics = runDiagnostics;
      if (diagnostics?.runId !== currentRun) return;
      const committedAt = performance.now();
      records.forEach((record, index) => {
        if (!committed[index]) return;
        const dispatchedAt = dispatchStartedAt.get(record);
        if (dispatchedAt !== undefined)
          diagnostics.maxViewportCommitMs = Math.max(
            diagnostics.maxViewportCommitMs,
            committedAt - dispatchedAt,
          );
      });
    };

    const finishRunDiagnostics = (
      currentRun: number,
      cancelledReason?: TranslationRejectionReason,
    ) => {
      const diagnostics = runDiagnostics;
      if (diagnostics?.runId !== currentRun) return;
      if (cancelledReason) addRunRejection(currentRun, cancelledReason);
      runDiagnostics = undefined;
      const completedAt = performance.now();
      const summary: TranslationRunSummary = {
        // Page runs are backend-routed with OpenAI as the primary engine.
        provider: "openai",
        records: diagnostics.records,
        sourceCharacters: diagnostics.sourceCharacters,
        requestCount: diagnostics.requestCount,
        queueMs: diagnostics.queueMs,
        requestMs: diagnostics.requestMs,
        firstCommitMs:
          diagnostics.firstCommitAt === undefined
            ? 0
            : diagnostics.firstCommitAt - diagnostics.startedAt,
        completeMs: completedAt - diagnostics.startedAt,
        rejectedCount: diagnostics.rejectedCount,
        discoveredRecords: diagnostics.discoveredRecords,
        eligibleRecords: diagnostics.eligibleRecords,
        attemptedRecords: diagnostics.attemptedRecords,
        deterministicRecords: diagnostics.deterministicRecords,
        localCacheHits: diagnostics.localCacheHits,
        localCacheMisses: diagnostics.localCacheMisses,
        localCacheInvalid: diagnostics.localCacheInvalid,
        chainCacheHits: diagnostics.chainCacheHits,
        providerAccepted: diagnostics.providerAccepted,
        providerRejected: diagnostics.providerRejected,
        googleFallbackAttempted: diagnostics.googleFallbackAttempted,
        googleFallbackAccepted: diagnostics.googleFallbackAccepted,
        nativeAttempted: diagnostics.nativeAttempted,
        nativeAccepted: diagnostics.nativeAccepted,
        storageReadCalls: diagnostics.storageReadCalls,
        storageWriteCalls: diagnostics.storageWriteCalls,
        storageReadMs: diagnostics.storageReadMs,
        storageWriteMs: diagnostics.storageWriteMs,
        maxViewportDispatchMs: diagnostics.maxViewportDispatchMs,
        maxViewportCommitMs: diagnostics.maxViewportCommitMs,
        rejectionReasons: diagnostics.rejectionReasons,
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
      };
      void browser.runtime
        .sendMessage({
          type: "RECORD_TRANSLATION_DIAGNOSTICS",
          runId: currentRun,
          summary,
          // Settled with accepted translations: the background relays one
          // content-free `file_translated` product event (ADR 0017).
          ...(cancelledReason || !appliedTarget
            ? {}
            : { appliedTargetLanguage: appliedTarget }),
        })
        .catch(() => undefined);
    };

    const recordIsActive = (item: TranslationRecord) =>
      "nodes" in item
        ? item.nodes.some((node) => node.isConnected) ||
          deferredPieces.has(item)
        : item.node.isConnected &&
          item.node.getAttribute(item.attribute) === item.original;

    const retryDelay = (item: TranslationRecord, retryAfterMs?: number) => {
      const attempt = attemptCounts.get(item) ?? 1;
      const fallback = RETRY_DELAYS_MS[attempt - 1] ?? 0;
      return Math.min(
        MAX_RETRY_DELAY_MS,
        Math.max(0, retryAfterMs ?? fallback),
      );
    };

    const scheduleRetry = (item: TranslationRecord, retryAfterMs?: number) => {
      if (
        item.isTranslated ||
        !recordIsActive(item) ||
        (attemptCounts.get(item) ?? 0) >= MAX_PROVIDER_ATTEMPTS
      )
        return false;
      attempted.delete(item);
      generationCohort.add(item);
      retryNotBefore.set(
        item,
        performance.now() + retryDelay(item, retryAfterMs),
      );
      return true;
    };

    const hasPendingRetry = () =>
      [...retryNotBefore].some(
        ([item]) => !item.isTranslated && recordIsActive(item),
      );

    const hasUnresolved = () =>
      authError !== undefined ||
      deferredResults.size > 0 ||
      [...attempted].some(
        (item) => !item.isTranslated && recordIsActive(item),
      ) ||
      (runFailed &&
        [...initialCohort, ...generationCohort].some(
          (item) => !attempted.has(item) && recordIsActive(item),
        ));

    const hasAccepted = () =>
      (translatedPageTitle !== undefined &&
        document.querySelector("title") === translatedPageTitleNode &&
        document.title === translatedPageTitle) ||
      [...nodesToRestore.values()].some(retainedTranslation) ||
      attributes.some(
        (item) =>
          item.isTranslated &&
          item.node.isConnected &&
          item.node.getAttribute(item.attribute) === item.translated,
      );

    const contentStateResponse = () => ({
      state,
      targetLanguage,
      translated: state === "translated" || state === "partial",
      appliedTarget,
      hasUnresolved: hasUnresolved(),
      nativeRecoveryProgress,
      translationPath,
      ...(authError ? { error: authError } : {}),
    });

    const flushTerminalStateWaiters = () => {
      if (state === "translating" || state === "preparing") return;
      const waiters = [...terminalStateWaiters];
      terminalStateWaiters.clear();
      waiters.forEach((respond) => respond());
    };

    const cancelRunCompletion = () => {
      cancelPendingStart?.();
      cancelPendingStart = undefined;
      runCompletion?.resolve("error");
      runCompletion = undefined;
    };

    const settleRunCompletion = (
      currentRun: number,
      terminalState: PageTranslationState,
    ) => {
      if (runCompletion?.runId !== currentRun) return;
      runCompletion.resolve(terminalState);
      runCompletion = undefined;
    };

    /** On the native path a prepared session is the translation itself. */
    const nativeSessionIsTranslating = () =>
      translationPath === "native" && nativeRecoveryProgress?.phase === "ready";

    const updateRunState = (currentRun: number) => {
      if (currentRun !== runId) return;
      const canRecoverRunFailure = runFailed;
      // On the native path, on-device work is the translation itself:
      // "preparing" covers only the first-use language-pack preparation.
      if (nativeRecoveryPending > 0 && !nativeSessionIsTranslating()) {
        state = "preparing";
        return;
      }
      if (
        activeBatchCount(currentRun) > 0 ||
        titlePendingRun === currentRun ||
        ((!runFailed || canRecoverRunFailure) &&
          (!initialCollectionDone || hasPendingRetry()))
      ) {
        state = "translating";
        return;
      }
      const pendingInitial = [...initialCohort, ...generationCohort].some(
        (item) => recordIsActive(item) && !attempted.has(item),
      );
      if ((!runFailed || canRecoverRunFailure) && pendingInitial) {
        state = "translating";
        return;
      }
      const accepted = hasAccepted();
      const unresolved = hasUnresolved();
      state = settlePageTranslationState({ accepted, unresolved });
      appliedTarget = accepted ? targetLanguage : undefined;
      flushTerminalStateWaiters();
      finishRunDiagnostics(currentRun);
      settleRunCompletion(currentRun, state);
    };

    const consumeFailures = <T extends TranslatePiece | TranslateAttribute>(
      current: T[],
      failures: HtmlTranslateFailure[],
      committed: boolean[],
    ) => {
      const retrying = current.map(() => false);
      const runFailure = failures.some((failure) => failure.scope === "run");
      if (runFailure) {
        runFailed = true;
        retryNotBefore.clear();
      }
      const byIndex = new Map(
        failures.map((failure) => [failure.index, failure] as const),
      );
      current.forEach((item, index) => {
        if (committed[index]) {
          retryNotBefore.delete(item);
          return;
        }
        if ("nodes" in item && !item.nodes.length && deferredPieces.has(item))
          return;
        const failure = byIndex.get(index);
        if (runFailed || (failure && !failure.retryable)) return;
        retrying[index] = scheduleRetry(item, failure?.retryAfterMs);
      });
      if (failures.length)
        console.error(
          "Translation batch failed",
          failures.map((failure) => failure.message),
        );
      return retrying;
    };

    const currentProtectedConstraint = (item: RestoreNode) => {
      const constraint = item.constraint;
      if (
        !constraint ||
        !item.lastAppliedHostRect ||
        !item.node.isConnected ||
        item.node.data !== item.translatedText ||
        !constraint.host.contains(item.node) ||
        item.wrapper !== constraint.wrapper ||
        (item.wrapper
          ? item.node.parentElement !== item.wrapper
          : item.node.parentElement?.classList.contains(ELLIPSIS_CLASS))
      )
        return null;
      return constraint;
    };

    const stopPendingWork = (
      cancelledRun?: number,
      preserveDiscovery = false,
    ) => {
      for (const [node, pending] of deferredResults) {
        if (
          node.isConnected &&
          node.data === pending.source &&
          !pending.piece.nodes.includes(node)
        )
          pending.piece.nodes.push(node);
      }
      deferredResults.clear();
      deferredPieces.clear();
      deferredApplyRun = undefined;
      deferredScanCursor = 0;
      if (cancelledRun !== undefined) {
        finishRunDiagnostics(cancelledRun, "stale");
        void browser.runtime
          .sendMessage({
            type: "CANCEL_NATIVE_TRANSLATION",
            runId: cancelledRun,
          })
          .catch(() => undefined);
      }
      cancelRunCompletion();
      if (routineTimer !== undefined) window.clearTimeout(routineTimer);
      routineTimer = undefined;
      observer?.disconnect();
      observer = undefined;
      if (!preserveDiscovery) {
        addedNodes.splice(0);
        removedNodes.splice(0);
        collectors.splice(0);
      }
      initialCollectionDone = false;
      collectorPumpRun = undefined;
      laneQueues.priority.splice(0);
      laneQueues.bulk.splice(0);
      laneScanCursors.priority = 0;
      laneScanCursors.bulk = 0;
      laneScanRemaining.priority = 0;
      laneScanRemaining.bulk = 0;
      selectionLaneIndex = 0;
      selectionContinuationRun = undefined;
      activeContentBatches.clear();
      attempted.clear();
      attemptCounts.clear();
      retryNotBefore.clear();
      initialCohort.clear();
      generationCohort.clear();
      eligibleThisRun.clear();
      attemptedThisRun.clear();
      eligibleObservedAt.clear();
      dispatchStartedAt.clear();
      runFailed = false;
      nativeRecoveryPending = 0;
      nativeRecoveryUnavailablePairs.clear();
      nativeRecoveryProgress = undefined;
      titlePendingRun = undefined;
    };

    const adoptTranslationPath = (currentRun: number, response: unknown) => {
      const path = (response as { path?: unknown } | undefined)?.path;
      if (currentRun === runId && isTranslationPath(path))
        translationPath = path;
    };

    const stopForAuth = (currentRun: number, response: unknown) => {
      if (currentRun !== runId) return true;
      const error = (response as { error?: unknown } | undefined)?.error;
      if (error !== "auth-required" && error !== "auth-unavailable")
        return false;
      const accepted = hasAccepted();
      if (accepted) appliedTarget ??= targetLanguage;
      authError = error;
      runId += 1;
      stopPendingWork(currentRun);
      state = accepted ? "partial" : "error";
      flushTerminalStateWaiters();
      return true;
    };

    const restorePage = (cancelledRun?: number) => {
      stopPendingWork(cancelledRun);
      authError = undefined;
      translationActive = false;
      sourceLanguageHint = undefined;
      translationPath = "provider";
      appliedTarget = undefined;
      if (
        originalPageTitle !== undefined &&
        document.querySelector("title") === translatedPageTitleNode &&
        document.title === translatedPageTitle
      )
        document.title = originalPageTitle;
      originalPageTitle = undefined;
      translatedPageTitle = undefined;
      translatedPageTitleNode = undefined;
      titlePendingRun = undefined;
      for (const item of nodesToRestore.values()) {
        if (item.wrapper) {
          if (item.node.parentElement !== item.wrapper) {
            if (item.wrapper.isConnected && !item.wrapper.hasChildNodes())
              item.wrapper.remove();
            item.wrapper = null;
            item.constraint = null;
            item.lastAppliedHostRect = null;
          } else {
            unwrapLayoutConstraint(item.node);
            if (item.node.parentElement === item.wrapper) continue;
          }
        }
        if (!item.node.isConnected) {
          continue;
        }
        if (item.node.textContent === item.translatedText)
          item.node.textContent = item.originalText;
      }
      for (const item of attributes) {
        if (
          item.translated &&
          item.node.getAttribute(item.attribute) === item.translated
        )
          item.node.setAttribute(item.attribute, item.original);
      }
      nodesToRestore.clear();
      pieces = [];
      attributes = [];
      state = "original";
    };

    // Batched application: interleaving one node's writes with the next
    // node's reads forces a full page reflow per node, which is what made
    // large tables lag. Instead every stage runs for the whole batch —
    // capture (reads), install raw (writes), validate (reads) — and only the
    // records whose raw geometry failed take the per-node wrapper path.
    const applyPieces = async (
      currentRun: number,
      current: TranslatePiece[],
      requested: Text[][],
      sources: string[][],
      results: string[][],
      cacheableResults?: string[][],
      provenance?: (OpenAIFallbackProvenance | undefined)[][],
    ): Promise<boolean[]> => {
      const yieldWhenOver = async (sliceStart: number) => {
        if (performance.now() - sliceStart <= 8) return sliceStart;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        return performance.now();
      };
      const committedByPiece = current.map(
        (_, index) =>
          (requested[index] ?? []).length > 0 &&
          (results[index] ?? []).length === (requested[index] ?? []).length,
      );
      const residualNodesByPiece: Text[][] = current.map(() => []);
      const residualSourcesByPiece: string[][] = current.map(() => []);
      interface NodeApply {
        pieceIndex: number;
        nodeIndex: number;
        node: Text;
        restore: RestoreNode;
      }
      const jobs: NodeApply[] = [];
      const defer = (
        pieceIndex: number,
        nodeIndex: number,
        node: Text,
        source: string,
        text: string,
      ) => {
        if (!deferredResults.has(node)) {
          const piece = current[pieceIndex]!;
          deferredResults.set(node, {
            piece,
            runId: currentRun,
            target: targetLanguage,
            parent: node.parentNode,
            source,
            text,
            cacheable:
              cacheableResults?.[pieceIndex]?.[nodeIndex] === text ||
              provenance?.[pieceIndex]?.[nodeIndex] !== undefined,
            provenance: provenance?.[pieceIndex]?.[nodeIndex],
          });
          const pending = deferredPieces.get(piece) ?? new Set<Text>();
          pending.add(node);
          deferredPieces.set(piece, pending);
        }
        committedByPiece[pieceIndex] = false;
      };
      const rendered = (pieceIndex: number, node: Text) =>
        pieceIsInViewport(
          { ...current[pieceIndex]!, nodes: [node] },
          window.innerHeight,
          window.innerWidth,
          Infinity,
          Infinity,
        );

      // Stage 1 — validate provider values and build DOM work incrementally.
      let sliceStart = performance.now();
      for (let index = 0; index < current.length; index += 1) {
        if (currentRun !== runId) break;
        const requestedNodes = requested[index] ?? [];
        const translated = results[index] ?? [];
        for (
          let nodeIndex = 0;
          nodeIndex < requestedNodes.length;
          nodeIndex += 1
        ) {
          sliceStart = await yieldWhenOver(sliceStart);
          if (currentRun !== runId) break;
          const node = requestedNodes[nodeIndex]!;
          const source = sources[index]?.[nodeIndex];
          const providerText = translated[nodeIndex];
          if (
            !source ||
            !providerText ||
            !node.isConnected ||
            node.data !== source
          ) {
            if (source && providerText && !node.isConnected)
              addRunRejection(currentRun, "detached");
            else if (source && providerText && node.data !== source)
              addRunRejection(currentRun, "stale");
            committedByPiece[index] = false;
            if (
              source &&
              !providerText &&
              node.isConnected &&
              node.data === source
            ) {
              residualNodesByPiece[index]!.push(node);
              residualSourcesByPiece[index]!.push(source);
            }
            continue;
          }
          const translatedText = providerText;
          if (!rendered(index, node)) {
            defer(index, nodeIndex, node, source, translatedText);
            continue;
          }
          jobs.push({
            pieceIndex: index,
            nodeIndex,
            node,
            restore: {
              node,
              originalText: source,
              translatedText,
              wrapper: null,
              constraint: null,
              lastAppliedHostRect: null,
            },
          });
        }
      }

      // Stages 2–4 run per adaptive chunk with no await inside, so a frame
      // never paints raw text whose repair has not happened yet. Seed four
      // records, then adapt up to 16 with a 6ms target for headroom under the
      // 8ms budget, yielding only after the whole chunk is stable.
      const APPLY_SLICE_MS = 6;
      const MAX_ADAPTIVE_CHUNK = 16;
      for (
        let chunkStart = 0, chunkSize = Math.min(4, jobs.length);
        chunkStart < jobs.length;
      ) {
        if (currentRun !== runId) break;
        const candidates = jobs.slice(chunkStart, chunkStart + chunkSize);
        const chunk = candidates.filter((job) => {
          if (
            !job.node.isConnected ||
            job.node.data !== job.restore.originalText
          ) {
            committedByPiece[job.pieceIndex] = false;
            return false;
          }
          if (rendered(job.pieceIndex, job.node)) return true;
          defer(
            job.pieceIndex,
            job.nodeIndex,
            job.node,
            job.restore.originalText,
            job.restore.translatedText,
          );
          return false;
        });
        const chunkStartedAt = performance.now();

        // Capture every baseline before this chunk writes.
        for (const job of chunk) {
          try {
            job.restore.constraint = captureLayoutConstraint(job.node);
          } catch {
            // A non-standard host DOM remains readable translated flow content.
          }
        }

        // Stage 2 — one write pass installs the chunk raw. Records are
        // registered immediately so a restore during a later yield is exact.
        for (const job of chunk) {
          extensionWrites.add(job.node);
          job.node.data = job.restore.translatedText;
          queueMicrotask(() => extensionWrites.delete(job.node));
          nodesToRestore.set(job.node, job.restore);
        }

        // Stage 3 — one read pass validates the chunk against baselines.
        const repairs: NodeApply[] = [];
        for (const job of chunk) {
          const constraint = job.restore.constraint;
          if (!constraint) continue;
          if (
            job.node.isConnected &&
            job.node.data === job.restore.translatedText &&
            rawTranslationMatchesBaseline(constraint, 1)
          ) {
            job.restore.lastAppliedHostRect = visibleHostRect(constraint.host);
            continue;
          }
          repairs.push(job);
        }

        // Drift caused by the batch's own writes (a table redistributing its
        // columns) is re-anchored and re-validated with reads only. The
        // host's own footprint must survive the re-anchor: height always,
        // width too for multi-line clamps. Only genuine footprint changes or
        // overflow keep a per-node repair.
        const stillFailing: NodeApply[] = [];
        for (const job of repairs) {
          const constraint = job.restore.constraint;
          if (
            !constraint ||
            !job.node.isConnected ||
            job.node.data !== job.restore.translatedText
          )
            continue;
          const priorHostWidth = constraint.baselineHostRect.width;
          const priorHostHeight = constraint.baselineHostRect.height;
          if (
            rebaselineLayoutConstraint(constraint) &&
            Math.abs(constraint.baselineHostRect.height - priorHostHeight) <=
              1 &&
            (constraint.mode === "single-line" ||
              Math.abs(constraint.baselineHostRect.width - priorHostWidth) <=
                1) &&
            rawTranslationMatchesBaseline(constraint, 1)
          ) {
            job.restore.lastAppliedHostRect = visibleHostRect(constraint.host);
            continue;
          }
          stillFailing.push(job);
        }

        // Stage 4 — the failing subset takes the per-node wrapper path. All
        // failing sources are restored first so no record is recaptured
        // under a sibling's raw overflow still squeezing the shared row;
        // each record then re-captures from that settled state and applies.
        for (const job of stillFailing) {
          if (
            job.node.isConnected &&
            job.node.data === job.restore.translatedText &&
            !job.node.parentElement?.classList.contains(ELLIPSIS_CLASS)
          ) {
            extensionWrites.add(job.node);
            job.node.data = job.restore.originalText;
            queueMicrotask(() => extensionWrites.delete(job.node));
          }
        }
        for (const job of stillFailing) {
          const { restore } = job;
          if (!job.node.isConnected || job.node.data !== restore.originalText)
            continue;
          if (!rendered(job.pieceIndex, job.node)) {
            defer(
              job.pieceIndex,
              job.nodeIndex,
              job.node,
              restore.originalText,
              restore.translatedText,
            );
            continue;
          }
          let constraint: LayoutConstraint | null = null;
          try {
            constraint = captureLayoutConstraint(job.node);
          } catch {
            // A non-standard host DOM remains readable translated flow content.
          }
          restore.constraint = constraint;
          if (!constraint) {
            extensionWrites.add(job.node);
            job.node.data = restore.translatedText;
            queueMicrotask(() => extensionWrites.delete(job.node));
            continue;
          }
          applyTranslatedLayout(restore, constraint);
          if (!layoutProtectedGeometryMatchesBaseline(constraint, 1)) {
            applyTranslatedLayout(restore, constraint, "source-only");
            if (!layoutProtectedGeometryMatchesBaseline(constraint, 1))
              keepTranslatedRaw(restore, constraint);
          }
        }

        const chunkDuration = Math.max(0.1, performance.now() - chunkStartedAt);
        chunkStart += candidates.length;
        chunkSize = Math.max(
          1,
          Math.min(
            MAX_ADAPTIVE_CHUNK,
            Math.floor((candidates.length * APPLY_SLICE_MS) / chunkDuration),
          ),
        );
        if (chunkStart < jobs.length) await yieldToMain();
      }

      if (currentRun !== runId) return current.map(() => false);

      // Stage 5 — retention bookkeeping mirrors the per-node contract.
      let retainedAny = false;
      for (const job of jobs) {
        if (retainedTranslation(job.restore)) {
          releaseDeferredResult(job.node);
          nodesToRestore.set(job.node, job.restore);
          retainedAny = true;
        } else {
          committedByPiece[job.pieceIndex] = false;
          nodesToRestore.delete(job.node);
        }
      }
      if (retainedAny) markFirstCommit(currentRun);
      for (let index = 0; index < current.length; index += 1) {
        const piece = current[index]!;
        piece.nodes = residualNodesByPiece[index]!;
        sources[index] = residualSourcesByPiece[index]!;
        piece.isTranslated =
          committedByPiece[index]! &&
          piece.nodes.length === 0 &&
          !deferredPieces.has(piece);
        committedByPiece[index] = piece.isTranslated;
      }

      // Applying this batch may have moved geometry that other records
      // protect (a table column widening moves every row). Re-anchor all
      // stored rects with a cheap read-only pass so the repair routine does
      // not churn through expensive per-record recaptures.
      if (jobs.length && currentRun === runId) {
        sliceStart = performance.now();
        for (const item of nodesToRestore.values()) {
          sliceStart = await yieldWhenOver(sliceStart);
          if (currentRun !== runId) break;
          const constraint = currentProtectedConstraint(item);
          if (!constraint) continue;
          if (rebaselineLayoutConstraint(constraint))
            item.lastAppliedHostRect = visibleHostRect(constraint.host);
        }
      }
      return committedByPiece;
    };

    const refreshEntry = (node: Text, item: RestoreNode) => {
      if (item.wrapper && item.node.parentElement !== item.wrapper) {
        if (item.wrapper.isConnected) releaseLayoutWrapper(item.wrapper);
        item.wrapper = null;
        item.constraint = null;
        item.lastAppliedHostRect = null;
        return;
      }
      if (!item.node.isConnected || item.node.data !== item.translatedText) {
        if (item.node.parentElement === item.wrapper)
          unwrapLayoutConstraint(item.node);
        else if (item.wrapper?.isConnected) releaseLayoutWrapper(item.wrapper);
        nodesToRestore.delete(node);
        return;
      }
      const previousRect = item.lastAppliedHostRect;
      let constraint = item.constraint;
      if (!constraint || !previousRect) return;
      const ownershipChanged = !constraint.host.contains(item.node);
      let geometryChanged = false;
      if (!ownershipChanged) {
        constraint = currentProtectedConstraint(item);
        if (!constraint) return;
        const currentRect = visibleHostRect(constraint.host);
        if (!currentRect) return;
        geometryChanged =
          hostRectChanged(currentRect, previousRect) ||
          !layoutProtectedGeometryMatchesBaseline(constraint, 1);
        if (!geometryChanged) return;
      }
      if (ownershipChanged || geometryChanged) {
        extensionWrites.add(item.node);
        const recaptured = recaptureLayoutConstraint(
          constraint,
          item.translatedText,
        );
        queueMicrotask(() => extensionWrites.delete(item.node));
        item.wrapper = null;
        if (!recaptured) {
          keepTranslatedRaw(item, constraint);
          return;
        }
        constraint = recaptured;
        item.constraint = recaptured;
      }
      applyTranslatedLayout(item, constraint);
      if (!layoutProtectedGeometryMatchesBaseline(constraint, 1)) {
        applyTranslatedLayout(item, constraint, "source-only");
        if (!layoutProtectedGeometryMatchesBaseline(constraint, 1))
          keepTranslatedRaw(item, constraint);
      }
      if (!retainedTranslation(item)) nodesToRestore.delete(node);
    };

    // Each 300ms tick validates as many records as fit an 8ms budget and
    // resumes from the same position next tick, so repair stays responsive
    // without ever blocking the main thread on large pages.
    let refreshCursor = 0;
    const refreshLayoutConstraints = () => {
      const entries = [...nodesToRestore.entries()];
      if (!entries.length) return;
      const started = performance.now();
      if (refreshCursor >= entries.length) refreshCursor = 0;
      let processed = 0;
      while (processed < entries.length) {
        if (processed > 0 && performance.now() - started > 8) break;
        const [node, item] =
          entries[(refreshCursor + processed) % entries.length]!;
        processed += 1;
        refreshEntry(node, item);
      }
      refreshCursor = (refreshCursor + processed) % entries.length;
    };

    type ContentBatch =
      | { lane: TranslationLane; pieces: TranslatePiece[] }
      | { lane: TranslationLane; attributes: TranslateAttribute[] };

    const recordIsVisible = (item: TranslationRecord) => {
      const innerHeight = window.innerHeight;
      const innerWidth = window.innerWidth;
      return "nodes" in item
        ? pieceIsInViewport(
            item,
            innerHeight,
            innerWidth,
            innerHeight,
            innerWidth,
          )
        : attributeIsInViewport(
            item.node,
            innerHeight,
            innerWidth,
            innerHeight,
            innerWidth,
          );
    };

    const recordCanDispatch = (item: TranslationRecord) =>
      !item.isTranslated &&
      recordIsActive(item) &&
      !attempted.has(item) &&
      (retryNotBefore.get(item) ?? 0) <= performance.now() &&
      (initialCohort.has(item) ||
        generationCohort.has(item) ||
        recordIsVisible(item));

    const providerBoundCost = (item: TranslationRecord) => {
      const values =
        "nodes" in item ? item.nodes.map((node) => node.data) : [item.original];
      const providerValues = values.filter(
        (value) => !isDeterministicTranslationValue(value),
      );
      return {
        records: providerValues.length,
        characters: providerValues.reduce(
          (total, value) => total + value.length,
          0,
        ),
      };
    };

    interface BatchSelection {
      batch?: ContentBatch;
      budgetExpired: boolean;
    }

    const BATCH_SELECTION_MS = 6;
    const MAX_CONTENT_ITEMS = 128;

    const saveLaneCursor = (
      lane: TranslationLane,
      queue: TranslationRecord[],
      nextIndex: number,
      dropped: Set<TranslationRecord>,
    ) => {
      const next = queue.length ? queue[nextIndex % queue.length] : undefined;
      if (dropped.size)
        laneQueues[lane] = queue.filter((item) => !dropped.has(item));
      const retained = laneQueues[lane];
      laneScanCursors[lane] = next ? Math.max(0, retained.indexOf(next)) : 0;
    };

    const selectedBatch = (
      lane: TranslationLane,
      selected: TranslationRecord[],
      piecesBatch: boolean | undefined,
    ): ContentBatch | undefined =>
      piecesBatch === undefined
        ? undefined
        : piecesBatch
          ? { lane, pieces: selected as TranslatePiece[] }
          : { lane, attributes: selected as TranslateAttribute[] };

    const nextBatch = (
      selectionStartedAt: number,
      providerAttempt: boolean,
    ): BatchSelection => {
      const lanes = ["priority", "bulk"] as const;
      for (
        let laneIndex = selectionLaneIndex;
        laneIndex < lanes.length;
        laneIndex += 1
      ) {
        selectionLaneIndex = laneIndex as 0 | 1;
        const lane = lanes[laneIndex]!;
        if (lane === "bulk" && !initialCollectionDone) {
          selectionLaneIndex = 0;
          return { budgetExpired: false };
        }
        const queue = laneQueues[lane];
        if (!queue.length) {
          laneScanCursors[lane] = 0;
          laneScanRemaining[lane] = 0;
          selectionLaneIndex = laneIndex === 0 ? 1 : 0;
          continue;
        }
        if (performance.now() - selectionStartedAt >= BATCH_SELECTION_MS)
          return { budgetExpired: true };
        const maxRecords = lane === "priority" ? 24 : 128;
        const maxCharacters = lane === "priority" ? 600 : 8_000;
        const selected: TranslationRecord[] = [];
        const dropped = new Set<TranslationRecord>();
        let piecesBatch: boolean | undefined;
        let providerRecords = 0;
        let characters = 0;
        let index = laneScanCursors[lane] % queue.length;
        const scanLimit = Math.min(
          laneScanRemaining[lane] || queue.length,
          queue.length,
        );
        let scanned = 0;
        for (; scanned < scanLimit; scanned += 1) {
          if (
            scanned > 0 &&
            performance.now() - selectionStartedAt >= BATCH_SELECTION_MS
          ) {
            saveLaneCursor(lane, queue, index, dropped);
            laneScanRemaining[lane] = selected.length
              ? 0
              : Math.min(scanLimit - scanned, laneQueues[lane].length);
            if (selected.length) selectionLaneIndex = 0;
            return {
              batch: selectedBatch(lane, selected, piecesBatch),
              budgetExpired: true,
            };
          }
          const item = queue[index]!;
          if (item.isTranslated || !recordIsActive(item)) {
            dropped.add(item);
            index = (index + 1) % queue.length;
            continue;
          }
          if (!recordCanDispatch(item)) {
            index = (index + 1) % queue.length;
            continue;
          }
          if (piecesBatch === undefined) piecesBatch = "nodes" in item;
          else if ("nodes" in item !== piecesBatch) {
            saveLaneCursor(lane, queue, index, dropped);
            laneScanRemaining[lane] = 0;
            selectionLaneIndex = 0;
            return {
              batch: selectedBatch(lane, selected, piecesBatch),
              budgetExpired: false,
            };
          }
          const cost = providerBoundCost(item);
          if (
            selected.length >= MAX_CONTENT_ITEMS ||
            (selected.length > 0 &&
              cost.records > 0 &&
              (providerRecords + cost.records > maxRecords ||
                characters + cost.characters > maxCharacters))
          ) {
            saveLaneCursor(lane, queue, index, dropped);
            laneScanRemaining[lane] = 0;
            selectionLaneIndex = 0;
            return {
              batch: selectedBatch(lane, selected, piecesBatch),
              budgetExpired: false,
            };
          }
          const dispatchedAt = performance.now();
          if (!eligibleThisRun.has(item)) {
            eligibleThisRun.add(item);
            if (runDiagnostics?.runId === runId)
              runDiagnostics.eligibleRecords += 1;
          }
          const eligibleAt = eligibleObservedAt.get(item) ?? dispatchedAt;
          if (runDiagnostics?.runId === runId)
            runDiagnostics.maxViewportDispatchMs = Math.max(
              runDiagnostics.maxViewportDispatchMs,
              dispatchedAt - eligibleAt,
            );
          if (!attemptedThisRun.has(item)) {
            attemptedThisRun.add(item);
            if (runDiagnostics?.runId === runId) {
              runDiagnostics.attemptedRecords += 1;
              const values =
                "nodes" in item
                  ? item.nodes.map((node) => node.data)
                  : [item.original];
              runDiagnostics.deterministicRecords += values.filter(
                isDeterministicTranslationValue,
              ).length;
            }
          }
          attempted.add(item);
          retryNotBefore.delete(item);
          if (providerAttempt)
            attemptCounts.set(item, (attemptCounts.get(item) ?? 0) + 1);
          dispatchStartedAt.set(item, dispatchedAt);
          selected.push(item);
          providerRecords += cost.records;
          characters += cost.characters;
          index = (index + 1) % queue.length;
          if (selected.length >= MAX_CONTENT_ITEMS) {
            saveLaneCursor(lane, queue, index, dropped);
            laneScanRemaining[lane] = 0;
            selectionLaneIndex = 0;
            return {
              batch: selectedBatch(lane, selected, piecesBatch),
              budgetExpired:
                performance.now() - selectionStartedAt >= BATCH_SELECTION_MS,
            };
          }
        }
        saveLaneCursor(lane, queue, selected.length ? index : 0, dropped);
        laneScanRemaining[lane] = 0;
        if (selected.length) {
          selectionLaneIndex = 0;
          return {
            batch: selectedBatch(lane, selected, piecesBatch),
            budgetExpired:
              performance.now() - selectionStartedAt >= BATCH_SELECTION_MS,
          };
        }
        selectionLaneIndex = laneIndex === 0 ? 1 : 0;
      }
      selectionLaneIndex = 0;
      return { budgetExpired: false };
    };

    interface RecoveryResult {
      results: string[];
      provenance: (OpenAIFallbackProvenance | undefined)[];
      nativeAttempted: number;
    }

    const recoverWithNative = async (
      currentRun: number,
      texts: string[],
    ): Promise<RecoveryResult> => {
      const results = texts.map(() => "");
      const provenance = texts.map(
        () => undefined as OpenAIFallbackProvenance | undefined,
      );
      if (currentRun !== runId || !texts.length)
        return { results, provenance, nativeAttempted: 0 };

      // The backend already routed OpenAI and its Google fallback (or the
      // native path skipped it); only the on-device stage remains here.
      if (!translationActive || translationPath === "unavailable")
        return { results, provenance, nativeAttempted: 0 };

      const indexesBySource = new Map<TargetLanguage, number[]>();
      texts.forEach((text, index) => {
        if (results[index]) return;
        const sourceLanguage = resolveRecordSourceLanguage(
          text,
          sourceLanguageHint,
        );
        if (sourceLanguage === "auto" || sourceLanguage === targetLanguage)
          return;
        const indexes = indexesBySource.get(sourceLanguage) ?? [];
        indexes.push(index);
        indexesBySource.set(sourceLanguage, indexes);
      });
      if (!indexesBySource.size)
        return { results, provenance, nativeAttempted: 0 };

      nativeRecoveryPending += 1;
      if (!nativeSessionIsTranslating()) state = "preparing";
      let nativeAttempted = 0;
      try {
        for (const [sourceLanguage, eligibleIndexes] of indexesBySource) {
          if (currentRun !== runId) break;
          const pair = `${sourceLanguage}:${targetLanguage}`;
          if (nativeRecoveryUnavailablePairs.has(pair)) continue;
          const eligibleTexts = eligibleIndexes.map((index) => texts[index]!);
          nativeAttempted += eligibleTexts.length;
          if (runDiagnostics?.runId === currentRun)
            runDiagnostics.nativeAttempted += eligibleTexts.length;
          try {
            const status = await browser.runtime.sendMessage({
              type: "PREPARE_NATIVE_TRANSLATOR",
              runId: currentRun,
              sourceLanguage,
              targetLanguage,
            });
            if (stopForAuth(currentRun, status)) break;
            if (status?.progress) nativeRecoveryProgress = status.progress;

            const response = await browser.runtime.sendMessage({
              type: "TRANSLATE_NATIVE_TEXT",
              runId: currentRun,
              sourceLanguage,
              targetLanguage,
              texts: eligibleTexts,
            });
            if (
              stopForAuth(currentRun, response) ||
              response?.runId !== currentRun ||
              !Array.isArray(response?.results) ||
              response.results.length !== eligibleTexts.length
            )
              continue;
            const nativeResults = response.results as NativeRecoveryResult[];
            if (
              nativeResults.every((result) => result.status === "unavailable")
            )
              nativeRecoveryUnavailablePairs.add(pair);
            if (nativeResults.some((result) => result.status === "accepted"))
              nativeRecoveryProgress = { phase: "ready" };
            if (runDiagnostics?.runId === currentRun)
              runDiagnostics.nativeAccepted += nativeResults.filter(
                (result) => result.status === "accepted",
              ).length;
            eligibleIndexes.forEach((textIndex, resultIndex) => {
              const result = nativeResults[resultIndex];
              if (result?.status === "accepted") {
                results[textIndex] = result.text;
                provenance[textIndex] = "browser-native";
              }
            });
          } catch {
            if (currentRun === runId) nativeRecoveryUnavailablePairs.add(pair);
          }
        }
        return { results, provenance, nativeAttempted };
      } finally {
        if (currentRun === runId)
          nativeRecoveryPending = Math.max(0, nativeRecoveryPending - 1);
      }
    };

    const cacheAcceptedOpenAiFallback = async (
      currentRun: number,
      sources: string[][],
      results: string[][],
      provenance: OpenAIFallbackProvenance,
    ) => {
      if (currentRun !== runId || !translationActive || !sources.length) return;
      try {
        const response = await browser.runtime.sendMessage({
          type: "CACHE_ACCEPTED_OPENAI_FALLBACK",
          runId: currentRun,
          targetLanguage,
          sources,
          results,
          provenance,
        });
        stopForAuth(currentRun, response);
        mergeProviderDiagnostics(currentRun, response?.diagnostics);
      } catch {
        // A cache write never changes the retained translation outcome.
      }
    };

    const cacheAcceptedPrimary = async (
      currentRun: number,
      sources: string[][],
      results: string[][],
    ) => {
      if (currentRun !== runId || !sources.length) return;
      try {
        const response = await browser.runtime.sendMessage({
          type: "CACHE_ACCEPTED_OPENAI_HTML",
          runId: currentRun,
          targetLanguage,
          sources,
          results,
        });
        stopForAuth(currentRun, response);
        mergeProviderDiagnostics(currentRun, response?.diagnostics);
      } catch {
        /* Cache persistence never undoes retained DOM. */
      }
    };

    const releaseDeferredResult = (node: Text) => {
      const pending = deferredResults.get(node);
      if (!pending) return;
      deferredResults.delete(node);
      const nodes = deferredPieces.get(pending.piece);
      nodes?.delete(node);
      if (!nodes?.size) deferredPieces.delete(pending.piece);
    };

    const flushDeferredResults = async (currentRun: number) => {
      if (
        deferredApplyRun === currentRun ||
        currentRun !== runId ||
        !deferredResults.size
      )
        return;
      const selected: [Text, DeferredResult][] = [];
      const scanStarted = performance.now();
      const pendingEntries = [...deferredResults];
      if (deferredScanCursor >= pendingEntries.length) deferredScanCursor = 0;
      let scanned = 0;
      for (; scanned < pendingEntries.length; scanned += 1) {
        const [node, pending] =
          pendingEntries[
            (deferredScanCursor + scanned) % pendingEntries.length
          ]!;
        if (
          pending.runId !== currentRun ||
          pending.target !== targetLanguage ||
          !node.isConnected ||
          node.data !== pending.source ||
          node.parentNode !== pending.parent
        ) {
          releaseDeferredResult(node);
          continue;
        }
        if (
          pieceIsInViewport(
            { ...pending.piece, nodes: [node] },
            window.innerHeight,
            window.innerWidth,
            window.innerHeight,
            window.innerWidth,
          )
        )
          selected.push([node, pending]);
        if (
          selected.length >= MAX_CONTENT_ITEMS ||
          performance.now() - scanStarted >= 8
        ) {
          scanned += 1;
          break;
        }
      }
      deferredScanCursor =
        (deferredScanCursor + scanned) % pendingEntries.length;
      if (!selected.length) return;
      deferredApplyRun = currentRun;
      reserveBatch(currentRun);
      state = "translating";
      try {
        const authorization = await browser.runtime.sendMessage({
          type: "AUTHORIZE_TRANSLATION_COMMIT",
          runId: currentRun,
          targetLanguage,
        });
        if (stopForAuth(currentRun, authorization)) return;
        if (authorization?.ok !== true || authorization.runId !== currentRun) {
          stopForAuth(currentRun, { error: "auth-unavailable" });
          return;
        }
        const groups = new Map<TranslatePiece, [Text, DeferredResult][]>();
        for (const entry of selected) {
          if (deferredResults.get(entry[0]) !== entry[1]) continue;
          if (
            entry[0].parentNode !== entry[1].parent ||
            entry[0].data !== entry[1].source
          ) {
            releaseDeferredResult(entry[0]);
            continue;
          }
          const group = groups.get(entry[1].piece) ?? [];
          group.push(entry);
          groups.set(entry[1].piece, group);
        }
        for (const [piece, entries] of groups) {
          const nodes = entries.map(([node]) => node);
          const sources = [entries.map(([, pending]) => pending.source)];
          const results = [entries.map(([, pending]) => pending.text)];
          const work = { ...piece, nodes };
          await applyPieces(currentRun, [work], [nodes], sources, results);
          if (currentRun !== runId) return;
          piece.isTranslated =
            !piece.nodes.length && !deferredPieces.has(piece);
          const cacheGroups = new Map<
            OpenAIFallbackProvenance | undefined,
            { sources: string[][]; results: string[][] }
          >();
          for (const [node, pending] of entries) {
            const retained = nodesToRestore.get(node);
            if (
              !pending.cacheable ||
              !retained ||
              retained.originalText !== pending.source ||
              retained.translatedText !== pending.text ||
              !retainedTranslation(retained)
            )
              continue;
            const group = cacheGroups.get(pending.provenance) ?? {
              sources: [],
              results: [],
            };
            group.sources.push([pending.source]);
            group.results.push([pending.text]);
            cacheGroups.set(pending.provenance, group);
          }
          for (const [provenance, group] of cacheGroups) {
            if (provenance)
              await cacheAcceptedOpenAiFallback(
                currentRun,
                group.sources,
                group.results,
                provenance,
              );
            else
              await cacheAcceptedPrimary(
                currentRun,
                group.sources,
                group.results,
              );
            if (currentRun !== runId) return;
          }
        }
      } catch {
        if (currentRun === runId)
          stopForAuth(currentRun, { error: "auth-unavailable" });
      } finally {
        releaseBatch(currentRun);
        if (deferredApplyRun === currentRun) deferredApplyRun = undefined;
        if (currentRun === runId) {
          updateRunState(currentRun);
          sendVisible(currentRun);
        }
      }
    };

    const dispatchPieces = async (
      currentRun: number,
      piecesNow: TranslatePiece[],
      fallbackOnly: boolean,
    ) => {
      const requestedNodes = piecesNow.map((piece) => [...piece.nodes]);
      const originalSources = requestedNodes.map((nodes) =>
        nodes.map((node) => node.data),
      );
      const sources = originalSources.map((row) => [...row]);
      try {
        const response = fallbackOnly
          ? {
              results: originalSources.map((row) => row.map(() => "")),
              failures: [],
            }
          : await browser.runtime.sendMessage({
              type: "TRANSLATE_HTML",
              runId: currentRun,
              targetLanguage,
              pieces: originalSources,
              deferCache: true,
            });
        if (stopForAuth(currentRun, response)) return;
        adoptTranslationPath(currentRun, response);
        const primaryResults = Array.isArray(response?.results)
          ? (response.results as string[][])
          : [];
        const cacheableResults = Array.isArray(response?.cacheableResults)
          ? (response.cacheableResults as string[][])
          : undefined;
        // "google" marks a backend Google-fallback value: it is cached in the
        // recovery chain namespace, never as an OpenAI result.
        const primaryProvenance = originalSources.map((row, pieceIndex) =>
          row.map((_, nodeIndex) =>
            response?.provenance?.[pieceIndex]?.[nodeIndex] === "google"
              ? ("google" as const)
              : undefined,
          ),
        );
        const failures = Array.isArray(response?.failures)
          ? (response.failures as HtmlTranslateFailure[])
          : [];
        mergeProviderDiagnostics(currentRun, response?.diagnostics);
        if (runDiagnostics?.runId === currentRun)
          runDiagnostics.googleFallbackAccepted += primaryProvenance
            .flat()
            .filter(Boolean).length;
        let committed = await applyPieces(
          currentRun,
          piecesNow,
          requestedNodes,
          sources,
          primaryResults,
          cacheableResults,
          primaryProvenance,
        );
        const acceptedByEngine = new Map<
          "openai" | "google",
          { sources: string[][]; results: string[][] }
        >();
        requestedNodes.forEach((nodes, pieceIndex) =>
          nodes.forEach((node, nodeIndex) => {
            const retained = nodesToRestore.get(node);
            const text = primaryResults[pieceIndex]?.[nodeIndex];
            if (
              retained &&
              text &&
              cacheableResults?.[pieceIndex]?.[nodeIndex] === text &&
              retained.originalText ===
                originalSources[pieceIndex]?.[nodeIndex] &&
              retained.translatedText === text &&
              retainedTranslation(retained)
            ) {
              const engine =
                primaryProvenance[pieceIndex]?.[nodeIndex] ?? "openai";
              const accepted = acceptedByEngine.get(engine) ?? {
                sources: [],
                results: [],
              };
              accepted.sources.push([retained.originalText]);
              accepted.results.push([text]);
              acceptedByEngine.set(engine, accepted);
            }
          }),
        );
        for (const [engine, accepted] of acceptedByEngine)
          if (engine === "google")
            await cacheAcceptedOpenAiFallback(
              currentRun,
              accepted.sources,
              accepted.results,
              "google",
            );
          else
            await cacheAcceptedPrimary(
              currentRun,
              accepted.sources,
              accepted.results,
            );
        markCommitted(currentRun, piecesNow, committed);
        if (currentRun !== runId) return;
        const retrying = fallbackOnly
          ? piecesNow.map(() => false)
          : consumeFailures(piecesNow, failures, committed);

        const residualNodes = piecesNow.map((piece) => [...piece.nodes]);
        const residualSources = sources.map((row) => [...row]);
        const owners: { pieceIndex: number; nodeIndex: number }[] = [];
        const texts: string[] = [];
        residualSources.forEach((row, pieceIndex) => {
          if (retrying[pieceIndex]) return;
          row.forEach((source, nodeIndex) => {
            owners.push({ pieceIndex, nodeIndex });
            texts.push(source);
          });
        });
        const recovery = await recoverWithNative(currentRun, texts);
        if (currentRun !== runId) return;
        const recoveredResults = residualSources.map((row) =>
          row.map(() => ""),
        );
        const recoveredProvenance = residualSources.map((row) =>
          row.map(() => undefined as OpenAIFallbackProvenance | undefined),
        );
        owners.forEach(({ pieceIndex, nodeIndex }, index) => {
          recoveredResults[pieceIndex]![nodeIndex] =
            recovery.results[index] ?? "";
          recoveredProvenance[pieceIndex]![nodeIndex] =
            recovery.provenance[index];
        });
        if (recovery.results.some(Boolean)) {
          await applyPieces(
            currentRun,
            piecesNow,
            residualNodes,
            residualSources,
            recoveredResults,
            undefined,
            recoveredProvenance,
          );
          if (currentRun !== runId) return;
          committed = piecesNow.map((piece) => piece.isTranslated);
          markCommitted(currentRun, piecesNow, committed);
          const acceptedByProvenance = new Map<
            OpenAIFallbackProvenance,
            { sources: string[][]; results: string[][] }
          >();
          recovery.results.forEach((result, index) => {
            const owner = owners[index];
            const node = owner
              ? residualNodes[owner.pieceIndex]?.[owner.nodeIndex]
              : undefined;
            const restore = node ? nodesToRestore.get(node) : undefined;
            const provenance = recovery.provenance[index];
            if (
              !result ||
              !restore ||
              restore.originalText !== texts[index] ||
              restore.translatedText !== result ||
              !retainedTranslation(restore) ||
              !provenance
            )
              return;
            const accepted = acceptedByProvenance.get(provenance) ?? {
              sources: [],
              results: [],
            };
            accepted.sources.push([texts[index]!]);
            accepted.results.push([result]);
            acceptedByProvenance.set(provenance, accepted);
          });
          for (const [provenance, accepted] of acceptedByProvenance)
            await cacheAcceptedOpenAiFallback(
              currentRun,
              accepted.sources,
              accepted.results,
              provenance,
            );
        }
      } catch (error) {
        if (currentRun !== runId) return;
        runFailed = true;
        console.error("Translation batch failed", error);
      }
    };

    const dispatchAttributes = async (
      currentRun: number,
      attributesNow: TranslateAttribute[],
      fallbackOnly: boolean,
    ) => {
      try {
        const response = fallbackOnly
          ? { results: [], failures: [] }
          : await browser.runtime.sendMessage({
              type: "TRANSLATE_TEXT",
              runId: currentRun,
              targetLanguage,
              texts: attributesNow.map((item) => item.original),
            });
        if (stopForAuth(currentRun, response)) return;
        adoptTranslationPath(currentRun, response);
        const primaryResults = (response?.results as string[]) ?? [];
        mergeProviderDiagnostics(currentRun, response?.diagnostics);
        if (
          runDiagnostics?.runId === currentRun &&
          Array.isArray(response?.provenance)
        )
          runDiagnostics.googleFallbackAccepted += (
            response.provenance as unknown[]
          ).filter((value) => value === "google").length;
        const committed = attributesNow.map((item, index) => {
          const translated = primaryResults[index];
          if (
            !translated ||
            !item.node.isConnected ||
            item.node.getAttribute(item.attribute) !== item.original
          )
            return false;
          item.node.setAttribute(item.attribute, translated);
          if (item.node.getAttribute(item.attribute) !== translated)
            return false;
          item.translated = translated;
          item.isTranslated = true;
          return true;
        });
        attributesNow.forEach((item, index) => {
          if (!primaryResults[index] || committed[index]) return;
          addRunRejection(
            currentRun,
            item.node.isConnected ? "stale" : "detached",
          );
        });
        if (committed.some(Boolean)) markFirstCommit(currentRun);
        const failures = Array.isArray(response?.failures)
          ? (response.failures as HtmlTranslateFailure[])
          : [];
        const retrying = fallbackOnly
          ? attributesNow.map(() => false)
          : consumeFailures(attributesNow, failures, committed);
        const unresolvedIndexes = committed.flatMap((accepted, index) => {
          const item = attributesNow[index]!;
          return !accepted &&
            !retrying[index] &&
            item.node.isConnected &&
            item.node.getAttribute(item.attribute) === item.original
            ? [index]
            : [];
        });
        const recovery = await recoverWithNative(
          currentRun,
          unresolvedIndexes.map((index) => attributesNow[index]!.original),
        );
        if (currentRun !== runId) return;
        const acceptedRecoveryIndexes: number[] = [];
        unresolvedIndexes.forEach((attributeIndex, recoveryIndex) => {
          const item = attributesNow[attributeIndex]!;
          const translated = recovery.results[recoveryIndex];
          if (
            !translated ||
            !item.node.isConnected ||
            item.node.getAttribute(item.attribute) !== item.original
          )
            return;
          item.node.setAttribute(item.attribute, translated);
          if (item.node.getAttribute(item.attribute) !== translated) return;
          item.translated = translated;
          item.isTranslated = true;
          committed[attributeIndex] = true;
          acceptedRecoveryIndexes.push(recoveryIndex);
        });
        const acceptedByProvenance = new Map<
          OpenAIFallbackProvenance,
          { sources: string[][]; results: string[][] }
        >();
        acceptedRecoveryIndexes.forEach((recoveryIndex) => {
          const provenance = recovery.provenance[recoveryIndex];
          const result = recovery.results[recoveryIndex];
          const attributeIndex = unresolvedIndexes[recoveryIndex];
          if (!provenance || !result || attributeIndex === undefined) return;
          const accepted = acceptedByProvenance.get(provenance) ?? {
            sources: [],
            results: [],
          };
          accepted.sources.push([attributesNow[attributeIndex]!.original]);
          accepted.results.push([result]);
          acceptedByProvenance.set(provenance, accepted);
        });
        for (const [provenance, accepted] of acceptedByProvenance)
          await cacheAcceptedOpenAiFallback(
            currentRun,
            accepted.sources,
            accepted.results,
            provenance,
          );
        markCommitted(currentRun, attributesNow, committed);
      } catch (error) {
        if (currentRun !== runId) return;
        runFailed = true;
        console.error("Translation batch failed", error);
      }
    };

    const launchBatch = (
      currentRun: number,
      batch: ContentBatch,
      fallbackOnly: boolean,
    ) => {
      reserveBatch(currentRun);
      const request =
        "pieces" in batch
          ? dispatchPieces(currentRun, batch.pieces, fallbackOnly)
          : dispatchAttributes(currentRun, batch.attributes, fallbackOnly);
      void request.finally(() => {
        releaseBatch(currentRun);
        if (currentRun !== runId) return;
        updateRunState(currentRun);
        sendVisible(currentRun);
      });
    };

    const scheduleSelectionContinuation = (currentRun: number) => {
      if (selectionContinuationRun === currentRun) return;
      selectionContinuationRun = currentRun;
      void (async () => {
        await yieldToMain();
        if (selectionContinuationRun === currentRun)
          selectionContinuationRun = undefined;
        if (currentRun === runId) sendVisible(currentRun);
      })();
    };

    const sendVisible = (currentRun: number) => {
      if (currentRun !== runId || state === "original" || !translationActive)
        return;
      if (runFailed) titlePendingRun = undefined;
      const maxContentBatches = TRANSLATION_CONCURRENCY;
      const fallbackOnly = runFailed;
      const selectionStartedAt = performance.now();
      while (
        (!runFailed || fallbackOnly) &&
        activeBatchCount(currentRun) < maxContentBatches
      ) {
        const selection = nextBatch(selectionStartedAt, !fallbackOnly);
        if (selection.batch)
          launchBatch(currentRun, selection.batch, fallbackOnly);
        if (selection.budgetExpired) {
          scheduleSelectionContinuation(currentRun);
          break;
        }
        if (!selection.batch) break;
      }
      if (
        !runFailed &&
        titlePendingRun === currentRun &&
        initialCollectionDone &&
        activeBatchCount(currentRun) < maxContentBatches
      ) {
        titlePendingRun = undefined;
        void translateTitle(currentRun);
      }
      updateRunState(currentRun);
    };

    const registerCollected = (
      collectedPieces: TranslatePiece[],
      collectedAttributes: TranslateAttribute[],
      initial: boolean,
    ) => {
      const existingNodes = new Set([
        ...pieces.flatMap((piece) => piece.nodes),
        ...nodesToRestore.keys(),
        ...deferredResults.keys(),
      ]);
      for (const piece of collectedPieces) {
        const nodes = piece.nodes.filter((node) => !existingNodes.has(node));
        if (!nodes.length) continue;
        const item =
          nodes.length === piece.nodes.length ? piece : { ...piece, nodes };
        const lane = translationLane(item);
        pieces.push(item);
        laneQueues[lane].push(item);
        laneScanRemaining[lane] = 0;
        selectionLaneIndex = 0;
        nodes.forEach((node) => existingNodes.add(node));
        const visible = recordIsVisible(item);
        if (visible) eligibleObservedAt.set(item, performance.now());
        if (initial && visible) initialCohort.add(item);
        if (runDiagnostics?.runId === runId)
          runDiagnostics.discoveredRecords += 1;
      }
      for (const item of collectedAttributes) {
        const overlap = attributes.some(
          (existing) =>
            existing.node === item.node &&
            existing.attribute === item.attribute,
        );
        if (overlap) continue;
        const lane = translationLane(item);
        attributes.push(item);
        laneQueues[lane].push(item);
        laneScanRemaining[lane] = 0;
        selectionLaneIndex = 0;
        const visible = recordIsVisible(item);
        if (visible) eligibleObservedAt.set(item, performance.now());
        if (initial && visible) initialCohort.add(item);
        if (runDiagnostics?.runId === runId)
          runDiagnostics.discoveredRecords += 1;
      }
    };

    const drainCollectorSlice = (currentRun: number) => {
      const started = performance.now();
      while (currentRun === runId && collectors.length) {
        const pending = collectors[0]!;
        const remaining = Math.max(0, 8 - (performance.now() - started));
        const drained = pending.collector.drain(remaining);
        registerCollected(drained.pieces, drained.attributes, pending.initial);
        if (drained.done) {
          collectors.shift();
          if (pending.initial) initialCollectionDone = true;
        }
        if (performance.now() - started >= 8 || !drained.done) break;
      }
    };

    const pumpCollectors = (currentRun: number) => {
      if (collectorPumpRun === currentRun) return;
      collectorPumpRun = currentRun;
      void (async () => {
        while (currentRun === runId && collectors.length) {
          drainCollectorSlice(currentRun);
          sendVisible(currentRun);
          if (collectors.length) await yieldToMain();
        }
      })().finally(() => {
        if (collectorPumpRun === currentRun) collectorPumpRun = undefined;
        if (currentRun !== runId) return;
        updateRunState(currentRun);
        if (collectors.length) pumpCollectors(currentRun);
      });
    };

    const drainMutations = (currentRun: number) => {
      if (!document.body || currentRun !== runId) return;
      const rootsForAddedNode = (node: Node): ParentNode[] => {
        if (node instanceof Element) return node.isConnected ? [node] : [];
        if (node instanceof Text)
          return node.parentElement?.isConnected ? [node.parentElement] : [];
        if (node instanceof DocumentFragment)
          return Array.from(node.childNodes).flatMap(rootsForAddedNode);
        return [];
      };
      const pending = addedNodes.splice(0);
      const removed = removedNodes.splice(0);
      for (const item of new Set([...attempted, ...retryNotBefore.keys()])) {
        if ("nodes" in item) {
          item.nodes = item.nodes.filter((node) => node.isConnected);
          if (
            !item.nodes.length &&
            !item.isTranslated &&
            !deferredPieces.has(item)
          ) {
            attempted.delete(item);
            initialCohort.delete(item);
            generationCohort.delete(item);
            eligibleThisRun.delete(item);
            attemptedThisRun.delete(item);
            eligibleObservedAt.delete(item);
            dispatchStartedAt.delete(item);
            attemptCounts.delete(item);
            retryNotBefore.delete(item);
          }
        } else if (!item.node.isConnected) {
          attempted.delete(item);
          initialCohort.delete(item);
          generationCohort.delete(item);
          eligibleThisRun.delete(item);
          attemptedThisRun.delete(item);
          eligibleObservedAt.delete(item);
          dispatchStartedAt.delete(item);
          attemptCounts.delete(item);
          retryNotBefore.delete(item);
        }
      }
      for (const [node, item] of nodesToRestore) {
        if (item.node.isConnected) continue;
        if (item.wrapper?.isConnected) releaseLayoutWrapper(item.wrapper);
        nodesToRestore.delete(node);
      }
      const roots: ParentNode[] = [];
      pending.forEach((node) => {
        if (
          removed.includes(node) ||
          (node instanceof Element &&
            (node.classList.contains(ELLIPSIS_CLASS) ||
              node.matches(`${BASELINE_MARKER_TAG}.${BASELINE_MARKER_CLASS}`)))
        )
          return;
        rootsForAddedNode(node).forEach((root) => {
          if (
            root instanceof Element &&
            root.classList.contains(ELLIPSIS_CLASS)
          )
            return;
          if (
            roots.some(
              (existing) =>
                existing === root ||
                (existing instanceof Node && existing.contains(root as Node)),
            )
          )
            return;
          roots.push(root);
        });
      });
      roots.forEach((root) =>
        collectors.push({
          collector: createTranslationCollector(root, location.hostname),
          initial: false,
        }),
      );
      if (roots.length) pumpCollectors(currentRun);
    };

    const translationRoutine = (currentRun: number) => {
      if (currentRun !== runId) return;
      void flushDeferredResults(currentRun);
      drainMutations(currentRun);
      try {
        refreshLayoutConstraints();
      } catch (error) {
        console.error("Layout refresh failed", error);
      }
      sendVisible(currentRun);
      const now = performance.now();
      const nextRetryAt = Math.min(
        ...[...retryNotBefore]
          .filter(([item]) => !item.isTranslated && recordIsActive(item))
          .map(([, due]) => due),
      );
      const delay = Number.isFinite(nextRetryAt)
        ? Math.max(0, Math.min(300, nextRetryAt - now))
        : 300;
      routineTimer = ctx.setTimeout(
        () => translationRoutine(currentRun),
        delay,
      );
    };

    const absorbMutations = (currentRun: number) => {
      if (!document.body || currentRun !== runId) return;
      observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === "characterData") {
            const node = mutation.target as Text;
            if (extensionWrites.has(node)) return;
            pieces.forEach((piece) => {
              if (!piece.nodes.includes(node)) return;
              piece.nodes = piece.nodes.filter((item) => item !== node);
              piece.isTranslated = false;
            });
            const restore = nodesToRestore.get(node);
            if (restore?.wrapper) {
              if (node.parentElement === restore.wrapper)
                unwrapLayoutConstraint(node);
              else if (restore.wrapper.isConnected)
                releaseLayoutWrapper(restore.wrapper);
            }
            nodesToRestore.delete(node);
            addedNodes.push(node);
            return;
          }
          mutation.addedNodes.forEach((node) => addedNodes.push(node));
          mutation.removedNodes.forEach((node) => removedNodes.push(node));
        });
      });
      observer.observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    };

    const translateTitle = async (currentRun: number) => {
      const title = document.querySelector("title");
      const sourceTitle = document.title;
      if (
        !title ||
        !sourceTitle.trim() ||
        title.isContentEditable ||
        ["", "true", "plaintext-only"].includes(
          title.getAttribute("contenteditable") ?? "false",
        )
      )
        return;
      reserveBatch(currentRun);
      try {
        const response = await browser.runtime.sendMessage({
          type: "TRANSLATE_SINGLE",
          runId: currentRun,
          targetLanguage,
          text: sourceTitle,
        });
        if (stopForAuth(currentRun, response)) return;
        adoptTranslationPath(currentRun, response);
        mergeProviderDiagnostics(currentRun, response?.diagnostics);
        const titleIsCurrent = () =>
          document.querySelector("title") === title &&
          document.title === sourceTitle;
        let text = typeof response?.text === "string" ? response.text : "";
        let nativeTitle = false;
        // The title follows the same chain: an unresolved title (or any title
        // on the native path) gets its one on-device attempt.
        if (!text && titleIsCurrent()) {
          const recovery = await recoverWithNative(currentRun, [sourceTitle]);
          if (currentRun !== runId) return;
          text = recovery.results[0] ?? "";
          nativeTitle = recovery.provenance[0] === "browser-native";
        }
        if (!text || !titleIsCurrent()) return;
        document.title = text;
        if (document.title !== sourceTitle) {
          originalPageTitle = sourceTitle;
          translatedPageTitle = document.title;
          translatedPageTitleNode = title;
          markFirstCommit(currentRun);
          if (nativeTitle && document.title === text)
            await cacheAcceptedOpenAiFallback(
              currentRun,
              [[sourceTitle]],
              [[text]],
              "browser-native",
            );
        }
      } catch (error) {
        if (currentRun === runId)
          console.error("Title translation failed", error);
      } finally {
        releaseBatch(currentRun);
        if (currentRun === runId) {
          updateRunState(currentRun);
          sendVisible(currentRun);
        }
      }
    };

    const startTranslation = async (requested?: TargetLanguage) => {
      const requestedTarget = requested ?? targetLanguage;
      if (
        !authError &&
        state === "translated" &&
        appliedTarget === requestedTarget
      )
        return state;
      const startedAt = performance.now();
      const claimedStart = ++startToken;
      const resumeDiscovery = authError !== undefined;
      const translateRemaining =
        state === "partial" &&
        appliedTarget === requestedTarget &&
        targetLanguage === requestedTarget;
      const remainingSnapshot = translateRemaining
        ? (resumeDiscovery
            ? [...pieces, ...attributes]
            : [...attempted]
          ).filter((item) => !item.isTranslated && recordIsActive(item))
        : [];
      const previousRun = runId;
      runId += 1;
      const currentRun = runId;
      stopPendingWork(
        previousRun || undefined,
        translateRemaining && !resumeDiscovery,
      );
      state = "preparing";
      const cancelled = new Promise<undefined>((resolve) => {
        cancelPendingStart = () => resolve(undefined);
      });
      const started = await Promise.race([
        browser.runtime.sendMessage({
          type: "BEGIN_TRANSLATION_RUN",
          runId: currentRun,
        }),
        cancelled,
      ]);
      if (claimedStart !== startToken || currentRun !== runId) return state;
      cancelPendingStart = undefined;
      if (stopForAuth(currentRun, started)) return state;
      if (started?.ok !== true) throw new Error("Invalid translation run");
      authError = undefined;
      targetLanguage = requestedTarget;
      if (translateRemaining) {
        remainingSnapshot.forEach((item) => {
          if ("nodes" in item)
            item.nodes = item.nodes.filter((node) => !nodesToRestore.has(node));
          generationCohort.add(item);
          eligibleObservedAt.set(item, startedAt);
        });
        for (const item of [...pieces, ...attributes])
          if (!item.isTranslated && recordIsActive(item))
            laneQueues[translationLane(item)].push(item);
        initialCollectionDone = !resumeDiscovery;
      } else {
        restorePage();
        runId = currentRun;
      }
      translationActive = true;
      translationPath = isTranslationPath(started?.path)
        ? started.path
        : "provider";
      sourceLanguageHint = TARGET_LANGUAGES.some(
        (language) => language.code === started?.sourceLanguageHint,
      )
        ? started.sourceLanguageHint
        : undefined;
      if (sourceLanguageHint && sourceLanguageHint !== targetLanguage) {
        const preparedRun = currentRun;
        void browser.runtime
          .sendMessage({
            type: "PREPARE_NATIVE_TRANSLATOR",
            runId: currentRun,
            sourceLanguage: sourceLanguageHint,
            targetLanguage,
          })
          .then((status) => {
            if (stopForAuth(preparedRun, status)) return;
            if (status?.progress) nativeRecoveryProgress = status.progress;
          })
          .catch(() => undefined);
      }
      runDiagnostics = {
        runId: currentRun,
        startedAt,
        records: 0,
        sourceCharacters: 0,
        requestCount: 0,
        queueMs: 0,
        requestMs: 0,
        rejectedCount: 0,
        rejectionReasons: {},
        discoveredRecords: translateRemaining ? remainingSnapshot.length : 0,
        eligibleRecords: 0,
        attemptedRecords: 0,
        deterministicRecords: 0,
        localCacheHits: 0,
        localCacheMisses: 0,
        localCacheInvalid: 0,
        chainCacheHits: 0,
        providerAccepted: 0,
        providerRejected: 0,
        googleFallbackAttempted: 0,
        googleFallbackAccepted: 0,
        nativeAttempted: 0,
        nativeAccepted: 0,
        storageReadCalls: 0,
        storageWriteCalls: 0,
        storageReadMs: 0,
        storageWriteMs: 0,
        maxViewportDispatchMs: 0,
        maxViewportCommitMs: 0,
      };
      if (!translateRemaining || (resumeDiscovery && !translatedPageTitle))
        titlePendingRun = currentRun;
      state = "translating";
      const completion = new Promise<PageTranslationState>((resolve) => {
        runCompletion = { runId: currentRun, resolve };
      });
      if (translateRemaining && !resumeDiscovery) {
        absorbMutations(currentRun);
        if (collectors.length) pumpCollectors(currentRun);
        sendVisible(currentRun);
      } else {
        collectors.push({
          collector: createTranslationCollector(
            document.documentElement,
            location.hostname,
          ),
          initial: true,
        });
        absorbMutations(currentRun);
        pumpCollectors(currentRun);
      }
      if (currentRun === runId) translationRoutine(currentRun);
      return completion;
    };

    type ContentMessageListener = Parameters<
      typeof browser.runtime.onMessage.addListener
    >[0];
    browser.runtime.onMessage.addListener(onContentMessage);
    ctx.onInvalidated(() => {
      startToken += 1;
      runId += 1;
      cancelRunCompletion();
      if (routineTimer !== undefined) window.clearTimeout(routineTimer);
      routineTimer = undefined;
      observer?.disconnect();
      observer = undefined;
      terminalStateWaiters.clear();
      attemptCounts.clear();
      retryNotBefore.clear();
      deferredResults.clear();
      deferredPieces.clear();
      deferredApplyRun = undefined;
      browser.runtime.onMessage.removeListener(onContentMessage);
    });
    function onContentMessage(
      ...[message, , sendResponse]: Parameters<ContentMessageListener>
    ) {
      if (message.type === "AUTH_STATE_CHANGED") {
        stopForAuth(runId, { error: "auth-required" });
        return false;
      }
      if (message.type === "CONTENT_STATE") {
        if (!isTopFrame) return false;
        sendResponse(contentStateResponse());
        return false;
      }
      if (message.type === "WAIT_FOR_CONTENT_TERMINAL_STATE") {
        if (!isTopFrame) return false;
        if (state === "translating" || state === "preparing") {
          terminalStateWaiters.add(() => sendResponse(contentStateResponse()));
          return true;
        }
        sendResponse(contentStateResponse());
        return false;
      }
      if (message.type === "DETECT_PAGE") {
        if (!isTopFrame) return false;
        void browser.runtime
          .sendMessage({ type: "DETECT_TAB_LANGUAGE" })
          .then((detected) => {
            if (ctx.signal.aborted) return;
            sendResponse({
              pageLanguage: detected?.pageLanguage || "Unknown",
            });
          });
        return true;
      }
      if (message.type === "START_TRANSLATION") {
        const responseTarget = message.targetLanguage as TargetLanguage;
        const translation = startTranslation(responseTarget);
        const currentStart = startToken;
        const done = translation.catch((error) => {
          if (currentStart !== startToken) return;
          console.error(error);
          state = "error";
          flushTerminalStateWaiters();
          return "error" as const;
        });
        if (!isTopFrame) {
          void done;
          return false;
        }
        void done.then((terminalState) => {
          if (ctx.signal.aborted) return;
          if (currentStart === startToken && authError) {
            sendResponse({ ok: false, ...contentStateResponse() });
            return;
          }
          if (currentStart !== startToken) {
            sendResponse({
              ok: false,
              state: "error",
              targetLanguage: responseTarget,
              translated: false,
              appliedTarget: undefined,
              hasUnresolved: false,
            });
            return;
          }
          const responseState = terminalState ?? state;
          sendResponse({
            ok: responseState === "translated" || responseState === "partial",
            state: responseState,
            targetLanguage: responseTarget,
            translated:
              responseState === "translated" || responseState === "partial",
            appliedTarget:
              responseState === "translated" || responseState === "partial"
                ? responseTarget
                : undefined,
            hasUnresolved: responseState === "partial",
          });
        });
        return true;
      }
      if (message.type === "SHOW_ORIGINAL") {
        startToken += 1;
        const cancelledRun = runId;
        runId += 1;
        restorePage(cancelledRun || undefined);
        flushTerminalStateWaiters();
        if (!isTopFrame) return false;
        sendResponse({ ok: true });
        return false;
      }
      return false;
    }
    const htmlLang = readHtmlLang(document) || undefined;
    void browser.runtime.sendMessage({
      type: "CONTENT_READY",
      url: location.href,
      hostname: location.hostname,
      htmlLang,
    });
  },
});
