import {
  parseProviderSettings,
  type ProviderSettings,
} from "@/shared/provider-settings";
import type { ExtensionStorage } from "@/lib/indexeddb-storage";

/**
 * IndexedDB key of the provider settings record (ADR 0020). The database
 * belongs to the extension origin, so content scripts (which run on the page
 * origin) cannot open it; only the background and extension pages can.
 */
export const PROVIDER_SETTINGS_KEY = "providerSettings";

export function createProviderSettingsStore(
  storage: Pick<ExtensionStorage, "get" | "set">,
) {
  return {
    async read(): Promise<ProviderSettings | undefined> {
      return parseProviderSettings(await storage.get(PROVIDER_SETTINGS_KEY));
    },
    async write(settings: ProviderSettings) {
      await storage.set(PROVIDER_SETTINGS_KEY, settings);
    },
  };
}
