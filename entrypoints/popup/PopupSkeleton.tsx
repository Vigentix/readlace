import { card } from "./ui";
import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";

// Radius is set per placeholder so it matches the control it stands for.
const fill = "animate-pulse bg-line motion-reduce:animate-none";

/**
 * Loading shell. Each row reserves the exact height of the signed-in popup
 * row it stands for (header, page card with its Always translate foot,
 * spreadsheet tool, empty footer status), so the ready popup does not shift
 * the layout.
 */
export function PopupSkeleton() {
  const t = useMessages(popupMessages);
  return (
    <main
      className="flex w-90 flex-col gap-3 bg-paper font-sans text-ink"
      aria-busy="true"
    >
      <span className="sr-only">{t.t("loading")}</span>
      <header
        className="flex h-14 shrink-0 items-center gap-2.5 px-4"
        data-skeleton-row="header"
      >
        <div className={`${fill} size-8 shrink-0 rounded-lg`} />
        <div className="min-w-0 flex-1">
          <div className={`${fill} h-3.5 w-24 rounded-md`} />
        </div>
        <div className={`${fill} size-8 shrink-0 rounded-full`} />
      </header>
      <div className={card} data-skeleton-row="page">
        <div className="flex h-5 items-center gap-2">
          <div className={`${fill} size-5 rounded-[5px]`} />
          <div className={`${fill} h-3 w-36 rounded-md`} />
        </div>
        <div className="mt-3 grid h-9 grid-cols-[minmax(0,1fr)_16px_minmax(0,1.25fr)] items-center gap-2">
          <div className={`${fill} h-4 w-20 rounded-md`} />
          <span />
          <div className={`${fill} h-9 w-full rounded-lg`} />
        </div>
        <div className={`${fill} mt-3 h-11 w-full rounded-[10px]`} />
        <div
          className="mt-3 box-content flex h-8 items-center justify-between border-t border-line pt-2"
          data-skeleton-row="always"
        >
          <div className={`${fill} h-3.5 w-40 rounded-md`} />
          <div className={`${fill} h-[22px] w-[38px] rounded-full`} />
        </div>
      </div>
      <div className="mx-3 shrink-0" data-skeleton-row="spreadsheet-tools">
        <div className={`${fill} h-12 w-full rounded-[10px]`} />
      </div>
      <div className="-mt-3 px-4 pb-1" data-skeleton-row="status" />
    </main>
  );
}
