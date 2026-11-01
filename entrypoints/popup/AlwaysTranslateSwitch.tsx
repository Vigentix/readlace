import { useMessages } from "@/lib/i18n/react";
import { popupMessages } from "@/lib/i18n/catalog/popup";

/**
 * The per-site "Always translate" preference as an on/off switch. It sits at
 * the foot of the page card, since it belongs to the page that is open.
 */
export function AlwaysTranslateSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useMessages(popupMessages);
  return (
    <label className="mt-3 box-content flex h-8 shrink-0 cursor-pointer items-center justify-between gap-3 border-t border-line pt-2 text-[13.5px] leading-5 text-ink-soft">
      <span>{t.t("page.always")}</span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative h-[22px] w-[38px] shrink-0 rounded-full bg-line-strong transition-colors duration-[220ms] ease-std peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card after:absolute after:top-[3px] after:left-[3px] after:size-4 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgb(0_0_0/0.25)] after:transition-transform after:duration-[220ms] after:ease-std peer-checked:after:translate-x-4"
      />
    </label>
  );
}
