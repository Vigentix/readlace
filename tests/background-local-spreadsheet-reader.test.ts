import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_SETTINGS_KEY } from "@/lib/provider-settings-store";
import { testProviderSettings } from "@/tests/fixtures/openai-responses";
import { fakeBrowser } from "wxt/testing/fake-browser";

import {
  MAX_LOCAL_TRANSLATION_RESPONSE_UNITS,
  MAX_LOCAL_TRANSLATION_RESULT_UNITS,
  type LocalSpreadsheetTranslateRequest,
  type LocalSpreadsheetTranslateResponse,
} from "@/lib/local-spreadsheet-reader";

const mocks = vi.hoisted(() => ({
  // ADR 0015 launch flags: Sheets Reader on for these suites.
  sheetsReaderOn: true,
  driveOfficeReader: vi.fn(() => true),
  values: new Map<string, unknown>(),
  backendUser: vi.fn(),
  backendLogin: vi.fn(),
  backendSignOut: vi.fn(),
  backendStage: vi.fn(),
  translateText: vi.fn(),
  createOpenAI: vi.fn(),
  createNative: vi.fn(),
  generation: 0,
}));

vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: async (key: string) => mocks.values.get(key),
    getMany: async (keys: string[]) =>
      Object.fromEntries(
        keys
          .filter((key) => mocks.values.has(key))
          .map((key) => [key, mocks.values.get(key)]),
      ),
    getByPrefix: async (prefix: string) =>
      Object.fromEntries(
        [...mocks.values].filter(([key]) => key.startsWith(prefix)),
      ),
    set: vi.fn(),
    setMany: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@/lib/translate/openai-html", () => ({
  createOpenAIHtmlTranslator: mocks.createOpenAI,
}));

vi.mock("@/lib/translate/browser-native", () => ({
  createNativeTranslatorHost: mocks.createNative,
}));

vi.mock("@/lib/workspace-features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-features")>()),
  sheetsReaderEnabled: () => mocks.sheetsReaderOn,
  driveOfficeReaderEnabled: mocks.driveOfficeReader,
}));
import background from "@/entrypoints/background";
import { GOOGLE_WORKSPACE_SCOPES } from "@/shared/google-workspace-config";

/** ADR 0020: the one local identity the background uses (no accounts). */
const AUTHENTICATED = {
  authenticated: true as const,
  user: { id: "local", email: "" },
};
const HASH = "a".repeat(40);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const request = (
  readerInstanceId: string,
  requestId: number,
  overrides: Partial<LocalSpreadsheetTranslateRequest> = {},
): LocalSpreadsheetTranslateRequest => ({
  type: "LOCAL_SPREADSHEET_TRANSLATE",
  readerInstanceId,
  requestId,
  generation: 1,
  targetLanguage: "vi",
  records: [{ id: "A1", sourceHash: HASH, text: "こんにちは" }],
  ...overrides,
});

const sender = (overrides: Record<string, unknown> = {}) => ({
  id: browser.runtime.id,
  url: `${browser.runtime.getURL("/reader.html" as never)}?local=1`,
  documentId: "local-reader-document",
  ...(typeof overrides.url === "string" &&
  overrides.url.includes("sourceTabId=7")
    ? { tab: { id: 70 } }
    : {}),
  ...overrides,
});

async function send(message: unknown, from: unknown = sender()) {
  const responses = await fakeBrowser.runtime.onMessage.trigger(
    message as never,
    from as never,
    vi.fn(),
  );
  const response: unknown = responses[0];
  return response as LocalSpreadsheetTranslateResponse;
}
async function boundOfficeReader() {
  const clientId = "123-web.apps.googleusercontent.com";
  vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", clientId);
  Object.defineProperty(browser, "identity", {
    configurable: true,
    value: {
      getRedirectURL: vi.fn(
        () => "https://test.chromiumapp.org/google-workspace",
      ),
      launchWebAuthFlow: vi.fn(),
    },
  });
  let url = "https://docs.google.com/spreadsheets/d/office123/edit";
  vi.spyOn(browser.tabs, "get").mockImplementation(async () => ({
    id: 7,
    windowId: 1,
    url,
  }));
  const contexts = vi.fn(async () => [
    {
      contextType: "SIDE_PANEL",
      documentId: "global-office-document",
      documentUrl: browser.runtime.getURL("/reader.html" as never),
      windowId: 1,
    },
  ]);
  Object.defineProperty(browser.runtime, "getContexts", {
    configurable: true,
    value: contexts,
  });
  Object.defineProperty(browser.storage.session, "setAccessLevel", {
    configurable: true,
    value: vi.fn(),
  });
  const issuedAt = Date.now();
  await browser.storage.session.set({
    ["workspaceReaderGoogleToken:v1"]: {
      version: 2,
      accessToken: "test-token",
      issuedAt,
      expiresAt: issuedAt + 3_600_000,
      clientId,
      extensionId: browser.runtime.id,
      scopes: [...GOOGLE_WORKSPACE_SCOPES],
      managedAccountId: "local",
    },
  });
  const from = sender({
    url: browser.runtime.getURL("/reader.html" as never),
    documentId: "global-office-document",
  });
  expect(
    await send(
      {
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: "bound-office",
        requestId: 1,
        sourceTabId: 7,
      },
      from,
    ),
  ).toMatchObject({ ok: true });
  return {
    from,
    contexts,
    changeSource: () => {
      url = url.replace("office123", "another-file");
    },
  };
}

