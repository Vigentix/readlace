export type SpreadsheetTranslationPhase =
  "idle" | "translating" | "watching" | "paused" | "partial" | "error";

export interface SpreadsheetTranslationState {
  readonly phase: SpreadsheetTranslationPhase;
}

export type SpreadsheetTranslationEvent =
  | { readonly type: "start" }
  | { readonly type: "request-accepted" }
  | { readonly type: "completion" }
  | { readonly type: "empty-visible" }
  | { readonly type: "stop" }
  | { readonly type: "resume" }
  | { readonly type: "partial" }
  | { readonly type: "retry" }
  | { readonly type: "error" }
  | { readonly type: "settings-change" }
  | { readonly type: "source-change" }
  | { readonly type: "browser-sheet-change" }
  | { readonly type: "reader-sheet-change" };

export interface SpreadsheetTranslationContext {
  readonly sourceReady: boolean;
  readonly settingsReady?: boolean;
  readonly hasVisibleRecords: boolean;
  readonly hasTranslations: boolean;
}

/**
 * The primary button's label as a Reader message key (`lib/i18n/catalog/
 * reader.en.ts`); the toolbar translates it when it renders.
 */
export type SpreadsheetPrimaryLabel =
  | "reader.primary.translate"
  | "reader.primary.translating"
  | "reader.primary.translationOn"
  | "reader.primary.resume"
  | "reader.primary.retryUnresolved"
  | "reader.primary.retry";

export interface SpreadsheetTranslationCapabilities {
  readonly primaryLabel: SpreadsheetPrimaryLabel;
  readonly primaryDisabled: boolean;
  readonly stopDisabled: boolean;
  readonly settingsDisabled: boolean;
  readonly presentationDisabled: boolean;
  readonly shouldContinueOnReaderSheetChange: boolean;
}

export const INITIAL_SPREADSHEET_TRANSLATION_STATE: SpreadsheetTranslationState =
  Object.freeze({ phase: "idle" });

const PRIMARY_LABELS: Record<
  SpreadsheetTranslationPhase,
  SpreadsheetPrimaryLabel
> = {
  idle: "reader.primary.translate",
  translating: "reader.primary.translating",
  watching: "reader.primary.translationOn",
  paused: "reader.primary.resume",
  partial: "reader.primary.retryUnresolved",
  error: "reader.primary.retry",
};

function isActivePhase(phase: SpreadsheetTranslationPhase) {
  return phase === "translating" || phase === "watching";
}

function withPhase(
  state: SpreadsheetTranslationState,
  phase: SpreadsheetTranslationPhase,
) {
  return state.phase === phase ? state : { phase };
}

export function transitionSpreadsheetTranslation(
  state: SpreadsheetTranslationState,
  event: SpreadsheetTranslationEvent,
): SpreadsheetTranslationState {
  switch (event.type) {
    case "start":
      return isActivePhase(state.phase)
        ? state
        : withPhase(state, "translating");
    case "request-accepted":
      return state.phase === "watching" || state.phase === "partial"
        ? withPhase(state, "translating")
        : state;
    case "completion":
    case "empty-visible":
      return state.phase === "translating"
        ? withPhase(state, "watching")
        : state;
    case "stop":
      return isActivePhase(state.phase) || state.phase === "partial"
        ? withPhase(state, "paused")
        : state;
    case "resume":
      return state.phase === "paused" ? withPhase(state, "translating") : state;
    case "partial":
      return isActivePhase(state.phase) ? withPhase(state, "partial") : state;
    case "retry":
      return state.phase === "partial" || state.phase === "error"
        ? withPhase(state, "translating")
        : state;
    case "error":
      return withPhase(state, "error");
    case "settings-change":
    case "source-change":
    case "browser-sheet-change":
      return withPhase(state, "idle");
    case "reader-sheet-change":
      return isActivePhase(state.phase)
        ? withPhase(state, "translating")
        : withPhase(state, "idle");
  }
}

export function deriveSpreadsheetTranslationCapabilities(
  state: SpreadsheetTranslationState,
  context: SpreadsheetTranslationContext,
): SpreadsheetTranslationCapabilities {
  const active = isActivePhase(state.phase);
  const needsVisibleRecords =
    state.phase === "idle" ||
    state.phase === "partial" ||
    state.phase === "error";

  return {
    primaryLabel: PRIMARY_LABELS[state.phase],
    primaryDisabled:
      active ||
      !context.sourceReady ||
      (needsVisibleRecords && !context.hasVisibleRecords),
    stopDisabled: !active,
    settingsDisabled:
      !(context.settingsReady ?? context.sourceReady) ||
      state.phase === "translating",
    presentationDisabled: !context.hasTranslations,
    shouldContinueOnReaderSheetChange: active,
  };
}
