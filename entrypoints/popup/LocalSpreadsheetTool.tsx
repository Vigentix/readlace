import { FileSpreadsheet } from "lucide-react";
import { focusRing } from "./ui";
import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";

/**
 * The popup quick-open for the Local Spreadsheet Reader: it opens the Reader
 * tab, where a workbook is dropped or picked. Every feature is open
 * (ADR 0020).
 */
export function LocalSpreadsheetTool({
  opening,
  onOpen,
}: {
  opening: boolean;
  onOpen: () => void;
}) {
  const t = useMessages(popupMessages);
  const label = t.t(opening ? "tools.opening" : "tools.open");
  return (
    <section
      className="mx-3 flex shrink-0 flex-col gap-2"
      aria-label={t.t("tools.section")}
    >
      <button
        type="button"
        className={`flex h-12 w-full items-center gap-3 rounded-xl border border-line bg-transparent px-3 text-left transition-[border-color,background-color,translate,box-shadow] duration-150 ease-std ${focusRing} enabled:cursor-pointer enabled:hover:border-brand enabled:hover:bg-card enabled:active:translate-y-px disabled:cursor-not-allowed`}
        disabled={opening}
        aria-busy={opening}
        aria-label={label}
        onClick={onOpen}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-ink">
          <FileSpreadsheet aria-hidden="true" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[13.5px] leading-[18px] font-semibold text-ink">
            {label}
          </span>
          <span className="block truncate text-xs leading-4 text-muted">
            {t.t("tools.hint")}
          </span>
        </span>
      </button>
    </section>
  );
}