describe("background local spreadsheet translation", () => {
  beforeEach(() => {
    vi.stubEnv(
      "WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID",
      "123-web.apps.googleusercontent.com",
    );
    mocks.generation = 0;
    mocks.values.clear();
    // ADR 0020: the user's own OpenAI key drives the provider path.
    mocks.values.set(PROVIDER_SETTINGS_KEY, testProviderSettings());
    vi.spyOn(browser.tabs, "query").mockImplementation(
      async () =>
        [
          {
            id: 7,
            windowId: 1,
            url: "https://docs.google.com/spreadsheets/d/office123/edit",
          },
        ] as never,
    );
    vi.spyOn(browser.tabs, "get").mockImplementation(async (id) => ({
      id,
      windowId: 1,
      url:
        id === 70
          ? `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7`
          : "https://docs.google.com/spreadsheets/d/office123/edit",
    }));
    mocks.translateText.mockReset().mockResolvedValue({
      results: ["Xin chào"],
      failures: [],
    });
    mocks.createOpenAI.mockReturnValue({
      translateText: mocks.translateText,
      translateHtml: vi.fn(),
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
    (background.main as () => void)();
  });

  it("accepts only the exact extension local Reader and zero-byte schema", async () => {
    const valid = request("sender-valid", 1);
    const translated = await send(valid);
    expect(translated).toEqual({
      type: valid.type,
      readerInstanceId: valid.readerInstanceId,
      requestId: 1,
      generation: 1,
      ok: true,
      results: [{ id: "A1", sourceHash: HASH, text: "Xin chào" }],
    });
    expect(JSON.stringify(translated)).not.toContain("こんにちは");
    expect(mocks.translateText).toHaveBeenCalledWith(["こんにちは"], "vi");

    const office = request("office-sender-valid", 1);
    await expect(
      send(
        office,
        sender({
          url: `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=7`,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    const originalNavigation = request("office-original-url-valid", 1);
    await expect(
      send(
        originalNavigation,
        sender({
          url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7`,
        }),
      ),
    ).resolves.toMatchObject({ ok: true });

    for (const [index, from] of [
      sender({ id: "foreign-extension" }),
      sender({ url: browser.runtime.getURL("/reader.html" as never) }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?local=1&extra=1`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?local=1#hash`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?office=1`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=0`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=07`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=7&extra=1`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7&office=1`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=7#hash`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=0`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=07`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7&extra=1`,
      }),
      sender({
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7#hash`,
      }),
    ].entries()) {
      await expect(
        send(request(`bad-sender-${index}`, 1), from),
      ).resolves.toMatchObject({
        ok: false,
        error:
          from.url === browser.runtime.getURL("/reader.html" as never) &&
          from.id === browser.runtime.id
            ? "reader-channel-unavailable"
            : "invalid-request",
      });
    }

    await expect(
      send({ ...request("bytes-forbidden", 1), fileBytes: [1, 2, 3] }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    await expect(
      send({
        ...request("metadata-forbidden", 1),
        workbook: { name: "secret" },
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(mocks.translateText).toHaveBeenCalledTimes(3);
  });
  it("translates a bare original Drive Reader only through its validated Context owner", async () => {
    const { from } = await boundOfficeReader();
    expect(await send(request("bound-office", 2), from)).toMatchObject({
      ok: true,
      results: [{ text: "Xin chào" }],
    });
    expect(mocks.translateText).toHaveBeenCalledOnce();
    expect(mocks.translateText).toHaveBeenCalledWith(["こんにちは"], "vi");
  });
  it.each(["owner", "document", "window", "source"])(
    "rejects a bare Drive translation with obsolete %s before provider work",
    async (kind) => {
      const { from, contexts, changeSource } = await boundOfficeReader();
      if (kind === "document") from.documentId = "forged-document";
      if (kind === "window")
        contexts.mockResolvedValue([
          {
            contextType: "SIDE_PANEL",
            documentId: "global-office-document",
            documentUrl: browser.runtime.getURL("/reader.html" as never),
            windowId: 2,
          },
        ]);
      if (kind === "source") changeSource();
      if (kind === "generation") mocks.generation += 1;
      if (kind === "account")
        mocks.backendUser.mockResolvedValue({
          ...AUTHENTICATED,
          user: { ...AUTHENTICATED.user, id: "other-user" },
        });
      expect(
        await send(
          request(kind === "owner" ? "forged-owner" : "bound-office", 2),
          from,
        ),
      ).toMatchObject({ ok: false });
      expect(mocks.translateText).not.toHaveBeenCalled();
      expect(mocks.translateText).not.toHaveBeenCalled();
    },
  );
  it("keeps a formerly bound global source working while another editor tab is active in its window", async () => {
    const { from } = await boundOfficeReader();
    vi.mocked(browser.tabs.query).mockImplementation(
      async () => [{ id: 8, windowId: 1 }] as never,
    );
    expect(await send(request("bound-office", 2), from)).toMatchObject({
      ok: true,
    });
    expect(mocks.translateText).toHaveBeenCalledOnce();
  });
  it("keeps a provider result when the global Reader's window activates another tab", async () => {
    const { from } = await boundOfficeReader();
    const pending = deferred<{ results: string[]; failures: never[] }>();
    mocks.translateText.mockReturnValueOnce(pending.promise);
    const result = send(request("bound-office", 2), from);
    await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledOnce());
    vi.mocked(browser.tabs.query).mockImplementation(
      async () => [{ id: 8, windowId: 1 }] as never,
    );
    pending.resolve({ results: ["late"], failures: [] });
    expect(await result).toMatchObject({ ok: true });
  });

  it("maps a provider failure per record", async () => {
    mocks.translateText.mockRejectedValueOnce(new Error("provider down"));
    await expect(send(request("provider-failure", 1))).resolves.toMatchObject({
      ok: true,
      results: [{ id: "A1", sourceHash: HASH, error: "provider-error" }],
    });
  });

  it("rejects non-monotonic generations and discards an overtaken response", async () => {
    const pending = deferred<{ results: string[]; failures: never[] }>();
    mocks.translateText.mockReturnValueOnce(pending.promise);
    const older = send(request("ordering", 1, { generation: 1 }));
    await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledOnce());
    await expect(
      send(request("ordering", 2, { generation: 2 })),
    ).resolves.toMatchObject({ ok: true, requestId: 2, generation: 2 });
    pending.resolve({ results: ["late"], failures: [] });
    await expect(older).resolves.toMatchObject({
      ok: false,
      error: "invalid-request",
      requestId: 1,
      generation: 1,
    });
    await expect(
      send(request("ordering", 2, { generation: 2 })),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    await expect(
      send(request("ordering", 3, { generation: 1 })),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
  });

  it("bounds retained Reader owners without reviving an evicted pending request", async () => {
    const pending = deferred<{ results: string[]; failures: never[] }>();
    mocks.translateText.mockReturnValueOnce(pending.promise);
    const evictedPending = send(request("owner-0", 1, { generation: 1 }));
    await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledOnce());

    for (let index = 1; index <= 256; index += 1) {
      const response = await send(request(`owner-${index}`, 1));
      expect(response.ok).toBe(true);
    }

    await expect(send(request("owner-0", 1))).resolves.toMatchObject({
      ok: true,
    });
    await expect(send(request("owner-256", 1))).resolves.toMatchObject({
      ok: false,
      error: "invalid-request",
    });

    pending.resolve({ results: ["late"], failures: [] });
    await expect(evictedPending).resolves.toMatchObject({
      ok: false,
      error: "invalid-request",
    });
  });

  it("never forwards oversized individual or aggregate provider output", async () => {
    const oversized = "x".repeat(MAX_LOCAL_TRANSLATION_RESULT_UNITS + 1);
    mocks.translateText.mockResolvedValueOnce({
      results: [oversized],
      failures: [],
    });
    const individual = await send(request("oversized-result", 1));
    expect(individual).toMatchObject({
      ok: true,
      results: [{ id: "A1", sourceHash: HASH, error: "provider-error" }],
    });
    expect(JSON.stringify(individual)).not.toContain(oversized);

    const expanded = "z".repeat(3_000);
    mocks.translateText.mockResolvedValueOnce({
      results: [expanded, expanded, expanded],
      failures: [],
    });
    const aggregateRequest = request("aggregate-result", 1, {
      records: [
        { id: "A1", sourceHash: HASH, text: "a" },
        { id: "A2", sourceHash: HASH, text: "b" },
        { id: "A3", sourceHash: HASH, text: "c" },
      ],
    });
    const aggregate = await send(aggregateRequest);
    expect(aggregate).toMatchObject({
      ok: true,
      results: [
        { id: "A1", text: expanded },
        { id: "A2", text: expanded },
        { id: "A3", error: "provider-error" },
      ],
    });
    if (!aggregate.ok) throw new Error("Expected translated response");
    const outputUnits = aggregate.results.reduce(
      (total, result) => total + ("text" in result ? result.text.length : 0),
      0,
    );
    expect(outputUnits).toBeLessThanOrEqual(
      MAX_LOCAL_TRANSLATION_RESPONSE_UNITS,
    );
  });
});
