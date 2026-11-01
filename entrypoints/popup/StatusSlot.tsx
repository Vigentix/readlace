import type { ReactNode } from "react";
import { CircleAlert, FileSpreadsheet, MonitorSmartphone } from "lucide-react";
import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";
import { primaryButton, secondaryButton } from "./ui";

/**
 * The single status slot (Decision 6): the top notice chosen by
 * `topStatusNotice`. It sits after the page controls, so a notice appearing
 * never moves the Translate control. The live `role="status"` line stays the
 * popup's last child (the footer), outside this slot.
 */
export function StatusSlot({ notice }: { notice?: ReactNode }) {
  if (!notice) return null;
  return (
    <div
      data-status-slot=""
      className="flex shrink-0 flex-col gap-2.5 border-t border-line px-4 pt-3"
    >
      {notice}
    </div>
  );
}

const TONES = {
  warn: { box: "bg-coral-soft text-ink", icon: "text-coral-ink" },
  info: { box: "bg-brand-soft text-ink", icon: "text-brand-ink" },
  neutral: { box: "bg-paper-2 text-ink-soft", icon: "text-muted" },
} as const;

function Notice({
  label,
  role,
  tone,
  icon: Icon,
  title,
  children,
}: {
  label: string;
  role?: "alert";
  tone: keyof typeof TONES;
  icon: typeof CircleAlert;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section
      role={role}
      aria-label={label}
      className={`flex animate-rl-enter gap-2.5 rounded-[10px] px-3 py-2 text-xs leading-[18px] ${TONES[tone].box}`}
    >
      <Icon
        aria-hidden="true"
        className={`mt-px size-4 shrink-0 ${TONES[tone].icon}`}
        strokeWidth={2}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13px] leading-[18px] font-semibold text-ink">
          {title}
        </p>
        {children}
      </div>
    </section>
  );
}

/**
 * No provider key and no on-device Translator: nothing can translate here.
 * Say so and point to Settings (ADR 0020).
 */
export function OnDeviceNotice({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const t = useMessages(popupMessages);
  return (
    <Notice
      label={t.t("notice.onDevice")}
      tone="warn"
      icon={MonitorSmartphone}
      title={t.t("notice.onDeviceUnsupported")}
    >
      <p>{t.t("notice.onDeviceAddKey")}</p>
      <button
        type="button"
        className={`${secondaryButton} mt-2 h-9 self-start text-[13px]`}
        onClick={onOpenSettings}
      >
        {t.t("settings.open")}
      </button>
    </Notice>
  );
}

/** A native Sheet while the Sheets Reader flag is off (ADR 0015). */
export function SheetsComingSoonNotice({
  message,
  opening,
  onOpen,
}: {
  message: string;
  opening: boolean;
  onOpen: () => void;
}) {
  const t = useMessages(popupMessages);
  return (
    <Notice
      label={t.t("notice.sheets")}
      tone="info"
      icon={FileSpreadsheet}
      title={message}
    >
      <p className="text-ink-soft">{t.t("notice.sheetsDownloadSteps")}</p>
      <button
        type="button"
        className={`${primaryButton} mt-2 h-9 self-start text-[13px]`}
        disabled={opening}
        aria-busy={opening}
        onClick={onOpen}
      >
        {t.t(opening ? "tools.opening" : "tools.open")}
      </button>
    </Notice>
  );
}
