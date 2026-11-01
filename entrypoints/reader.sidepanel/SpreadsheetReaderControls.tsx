import {
  AlertCircle,
  Languages,
  LoaderCircle,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";

import { Select, type SelectOption } from "@/components/Select";
import { readerMessages } from "@/lib/i18n/catalog/reader";
import { useMessages } from "@/lib/i18n/react";
import type {
  SpreadsheetTranslationCapabilities,
  SpreadsheetTranslationState,
} from "@/lib/spreadsheet-reader-state";

export type SpreadsheetSourcePhase =
  | "bootstrapping"
  | "identifying"
  | "discovering"
  | "loading-sheet"
  | "awaiting-start"
  | "empty"
  | "ready"
  | "error"
  | "disconnecting";

export type SpreadsheetPresentation = "translation" | "original";

/**
 * Text props (`sourceLabel`, `sourceTitle`, `worksheetPlaceholder`, message
 * and connection labels, `completionAnnouncement`) arrive already worded in
 * the UI locale; the toolbar translates only its own fixed labels.
 */
export interface SpreadsheetReaderActionableMessage {
  readonly text: string;
  readonly tone: "partial" | "warning" | "error";
}

export type SpreadsheetReaderConnection =
  | {
      readonly kind: "google";
      readonly label: string;
      readonly badgeLabel: string;
      readonly disconnecting: boolean;
      readonly onDisconnect: () => void;
    }
  | {
      readonly kind: "local";
      readonly label: string;
      readonly badgeLabel: string;
    };

export interface SpreadsheetReaderControlsProps {
  readonly sourceLabel: string;
  readonly sourceTitle: string;
  readonly sourcePhase: SpreadsheetSourcePhase;
  readonly worksheetOptions: readonly SelectOption[];
  readonly worksheetValue: string;
  readonly worksheetDisabled?: boolean;
  readonly worksheetPlaceholder?: string;
  readonly onWorksheetChange: (value: string) => void;
  readonly targetOptions: readonly SelectOption[];
  readonly targetValue: string;
  readonly onTargetChange: (value: string) => void;
  readonly translationState: SpreadsheetTranslationState;
  readonly translationCapabilities: SpreadsheetTranslationCapabilities;
  readonly onPrimaryAction: () => void;
  readonly onStop: () => void;
  readonly presentation: SpreadsheetPresentation;
  readonly onPresentationChange: (value: SpreadsheetPresentation) => void;
  readonly refreshDisabled: boolean;
  readonly onRefresh: () => void;
  readonly clearDisabled: boolean;
  readonly onClear: () => void;
  readonly connection: SpreadsheetReaderConnection;
  readonly actionableMessage?: SpreadsheetReaderActionableMessage;
  readonly completionAnnouncement?: string;
}

export interface SpreadsheetReaderSourceStateProps {
  readonly phase: SpreadsheetSourcePhase;
  readonly title?: string;
  readonly description?: string;
}

const sourcePhaseLabels = {
  bootstrapping: "reader.phase.bootstrapping",
  identifying: "reader.phase.identifying",
  discovering: "reader.phase.discovering",
  "loading-sheet": "reader.phase.loadingSheet",
  "awaiting-start": "reader.phase.awaitingStart",
  empty: "reader.phase.empty",
  error: "reader.phase.error",
  disconnecting: "reader.phase.disconnecting",
} as const satisfies Record<Exclude<SpreadsheetSourcePhase, "ready">, string>;

const gridSkeleton = (
  <div className="spreadsheet-grid-skeleton" aria-hidden="true">
    {Array.from({ length: 10 }, (_, row) => (
      <div className="spreadsheet-skeleton-row" key={row}>
        <span />
        <span />
        <span />
      </div>
    ))}
  </div>
);

export function SpreadsheetReaderSourceState({
  phase,
  title,
  description,
}: SpreadsheetReaderSourceStateProps) {
  const t = useMessages(readerMessages);
  if (phase === "ready") return null;
  const loading =
    phase === "bootstrapping" ||
    phase === "identifying" ||
    phase === "discovering" ||
    phase === "loading-sheet";

  return (
    <section
      className={
        loading
          ? "spreadsheet-source-state is-loading"
          : "spreadsheet-source-state"
      }
      aria-label={t.t("reader.sourceState")}
      aria-busy={loading || phase === "disconnecting"}
      data-source-phase={phase}
    >
      <div
        className="spreadsheet-source-message"
        role={phase === "error" ? "alert" : "status"}
        aria-atomic="true"
      >
        <strong>{title ?? t.t(sourcePhaseLabels[phase])}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      {loading ? gridSkeleton : null}
    </section>
  );
}

export default function SpreadsheetReaderControls({
  sourceLabel,
  sourceTitle,
  sourcePhase,
  worksheetOptions,
  worksheetValue,
  worksheetDisabled,
  worksheetPlaceholder: worksheetPlaceholderText,
  onWorksheetChange,
  targetOptions,
  targetValue,
  onTargetChange,
  translationState,
  translationCapabilities,
  onPrimaryAction,
  onStop,
  presentation,
  onPresentationChange,
  refreshDisabled,
  onRefresh,
  clearDisabled,
  onClear,
  connection,
  actionableMessage,
  completionAnnouncement,
}: SpreadsheetReaderControlsProps) {
  const t = useMessages(readerMessages);
  const worksheetPlaceholder =
    worksheetPlaceholderText ?? t.t("reader.worksheetPlaceholder");
  const selectedWorksheet = worksheetOptions.find(
    (option) => option.value === worksheetValue,
  );
  const hasWorksheetCatalog = worksheetOptions.length > 0;
  const worksheetTitle = hasWorksheetCatalog
    ? (selectedWorksheet?.label ?? "")
    : worksheetPlaceholder;
  const sourceBusy =
    sourcePhase === "bootstrapping" ||
    sourcePhase === "identifying" ||
    sourcePhase === "discovering" ||
    sourcePhase === "loading-sheet" ||
    sourcePhase === "disconnecting";
  const translating = translationState.phase === "translating";
  const sourceLoading = sourceBusy && sourcePhase !== "disconnecting";
  const primaryBusy = translating || sourceLoading;
  const settingsDisabled =
    sourceBusy || translationCapabilities.settingsDisabled;

  return (
    <section
      className="reader-controls spreadsheet-reader-controls"
      aria-label={t.t("reader.controls")}
      aria-busy={sourceBusy || translating}
    >
      <div className="source-context">
        <span>{sourceLabel}</span>
        <strong title={sourceTitle}>{sourceTitle}</strong>
      </div>

      <div className="reader-fields spreadsheet-fields">
        <div className="reader-field spreadsheet-field" title={worksheetTitle}>
          <Select
            disabled={
              !hasWorksheetCatalog || (worksheetDisabled ?? settingsDisabled)
            }
            label={t.t("reader.worksheet")}
            options={
              hasWorksheetCatalog
                ? worksheetOptions
                : [{ value: "", label: worksheetPlaceholder }]
            }
            value={selectedWorksheet?.value ?? ""}
            variant="compact"
            onValueChange={onWorksheetChange}
          />
        </div>
        <div className="reader-field spreadsheet-field">
          <Select
            disabled={settingsDisabled}
            label={t.t("reader.translateTo")}
            options={targetOptions}
            value={targetValue}
            variant="compact"
            onValueChange={onTargetChange}
          />
        </div>
      </div>

      <div className="primary-actions spreadsheet-primary-actions">
        <button
          type="button"
          className="primary-button"
          disabled={sourceBusy || translationCapabilities.primaryDisabled}
          aria-busy={primaryBusy}
          onClick={onPrimaryAction}
        >
          {primaryBusy ? (
            <LoaderCircle
              size={16}
              className="spinner"
              aria-hidden="true"
              data-testid="reader-spinner"
            />
          ) : (
            <Languages size={16} aria-hidden="true" />
          )}
          <span>
            {sourceLoading
              ? t.t("reader.loading")
              : t.t(translationCapabilities.primaryLabel)}
          </span>
        </button>
        <button
          type="button"
          className="secondary-button stop-button"
          disabled={translationCapabilities.stopDisabled}
          onClick={onStop}
        >
          <Square size={16} aria-hidden="true" />
          <span>{t.t("reader.stop")}</span>
        </button>
      </div>

      <div className="reader-secondary-row spreadsheet-secondary-row">
        <div
          className="sheet-presentation-toggle"
          aria-label={t.t("reader.presentation")}
        >
          <button
            type="button"
            aria-pressed={presentation === "translation"}
            disabled={translationCapabilities.presentationDisabled}
            onClick={() => onPresentationChange("translation")}
          >
            {t.t("reader.presentation.translation")}
          </button>
          <button
            type="button"
            aria-pressed={presentation === "original"}
            disabled={translationCapabilities.presentationDisabled}
            onClick={() => onPresentationChange("original")}
          >
            {t.t("reader.presentation.original")}
          </button>
        </div>
        <div className="utility-actions">
          <button type="button" disabled={refreshDisabled} onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            {t.t("reader.refresh")}
          </button>
          <button type="button" disabled={clearDisabled} onClick={onClear}>
            <Trash2 aria-hidden="true" />
            {t.t("reader.clearView")}
          </button>
        </div>
      </div>

      {actionableMessage ? (
        <div
          className={`reader-status ${actionableMessage.tone}`}
          role={actionableMessage.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          aria-atomic="true"
        >
          <AlertCircle aria-hidden="true" />
          <span>{actionableMessage.text}</span>
        </div>
      ) : null}

      {completionAnnouncement ? (
        <p className="reader-sr-only" role="status" aria-live="polite">
          {completionAnnouncement}
        </p>
      ) : null}

      {translating ? (
        <span className="reader-progress" aria-hidden="true">
          <span className="reader-progress-thread" data-thread="" />
        </span>
      ) : null}

      <div className="spreadsheet-connection-footer">
        <div className="spreadsheet-connection-context">
          <span>{connection.label}</span>
          <span className="connection connected">{connection.badgeLabel}</span>
        </div>
        {connection.kind === "google" ? (
          <button
            type="button"
            className="disconnect-button"
            disabled={connection.disconnecting}
            onClick={connection.onDisconnect}
          >
            {connection.disconnecting
              ? t.t("reader.disconnecting")
              : t.t("reader.disconnectGoogle")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
