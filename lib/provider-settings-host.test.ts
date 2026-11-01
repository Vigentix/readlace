import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_KEY_REMOVE,
  PROVIDER_KEY_TEST,
  PROVIDER_SETTINGS_GET,
  PROVIDER_SETTINGS_SAVE,
  createProviderSettingsHost,
} from "./provider-settings-host";
import type { KeyTestResult } from "./provider-key-test";
import { PROVIDER_SETTINGS_KEY } from "./provider-settings-store";

const KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const OTHER_KEY = "sk-proj-zyxwvutsrqponmlkjihgfedcba9876543210";

function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (key: string) => structuredClone(data.get(key))),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    }),
  };
}

const settingsPage = { settingsPage: true };
const otherSender = { settingsPage: false };

function host(
  storage = memoryStorage(),
  testKey = vi.fn(async (): Promise<KeyTestResult> => "valid"),
) {
  return {
    storage,
    testKey,
    host: createProviderSettingsHost({ storage, testKey }),
  };
}

describe("provider settings host", () => {
  it("saves a key from the Settings page and returns only a masked view", async () => {
    const { host: settings, storage } = host();
    const saved = await settings.handle(
      { type: PROVIDER_SETTINGS_SAVE, apiKey: ` ${KEY} `, model: "gpt-5-mini" },
      settingsPage,
    );
    expect(saved).toEqual({
      ok: true,
      settings: {
        activeProvider: "openai",
        providers: {
          openai: {
            configured: true,
            maskedKey: "sk-…6789",
            model: "gpt-5-mini",
          },
        },
      },
      keyRejected: false,
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(storage.data.get(PROVIDER_SETTINGS_KEY)).toMatchObject({
      providers: { openai: { apiKey: KEY, model: "gpt-5-mini" } },
    });
    expect(await settings.credentials()).toEqual({
      apiKey: KEY,
      model: "gpt-5-mini",
    });
    expect(settings.engineState()).toEqual({
      keyConfigured: true,
      keyRejected: false,
    });
  });

  it("refuses every message from anything but the Settings page", async () => {
    const { host: settings, storage } = host();
    for (const type of [
      PROVIDER_SETTINGS_GET,
      PROVIDER_SETTINGS_SAVE,
      PROVIDER_KEY_REMOVE,
      PROVIDER_KEY_TEST,
    ])
      expect(await settings.handle({ type, apiKey: KEY }, otherSender)).toEqual(
        { ok: false, error: "forbidden" },
      );
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("ignores unrelated messages", async () => {
    const { host: settings } = host();
    expect(
      await settings.handle({ type: "SOMETHING_ELSE" }, settingsPage),
    ).toBeUndefined();
  });

  it("rejects a malformed key or model without writing", async () => {
    const { host: settings, storage } = host();
    expect(
      await settings.handle(
        { type: PROVIDER_SETTINGS_SAVE, apiKey: "nope" },
        settingsPage,
      ),
    ).toEqual({ ok: false, error: "invalid-key" });
    expect(
      await settings.handle(
        { type: PROVIDER_SETTINGS_SAVE, model: "gpt-unknown" },
        settingsPage,
      ),
    ).toEqual({ ok: false, error: "invalid-model" });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("removes the key but keeps the model", async () => {
    const { host: settings } = host();
    await settings.handle(
      { type: PROVIDER_SETTINGS_SAVE, apiKey: KEY, model: "gpt-5" },
      settingsPage,
    );
    const removed = await settings.handle(
      { type: PROVIDER_KEY_REMOVE },
      settingsPage,
    );
    expect(removed).toMatchObject({
      ok: true,
      settings: {
        providers: { openai: { configured: false, model: "gpt-5" } },
      },
    });
    expect(await settings.credentials()).toBeUndefined();
  });

  it("loads saved settings after a worker restart", async () => {
    const storage = memoryStorage();
    await host(storage).host.handle(
      { type: PROVIDER_SETTINGS_SAVE, apiKey: KEY },
      settingsPage,
    );
    const restarted = host(storage).host;
    await restarted.ready();
    expect(restarted.engineState().keyConfigured).toBe(true);
  });

  it("steps down after a rejected key until a new key is saved", async () => {
    const { host: settings } = host();
    await settings.handle(
      { type: PROVIDER_SETTINGS_SAVE, apiKey: KEY },
      settingsPage,
    );
    settings.markKeyRejected();
    expect(settings.engineState().keyRejected).toBe(true);
    // A rejected key is never sent again, even by work already running.
    expect(await settings.credentials()).toBeUndefined();
    expect(
      await settings.handle({ type: PROVIDER_SETTINGS_GET }, settingsPage),
    ).toMatchObject({ keyRejected: true });
    await settings.handle(
      { type: PROVIDER_SETTINGS_SAVE, apiKey: OTHER_KEY },
      settingsPage,
    );
    expect(settings.engineState().keyRejected).toBe(false);
  });

  it("tests a candidate key, or the saved one", async () => {
    const { host: settings, testKey } = host();
    expect(
      await settings.handle({ type: PROVIDER_KEY_TEST }, settingsPage),
    ).toEqual({ ok: false, error: "no-key" });
    expect(
      await settings.handle(
        { type: PROVIDER_KEY_TEST, apiKey: KEY, model: "gpt-5-mini" },
        settingsPage,
      ),
    ).toEqual({ ok: true, result: "valid" });
    expect(testKey).toHaveBeenLastCalledWith(KEY, "gpt-5-mini");
  });

  it("a failed test of the saved key marks it rejected; a passing one clears it", async () => {
    const testKey = vi.fn(async (): Promise<KeyTestResult> => "invalid-key");
    const { host: settings } = host(memoryStorage(), testKey);
    await settings.handle(
      { type: PROVIDER_SETTINGS_SAVE, apiKey: KEY },
      settingsPage,
    );
    await settings.handle({ type: PROVIDER_KEY_TEST }, settingsPage);
    expect(settings.engineState().keyRejected).toBe(true);
    testKey.mockResolvedValueOnce("valid");
    await settings.handle({ type: PROVIDER_KEY_TEST }, settingsPage);
    expect(settings.engineState().keyRejected).toBe(false);
  });

  it("treats an unreadable stored record as not configured", async () => {
    const storage = memoryStorage();
    storage.data.set(PROVIDER_SETTINGS_KEY, { version: 99 });
    const { host: settings } = host(storage);
    await settings.ready();
    expect(settings.engineState().keyConfigured).toBe(false);
  });
});
