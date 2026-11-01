/** The Settings page (`entrypoints/options`, ADR 0020). */
export const settingsEn = {
  "providerSettings.title": "Settings",
  "providerSettings.loading": "Loading settings…",
  "providerSettings.loadFailed": "Settings could not be loaded.",
  "providerSettings.section": "Translation provider",
  "providerSettings.intro":
    "Readlace is free. For AI translation, use your own provider API key; the provider bills you directly. Without a key, Readlace translates on-device in Chrome 138+ desktop.",
  "providerSettings.provider": "Provider",
  "providerSettings.providerOpenAI": "OpenAI",
  "providerSettings.providerMore": "More providers are coming.",
  "providerSettings.model": "Model",
  "providerSettings.apiKey": "API key",
  "providerSettings.apiKeyPlaceholder": "sk-…",
  "providerSettings.savedKey": "Saved key: {key}",
  "providerSettings.noKey": "No key saved. Translation runs on-device.",
  "providerSettings.keyRejected":
    "OpenAI rejected the saved key. Translation runs on-device until you replace it.",
  "providerSettings.save": "Save",
  "providerSettings.saving": "Saving…",
  "providerSettings.test": "Test key",
  "providerSettings.testing": "Testing…",
  "providerSettings.remove": "Remove key",
  "providerSettings.saved": "Saved.",
  "providerSettings.removed": "Key removed.",
  "providerSettings.error.invalid-key":
    "That does not look like an API key. Paste the whole key.",
  "providerSettings.error.invalid-model": "Choose a model from the list.",
  "providerSettings.error.storage-failed": "The settings could not be saved.",
  "providerSettings.error.forbidden": "This page cannot change the settings.",
  "providerSettings.error.no-key": "Paste a key or save one first.",
  "providerSettings.test.valid": "The key works with this model.",
  "providerSettings.test.invalid-key": "OpenAI rejected this key.",
  "providerSettings.test.model-unavailable":
    "This key cannot use the selected model.",
  "providerSettings.test.rate-limited":
    "OpenAI is limiting requests for this key. Check its usage and billing, then try again.",
  "providerSettings.test.unreachable":
    "OpenAI could not be reached. Try again later.",
  "providerSettings.diagnostics": "Copy diagnostics",
  "providerSettings.diagnosticsHint":
    "For bug reports: versions, settings and counts only, never your key or page text.",
  "providerSettings.diagnosticsCopied":
    "Diagnostics copied. Paste them into your GitHub issue.",
  "providerSettings.diagnosticsFailed": "Diagnostics could not be copied.",
  "providerSettings.storageNote":
    "Your key is stored unencrypted in this browser profile on this device, is never synced, and is sent only to OpenAI. Create a dedicated project key with a spending limit for Readlace.",
  "providerSettings.privacyNote":
    "With a key, the text you translate goes from your browser straight to OpenAI. Readlace has no server and collects no data.",
} as const;
