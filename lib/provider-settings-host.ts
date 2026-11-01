import {
  emptyProviderSettings,
  isOpenAIModel,
  normalizeApiKey,
  providerSettingsView,
  withOpenAIKey,
  withOpenAIModel,
  withoutOpenAIKey,
  DEFAULT_OPENAI_MODEL,
  type ProviderSettings,
  type ProviderSettingsView,
} from "@/shared/provider-settings";
import type { ByokCredentials } from "@/lib/byok-stage";
import type { KeyTestResult } from "@/lib/provider-key-test";
import { createProviderSettingsStore } from "@/lib/provider-settings-store";
import type { ExtensionStorage } from "@/lib/indexeddb-storage";
import type { EngineState } from "@/lib/translation-path";

export const PROVIDER_SETTINGS_GET = "PROVIDER_SETTINGS_GET";
export const PROVIDER_SETTINGS_SAVE = "PROVIDER_SETTINGS_SAVE";
export const PROVIDER_KEY_REMOVE = "PROVIDER_KEY_REMOVE";
export const PROVIDER_KEY_TEST = "PROVIDER_KEY_TEST";

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  PROVIDER_SETTINGS_GET,
  PROVIDER_SETTINGS_SAVE,
  PROVIDER_KEY_REMOVE,
  PROVIDER_KEY_TEST,
]);

export type ProviderSettingsResponse =
  | { ok: true; settings: ProviderSettingsView; keyRejected: boolean }
  | {
      ok: false;
      error: "forbidden" | "invalid-key" | "invalid-model" | "storage-failed";
    };

export type ProviderKeyTestResponse =
  | { ok: true; result: KeyTestResult }
  | {
      ok: false;
      error: "forbidden" | "no-key" | "invalid-key" | "invalid-model";
    };

export interface ProviderSettingsSender {
  /** The message came from this extension's own Settings page. */
  settingsPage: boolean;
}

export interface ProviderSettingsHostDependencies {
  storage: Pick<ExtensionStorage, "get" | "set">;
  testKey(apiKey: string, model: string): Promise<KeyTestResult>;
}

/**
 * Background owner of the provider settings (ADR 0020). It is the only code
 * that holds the key in memory; it answers the Settings page with a masked
 * view and hands the key only to the translation stage.
 */
export function createProviderSettingsHost(
  deps: ProviderSettingsHostDependencies,
) {
  const store = createProviderSettingsStore(deps.storage);
  let settings: ProviderSettings | undefined;
  let keyRejected = false;
  let loading: Promise<void> | undefined;
  const ready = () => {
    loading ??= store
      .read()
      .then((value) => {
        settings = value;
      })
      .catch(() => {
        settings = undefined;
        loading = undefined;
      });
    return loading;
  };
  const current = () => settings ?? emptyProviderSettings();
  const response = (): ProviderSettingsResponse => ({
    ok: true,
    settings: providerSettingsView(settings),
    keyRejected,
  });
  const write = async (next: ProviderSettings) => {
    try {
      await store.write(next);
    } catch {
      return false;
    }
    settings = next;
    return true;
  };

  const save = async (message: Record<string, unknown>) => {
    let next = current();
    let keyChanged = false;
    if (message.apiKey !== undefined) {
      const apiKey = normalizeApiKey(message.apiKey);
      if (!apiKey) return { ok: false, error: "invalid-key" } as const;
      keyChanged = apiKey !== next.providers.openai?.apiKey;
      next = withOpenAIKey(next, apiKey);
    }
    if (message.model !== undefined) {
      if (!isOpenAIModel(message.model))
        return { ok: false, error: "invalid-model" } as const;
      next = withOpenAIModel(next, message.model);
    }
    if (!(await write(next)))
      return { ok: false, error: "storage-failed" } as const;
    if (keyChanged) keyRejected = false;
    return response();
  };

  const test = async (
    message: Record<string, unknown>,
  ): Promise<ProviderKeyTestResponse> => {
    const saved = current().providers.openai;
    let apiKey = saved?.apiKey;
    let testingSaved = true;
    if (message.apiKey !== undefined) {
      const candidate = normalizeApiKey(message.apiKey);
      if (!candidate) return { ok: false, error: "invalid-key" };
      testingSaved = candidate === saved?.apiKey;
      apiKey = candidate;
    }
    if (!apiKey) return { ok: false, error: "no-key" };
    const model = message.model ?? saved?.model ?? DEFAULT_OPENAI_MODEL;
    if (!isOpenAIModel(model)) return { ok: false, error: "invalid-model" };
    const result = await deps.testKey(apiKey, model);
    if (testingSaved) {
      if (result === "invalid-key") keyRejected = true;
      else if (result === "valid") keyRejected = false;
    }
    return { ok: true, result };
  };

  return {
    ready,
    engineState(): EngineState {
      return {
        keyConfigured: settings?.providers.openai?.apiKey !== undefined,
        keyRejected,
      };
    },
    /** The key for the next request; none once the provider rejected it. */
    async credentials(): Promise<ByokCredentials | undefined> {
      await ready();
      const openai = settings?.providers.openai;
      return openai?.apiKey && !keyRejected
        ? { apiKey: openai.apiKey, model: openai.model }
        : undefined;
    },
    markKeyRejected() {
      keyRejected = true;
    },
    /** Masked state for extension surfaces such as the popup. */
    view() {
      return { settings: providerSettingsView(settings), keyRejected };
    },
    async handle(
      message: unknown,
      sender: ProviderSettingsSender,
    ): Promise<ProviderSettingsResponse | ProviderKeyTestResponse | undefined> {
      if (
        !message ||
        typeof message !== "object" ||
        !MESSAGE_TYPES.has((message as { type?: unknown }).type as string)
      )
        return undefined;
      if (!sender.settingsPage) return { ok: false, error: "forbidden" };
      await ready();
      const request = message as Record<string, unknown>;
      switch (request.type) {
        case PROVIDER_SETTINGS_SAVE:
          return save(request);
        case PROVIDER_KEY_REMOVE:
          return (await write(withoutOpenAIKey(current())))
            ? ((keyRejected = false), response())
            : { ok: false, error: "storage-failed" };
        case PROVIDER_KEY_TEST:
          return test(request);
        default:
          return response();
      }
    },
  };
}
