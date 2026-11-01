import { useId } from "react";
import { Settings } from "lucide-react";
import { focusRing } from "./ui";

/**
 * Header shortcut to the Settings page (provider and API key, ADR 0020).
 * When translation runs on-device, or OpenAI rejected the key, a dot on the
 * icon and the button's description say so, without adding a row: the ready
 * popup keeps the skeleton's height.
 */
export function SettingsButton({
  label,
  hint,
  tone,
  onOpen,
}: {
  label: string;
  hint?: string;
  tone?: "info" | "warn";
  onOpen: () => void;
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={hint ? hintId : undefined}
      title={hint ?? label}
      className={`relative flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-[background-color,color,translate] duration-150 ease-std ${focusRing} enabled:cursor-pointer enabled:hover:bg-paper-2 enabled:hover:text-ink enabled:active:translate-y-px`}
      onClick={onOpen}
    >
      <Settings aria-hidden="true" className="size-4" />
      {hint ? (
        <>
          <span
            aria-hidden="true"
            data-settings-attention={tone ?? "info"}
            className={`absolute top-1 right-1 size-2 rounded-full ring-2 ring-paper ${tone === "warn" ? "bg-warn" : "bg-brand"}`}
          />
          <span id={hintId} className="sr-only">
            {hint}
          </span>
        </>
      ) : null}
    </button>
  );
}
