import type { ReactNode } from "react";
import { ArrowRight, Globe } from "lucide-react";
import type { NativeRecoveryProgress } from "@/lib/translate/browser-native";
import { card } from "./ui";
import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";

/**
 * The "This page" card (Decision 6): the site, the language pair and the
 * primary control. Rows have fixed heights shared with `PopupSkeleton`.
 */
export function PageCard({
  host,
  children,
}: {
  host: string;
  children?: ReactNode;
}) {
  const t = useMessages(popupMessages);
  return (
    <section aria-label={t.t("page.card")} className={card}>
      <div className="flex h-5 min-w-0 items-center gap-2 text-[12.5px] leading-5 text-muted">
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-coral-soft text-coral-ink"
        >
          <Globe className="size-3" strokeWidth={2.25} />
        </span>
        <span className="truncate" title={host || undefined}>
          {host || t.t("page.card")}
        </span>
      </div>
      {children}
    </section>
  );
}

/**
 * `Japanese → [English ▾]` on one line. The labels stay for assistive
 * technology only; the detected side is absent in Reader mode.
 */
export function LanguageRow({
  detected,
  target,
}: {
  detected?: string;
  target: ReactNode;
}) {
  const t = useMessages(popupMessages);
  return (
    <div
      className={
        detected === undefined
          ? "mt-3 grid h-9 grid-cols-1 items-center"
          : "mt-3 grid h-9 grid-cols-[minmax(0,1fr)_16px_minmax(0,1.25fr)] items-center gap-2"
      }
    >
      {detected === undefined ? null : (
        <>
          <p className="min-w-0 truncate text-[15px] leading-5 font-semibold text-ink">
            <span className="sr-only">{t.t("page.detectedLanguage")}: </span>
            {detected}
          </p>
          <ArrowRight
            aria-hidden="true"
            className="size-4 text-muted"
            strokeWidth={2}
          />
        </>
      )}
      <div className="relative min-w-0 text-sm">{target}</div>
    </div>
  );
}

/** Why Translate is disabled, under the control. */
export function DisabledReason({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <p id={id} className="mt-2 animate-rl-fade text-xs leading-4 text-muted">
      {children}
    </p>
  );
}

/** First-use language-pack preparation for on-device translation. */
export function NativeDownloadProgress({
  progress,
}: {
  progress: NativeRecoveryProgress;
}) {
  const t = useMessages(popupMessages);
  const fraction =
    progress.loaded !== undefined && progress.total
      ? Math.min(1, Math.max(0, progress.loaded / progress.total))
      : undefined;
  return (
    <div className="mt-3 flex animate-rl-enter flex-col gap-1.5 text-xs leading-4 text-muted">
      <span>
        {fraction === undefined
          ? t.t("native.downloading")
          : t.t("native.downloadingPercent", {
              percent: Math.round(fraction * 100),
            })}
      </span>
      <progress
        aria-label={t.t("native.progress")}
        className="h-1.5 w-full appearance-none overflow-hidden rounded-full bg-paper-2 [&::-moz-progress-bar]:bg-brand [&::-webkit-progress-bar]:bg-paper-2 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-brand"
        max={1}
        {...(fraction === undefined ? {} : { value: fraction })}
      />
    </div>
  );
}
