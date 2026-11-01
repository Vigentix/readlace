import { browser } from "wxt/browser";
import { UI_LOCALES, type UiLocale } from "./core";

/**
 * The stored UI locale preference (`CONTEXT.md` **UI locale**). It lives in
 * the extension IndexedDB `kv` store under this key and is read and written
 * only by the background (`UI_LOCALE_GET` / `UI_LOCALE_SET`); content
 * scripts never open that database.
 */
export const UI_LOCALE_KEY = "uiLocale";

export interface UiLocaleGetRequest {
  type: "UI_LOCALE_GET";
}
export interface UiLocaleSetRequest {
  type: "UI_LOCALE_SET";
  locale: UiLocale;
}
export interface UiLocaleResponse {
  /** The locale the UI shows: the stored choice, else the browser language. */
  locale: UiLocale;
  /** The user's explicit choice, if any. */
  stored: UiLocale | null;
}
/** Broadcast to open extension pages after a successful `UI_LOCALE_SET`. */
export interface UiLocaleChangedEvent {
  type: "UI_LOCALE_CHANGED";
  locale: UiLocale;
}

export function parseUiLocale(value: unknown): UiLocale | undefined {
  return UI_LOCALES.includes(value as UiLocale)
    ? (value as UiLocale)
    : undefined;
}

/**
 * A stored choice wins; otherwise any `vi*` browser language is Vietnamese
 * and everything else English.
 */
export function resolveUiLocale(
  stored: unknown,
  browserLanguage: string | undefined,
): UiLocale {
  const choice = parseUiLocale(stored);
  if (choice) return choice;
  return /^vi(?:[-_]|$)/i.test(browserLanguage?.trim() ?? "") ? "vi" : "en";
}

/** The browser's UI language (`i18n.getUILanguage`), else `navigator`. */
export function browserUiLanguage(): string | undefined {
  try {
    const language = browser.i18n?.getUILanguage?.();
    if (typeof language === "string" && language) return language;
  } catch {
    // Test fakes and some hosts do not implement `i18n`.
  }
  return typeof navigator === "undefined" ? undefined : navigator.language;
}

export function parseUiLocaleResponse(
  value: unknown,
): UiLocaleResponse | undefined {
  const response = value as Partial<UiLocaleResponse> | null | undefined;
  const locale = parseUiLocale(response?.locale);
  if (!locale) return undefined;
  return { locale, stored: parseUiLocale(response?.stored) ?? null };
}

/**
 * The current UI locale from the background. Without an answer (old
 * background, test fake) the browser language decides.
 */
export async function requestUiLocale(): Promise<UiLocale> {
  const response = await browser.runtime
    .sendMessage({ type: "UI_LOCALE_GET" } satisfies UiLocaleGetRequest)
    .then(parseUiLocaleResponse, () => undefined);
  return response?.locale ?? resolveUiLocale(undefined, browserUiLanguage());
}

/** Saves an explicit choice; resolves with the saved locale. */
export async function saveUiLocale(locale: UiLocale): Promise<UiLocale> {
  const response = parseUiLocaleResponse(
    await browser.runtime.sendMessage({
      type: "UI_LOCALE_SET",
      locale,
    } satisfies UiLocaleSetRequest),
  );
  if (!response) throw new Error("UI locale was not saved");
  return response.locale;
}

export function parseUiLocaleChanged(message: unknown): UiLocale | undefined {
  const event = message as Partial<UiLocaleChangedEvent> | null | undefined;
  return event?.type === "UI_LOCALE_CHANGED"
    ? parseUiLocale(event.locale)
    : undefined;
}
