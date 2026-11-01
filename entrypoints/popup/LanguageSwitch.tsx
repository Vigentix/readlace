import { useId } from "react";
import type { UiLocale } from "@/lib/i18n/core";
import { useMessages, useUiLocale } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";

/** Each language in its own name, so it is findable from either locale. */
const OPTIONS: readonly { value: UiLocale; label: string }[] = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

/**
 * The UI language (`CONTEXT.md` **UI locale**): in the account menu, and in
 * the sign-in panel while signed out. A choice is saved through the
 * background and applies at once here and in open Reader pages.
 */
export function LanguageSwitch({
  className = "",
  stacked = false,
}: {
  className?: string;
  /** Label above a full-width switch (the narrow account menu). */
  stacked?: boolean;
}) {
  const t = useMessages(popupMessages);
  const { locale, setLocale } = useUiLocale();
  const labelId = useId();
  const name = useId();
  return (
    <div
      className={`flex shrink-0 ${stacked ? "flex-col items-stretch gap-1.5" : "items-center justify-between gap-3"} ${className}`}
    >
      <span id={labelId} className="text-xs leading-4 font-medium text-muted">
        {t.t("language.label")}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-2 gap-0.5 rounded-lg bg-paper-2 p-0.5"
      >
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            lang={option.value}
            className={`flex h-7 cursor-pointer items-center justify-center rounded-md px-2.5 text-xs leading-4 font-semibold whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-std has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand ${
              locale === option.value
                ? "bg-card text-ink shadow-card"
                : "text-muted hover:text-ink"
            }`}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              value={option.value}
              checked={locale === option.value}
              disabled={!setLocale}
              onChange={() => void setLocale?.(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}
