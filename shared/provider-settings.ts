/**
 * Translation provider settings for bring-your-own-key (ADR 0020).
 *
 * The record is versioned and keyed by provider from day one, so adding a
 * provider later needs no migration. Only the background and the Settings
 * page may hold the full record; everything else gets a
 * `ProviderSettingsView`, which never carries the key.
 */

export const PROVIDER_SETTINGS_VERSION = 1;
export const PROVIDER_IDS = ["openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Models offered for OpenAI. The prompt, strict JSON output and
 * `reasoningEffort: "minimal"` are verified on the GPT-5 family only.
 */
export const OPENAI_MODELS = ["gpt-5-nano", "gpt-5-mini", "gpt-5"] as const;
export type OpenAIModel = (typeof OPENAI_MODELS)[number];
export const DEFAULT_OPENAI_MODEL: OpenAIModel = "gpt-5-nano";

const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 512;

export interface OpenAIProviderSettings {
  /** Absent until the user saves a key; the model choice survives removal. */
  apiKey?: string;
  model: OpenAIModel;
}

export interface ProviderSettings {
  version: typeof PROVIDER_SETTINGS_VERSION;
  activeProvider: ProviderId;
  providers: { openai?: OpenAIProviderSettings };
}

/** What may leave the background: never the key itself. */
export interface ProviderSettingsView {
  activeProvider: ProviderId;
  providers: {
    openai: { configured: boolean; maskedKey?: string; model: OpenAIModel };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOpenAIModel(value: unknown): value is OpenAIModel {
  return (OPENAI_MODELS as readonly unknown[]).includes(value);
}

/**
 * A pasted key, trimmed. Refuses anything that cannot be a bearer token:
 * inner whitespace, non-printable or non-ASCII characters, or an implausible
 * length. The provider still decides whether the key is valid.
 */
export function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH)
    return undefined;
  return /^[\x21-\x7e]+$/.test(key) ? key : undefined;
}

/** `sk-…abcd`: a recognizable prefix and the last four characters only. */
export function maskApiKey(key: string) {
  const prefix = key.startsWith("sk-") ? "sk-" : "";
  return `${prefix}…${key.slice(-4)}`;
}

export function emptyProviderSettings(): ProviderSettings {
  return {
    version: PROVIDER_SETTINGS_VERSION,
    activeProvider: "openai",
    providers: {},
  };
}

/**
 * Validates an untrusted stored record. A malformed record yields
 * `undefined` (treated as "not configured") rather than a guess; an unknown
 * saved model falls back to the default.
 */
export function parseProviderSettings(
  value: unknown,
): ProviderSettings | undefined {
  if (
    !isRecord(value) ||
    value.version !== PROVIDER_SETTINGS_VERSION ||
    !(PROVIDER_IDS as readonly unknown[]).includes(value.activeProvider) ||
    !isRecord(value.providers)
  )
    return undefined;
  const settings = emptyProviderSettings();
  const openai = value.providers.openai;
  if (openai !== undefined) {
    if (!isRecord(openai)) return undefined;
    const model = isOpenAIModel(openai.model)
      ? openai.model
      : DEFAULT_OPENAI_MODEL;
    if (openai.apiKey === undefined) settings.providers.openai = { model };
    else {
      const apiKey = normalizeApiKey(openai.apiKey);
      if (!apiKey) return undefined;
      settings.providers.openai = { apiKey, model };
    }
  }
  return settings;
}

function openAIModelOf(settings: ProviderSettings) {
  return settings.providers.openai?.model ?? DEFAULT_OPENAI_MODEL;
}

export function withOpenAIKey(
  settings: ProviderSettings,
  apiKey: string,
): ProviderSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      openai: { apiKey, model: openAIModelOf(settings) },
    },
  };
}

export function withOpenAIModel(
  settings: ProviderSettings,
  model: OpenAIModel,
): ProviderSettings {
  const apiKey = settings.providers.openai?.apiKey;
  return {
    ...settings,
    providers: {
      ...settings.providers,
      openai: apiKey === undefined ? { model } : { apiKey, model },
    },
  };
}

export function withoutOpenAIKey(settings: ProviderSettings): ProviderSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      openai: { model: openAIModelOf(settings) },
    },
  };
}

export function providerSettingsView(
  settings: ProviderSettings | undefined,
): ProviderSettingsView {
  const openai = settings?.providers.openai;
  return {
    activeProvider: settings?.activeProvider ?? "openai",
    providers: {
      openai: {
        configured: openai?.apiKey !== undefined,
        ...(openai?.apiKey === undefined
          ? {}
          : { maskedKey: maskApiKey(openai.apiKey) }),
        model: openai?.model ?? DEFAULT_OPENAI_MODEL,
      },
    },
  };
}

/** Validates a view received in a runtime message (Settings, popup). */
export function parseProviderSettingsView(
  value: unknown,
): ProviderSettingsView | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) return undefined;
  const openai = value.providers.openai;
  if (
    !(PROVIDER_IDS as readonly unknown[]).includes(value.activeProvider) ||
    !isRecord(openai) ||
    typeof openai.configured !== "boolean" ||
    !isOpenAIModel(openai.model) ||
    (openai.maskedKey !== undefined && typeof openai.maskedKey !== "string")
  )
    return undefined;
  return {
    activeProvider: value.activeProvider as ProviderId,
    providers: {
      openai: {
        configured: openai.configured,
        ...(typeof openai.maskedKey === "string"
          ? { maskedKey: openai.maskedKey }
          : {}),
        model: openai.model,
      },
    },
  };
}
