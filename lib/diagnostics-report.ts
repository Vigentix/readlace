import type { EngineSource } from "@/lib/translation-path";
import type { ProviderId } from "@/shared/provider-settings";
import type { TranslationRunSummary } from "@/lib/translate/translation-diagnostics";

/** Settings page → background: the report for **Copy diagnostics**. */
export const DIAGNOSTICS_GET = "DIAGNOSTICS_GET";

/** Runs copied into a report; the stored history keeps the same number. */
const MAX_REPORTED_RUNS = 20;

const RUN_NUMBER_FIELDS = [
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
  "nativeAttempted",
  "nativeAccepted",
  "storageReadCalls",
  "storageWriteCalls",
  "storageReadMs",
  "storageWriteMs",
  "maxViewportDispatchMs",
  "maxViewportCommitMs",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
] as const satisfies readonly (keyof TranslationRunSummary)[];

export interface DiagnosticsInput {
  extensionVersion: string;
  userAgent: string;
  uiLocale: string;
  engine: {
    source: EngineSource;
    provider: ProviderId;
    model: string;
    keyConfigured: boolean;
    keyRejected: boolean;
  };
  onDeviceTranslation: "supported" | "unsupported";
  sheetsReader: boolean;
  workspaceReader: boolean;
  runs: readonly TranslationRunSummary[];
  now?: Date;
}

type ReportedRun = Partial<
  Record<(typeof RUN_NUMBER_FIELDS)[number], number>
> & {
  provider: string;
  rejectionReasons: Record<string, number>;
};

export interface DiagnosticsReport {
  readlaceDiagnostics: 1;
  generatedAt: string;
  extensionVersion: string;
  userAgent: string;
  uiLocale: string;
  engine: DiagnosticsInput["engine"];
  onDeviceTranslation: DiagnosticsInput["onDeviceTranslation"];
  sheetsReader: boolean;
  workspaceReader: boolean;
  recentRuns: ReportedRun[];
}

function reportedRun(run: TranslationRunSummary): ReportedRun {
  const reported: ReportedRun = {
    provider: String(run.provider),
    rejectionReasons: {},
  };
  for (const field of RUN_NUMBER_FIELDS) {
    const value = run[field];
    if (typeof value === "number" && Number.isFinite(value))
      reported[field] = value;
  }
  for (const [reason, count] of Object.entries(run.rejectionReasons ?? {}))
    if (typeof count === "number" && Number.isFinite(count))
      reported.rejectionReasons[reason] = count;
  return reported;
}

/**
 * A troubleshooting report the user can paste into a GitHub issue (ADR 0020).
 * Every field is copied explicitly from an allowlist, so the API key (or its
 * masked form), page text, translations and URLs can never be included, even
 * if a caller passes them by mistake.
 */
export function buildDiagnosticsReport(
  input: DiagnosticsInput,
): DiagnosticsReport {
  return {
    readlaceDiagnostics: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    extensionVersion: String(input.extensionVersion),
    userAgent: String(input.userAgent),
    uiLocale: String(input.uiLocale),
    engine: {
      source: input.engine.source,
      provider: input.engine.provider,
      model: String(input.engine.model),
      keyConfigured: input.engine.keyConfigured === true,
      keyRejected: input.engine.keyRejected === true,
    },
    onDeviceTranslation: input.onDeviceTranslation,
    sheetsReader: input.sheetsReader === true,
    workspaceReader: input.workspaceReader === true,
    recentRuns: input.runs.slice(-MAX_REPORTED_RUNS).map(reportedRun),
  };
}
