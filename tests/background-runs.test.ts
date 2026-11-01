import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PROVIDER_SETTINGS_KEY } from "@/lib/provider-settings-store";
import {
  TEST_PROVIDER_KEY,
  openAIResponsesBody,
  testProviderSettings,
} from "@/tests/fixtures/openai-responses";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  getMany: vi.fn(),
  setMany: vi.fn(),
  remove: vi.fn(),
  prepare: vi.fn(),
  translate: vi.fn(),
  query: vi.fn(),
  clearOwner: vi.fn(),
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
  createNativeTranslatorHost: () => ({
    prepare: mocks.prepare,
    translate: mocks.translate,
    query: mocks.query,
    clearOwner: mocks.clearOwner,
    cancel: vi.fn(),
  }),
}));
import background from "@/entrypoints/background";

const sender = {
  id: "test-extension-id",
  tab: { id: 7 },
  frameId: 0,
  documentId: "doc-1",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const OPENAI_ORIGIN = "https://api.openai.com";
const isOpenAI = (input: unknown) => String(input).startsWith(OPENAI_ORIGIN);
/** Answers every requested record id (the strict schema's `required`). */
const openAIAnswer = (init: RequestInit | undefined, text = "Xin chào") => {
  const body = JSON.parse(String(init?.body)) as {
    text?: { format?: { schema?: { required?: string[] } } };
  };
  const ids = body.text?.format?.schema?.required ?? [];
  return json(
    openAIResponsesBody(Object.fromEntries(ids.map((id) => [id, text]))),
  );
};
const textRequest = {
  type: "TRANSLATE_TEXT",
  runId: 1,
  texts: ["Hello"],
  targetLanguage: "vi",
};
async function send(message: unknown, owner = sender) {
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    message,
    owner as never,
    vi.fn(),
  );
  return response;
}
const begin = (owner = sender, runId = 1) =>
  send({ type: "BEGIN_TRANSLATION_RUN", runId }, owner);

