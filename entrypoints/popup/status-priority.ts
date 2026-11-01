/**
 * The popup's single status slot shows only the most urgent notice
 * (ui-enhancement Decision 6). Plans, quota and update notices went away
 * with the backend (ADR 0020).
 */
export type StatusNotice = "on-device-unsupported" | "sheets-coming-soon";

export interface StatusSignals {
  /** No provider key and no on-device Translator: no translation path. */
  onDeviceUnsupported: boolean;
  /** A native Sheet while the Sheets Reader is off (ADR 0020 build flag). */
  sheetsComingSoon: boolean;
}

/** Highest priority first. */
export const STATUS_PRIORITY: readonly StatusNotice[] = [
  "on-device-unsupported",
  "sheets-coming-soon",
];

const SIGNAL: Record<StatusNotice, keyof StatusSignals> = {
  "on-device-unsupported": "onDeviceUnsupported",
  "sheets-coming-soon": "sheetsComingSoon",
};

/** The one notice the slot shows, or `undefined` when nothing is pending. */
export function topStatusNotice(
  signals: StatusSignals,
): StatusNotice | undefined {
  return STATUS_PRIORITY.find((notice) => signals[SIGNAL[notice]]);
}
