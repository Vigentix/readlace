import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PROVIDER_SETTINGS_KEY } from "@/lib/provider-settings-store";
import { testProviderSettings } from "@/tests/fixtures/openai-responses";

import type { SelectionTranslationRequest } from "@/lib/selection-translation";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  storageGet: vi.fn(),
  storageGetMany: vi.fn(),
  storageGetByPrefix: vi.fn(),
  storageSet: vi.fn(),
  storageSetMany: vi.fn(),
  storageRemove: vi.fn(),
  backendUser: vi.fn(),
  backendLogin: vi.fn(),
  backendSignOut: vi.fn(),
  backendStage: vi.fn(),
  translateText: vi.fn(),
  translateHtml: vi.fn(),
  createOpenAI: vi.fn(),
  createNative: vi.fn(),
  generation: 0,
}));

vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: mocks.storageGet,
    getMany: mocks.storageGetMany,
    getByPrefix: mocks.storageGetByPrefix,
    set: mocks.storageSet,
    setMany: mocks.storageSetMany,
    remove: mocks.storageRemove,
  },
}));

vi.mock("@/lib/translate/openai-html", () => ({
  createOpenAIHtmlTranslator: mocks.createOpenAI,
}));

vi.mock("@/lib/translate/browser-native", () => ({
  createNativeTranslatorHost: mocks.createNative,
}));

import background from "@/entrypoints/background";

