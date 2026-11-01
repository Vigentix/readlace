/**
 * Shared popup class strings. Every enabled control changes color on hover,
 * moves 1px on press and shows a ring on keyboard focus; disabled controls
 * show `not-allowed` and never move (e2e `@popup-ui` interaction contract).
 */
export const focusRing =
  "focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-paper focus-visible:outline-none";

export const pressable = `transition-[background-color,border-color,color,translate,box-shadow] duration-150 ease-std ${focusRing} enabled:cursor-pointer enabled:active:translate-y-px disabled:cursor-not-allowed`;

export const primaryButton = `inline-flex items-center justify-center gap-2 rounded-[10px] bg-brand px-4 font-semibold text-on-brand ${pressable} enabled:hover:bg-brand-hover disabled:bg-paper-2 disabled:text-muted`;

export const secondaryButton = `inline-flex items-center justify-center gap-2 rounded-[10px] border border-line bg-card px-3 font-semibold text-ink ${pressable} enabled:hover:border-line-strong enabled:hover:bg-paper-2 disabled:text-muted`;

export const inputField =
  "h-9 rounded-lg border border-line bg-card px-3 text-sm font-normal text-ink transition-[border-color,box-shadow] duration-150 ease-std outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/25 disabled:cursor-not-allowed disabled:bg-paper-2 disabled:text-muted";

/** Card surface used for "this page" and the sign-in panel. */
export const card =
  "mx-3 rounded-xl border border-line bg-card p-3.5 shadow-card";
