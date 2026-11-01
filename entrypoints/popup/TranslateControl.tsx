import type { ReactNode } from "react";
import { CircleAlert, Check, Eye, RotateCcw, Square } from "lucide-react";
import type { PageTranslationState } from "@/lib/translate/page-language";
import { focusRing } from "./ui";
import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";

/**
 * Presentation of the page card's primary control (popup states review,
 * 2026-10-17). One control slot, 44px high in every state:
 *
 * - `button`: the indigo action. "Translate", "Translate to <language>"
 *   after the target changed, or "Try again" after an error.
 * - `busy`: still indigo (never greyed), a coral thread runs along the
 *   bottom, and Stop cancels the run and restores the original page.
 * - `view`: a pure view switch, Translation | Original. The pressed side
 *   does nothing; the other side switches. Switching back to Translation
 *   re-applies saved translations, so it costs no provider call.
 *
 * Labels and enablement come from the popup's existing rules
 * (`shouldEnableTranslate`); this only chooses the presentation.
 */
export type TranslateView =
  | {
      kind: "button";
      tone: "idle" | "error";
      label: string;
      disabled: boolean;
    }
  | {
      kind: "busy";
      label: string;
      /** Page runs can be stopped; opening the Reader cannot. */
      canStop: boolean;
    }
  | {
      kind: "view";
      showing: "translation" | "original";
      translationDisabled: boolean;
      originalDisabled: boolean;
    };

/** The line above the control that says what happened to the page. */
export type PageStatus = "translated" | "partial" | "original" | "error";

export function translateControlView({
  readerMode,
  readerOpening,
  pageState,
  translationActive,
  translated,
  retarget,
  restored,
  label,
  disabled,
  originalLocked,
}: {
  readerMode: boolean;
  readerOpening: boolean;
  pageState: PageTranslationState;
  /** Page state is `translating` or `preparing`. */
  translationActive: boolean;
  /** Page state is `translated` or `partial`. */
  translated: boolean;
  /** Translated, but to a different language than the one now chosen. */
  retarget: boolean;
  /** **Show original** ran from this popup; keep the view switch. */
  restored: boolean;
  label: string;
  disabled: boolean;
  /** Any popup operation is running (Show original must wait). */
  originalLocked: boolean;
}): TranslateView {
  if (readerMode)
    return readerOpening
      ? { kind: "busy", label, canStop: false }
      : { kind: "button", tone: "idle", label, disabled };
  if (translationActive) return { kind: "busy", label, canStop: true };
  if (pageState === "error")
    return { kind: "button", tone: "error", label, disabled };
  if (translated && retarget)
    return { kind: "button", tone: "idle", label, disabled };
  if (translated || restored)
    return {
      kind: "view",
      showing: translated ? "translation" : "original",
      translationDisabled: translated ? false : disabled,
      originalDisabled: !translated || originalLocked,
    };
  return { kind: "button", tone: "idle", label, disabled };
}

/** Which status line, if any, sits above the control. */
export function pageStatusFor({
  readerMode,
  pageState,
  translated,
  restored,
  translationActive,
}: {
  readerMode: boolean;
  pageState: PageTranslationState;
  translated: boolean;
  restored: boolean;
  translationActive: boolean;
}): PageStatus | undefined {
  if (readerMode || translationActive) return undefined;
  if (pageState === "error") return "error";
  if (pageState === "partial") return "partial";
  if (translated) return "translated";
  if (restored) return "original";
  return undefined;
}

const segmentClass = `relative z-10 flex min-w-0 items-center justify-center rounded-[7px] px-2 text-sm font-semibold transition-[color,translate] duration-150 ease-std ${focusRing} focus-visible:ring-offset-paper-2 enabled:cursor-pointer disabled:cursor-default`;

