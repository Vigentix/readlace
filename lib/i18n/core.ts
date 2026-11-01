/**
 * The extension's small typed i18n layer (UI locale, `CONTEXT.md`).
 *
 * A catalog is a flat record of message keys. English catalogs are the
 * source of truth (`as const`, so placeholder names are part of the type);
 * a Vietnamese catalog must be a `Translation` of its English one, so a
 * missing key is a compile error. Messages use `{name}` placeholders and,
 * where a count changes the wording, `{ one, other }` plural forms chosen
 * with `Intl.PluralRules` for the active locale (Vietnamese has only
 * `other`). Codes stay internal: the UI maps a JSON code to a key at the
 * edge and never classifies by message text.
 */

export const UI_LOCALES = ["en", "vi"] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** BCP 47 tags for `Intl` formatting, matching the web app (`web/lib/copy.ts`). */
export const INTL_LOCALE: Record<UiLocale, string> = {
  en: "en-US",
  vi: "vi-VN",
};

export interface PluralMessage {
  readonly one?: string;
  readonly other: string;
}
export type MessageValue = string | PluralMessage;
export type MessageCatalog = Readonly<Record<string, MessageValue>>;

/** The same keys as `C`, worded for another locale. */
export type Translation<C extends MessageCatalog> = {
  readonly [K in keyof C]: C[K] extends string ? string : PluralMessage;
};

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;
type MessageText<V> = V extends string
  ? V
  : V extends { readonly other: infer Other }
    ? Other | (V extends { readonly one: infer One } ? One : never)
    : never;
export type MessageParams<V> = V extends string
  ? [Placeholders<V>] extends [never]
    ? never
    : Record<Placeholders<V>, string | number>
  : Record<Placeholders<MessageText<V>> | "count", string | number> & {
      count: number;
    };
/** `t(key)` for a message without placeholders, `t(key, params)` otherwise. */
export type MessageArgs<V> = [MessageParams<V>] extends [never]
  ? []
  : [params: MessageParams<V>];

/** A message kept in state and translated when it renders. */
export type MessageRef<C extends MessageCatalog> = {
  [K in keyof C & string]: MessageArgs<C[K]> extends []
    ? K | { key: K }
    : { key: K; params: MessageParams<C[K]> };
}[keyof C & string];

export interface Translator<C extends MessageCatalog> {
  readonly locale: UiLocale;
  t<K extends keyof C & string>(key: K, ...args: MessageArgs<C[K]>): string;
  /** Translates a `MessageRef` stored in state. */
  text(ref: MessageRef<C>): string;
  /** Plain number in the active locale. */
  number(value: number, options?: Intl.NumberFormatOptions): string;
  /** Character counts: compact from 10,000 (`1.2M`, `1,2 Tr`). */
  chars(value: number): string;
  /** A date such as `Oct 14, 2026` / `14 thg 10, 2026`. */
  date(value: string | number | Date): string;
}

/** Substitutes `{name}` placeholders; numbers use the locale's digits. */
export function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>> | undefined,
  locale: UiLocale,
) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === "number"
      ? new Intl.NumberFormat(INTL_LOCALE[locale]).format(value)
      : value;
  });
}

/** Placeholder names in every form of a message (catalog parity tests). */
export function placeholdersOf(value: MessageValue) {
  const forms = typeof value === "string" ? [value] : Object.values(value);
  const names = new Set<string>();
  for (const form of forms)
    for (const match of String(form).matchAll(/\{(\w+)\}/g))
      names.add(match[1]!);
  return names;
}

function pluralForm(value: PluralMessage, count: number, locale: UiLocale) {
  const rule = new Intl.PluralRules(INTL_LOCALE[locale]).select(count);
  return rule === "one" && value.one !== undefined ? value.one : value.other;
}

export function formatMessage(
  value: MessageValue | undefined,
  params: Readonly<Record<string, string | number>> | undefined,
  locale: UiLocale,
) {
  if (value === undefined) return "";
  const template =
    typeof value === "string"
      ? value
      : pluralForm(value, Number(params?.count ?? 0), locale);
  return interpolate(template, params, locale);
}

export function createTranslator<C extends MessageCatalog>(
  locale: UiLocale,
  english: C,
  vietnamese: Translation<C>,
): Translator<C> {
  const catalog: MessageCatalog = locale === "vi" ? vietnamese : english;
  const intlLocale = INTL_LOCALE[locale];
  const t = (key: string, params?: Record<string, string | number>) =>
    formatMessage(catalog[key] ?? english[key], params, locale);
  return {
    locale,
    t: t as Translator<C>["t"],
    text: (ref) => {
      const value = ref as
        string | { key: string; params?: Record<string, string | number> };
      return typeof value === "string" ? t(value) : t(value.key, value.params);
    },
    number: (value, options) =>
      new Intl.NumberFormat(intlLocale, options).format(value),
    chars: (value) =>
      new Intl.NumberFormat(intlLocale, {
        notation: value >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
      }).format(value),
    date: (value) =>
      new Intl.DateTimeFormat(intlLocale, { dateStyle: "medium" }).format(
        new Date(value),
      ),
  };
}

/** A catalog pair with one translator per locale, created on first use. */
export interface MessageBundle<C extends MessageCatalog> {
  readonly en: C;
  readonly vi: Translation<C>;
  translator(locale: UiLocale): Translator<C>;
}

export function defineMessages<C extends MessageCatalog>(
  en: C,
  vi: Translation<C>,
): MessageBundle<C> {
  const cache = new Map<UiLocale, Translator<C>>();
  return {
    en,
    vi,
    translator(locale) {
      let translator = cache.get(locale);
      if (!translator) {
        translator = createTranslator(locale, en, vi);
        cache.set(locale, translator);
      }
      return translator;
    },
  };
}
