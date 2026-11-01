import { useEffect, useState } from "react";
import {
  Check,
  CircleAlert,
  Copy,
  Languages,
  LoaderCircle,
  X,
} from "lucide-react";
import { Mark } from "@/components/Mark";
import { Select, type SelectOption } from "@/components/Select";
import { TARGET_LANGUAGES, type TargetLanguage } from "@/lib/translation";
import { useMessages } from "@/lib/i18n/react";
import { languageKey } from "@/lib/i18n/catalog/common";
import { selectionMessages } from "@/lib/i18n/catalog/selection";

export type SelectionTranslationView = "hidden" | "icon" | "panel";

export interface SelectionTranslationPanelProps {
  busy: boolean;
  error: boolean;
  iconUrl: string;
  /** An error already translated for the panel's UI locale. */
  message: string;
  onClose: () => void;
  onOpen: () => void;
  onTargetChange: (target: TargetLanguage) => void;
  onTranslate: () => void;
  portalContainer: HTMLElement | ShadowRoot;
  result: string;
  target: TargetLanguage;
  timedOut: boolean;
  view: SelectionTranslationView;
}

const resultTransitionMs = 180;

type CopyState = "idle" | "copied" | "failed";

const copyLabels = {
  idle: "selection.copy",
  copied: "selection.copied",
  failed: "selection.copyFailed",
} as const satisfies Record<CopyState, string>;

/** Writes plain text with the async Clipboard API (secure pages only). */
async function writeClipboard(text: string) {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SelectionTranslationPanel({
  busy,
  error,
  iconUrl,
  message,
  onClose,
  onOpen,
  onTargetChange,
  onTranslate,
  portalContainer,
  result,
  target,
  timedOut,
  view,
}: SelectionTranslationPanelProps) {
  const t = useMessages(selectionMessages);
  const targetOptions: readonly SelectOption[] = TARGET_LANGUAGES.map(
    ({ code }) => ({ label: t.t(languageKey(code)), value: code }),
  );
  const showError = timedOut || error;
  const [lastResult, setLastResult] = useState(result);
  const displayedResult = result || lastResult;
  const [copy, setCopy] = useState<{ state: CopyState; text: string }>({
    state: "idle",
    text: "",
  });
  // A new or cleared result starts with a fresh Copy button.
  const copyState = copy.text === displayedResult ? copy.state : "idle";
  const copyResult = () => {
    const text = displayedResult;
    if (!text) return;
    void writeClipboard(text).then((copied) =>
      setCopy({ state: copied ? "copied" : "failed", text }),
    );
  };

  if (result && result !== lastResult) setLastResult(result);
  else if (!result && view !== "panel" && lastResult) setLastResult("");

  useEffect(() => {
    if (result || !lastResult) return;
    const timer = window.setTimeout(
      () => setLastResult(""),
      resultTransitionMs,
    );
    return () => window.clearTimeout(timer);
  }, [lastResult, result]);

  return (
    <div
      className="readlace-selection"
      data-role="selection-root"
      hidden={view === "hidden"}
    >
      <button
        type="button"
        className="readlace-selection__icon"
        data-role="selection-trigger"
        aria-label={t.t("selection.open")}
        title={t.t("selection.open")}
        hidden={view !== "icon"}
        onClick={onOpen}
      >
        <img src={iconUrl} alt="" aria-hidden="true" />
      </button>

      <section
        className="readlace-selection__panel"
        data-role="selection-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby="readlace-selection-title"
        aria-busy={busy}
        hidden={view !== "panel"}
      >
        <header className="readlace-selection__header">
          <div className="readlace-selection__brand flex min-w-0 items-center gap-2">
            <Mark className="readlace-selection__brand-icon" />
            <h2 id="readlace-selection-title">Readlace</h2>
          </div>
          <button
            type="button"
            className="readlace-selection__close"
            data-role="selection-close"
            aria-label={t.t("selection.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
        </header>

        <div
          className="readlace-selection__fields grid grid-cols-1 gap-2"
          data-role="selection-fields"
        >
          <div
            className="readlace-selection__field min-w-0"
            data-role="target-field"
          >
            <Select
              disabled={busy}
              label={t.t("selection.translateTo")}
              options={targetOptions}
              portalContainer={portalContainer}
              value={target}
              variant="compact"
              onValueChange={(value) => onTargetChange(value as TargetLanguage)}
            />
          </div>
        </div>

        <button
          type="button"
          className="readlace-selection__translate flex w-full items-center justify-center gap-2"
          data-role="selection-translate"
          disabled={busy}
          aria-busy={busy}
          onClick={onTranslate}
        >
          {busy ? (
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
              strokeWidth={2}
            />
          ) : (
            <Languages aria-hidden="true" className="size-4" strokeWidth={2} />
          )}
          <span>
            {t.t(busy ? "selection.translating" : "selection.translate")}
          </span>
          {busy ? (
            <span
              className="readlace-selection__thread"
              data-thread=""
              aria-hidden="true"
            />
          ) : null}
        </button>

        {showError ? (
          <p
            className="readlace-selection__status flex items-start gap-2"
            data-role="selection-status"
            data-state="error"
            role="alert"
          >
            <CircleAlert
              aria-hidden="true"
              className="size-4"
              strokeWidth={2}
            />
            <span>{timedOut ? t.t("selection.timeout") : message}</span>
          </p>
        ) : null}

        <div
          className="readlace-selection__result-group"
          data-has-result={result ? "true" : "false"}
        >
          <div className="readlace-selection__result-motion">
            <div
              className="readlace-selection__result-head"
              hidden={!displayedResult}
            >
              <p
                className="readlace-selection__result-label"
                aria-hidden="true"
              >
                {t.t("selection.result")}
              </p>
              <button
                type="button"
                className="readlace-selection__copy"
                data-role="selection-copy"
                data-state={copyState === "idle" ? undefined : copyState}
                aria-label={t.t(
                  copyState === "idle"
                    ? "selection.copyTranslation"
                    : copyLabels[copyState],
                )}
                onClick={copyResult}
                onAnimationEnd={(event) => {
                  if (event.target === event.currentTarget)
                    setCopy({ state: "idle", text: "" });
                }}
              >
                {copyState === "copied" ? (
                  <Check aria-hidden="true" strokeWidth={2.25} />
                ) : (
                  <Copy aria-hidden="true" strokeWidth={2} />
                )}
                <span>{t.t(copyLabels[copyState])}</span>
              </button>
            </div>
            <div
              className="readlace-selection__result max-h-[220px] overflow-auto whitespace-pre-wrap"
              data-role="selection-result"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              aria-label={t.t("selection.resultLabel")}
            >
              {displayedResult}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