// ADR 0020: no accounts. Runs, caches and the provider stage with the user's
// own OpenAI key, through the real adapters.
describe("background translation runs (actual adapters, user's OpenAI key)", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    mocks.values.clear();
    // ADR 0020: the user's own OpenAI key drives the provider path.
    mocks.values.set(PROVIDER_SETTINGS_KEY, testProviderSettings());
    // A provider saved by an earlier build must be ignored.
    mocks.values.set("translationProvider", "google");
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
    mocks.remove.mockImplementation(async (keys: string[]) => {
      keys.forEach((key) => mocks.values.delete(key));
    });
    mocks.prepare.mockResolvedValue({ ready: true, availability: "available" });
    mocks.translate.mockResolvedValue({
      runId: 1,
      results: [{ status: "translated", text: "Xin chào" }],
    });
    fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (isOpenAI(input)) return openAIAnswer(init);
      // There is no Readlace backend to call.
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(browser.tabs, "detectLanguage").mockResolvedValue("en" as never);
    vi.spyOn(browser.tabs, "query").mockResolvedValue([
      { id: 7 },
      { id: 8 },
    ] as never);
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
  /** Translation requests made directly to OpenAI with the user's key. */
  const stageCalls = () =>
    fetchMock.mock.calls.filter(([input]) => isOpenAI(input));

  it.each(["openai"])(
    "does not resurrect %s page caches from a retained result after Clear",
    async () => {
      await begin();
      await send({
        type: "TRANSLATE_HTML",
        runId: 1,
        pieces: [["Hello"]],
        targetLanguage: "vi",
        deferCache: true,
      });
      expect(mocks.setMany).not.toHaveBeenCalled();
      await send({ type: "CLEAR_SAVED_TRANSLATIONS" });
      const ack = {
        type: "CACHE_ACCEPTED_OPENAI_HTML",
        runId: 1,
        sources: [["Hello"]],
        results: [["Xin chào"]],
        targetLanguage: "vi",
      };
      expect(await send(ack)).toEqual({ saved: 0 });
      expect(
        await send({
          ...ack,
          type: "CACHE_ACCEPTED_OPENAI_FALLBACK",
          provenance: "google",
        }),
      ).toEqual({ saved: 0 });
      expect(mocks.setMany).not.toHaveBeenCalled();
      await begin(sender, 2);
      expect(await send({ ...ack, runId: 2 })).toMatchObject({ saved: 1 });
    },
  );

  it.each(["openai"])(
    "persists %s page primaries only after the retained-owner acknowledgement",
    async () => {
      await begin();
      const request = {
        type: "TRANSLATE_HTML",
        runId: 1,
        pieces: [["Hello"]],
        targetLanguage: "vi",
        deferCache: true,
      };
      expect(await send(request)).toMatchObject({
        results: [["Xin chào"]],
        diagnostics: { storageWriteCalls: 0 },
      });
      expect(mocks.setMany).not.toHaveBeenCalled();
      const ack = {
        type: "CACHE_ACCEPTED_OPENAI_HTML",
        runId: 1,
        sources: [["Hello"]],
        results: [["Xin chào"]],
        targetLanguage: "vi",
      };
      expect(await send(ack)).toMatchObject({
        saved: 1,
        diagnostics: { storageWriteCalls: 1 },
      });
      expect(mocks.setMany).toHaveBeenCalledOnce();
      expect(await send(request)).toMatchObject({
        results: [["Xin chào"]],
        diagnostics: { localCacheHits: 1, requestCount: 0 },
      });
      expect(stageCalls()).toHaveLength(1);
      await begin(sender, 2);
      expect(await send(ack)).toMatchObject({ error: "auth-required" });
      expect(mocks.setMany).toHaveBeenCalledOnce();
    },
  );

  it("requires a new BEGIN for missing, stale, other-frame and other-document contexts", async () => {
    expect(await send(textRequest)).toEqual({
      runId: 1,
      error: "auth-required",
    });
    await begin();
    expect(await send(textRequest, { ...sender, frameId: 1 })).toMatchObject({
      error: "auth-required",
    });
    expect(
      await send(textRequest, { ...sender, documentId: "doc-2" }),
    ).toMatchObject({ error: "auth-required" });
    await begin(sender, 2);
    expect(await send(textRequest)).toMatchObject({ error: "auth-required" });
    expect(stageCalls()).toHaveLength(0);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects untrusted and malformed messages before authentication", async () => {
    expect(
      await send(textRequest, { ...sender, id: "other-extension" }),
    ).toMatchObject({ error: "invalid-request" });
    expect(await send({ ...textRequest, texts: [1] })).toMatchObject({
      error: "invalid-request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves records unresolved after OpenAI 503 retries", async () => {
    await begin();
    fetchMock.mockImplementation(async (input) =>
      isOpenAI(input)
        ? json({ error: { message: "Provider unavailable" } }, 503)
        : json({}, 404),
    );
    expect(await send(textRequest)).toMatchObject({ results: [""] });
    // One stage: three OpenAI attempts, then the on-device stage decides.
    expect(stageCalls()).toHaveLength(3);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("treats an OpenAI 401 as a rejected key, never as a run failure", async () => {
    await begin();
    fetchMock.mockImplementation(async (input) =>
      isOpenAI(input)
        ? json({ error: { message: "Incorrect API key" } }, 401)
        : json({}, 404),
    );
    expect(await send(textRequest)).toMatchObject({ results: [""] });
    expect(stageCalls()).toHaveLength(1);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
    expect(await send({ type: "AUTH_STATUS" })).toMatchObject({
      authenticated: true,
      engineSource: "on-device",
      providerKeyRejected: true,
    });
    // Later work no longer calls OpenAI with the rejected key.
    await send(textRequest);
    expect(stageCalls()).toHaveLength(1);
  });

  it("hands the user's key only to OpenAI, never to pages, extension surfaces, logs or saved data", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    const settings = {
      id: "test-extension-id",
      url: browser.runtime.getURL("/options.html" as never),
      tab: { id: 99 },
    };
    const popup = {
      id: "test-extension-id",
      url: "chrome-extension://test/popup.html",
    };
    await begin();
    const responses = [
      await send({
        type: "TRANSLATE_HTML",
        runId: 1,
        pieces: [["Hello"], ["World"]],
        targetLanguage: "vi",
        deferCache: true,
      }),
      await send(textRequest),
      await send({
        type: "TRANSLATE_SINGLE",
        runId: 1,
        text: "Title",
        targetLanguage: "vi",
      }),
      await send({
        type: "CACHE_ACCEPTED_OPENAI_HTML",
        runId: 1,
        sources: [["Hello"]],
        results: [["Xin chào"]],
        targetLanguage: "vi",
      }),
      // A content script asking for the settings is refused outright.
      await send({ type: "PROVIDER_SETTINGS_GET" }),
      await send({ type: "PROVIDER_KEY_TEST" }),
      await send({ type: "AUTH_STATUS" }, popup as never),
      await send({ type: "DIAGNOSTICS_GET" }),
      await send({ type: "DIAGNOSTICS_GET" }, settings as never),
    ];
    const outgoing = [
      ...vi.mocked(browser.runtime.sendMessage).mock.calls,
      ...vi.mocked(browser.tabs.sendMessage).mock.calls,
    ];
    const saved = [...mocks.values].filter(
      ([key]) => key !== PROVIDER_SETTINGS_KEY,
    );
    const visible = JSON.stringify({ responses, outgoing, logged, saved });
    expect(visible).not.toContain(TEST_PROVIDER_KEY);
    expect(visible).not.toContain(TEST_PROVIDER_KEY.slice(-12));
    expect(responses[4]).toEqual({ ok: false, error: "forbidden" });
    // Copy diagnostics is for the Settings page only and carries no key.
    expect(responses[7]).toEqual({ ok: false, error: "forbidden" });
    expect(responses[8]).toMatchObject({
      ok: true,
      report: {
        readlaceDiagnostics: 1,
        engine: { source: "byok-openai", keyConfigured: true },
      },
    });

    // The only place the key appears is the Authorization header to OpenAI.
    expect(stageCalls().length).toBeGreaterThan(0);
    for (const [input, init] of fetchMock.mock.calls) {
      const authorization = new Headers(init?.headers).get("authorization");
      const body = String(init?.body ?? "");
      expect(body).not.toContain(TEST_PROVIDER_KEY);
      if (isOpenAI(input)) {
        expect(String(input)).toMatch(/^https:\/\/api\.openai\.com\//);
        expect(authorization).toBe(`Bearer ${TEST_PROVIDER_KEY}`);
      } else expect(authorization ?? "").not.toContain(TEST_PROVIDER_KEY);
    }
  });
});