export function TranslateControl({
  view,
  describedBy,
  onTranslate,
  onShowOriginal,
  onStop,
}: {
  view: TranslateView;
  describedBy?: string;
  onTranslate: () => void;
  onShowOriginal: () => void;
  onStop: () => void;
}) {
  const t = useMessages(popupMessages);
  if (view.kind === "view") {
    const translation = view.showing === "translation";
    return (
      <div
        role="group"
        aria-label={t.t("translate.view")}
        className="relative grid h-11 animate-rl-fade grid-cols-2 rounded-[10px] bg-paper-2 p-1"
      >
        <span
          aria-hidden="true"
          className={`absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-[7px] bg-card shadow-card ring-1 ring-line transition-transform duration-[220ms] ease-std motion-reduce:transition-none ${translation ? "translate-x-0" : "translate-x-full"}`}
        />
        <button
          type="button"
          aria-pressed={translation}
          aria-label={t.t("translate.showTranslation")}
          aria-describedby={describedBy}
          disabled={view.translationDisabled}
          onClick={translation ? undefined : onTranslate}
          className={`${segmentClass} ${translation ? "text-ink" : "text-muted enabled:hover:text-ink enabled:active:translate-y-px"}`}
        >
          <span className="truncate">{t.t("translate.translation")}</span>
        </button>
        <button
          type="button"
          aria-pressed={!translation}
          aria-label={t.t("translate.showOriginal")}
          disabled={view.originalDisabled}
          onClick={translation ? onShowOriginal : undefined}
          className={`${segmentClass} ${translation ? "text-muted enabled:hover:text-ink enabled:active:translate-y-px" : "text-ink"}`}
        >
          <span className="truncate">{t.t("translate.original")}</span>
        </button>
      </div>
    );
  }
  if (view.kind === "busy")
    return (
      <div className="grid h-11 grid-cols-[minmax(0,1fr)_auto] overflow-hidden rounded-[10px] bg-brand text-on-brand">
        <button
          type="button"
          data-state="busy"
          aria-busy="true"
          aria-describedby={describedBy}
          disabled
          className="relative flex min-w-0 cursor-progress items-center justify-center pb-1 text-[15px] font-semibold text-on-brand"
        >
          <span className="truncate">{view.label}</span>
          <span
            aria-hidden="true"
            className="absolute inset-x-3.5 bottom-2 h-[3px] overflow-hidden rounded-full bg-on-brand/20"
          >
            <span
              data-thread=""
              className="absolute inset-y-0 left-0 w-[34%] animate-rl-thread rounded-full bg-coral motion-reduce:left-1/3"
            />
          </span>
        </button>
        {view.canStop ? (
          <button
            type="button"
            aria-label={t.t("translate.stopLabel")}
            onClick={onStop}
            className={`flex items-center gap-1.5 border-l border-on-brand/20 bg-on-brand/10 px-3.5 text-[13.5px] font-semibold transition-[background-color,translate] duration-150 ease-std ${focusRing} focus-visible:ring-offset-brand enabled:cursor-pointer enabled:hover:bg-on-brand/20 enabled:active:translate-y-px`}
          >
            <Square
              aria-hidden="true"
              className="size-3 fill-current"
              strokeWidth={0}
            />
            {t.t("translate.stop")}
          </button>
        ) : null}
      </div>
    );
  return (
    <button
      type="button"
      data-state={view.tone}
      aria-busy={false}
      aria-describedby={describedBy}
      disabled={view.disabled}
      onClick={onTranslate}
      className={`relative flex h-11 w-full animate-rl-fade items-center justify-center gap-2 overflow-hidden rounded-[10px] bg-brand text-[15px] font-semibold text-on-brand transition-[background-color,color,translate,box-shadow] duration-150 ease-std ${focusRing} enabled:cursor-pointer enabled:hover:bg-brand-hover enabled:active:translate-y-px disabled:cursor-not-allowed disabled:bg-paper-2 disabled:text-muted`}
    >
      {view.tone === "error" ? (
        <RotateCcw aria-hidden="true" className="size-4" strokeWidth={2.25} />
      ) : null}
      <span className="truncate">{view.label}</span>
    </button>
  );
}

const STATUS_STYLE = {
  translated: { icon: Check, line: "text-ink-soft", mark: "text-ok" },
  partial: { icon: CircleAlert, line: "text-ink-soft", mark: "text-coral" },
  original: { icon: Eye, line: "text-ink-soft", mark: "text-muted" },
  error: { icon: CircleAlert, line: "text-danger", mark: "text-danger" },
} as const;

/** The status line above the control; `action` is an inline text button. */
export function PageStatusLine({
  status,
  children,
  action,
}: {
  status: PageStatus;
  children: ReactNode;
  action?: { label: string; disabled?: boolean; onClick: () => void };
}) {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <p
      data-page-status={status}
      className={`mt-3 flex animate-rl-fade items-start gap-1.5 text-[13px] leading-5 ${style.line}`}
    >
      <Icon
        aria-hidden="true"
        className={`mt-[3px] size-3.5 shrink-0 ${style.mark}`}
        strokeWidth={status === "translated" ? 2.75 : 2.25}
      />
      <span className="min-w-0">
        {children}
        {action ? (
          <button
            type="button"
            disabled={action.disabled}
            onClick={action.onClick}
            className={`ml-1.5 rounded-sm font-semibold text-brand-ink underline decoration-1 underline-offset-[3px] transition-colors duration-150 ${focusRing} focus-visible:ring-offset-card enabled:cursor-pointer enabled:hover:text-ink disabled:cursor-not-allowed disabled:text-muted`}
          >
            {action.label}
          </button>
        ) : null}
      </span>
    </p>
  );
}
