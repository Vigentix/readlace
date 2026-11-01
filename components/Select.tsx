import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  label: string;
  value: string;
}

interface SelectProps {
  disabled?: boolean;
  label: string;
  /** Keep the label for assistive technology only (the popup's one-line pair). */
  labelHidden?: boolean;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  portalContainer?: HTMLElement | ShadowRoot | null;
  value: string;
  /**
   * `popup` and `compact` (Reader, selection panel) use the shared paper/ink
   * tokens (`assets/ui-tokens.css`); `default` keeps the neutral palette.
   */
  variant?: "default" | "compact" | "popup";
}

const LABEL_CLASS = {
  default: "font-medium text-slate-800",
  compact: "text-xs leading-4 font-medium text-muted",
  popup: "text-xs leading-4 font-medium text-muted",
} as const;

const TRIGGER_CLASS = {
  default:
    "flex w-full items-center justify-between rounded-md border border-slate-300 bg-white font-normal text-slate-900 transition-[background-color,border-color,transform] select-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-100 focus-visible:outline-none enabled:cursor-pointer enabled:hover:border-slate-400 enabled:hover:bg-slate-50 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 h-9 px-3",
  compact:
    "flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-card font-medium text-ink transition-[background-color,border-color,translate] duration-150 ease-std select-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25 focus-visible:outline-none enabled:cursor-pointer enabled:hover:border-line-strong enabled:hover:bg-paper-2 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:bg-paper-2 disabled:text-muted h-8 px-2 text-sm",
  popup:
    "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 text-sm font-semibold text-ink transition-[background-color,border-color,translate] duration-150 ease-std select-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-card focus-visible:outline-none enabled:cursor-pointer enabled:hover:border-line-strong enabled:hover:bg-paper-2 enabled:active:translate-y-px disabled:cursor-not-allowed disabled:text-muted",
} as const;

const POPUP_CLASS = {
  default:
    "min-w-[var(--anchor-width)] overflow-hidden rounded-md border border-slate-200 bg-white py-1 text-sm text-slate-900 shadow-lg outline-none",
  compact:
    "min-w-[var(--anchor-width)] overflow-hidden rounded-lg border border-line bg-card p-1 text-sm text-ink shadow-pop outline-none",
  popup:
    "min-w-[var(--anchor-width)] origin-[var(--transform-origin)] overflow-hidden rounded-lg border border-line bg-card p-1 text-sm text-ink shadow-pop outline-none transition-[opacity,scale] duration-150 ease-std data-ending-style:scale-[.98] data-ending-style:opacity-0 data-starting-style:scale-[.98] data-starting-style:opacity-0",
} as const;

const ITEM_CLASS = {
  default:
    "grid cursor-pointer grid-cols-[1fr_1rem] items-center gap-3 font-normal outline-none select-none data-highlighted:bg-blue-50 data-highlighted:text-blue-900 data-selected:font-medium px-3 py-2",
  compact:
    "grid cursor-pointer grid-cols-[1fr_1rem] items-center gap-3 rounded-md font-normal outline-none select-none data-highlighted:bg-brand-soft data-highlighted:text-brand-ink data-selected:font-semibold px-2 py-1.5",
  popup:
    "grid cursor-pointer grid-cols-[1fr_1rem] items-center gap-3 rounded-md px-2.5 py-1.5 font-normal outline-none select-none data-highlighted:bg-brand-soft data-highlighted:text-brand-ink data-selected:font-semibold",
} as const;

export function Select({
  disabled,
  label,
  labelHidden = false,
  onValueChange,
  options,
  portalContainer,
  value,
  variant = "default",
}: SelectProps) {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue !== null) onValueChange(nextValue);
      }}
    >
      <BaseSelect.Label
        className={labelHidden ? "sr-only" : LABEL_CLASS[variant]}
      >
        {label}
      </BaseSelect.Label>
      <BaseSelect.Trigger
        aria-label={label}
        className={TRIGGER_CLASS[variant]}
        disabled={disabled}
      >
        <BaseSelect.Value>
          {(selectedValue) =>
            options.find((option) => option.value === selectedValue)?.label ??
            selectedValue
          }
        </BaseSelect.Value>
        <BaseSelect.Icon
          className={variant === "default" ? "text-slate-500" : "text-muted"}
        >
          <ChevronDown
            aria-hidden="true"
            className="size-4"
            strokeWidth={1.5}
          />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal container={portalContainer ?? undefined}>
        <BaseSelect.Positioner
          className="z-50 outline-none"
          data-role="select-positioner"
          sideOffset={4}
          alignItemWithTrigger={false}
          style={
            portalContainer ? { pointerEvents: "auto", zIndex: 1 } : undefined
          }
        >
          <BaseSelect.Popup className={POPUP_CLASS[variant]}>
            <BaseSelect.List>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  className={ITEM_CLASS[variant]}
                  label={option.label}
                  value={option.value}
                >
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                  <BaseSelect.ItemIndicator>
                    <Check
                      aria-hidden="true"
                      className="size-4"
                      strokeWidth={1.5}
                    />
                  </BaseSelect.ItemIndicator>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
