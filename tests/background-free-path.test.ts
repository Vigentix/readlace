import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { savedOpenAiFallbackKey } from "@/lib/translate/openai-html";
import { PROVIDER_SETTINGS_SAVE } from "@/lib/provider-settings-host";
import {
  TEST_PROVIDER_KEY,
  openAIResponsesBody,
} from "@/tests/fixtures/openai-responses";

// ADR 0020: without a usable provider key the extension translates
// on-device. The background path selector skips the provider stage, keeps
// saved-translation semantics, and switches paths when the Settings page
// saves a key or OpenAI rejects it.
const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  getMany: vi.fn(),
  setMany: vi.fn(),
  remove: vi.fn(),
  prepare: vi.fn(),
  translate: vi.fn(),
  query: vi.fn(),
  clearOwner: vi.fn(),
  hostOptions: [] as unknown[],
}));
vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: async (key: string) => mocks.values.get(key),
    set: async (key: string, value: unknown) => {
      mocks.values.set(key, value);
    },
    getMany: mocks.getMany,
    setMany: mocks.setMany,
    getByPrefix: async (prefix: string) =>
      Object.fromEntries(
        [...mocks.values].filter(([key]) => key.startsWith(prefix)),
      ),
    remove: mocks.remove,
  },
}));
vi.mock("@/lib/translate/browser-native", () => ({
  createNativeTranslatorHost: (options: unknown) => {
    mocks.hostOptions.push(options);
    return {
      prepare: mocks.prepare,
      translate: mocks.translate,
      query: mocks.query,
      clearOwner: mocks.clearOwner,
      cancel: vi.fn(),
    };
  },
}));
import background from "@/entrypoints/background";

const sender = {
  id: "test-extension-id",
  tab: { id: 7 },
  frameId: 0,
  documentId: "doc-1",
};
const period = {
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
};
const FREE = {
  plan: "free",
  source: "trial-expired",
  period,
  limits: null,
};
const account = { id: "user-1", email: "free@example.test" };
const tokens = {
  accessToken: "access-test",
  refreshToken: "refresh-test",
  accessExpiresAt: "2099-01-01T00:00:00Z",
  refreshExpiresAt: "2099-01-02T00:00:00Z",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
async function send(message: unknown, owner: unknown = sender) {
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    message,
    owner as never,
    vi.fn(),
  );
  return response;
}
const html = (pieces: string[][], runId = 1) =>
  send({
    type: "TRANSLATE_HTML",
    runId,
    pieces,
    targetLanguage: "vi",
    deferCache: true,
  });

