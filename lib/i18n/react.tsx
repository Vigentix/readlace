import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { browser } from "wxt/browser";
import type {
  MessageBundle,
  MessageCatalog,
  Translator,
  UiLocale,
} from "./core";
import {
  browserUiLanguage,
  parseUiLocaleChanged,
  requestUiLocale,
  resolveUiLocale,
  saveUiLocale,
} from "./locale";

interface UiLocaleState {
  locale: UiLocale;
  /** Saves an explicit choice through the background (extension pages). */
  setLocale?: (locale: UiLocale) => Promise<void>;
}

// Without a provider (unit tests of single components) the UI is English.
const UiLocaleContext = createContext<UiLocaleState>({ locale: "en" });

/**
 * A fixed locale for a subtree, with no effects. The selection panel uses
 * it: its runtime asks the background for the locale on mount and on every
 * open, and must not add listeners or touch the host page's DOM.
 */
export function UiLocaleScope({
  locale,
  children,
}: {
  locale: UiLocale;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ locale }), [locale]);
  return <UiLocaleContext value={value}>{children}</UiLocaleContext>;
}

/**
 * The UI locale of an extension page (popup, Reader). It starts from
 * `initialLocale` (or the browser language), asks the background unless an
 * initial locale was given, follows `UI_LOCALE_CHANGED` broadcasts so a
 * switch in the popup reaches open pages, and mirrors the locale into
 * `<html lang>` of this extension document.
 */
export function UiLocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale?: UiLocale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<UiLocale>(
    () => initialLocale ?? resolveUiLocale(undefined, browserUiLanguage()),
  );
  useEffect(() => {
    let active = true;
    if (initialLocale === undefined)
      void requestUiLocale().then((current) => {
        if (active) setLocaleState(current);
      });
    const onChanged = (message: unknown, sender: { id?: string }) => {
      if (sender.id !== browser.runtime.id) return;
      const next = parseUiLocaleChanged(message);
      if (next) setLocaleState(next);
    };
    browser.runtime.onMessage.addListener(onChanged);
    return () => {
      active = false;
      browser.runtime.onMessage.removeListener(onChanged);
    };
  }, [initialLocale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback(async (next: UiLocale) => {
    let previous: UiLocale | undefined;
    setLocaleState((current) => {
      previous = current;
      return next;
    });
    try {
      setLocaleState(await saveUiLocale(next));
    } catch {
      if (previous) setLocaleState(previous);
    }
  }, []);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <UiLocaleContext value={value}>{children}</UiLocaleContext>;
}

export function useUiLocale() {
  return useContext(UiLocaleContext);
}

/** The translator of one catalog bundle for the current UI locale. */
export function useMessages<C extends MessageCatalog>(
  bundle: MessageBundle<C>,
): Translator<C> {
  return bundle.translator(useContext(UiLocaleContext).locale);
}