const VALID_SENDER = {
  id: "test-extension-id",
  tab: { id: 7, url: "https://example.com/article" },
  frameId: 0,
  documentId: "document-1",
};
const request = (
  overrides: Partial<SelectionTranslationRequest> = {},
): SelectionTranslationRequest => ({
  type: "TRANSLATE_SELECTION",
  requestId: 1,
  text: "  selected text  ",
  targetLanguage: "vi",
  ...overrides,
});
const result = (text: string) => ({ results: [text], failures: [] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function send(message: unknown, sender: unknown = VALID_SENDER) {
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    message,
    sender as never,
    vi.fn(),
  );
  return response;
}

describe("background selection translation", () => {
  beforeEach(() => {
    mocks.generation = 0;
    mocks.values.clear();
    // ADR 0020: the user's own OpenAI key drives the provider path.
    mocks.values.set(PROVIDER_SETTINGS_KEY, testProviderSettings());
    mocks.storageGet.mockImplementation(async (key: string) =>
      mocks.values.get(key),
    );
    mocks.storageGetMany.mockResolvedValue({});
    mocks.storageGetByPrefix.mockResolvedValue({});
    mocks.storageSet.mockResolvedValue(undefined);
    mocks.storageSetMany.mockResolvedValue(undefined);
    mocks.storageRemove.mockResolvedValue(undefined);
    mocks.translateText.mockResolvedValue(result("backend result"));
    mocks.translateHtml.mockResolvedValue(result("backend html"));
    mocks.createOpenAI.mockReturnValue({
      translateText: mocks.translateText,
      translateHtml: mocks.translateHtml,
      cacheFallbackTranslations: vi.fn(),
      clearSavedTranslations: vi.fn(),
      invalidatePendingWork: vi.fn(),
    });
    mocks.createNative.mockReturnValue({
      prepare: vi.fn(),
      translate: vi.fn(),
      query: vi.fn(),
      cancel: vi.fn(),
      clearOwner: vi.fn(),
    });
    vi.spyOn(browser.tabs, "detectLanguage").mockResolvedValue("ja" as never);
    vi.spyOn(browser.scripting, "executeScript").mockResolvedValue([] as never);
    (background.main as () => void)();
    // Startup auth-hint storage is independent of sender-triggered selection reads.
    mocks.storageGet.mockClear();
  });

  it("injects only the fixed runtime UI into the sender frame", async () => {
    await expect(
      send({ type: "LOAD_SELECTION_TRANSLATION_UI" }),
    ).resolves.toEqual({ loaded: true });

    expect(browser.scripting.executeScript).toHaveBeenCalledOnce();
    expect(browser.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ["document-1"] },
      files: ["content-scripts/selection-ui.js"],
    });
  });

  it("falls back to the sender frame when document targeting is unavailable", async () => {
    const sender = { ...VALID_SENDER, frameId: 4, documentId: undefined };

    await expect(
      send({ type: "LOAD_SELECTION_TRANSLATION_UI" }, sender),
    ).resolves.toEqual({ loaded: true });
    expect(browser.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [4] },
      files: ["content-scripts/selection-ui.js"],
    });
  });

  it.each([
    [
      { type: "LOAD_SELECTION_TRANSLATION_UI" },
      { ...VALID_SENDER, id: "other" },
    ],
    [{ type: "LOAD_SELECTION_TRANSLATION_UI" }, { id: "test-extension-id" }],
    [
      { type: "LOAD_SELECTION_TRANSLATION_UI", file: "arbitrary.js" },
      VALID_SENDER,
    ],
    [{ type: "LOAD_SELECTION_TRANSLATION_UI", tabId: 99 }, VALID_SENDER],
    [
      { type: "LOAD_SELECTION_TRANSLATION_UI" },
      { ...VALID_SENDER, frameId: -1 },
    ],
  ])(
    "rejects untrusted or parameterized UI injection %#",
    async (message, sender) => {
      await expect(send(message, sender)).resolves.toBeUndefined();
      expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    },
  );

  it("coalesces concurrent injection and retries a failed load", async () => {
    const pending = deferred<never[]>();
    vi.mocked(browser.scripting.executeScript).mockReturnValueOnce(
      pending.promise as never,
    );

    const first = send({ type: "LOAD_SELECTION_TRANSLATION_UI" });
    const second = send({ type: "LOAD_SELECTION_TRANSLATION_UI" });
    await vi.waitFor(() =>
      expect(browser.scripting.executeScript).toHaveBeenCalledOnce(),
    );
    pending.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { loaded: true },
      { loaded: true },
    ]);

    vi.mocked(browser.scripting.executeScript).mockRejectedValueOnce(
      new Error("frame gone"),
    );
    await expect(
      send({ type: "LOAD_SELECTION_TRANSLATION_UI" }),
    ).resolves.toEqual({ loaded: false });
    await expect(
      send({ type: "LOAD_SELECTION_TRANSLATION_UI" }),
    ).resolves.toEqual({ loaded: true });
    expect(browser.scripting.executeScript).toHaveBeenCalledTimes(3);
  });

  it("does not coalesce injection across document identities", async () => {
    const firstLoad = deferred<never[]>();
    vi.mocked(browser.scripting.executeScript).mockReturnValueOnce(
      firstLoad.promise as never,
    );

    const first = send({ type: "LOAD_SELECTION_TRANSLATION_UI" });
    const nextDocument = send(
      { type: "LOAD_SELECTION_TRANSLATION_UI" },
      { ...VALID_SENDER, documentId: "document-2" },
    );
    await vi.waitFor(() =>
      expect(browser.scripting.executeScript).toHaveBeenCalledTimes(2),
    );
    firstLoad.resolve([]);

    await expect(Promise.all([first, nextDocument])).resolves.toEqual([
      { loaded: true },
      { loaded: true },
    ]);
    expect(browser.scripting.executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 7, documentIds: ["document-2"] },
      files: ["content-scripts/selection-ui.js"],
    });
  });

  it("has no provider context message for the selection UI", async () => {
    mocks.values.set("translationProvider", "openai");
    await expect(
      send({ type: "GET_SELECTION_TRANSLATION_CONTEXT" }),
    ).resolves.toBeUndefined();
    expect(mocks.storageGet).not.toHaveBeenCalled();
  });

  it("translates through the backend-routed translator and ignores a saved provider", async () => {
    mocks.values.set("translationProvider", "google");
    await expect(send(request())).resolves.toEqual({
      requestId: 1,
      text: "backend result",
    });
    expect(mocks.translateText).toHaveBeenCalledOnce();
    expect(mocks.translateText).toHaveBeenCalledWith(
      ["  selected text  "],
      "vi",
      expect.objectContaining({ cacheEpoch: expect.any(Number) }),
    );
    expect(mocks.translateText.mock.calls[0]![2]).not.toHaveProperty(
      "provider",
    );
    expect(mocks.storageGet).not.toHaveBeenCalled();
    expect(mocks.storageSet).not.toHaveBeenCalled();
    expect(mocks.storageSetMany).not.toHaveBeenCalled();
  });

  it("keeps a pending request independent of later storage changes", async () => {
    const pending = deferred<ReturnType<typeof result>>();
    mocks.translateText.mockReturnValueOnce(pending.promise);

    const response = send(request({ requestId: 2, targetLanguage: "en" }));
    await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalled());
    mocks.values.set("translationProvider", "google");
    pending.resolve(result("pinned result"));

    await expect(response).resolves.toEqual({
      requestId: 2,
      text: "pinned result",
    });
    expect(mocks.translateText).toHaveBeenCalledOnce();
  });

  it.each([
    [request(), { ...VALID_SENDER, id: "another-extension" }, 1],
    [request(), { id: "test-extension-id" }, 1],
    [request(), { id: "test-extension-id", tab: {} }, 1],
    [request({ requestId: -1 }), VALID_SENDER, 0],
    [request({ requestId: 1.5 }), VALID_SENDER, 0],
    [request({ text: "   " }), VALID_SENDER, 1],
    [request({ text: "x".repeat(4_001) }), VALID_SENDER, 1],
    [{ ...request(), text: 123 }, VALID_SENDER, 1],
    [{ ...request(), targetLanguage: "fr" }, VALID_SENDER, 1],
    [{ ...request(), provider: "openai" }, VALID_SENDER, 1],
  ])(
    "rejects invalid or untrusted request %# without adapter dispatch",
    async (message, sender, expectedId) => {
      const response = await send(message, sender);
      expect(response).toEqual({
        requestId: expectedId,
        error:
          typeof (message as { text?: unknown }).text === "string" &&
          (message as { text: string }).text.length > 4_000
            ? "too-long"
            : "invalid-request",
      });
      expect(mocks.translateText).not.toHaveBeenCalled();
    },
  );

  it("maps adapter oversize, thrown and empty outcomes to stable errors", async () => {
    mocks.translateText
      .mockResolvedValueOnce({
        results: [""],
        failures: [
          {
            index: 0,
            scope: "record",
            message: "Translation input exceeds the 4,000-character limit",
            retryable: false,
          },
        ],
      })
      .mockRejectedValueOnce(new Error("secret provider detail"))
      .mockResolvedValueOnce(result(""));

    await expect(
      send(request({ requestId: 5, text: "&".repeat(4_000) })),
    ).resolves.toEqual({ requestId: 5, error: "too-long" });
    await expect(send(request({ requestId: 6 }))).resolves.toEqual({
      requestId: 6,
      error: "translation-failed",
    });
    await expect(send(request({ requestId: 7 }))).resolves.toEqual({
      requestId: 7,
      error: "translation-failed",
    });
    expect(mocks.translateText).toHaveBeenCalledTimes(3);
  });

  it("does not alter an active page run and never reports a provider", async () => {
    mocks.values.set("translationProvider", "openai");
    const begun = await send({ type: "BEGIN_TRANSLATION_RUN", runId: 91 });
    expect(begun).toMatchObject({ ok: true });
    expect(begun).not.toHaveProperty("provider");

    await expect(send(request({ requestId: 8 }))).resolves.toEqual({
      requestId: 8,
      text: "backend result",
    });
    await expect(
      send({
        type: "TRANSLATE_TEXT",
        runId: 91,
        texts: ["page record"],
        targetLanguage: "vi",
      }),
    ).resolves.toMatchObject({ runId: 91, results: ["backend result"] });

    expect(mocks.translateText).toHaveBeenNthCalledWith(
      1,
      ["  selected text  "],
      "vi",
      expect.any(Object),
    );
    expect(mocks.translateText).toHaveBeenNthCalledWith(
      2,
      ["page record"],
      "vi",
      expect.any(Object),
    );
  });
});