describe("background Free on-device path", () => {
  let entitlement: unknown;
  let stageStatus: number;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  /** Translation requests made directly to OpenAI with the user's key. */
  const stageCalls = () =>
    fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("https://api.openai.com/v1/responses"),
    );
  const meCalls = () =>
    fetchMock.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === "/v1/me",
    );

  beforeEach(() => {
    entitlement = FREE;
    stageStatus = 200;
    mocks.hostOptions.length = 0;
    mocks.values.clear();
    mocks.getMany.mockImplementation(async (keys: string[]) =>
      Object.fromEntries(
        keys
          .filter((key) => mocks.values.has(key))
          .map((key) => [key, mocks.values.get(key)]),
      ),
    );
    mocks.setMany.mockImplementation(
      async (values: Record<string, unknown>) => {
        Object.entries(values).forEach(([key, value]) =>
          mocks.values.set(key, value),
        );
      },
    );
    mocks.remove.mockResolvedValue(undefined);
    mocks.prepare.mockResolvedValue({
      availability: "available",
      ready: true,
      progress: { phase: "ready" },
    });
    mocks.translate.mockImplementation(
      async (_key: string, _owner: string, message: { runId: number }) => ({
        runId: message.runId,
        results: [{ status: "accepted", text: "Xin chào" }],
      }),
    );
    fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/auth/refresh") return json(tokens);
      if (path === "/v1/me")
        return json({ authenticated: true, user: account, entitlement });
      if (stageStatus !== 200)
        return json({ error: { message: "Incorrect API key" } }, stageStatus);
      return json(openAIResponsesBody({ r0: "Xin chào AI" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Translator", { create: vi.fn(), availability: vi.fn() });
    vi.stubEnv("WXT_BACKEND_URL", "https://api.example.test");
    vi.spyOn(browser.tabs, "detectLanguage").mockResolvedValue("ja" as never);
    vi.spyOn(browser.tabs, "query").mockResolvedValue([] as never);
    vi.spyOn(browser.tabs, "sendMessage").mockResolvedValue(undefined);
    vi.spyOn(browser.runtime, "sendMessage").mockResolvedValue(undefined);
    vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Readlace",
      version: "1.4.2",
    });
    (background.main as () => void)();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("starts a Free run on the native path and never calls the backend stage", async () => {
    expect(
      await send({ type: "BEGIN_TRANSLATION_RUN", runId: 1 }),
    ).toMatchObject({ ok: true, path: "native" });
    const chainKey = await savedOpenAiFallbackKey("vi", "保存済み", "ja");
    mocks.values.set(
      chainKey,
      JSON.stringify({ t: "Đã lưu", p: "browser-native" }),
    );

    const response = await html([["保存済み"], ["未翻訳"]]);

    expect(stageCalls()).toHaveLength(0);
    expect(response).toMatchObject({
      runId: 1,
      path: "native",
      results: [["Đã lưu"], []],
      failures: [{ index: 1, scope: "record", retryable: false }],
    });
    // ADR 0020: no session to verify; nothing reaches a Readlace backend.
    expect(meCalls()).toHaveLength(0);
  });

  it("caches an accepted on-device result in the chain namespace with browser-native provenance", async () => {
    await send({ type: "BEGIN_TRANSLATION_RUN", runId: 1 });
    expect(
      await send({
        type: "CACHE_ACCEPTED_OPENAI_FALLBACK",
        runId: 1,
        sources: [["未翻訳"]],
        results: [["Chưa dịch"]],
        targetLanguage: "vi",
        provenance: "browser-native",
      }),
    ).toEqual({ saved: 1 });
    const value = JSON.parse(
      String(
        mocks.values.get(await savedOpenAiFallbackKey("vi", "未翻訳", "ja")),
      ),
    );
    expect(value).toMatchObject({ t: "Chưa dịch", p: "browser-native" });
    const warm = await html([["未翻訳"]]);
    expect(warm).toMatchObject({ results: [["Chưa dịch"]], failures: [] });
    expect(stageCalls()).toHaveLength(0);
  });

  it("reports unavailable for Free without the on-device Translator API", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await send({ type: "BEGIN_TRANSLATION_RUN", runId: 1 }),
    ).toMatchObject({ ok: true, path: "unavailable" });
    expect(await html([["未翻訳"]])).toMatchObject({ path: "unavailable" });
    expect(stageCalls()).toHaveLength(0);
    expect(await send({ type: "AUTH_STATUS" })).toMatchObject({
      authenticated: true,
      onDeviceTranslation: "unsupported",
      engineSource: "on-device",
    });
  });

  it("switches to the provider path once Settings saves a key, and back to native after OpenAI rejects it", async () => {
    expect(
      await send({ type: "BEGIN_TRANSLATION_RUN", runId: 1 }),
    ).toMatchObject({ path: "native" });
    // A content script cannot save a key.
    expect(
      await send({ type: PROVIDER_SETTINGS_SAVE, apiKey: TEST_PROVIDER_KEY }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await send(
        { type: PROVIDER_SETTINGS_SAVE, apiKey: TEST_PROVIDER_KEY },
        {
          id: "test-extension-id",
          url: browser.runtime.getURL("/options.html" as never),
          tab: { id: 99 },
        },
      ),
    ).toMatchObject({ ok: true });

    expect(await html([["未翻訳"]])).toMatchObject({
      path: "provider",
      results: [["Xin chào AI"]],
    });
    expect(stageCalls()).toHaveLength(1);

    stageStatus = 401;
    const refused = await html([["別の文"]]);
    expect(refused).not.toHaveProperty("error");
    expect(refused).toMatchObject({ results: [[]] });
    expect(stageCalls()).toHaveLength(2);
    // The rejected key is not retried; later work is on-device.
    expect(await html([["三つ目"]])).toMatchObject({ path: "native" });
    expect(stageCalls()).toHaveLength(2);
  });

  it("translates a selection on-device without a key and saves it to the chain cache", async () => {
    const response = await send({
      type: "TRANSLATE_SELECTION",
      requestId: 3,
      text: "こんにちは",
      targetLanguage: "vi",
    });

    expect(response).toEqual({ requestId: 3, text: "Xin chào" });
    expect(stageCalls()).toHaveLength(0);
    expect(mocks.prepare).toHaveBeenCalledWith({
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja",
      targetLanguage: "vi",
    });
    expect(mocks.translate).toHaveBeenCalledWith(
      "selection:7:0:doc-1:3",
      "selection:7:0:doc-1",
      expect.objectContaining({ texts: ["こんにちは"], sourceLanguage: "ja" }),
    );
    // ADR 0020: no session to verify before the on-device work.
    expect(meCalls()).toHaveLength(0);
    expect(
      JSON.parse(
        String(
          mocks.values.get(
            await savedOpenAiFallbackKey("vi", "こんにちは", "ja"),
          ),
        ),
      ),
    ).toMatchObject({ t: "Xin chào", p: "browser-native" });
  });

  it("reports on-device-unavailable for a Free selection without the Translator API", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await send({
        type: "TRANSLATE_SELECTION",
        requestId: 4,
        text: "こんにちは",
        targetLanguage: "vi",
      }),
    ).toEqual({ requestId: 4, error: "on-device-unavailable" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(stageCalls()).toHaveLength(0);
  });

  it("broadcasts first-use language-pack progress to extension pages without page text", () => {
    const options = mocks.hostOptions.at(-1) as {
      onProgress: (source: string, target: string, progress: unknown) => void;
    };
    options.onProgress("ja", "vi", {
      phase: "downloading",
      loaded: 0.25,
      total: 1,
    });
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "NATIVE_TRANSLATOR_PROGRESS",
      sourceLanguage: "ja",
      targetLanguage: "vi",
      progress: { phase: "downloading", loaded: 0.25, total: 1 },
    });
  });
});
