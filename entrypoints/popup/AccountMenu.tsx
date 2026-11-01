import { useEffect, useId, useRef, useState } from "react";
import { Eraser, Menu } from "lucide-react";
import { focusRing } from "./ui";
import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";
import { LanguageSwitch } from "./LanguageSwitch";

const itemClass = `flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-medium text-ink transition-[background-color,color,translate] duration-150 ease-std ${focusRing} focus-visible:ring-offset-card enabled:cursor-pointer enabled:hover:bg-paper-2 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:text-muted`;

/**
 * Menu disclosure in the header: Clear saved translations and the UI
 * language. There are no accounts (ADR 0020). It overlays the page card, so
 * opening it never shifts the layout. Choosing an action, Escape or a click
 * outside closes it.
 */
export function AccountMenu({
  clearDisabled,
  onClear,
}: {
  clearDisabled: boolean;
  onClear: () => void;
}) {
  const t = useMessages(popupMessages);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    panel.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  // A chosen action closes the menu; focus returns to the account button.
  function choose(action: () => void) {
    setOpen(false);
    trigger.current?.focus();
    action();
  }
  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label={t.t("account.menu")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`flex size-8 items-center justify-center rounded-full border border-line bg-card text-xs font-semibold text-ink-soft transition-[background-color,border-color,color,translate,box-shadow] duration-150 ease-std ${focusRing} enabled:cursor-pointer enabled:hover:border-line-strong enabled:hover:bg-paper-2 enabled:hover:text-ink enabled:active:translate-y-px aria-expanded:border-brand aria-expanded:text-brand-ink`}
        onClick={() => setOpen((current) => !current)}
      >
        <Menu aria-hidden="true" className="size-4" />
      </button>
      {open ? (
        <div
          ref={panel}
          id={panelId}
          className="absolute top-full right-0 z-30 mt-2 flex w-60 origin-top-right animate-rl-pop flex-col gap-0.5 rounded-xl border border-line bg-card p-1.5 shadow-pop"
        >
          <button
            type="button"
            className={itemClass}
            disabled={clearDisabled}
            onClick={() => choose(onClear)}
          >
            <Eraser aria-hidden="true" className="size-4 text-muted" />
            {t.t("account.clearSaved")}
          </button>
          <LanguageSwitch
            stacked
            className="mt-1 border-t border-line px-1.5 pt-2 pb-1"
          />
        </div>
      ) : null}
    </div>
  );
}
