import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENAI_MODEL,
  OPENAI_MODELS,
  emptyProviderSettings,
  maskApiKey,
  normalizeApiKey,
  parseProviderSettings,
  providerSettingsView,
  withOpenAIKey,
  withOpenAIModel,
  withoutOpenAIKey,
} from "./provider-settings";

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

describe("normalizeApiKey", () => {
  it("trims surrounding whitespace and keeps a plausible key", () => {
    expect(normalizeApiKey(`  ${KEY}\n`)).toBe(KEY);
  });

  it("refuses empty, short, inner-whitespace, non-ASCII and oversized input", () => {
    expect(normalizeApiKey("")).toBeUndefined();
    expect(normalizeApiKey("sk-short")).toBeUndefined();
    expect(normalizeApiKey("sk-abc def ghi jkl mno pqr")).toBeUndefined();
    expect(normalizeApiKey("sk-ключключключключключключ")).toBeUndefined();
    expect(normalizeApiKey(`sk-${"a".repeat(600)}`)).toBeUndefined();
    expect(normalizeApiKey(42)).toBeUndefined();
  });
});

describe("maskApiKey", () => {
  it("shows only the prefix and the last four characters", () => {
    expect(maskApiKey(KEY)).toBe("sk-…6789");
    expect(maskApiKey("abcdefghijklmnopqrstuvwxyz")).toBe("…wxyz");
  });
});

describe("parseProviderSettings", () => {
  it("accepts the versioned record", () => {
    const settings = withOpenAIKey(emptyProviderSettings(), KEY);
    expect(parseProviderSettings(settings)).toEqual({
      version: 1,
      activeProvider: "openai",
      providers: { openai: { apiKey: KEY, model: DEFAULT_OPENAI_MODEL } },
    });
  });

  it("accepts settings without a key", () => {
    expect(parseProviderSettings(emptyProviderSettings())).toEqual({
      version: 1,
      activeProvider: "openai",
      providers: {},
    });
  });

  it("refuses malformed records instead of guessing", () => {
    expect(parseProviderSettings(undefined)).toBeUndefined();
    expect(parseProviderSettings({ version: 2 })).toBeUndefined();
    expect(
      parseProviderSettings({
        version: 1,
        activeProvider: "anthropic",
        providers: {},
      }),
    ).toBeUndefined();
    expect(
      parseProviderSettings({
        version: 1,
        activeProvider: "openai",
        providers: { openai: { apiKey: "bad", model: DEFAULT_OPENAI_MODEL } },
      }),
    ).toBeUndefined();
  });

  it("falls back to the default model for an unknown saved model", () => {
    expect(
      parseProviderSettings({
        version: 1,
        activeProvider: "openai",
        providers: { openai: { apiKey: KEY, model: "gpt-unknown" } },
      })?.providers.openai?.model,
    ).toBe(DEFAULT_OPENAI_MODEL);
  });
});

describe("settings updates", () => {
  it("changes the model without touching the key, and removes the key", () => {
    const withKey = withOpenAIKey(emptyProviderSettings(), KEY);
    const model = OPENAI_MODELS.find(
      (value) => value !== DEFAULT_OPENAI_MODEL,
    )!;
    const changed = withOpenAIModel(withKey, model);
    expect(changed.providers.openai).toEqual({ apiKey: KEY, model });
    expect(withoutOpenAIKey(changed).providers.openai).toEqual({ model });
  });

  it("remembers the chosen model before any key exists", () => {
    const model = OPENAI_MODELS.find(
      (value) => value !== DEFAULT_OPENAI_MODEL,
    )!;
    const settings = withOpenAIKey(
      withOpenAIModel(emptyProviderSettings(), model),
      KEY,
    );
    expect(settings.providers.openai?.model).toBe(model);
  });
});

describe("providerSettingsView", () => {
  it("never carries the key", () => {
    const view = providerSettingsView(
      withOpenAIKey(emptyProviderSettings(), KEY),
    );
    expect(view).toEqual({
      activeProvider: "openai",
      providers: {
        openai: {
          configured: true,
          maskedKey: "sk-…6789",
          model: DEFAULT_OPENAI_MODEL,
        },
      },
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("describes an unconfigured provider", () => {
    expect(providerSettingsView(undefined)).toEqual({
      activeProvider: "openai",
      providers: {
        openai: { configured: false, model: DEFAULT_OPENAI_MODEL },
      },
    });
  });
});
