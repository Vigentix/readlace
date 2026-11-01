import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { UI_LOCALE_KEY } from "@/lib/i18n/locale";

const mocks = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: async (key: string) => mocks.values.get(key),
    set: async (key: string, value: unknown) => {
      mocks.values.set(key, value);
    },
    getMany: async (keys: string[]) =>
      Object.fromEntries(
        keys
          .filter((key) => mocks.values.has(key))
          .map((key) => [key, mocks.values.get(key)]),
      ),
    setMany: async (values: Record<string, unknown>) => {
      Object.entries(values).forEach(([key, value]) =>
        mocks.values.set(key, value),
      );
    },
    getByPrefix: async () => ({}),
    remove: async (keys: string[]) => {
      keys.forEach((key) => mocks.values.delete(key));
    },
  },
}));
vi.mock("@/lib/translate/browser-native", () => ({
  createNativeTranslatorHost: () => ({
    prepare: vi.fn(),
    translate: vi.fn(),
    query: vi.fn(),
    clearOwner: vi.fn(),
    cancel: vi.fn(),
  }),
}));
import background from "@/entrypoints/background";

const popup = () => ({
  id: browser.runtime.id,
  url: browser.runtime.getURL("/popup.html" as never),
});
const contentScript = () => ({
  id: browser.runtime.id,
  url: "https://example.test/article",
  tab: { id: 7 },
  frameId: 0,
});

async function send(message: unknown, sender: object) {
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    message,
    sender as never,
    vi.fn(),
  );
  return response;
}

describe("background UI locale (UI_LOCALE_GET / UI_LOCALE_SET)", () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let uiLanguage: string;
  beforeEach(() => {
    mocks.values.clear();
    uiLanguage = "en-US";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    vi.stubEnv("WXT_BACKEND_URL", "https://api.example.test");
    vi.spyOn(browser.tabs, "query").mockResolvedValue([] as never);
    broadcast = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
      broadcast as never,
    );
    Object.defineProperty(browser, "i18n", {
      configurable: true,
      value: { getUILanguage: () => uiLanguage },
    });
    (background.main as () => void)();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("follows the browser language until the user chooses", async () => {
    expect(await send({ type: "UI_LOCALE_GET" }, popup())).toEqual({
      locale: "en",
      stored: null,
    });
    uiLanguage = "vi-VN";
    expect(await send({ type: "UI_LOCALE_GET" }, popup())).toEqual({
      locale: "vi",
      stored: null,
    });
  });

  it("persists a choice in the extension store and broadcasts it", async () => {
    uiLanguage = "vi";
    expect(
      await send({ type: "UI_LOCALE_SET", locale: "en" }, popup()),
    ).toEqual({ locale: "en", stored: "en" });
    expect(mocks.values.get(UI_LOCALE_KEY)).toBe("en");
    expect(broadcast).toHaveBeenCalledWith({
      type: "UI_LOCALE_CHANGED",
      locale: "en",
    });
    // A stored choice wins over the browser language, also for content
    // scripts, which read it through the background only.
    expect(await send({ type: "UI_LOCALE_GET" }, contentScript())).toEqual({
      locale: "en",
      stored: "en",
    });
  });

  it("refuses writes from content scripts, other extensions and bad input", async () => {
    for (const [message, sender] of [
      [{ type: "UI_LOCALE_SET", locale: "vi" }, contentScript()],
      [
        { type: "UI_LOCALE_SET", locale: "vi" },
        { id: "other-extension", url: "chrome-extension://other/popup.html" },
      ],
      [
        { type: "UI_LOCALE_SET", locale: "vi" },
        { id: browser.runtime.id, url: "https://example.test/" },
      ],
      [{ type: "UI_LOCALE_SET", locale: "fr" }, popup()],
      [{ type: "UI_LOCALE_SET" }, popup()],
      [{ type: "UI_LOCALE_SET", locale: "vi", extra: true }, popup()],
    ] as const)
      expect(await send(message, sender)).toBeUndefined();
    expect(mocks.values.has(UI_LOCALE_KEY)).toBe(false);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "UI_LOCALE_CHANGED" }),
    );
    expect(
      await send(
        { type: "UI_LOCALE_GET" },
        { id: "other-extension", url: "chrome-extension://other/" },
      ),
    ).toBeUndefined();
  });

  it("ignores an invalid stored value", async () => {
    mocks.values.set(UI_LOCALE_KEY, "de");
    uiLanguage = "vi-VN";
    expect(await send({ type: "UI_LOCALE_GET" }, popup())).toEqual({
      locale: "vi",
      stored: null,
    });
  });
});
