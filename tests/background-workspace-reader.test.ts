import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import {
  MAX_LOADED_SOURCE_CHARACTERS,
  MAX_TRANSLATION_RECORD_CHARACTERS,
  type WorkspaceReaderRequest,
  type WorkspaceReaderResponse,
  type WorkspaceSourceVersion,
} from "@/lib/google-workspace-reader";

const mocks = vi.hoisted(() => ({
  // ADR 0015 launch flags: Sheets Reader on for these suites.
  sheetsReaderOn: true,
  driveOfficeReader: vi.fn(() => false),
  values: new Map<string, unknown>(),
  backendUser: vi.fn(),
  backendLogin: vi.fn(),
  backendSignOut: vi.fn(),
  backendStage: vi.fn(),
  translateText: vi.fn(),
  createOpenAI: vi.fn(),
  createNative: vi.fn(),
  storageSet: vi.fn(),
  storageSetMany: vi.fn(),
  getRedirectURL: vi.fn(),
  launchWebAuthFlow: vi.fn(),
  setSessionAccessLevel: vi.fn(),
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
    set: mocks.storageSet,
    setMany: mocks.storageSetMany,
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

const SOURCE_TAB_ID = 7;
const SHEETS_URL =
  "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
const DOCS_URL = "https://docs.google.com/document/d/doc_123/edit?tab=t.child";
/** ADR 0020: the one local identity the background uses (no accounts). */
const AUTHENTICATED = {
  authenticated: true as const,
  user: { id: "local", email: "" },
};
const WEB_CLIENT_ID = "123-web.apps.googleusercontent.com";
const WEB_REDIRECT =
  "https://imlhpiikjakgljngkdalbfgdpkniejdb.chromiumapp.org/google-workspace";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;
const WORKSPACE_TOKEN_KEY = "workspaceReaderGoogleToken:v1";

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const sheetMetadata = {
  spreadsheetId: "sheet_123",
  sheets: [
    {
      properties: {
        sheetId: 42,
        title: "Sheet 1",
        sheetType: "GRID",
        rightToLeft: false,
        gridProperties: {
          rowCount: 150,
          columnCount: 10,
          frozenRowCount: 1,
          frozenColumnCount: 1,
          hideGridlines: false,
        },
      },
    },
    {
      properties: {
        sheetId: 99,
        title: "Chart",
        sheetType: "OBJECT",
        rightToLeft: false,
        gridProperties: {
          rowCount: 1,
          columnCount: 1,
          frozenRowCount: 0,
          frozenColumnCount: 0,
          hideGridlines: false,
        },
      },
    },
    {
      properties: {
        sheetId: 7,
        title: "Sheet 2",
        sheetType: "GRID",
        rightToLeft: false,
        gridProperties: {
          rowCount: 2,
          columnCount: 2,
          frozenRowCount: 0,
          frozenColumnCount: 0,
          hideGridlines: false,
        },
      },
    },
  ],
};

const sheetValues = {
  range: "'Sheet 1'!A1:B150",
  majorDimension: "COLUMNS",
  values: [
    ["こんにちは", ...Array<string>(148).fill(""), "discovery-tail"],
    ["=A1"],
  ],
};

const sheetGridMetadata = {
  ...sheetMetadata,
  sheets: [
    {
      ...sheetMetadata.sheets[0],
      merges: [],
      data: [
        {
          startColumn: 0,
          columnMetadata: [
            { pixelSize: 96 },
            { pixelSize: 120, hiddenByUser: false },
          ],
        },
      ],
    },
  ],
};

const selectedSheetGridMetadata = {
  ...sheetMetadata,
  sheets: [
    {
      ...sheetMetadata.sheets[2],
      merges: [],
      data: [{ startColumn: 0, columnMetadata: [{ pixelSize: 96 }] }],
    },
  ],
};

const sheetPage = {
  spreadsheetId: "sheet_123",
  sheets: [
    {
      properties: {
        sheetId: 42,
        title: "Sheet 1",
        sheetType: "GRID",
        gridProperties: { rowCount: 150 },
      },
      data: [
        {
          startRow: 0,
          startColumn: 0,
          rowData: [
            {
              values: [
                {
                  userEnteredValue: { stringValue: "こんにちは" },
                  effectiveValue: { stringValue: "こんにちは" },
                  formattedValue: "こんにちは",
                },
                {
                  userEnteredValue: { formulaValue: "=A1" },
                  effectiveValue: { stringValue: "Hello" },
                  formattedValue: "Hello",
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const docsPage = {
  documentId: "doc_123",
  tabs: [
    {
      tabProperties: { tabId: "t.root", title: "Root" },
      documentTab: {
        body: {
          content: [
            {
              startIndex: 1,
              paragraph: {
                elements: [{ textRun: { content: "Root text\n" } }],
              },
            },
          ],
        },
      },
      childTabs: [
        {
          tabProperties: {
            tabId: "t.child",
            title: "Child",
            parentTabId: "t.root",
          },
          documentTab: {
            body: {
              content: [
                {
                  startIndex: 2,
                  paragraph: {
                    elements: [{ textRun: { content: "Child text\n" } }],
                  },
                },
                {
                  startIndex: 13,
                  table: {
                    tableRows: [
                      {
                        tableCells: [
                          {
                            content: [
                              {
                                startIndex: 14,
                                paragraph: {
                                  elements: [
                                    {
                                      textRun: { content: "Nested cell\n" },
                                    },
                                  ],
                                },
                              },
                              {
                                startIndex: 20,
                                paragraph: {
                                  elements: [
                                    { equation: { suggestedInsertionIds: [] } },
                                  ],
                                },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    },
  ],
};

let sourceUrl = SHEETS_URL;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let backgroundStarted = false;
let currentVersion: WorkspaceSourceVersion | undefined;
let bootstrapRequestId = 0;
let testReaderInstanceId = "reader-instance-1";

function ensureBackground() {
  if (backgroundStarted) return;
  backgroundStarted = true;
  (background.main as () => void)();
}

function sender(overrides: Record<string, unknown> = {}) {
  return {
    id: browser.runtime.id,
    url: browser.runtime.getURL("/reader.html" as never),
    documentId: "reader-document-1",
    ...(typeof overrides.url === "string" &&
    overrides.url.includes("?sourceTabId=")
      ? { tab: { id: 70 } }
      : {}),
    ...overrides,
  };
}

async function send(
  message: Record<string, unknown>,
  from: Record<string, unknown> = sender(),
) {
  ensureBackground();
  let actual: Record<string, unknown> = {
    readerInstanceId: testReaderInstanceId,
    ...message,
  };
  if (actual.type !== "WORKSPACE_READER_CONTEXT" && !("version" in actual)) {
    if (!currentVersion) {
      const [context] = await fakeBrowser.runtime.onMessage.trigger(
        {
          type: "WORKSPACE_READER_CONTEXT",
          readerInstanceId: "test-bootstrap-reader",
          requestId: ++bootstrapRequestId,
          sourceTabId: actual.sourceTabId,
        },
        from as never,
        vi.fn(),
      );
      const response = context as WorkspaceReaderResponse | undefined;
      if (response?.ok && response.type === "WORKSPACE_READER_CONTEXT")
        currentVersion = response.version;
    }
    actual = { ...actual, version: currentVersion };
  }
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    actual,
    from as never,
    vi.fn(),
  );
  const parsed = response as WorkspaceReaderResponse | undefined;
  if (parsed && "version" in parsed && parsed.version)
    currentVersion = parsed.version;
  return parsed;
}

async function discoverSheet(requestId = 1) {
  let cursor: Extract<
    WorkspaceReaderRequest,
    { type: "WORKSPACE_READER_DISCOVER" }
  >["cursor"] = null;
  for (let steps = 0; steps < 20; steps += 1) {
    const response = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: requestId++,
        sourceTabId: SOURCE_TAB_ID,
        cursor,
      }),
    );
    if (!response?.ok || response.type !== "WORKSPACE_READER_DISCOVER")
      throw new Error(`Discovery failed: ${JSON.stringify(response)}`);
    if (response.progress.status === "complete")
      return {
        grid: response.progress.grid,
        sheets: response.sheets,
        nextRequestId: requestId,
      };
    cursor = response.progress.cursor;
  }
  throw new Error("Discovery did not complete");
}

function request<T extends Record<string, unknown>>(value: T): T {
  return value;
}

function oauthReturn(
  authorizationUrl: string,
  entries: [string, string][] = [],
  redirect = WEB_REDIRECT,
) {
  const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
  const result = new URLSearchParams([
    ["access_token", "web-access-token"],
    ["token_type", "Bearer"],
    ["expires_in", "3600"],
    ["scope", GOOGLE_SCOPES.join(" ")],
    ["state", state],
  ]);
  for (const [key, value] of entries) {
    if (key.startsWith("+")) result.append(key.slice(1), value);
    else if (value) result.set(key, value);
    else result.delete(key);
  }
  return `${redirect}#${result}`;
}

async function useWebOauth() {
  vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", WEB_CLIENT_ID);
  mocks.getRedirectURL.mockReturnValue(WEB_REDIRECT);
  await browser.storage.session.remove(WORKSPACE_TOKEN_KEY);
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("background Google Workspace Reader", () => {
  beforeEach(async () => {
    mocks.sheetsReaderOn = true;
    mocks.driveOfficeReader.mockReturnValue(false);
    vi.useFakeTimers();
    backgroundStarted = false;
    currentVersion = undefined;
    bootstrapRequestId = 0;
    testReaderInstanceId = "reader-instance-1";
    vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", WEB_CLIENT_ID);
    sourceUrl = SHEETS_URL;
    mocks.generation = 0;
    mocks.values.clear();
    mocks.getRedirectURL.mockReturnValue(WEB_REDIRECT);
    mocks.launchWebAuthFlow.mockImplementation(async ({ url }) =>
      oauthReturn(url),
    );
    mocks.setSessionAccessLevel.mockResolvedValue(undefined);
    mocks.translateText.mockResolvedValue({
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
    Object.defineProperty(browser, "identity", {
      configurable: true,
      value: {
        getRedirectURL: mocks.getRedirectURL,
        launchWebAuthFlow: mocks.launchWebAuthFlow,
      },
    });
    vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Readlace",
      version: "0.0.1",
    } as never);
    const issuedAt = Date.now();
    await browser.storage.session.set({
      [WORKSPACE_TOKEN_KEY]: {
        version: 2,
        accessToken: "google-access-token",
        issuedAt,
        expiresAt: issuedAt + 3_600_000,
        clientId: WEB_CLIENT_ID,
        extensionId: browser.runtime.id,
        scopes: [...GOOGLE_SCOPES],
        managedAccountId: AUTHENTICATED.user.id,
      },
    });
    Object.defineProperty(browser.storage.session, "setAccessLevel", {
      configurable: true,
      value: mocks.setSessionAccessLevel,
    });
    vi.spyOn(browser.tabs, "get").mockImplementation(async (id) => ({
      id,
      url:
        id === 70
          ? `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}`
          : sourceUrl,
      windowId: 1,
    }));
    vi.spyOn(browser.tabs, "query").mockImplementation(
      async () =>
        [{ id: SOURCE_TAB_ID, windowId: 1, url: SHEETS_URL }] as never,
    );
    Object.defineProperty(browser.runtime, "getContexts", {
      configurable: true,
      value: vi.fn(async () => [
        {
          contextType: "SIDE_PANEL",
          documentId: "reader-document-1",
          documentUrl: browser.runtime.getURL("/reader.html" as never),
          windowId: 1,
        },
      ]),
    });
    fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "sheets.googleapis.com") {
        if (url.pathname.includes("/values/"))
          return json(
            decodeURIComponent(url.pathname).includes("Sheet 2")
              ? {
                  range: "'Sheet 2'!A1:B2",
                  majorDimension: "COLUMNS",
                  values: [["選択"]],
                }
              : sheetValues,
          );
        return json(
          url.searchParams.get("includeGridData") === "true"
            ? sheetPage
            : url.searchParams.has("ranges")
              ? url.searchParams.get("ranges")?.includes("Sheet 2")
                ? selectedSheetGridMetadata
                : sheetGridMetadata
              : sheetMetadata,
        );
      }
      if (url.hostname === "docs.googleapis.com") return json(docsPage);
      throw new Error(`Unexpected fetch: ${url.origin}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    Reflect.deleteProperty(browser, "identity");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts only the exact Reader sender, exact fields and increasing per-instance request IDs", async () => {
    const context = request({
      type: "WORKSPACE_READER_CONTEXT",
      requestId: 1,
      sourceTabId: SOURCE_TAB_ID,
    });

    await expect(send(context, sender({ url: SHEETS_URL }))).resolves.toEqual({
      type: context.type,
      readerInstanceId: testReaderInstanceId,
      requestId: 1,
      ok: false,
      error: "invalid-request",
    });
    await expect(send({ ...context, extra: true })).resolves.toEqual({
      type: context.type,
      readerInstanceId: testReaderInstanceId,
      requestId: 1,
      ok: false,
      error: "invalid-request",
    });
    await expect(send(context)).resolves.toMatchObject({
      type: context.type,
      requestId: 1,
      ok: true,
      configured: true,
      connected: true,
      context: {
        kind: "sheets",
        sourceTabId: SOURCE_TAB_ID,
        fileId: "sheet_123",
        activeId: "42",
      },
    });
    await expect(
      send(
        { ...context, readerInstanceId: "reader-instance-2" },
        sender({
          url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}`,
          documentId: "reader-tab-document",
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      send(
        context,
        sender({
          url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=8`,
          documentId: "forged-reader-tab",
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    await expect(send(context)).resolves.toEqual({
      type: context.type,
      readerInstanceId: testReaderInstanceId,
      requestId: 1,
      ok: false,
      error: "invalid-request",
    });
  });

  it("keeps Reader state for editor gid and URL noise with zero discovery/provider work", async () => {
    const context = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    expect(context).toMatchObject({ ok: true, version: { sourceRevision: 0 } });
    const discovered = await discoverSheet(2);
    const fetchCount = fetchMock.mock.calls.length;
    const notify = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    try {
      sourceUrl = `${SHEETS_URL.replace("#", "?utm_source=test#").replace("gid=42", "gid=7")}`;
      await fakeBrowser.tabs.onUpdated.trigger(
        SOURCE_TAB_ID,
        { url: sourceUrl },
        { id: SOURCE_TAB_ID, url: sourceUrl } as never,
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(notify).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(fetchCount);
      expect(mocks.translateText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, page: { startRow: 0 } });
  });

  it("makes the latest dropdown win over delayed selection and editor gid", async () => {
    await send({
      type: "WORKSPACE_READER_CONTEXT",
      requestId: 1,
      sourceTabId: SOURCE_TAB_ID,
    });
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const older = send({
      type: "WORKSPACE_READER_SELECT_SHEET",
      requestId: 2,
      sourceTabId: SOURCE_TAB_ID,
      sheetId: "42",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(
      send({
        type: "WORKSPACE_READER_SELECT_SHEET",
        requestId: 3,
        sourceTabId: SOURCE_TAB_ID,
        sheetId: "7",
      }),
    ).resolves.toMatchObject({ ok: true, context: { activeId: "7" } });
    sourceUrl = SHEETS_URL.replace("gid=42", "gid=99");
    pending.resolve(json(sheetMetadata));
    await expect(older).resolves.toMatchObject({
      ok: false,
      error: "invalid-request",
    });
    const context = await send({
      type: "WORKSPACE_READER_CONTEXT",
      requestId: 4,
      sourceTabId: SOURCE_TAB_ID,
    });
    expect(context).toMatchObject({
      ok: true,
      context: { activeId: "7" },
      targetLanguage: "vi",
      version: { sourceRevision: 0 },
    });
    const refreshed = await discoverSheet(5);
    expect(refreshed.grid).toMatchObject({ sheetId: "7" });
  });

  it("retains the initial worksheet only for its Reader owner and keeps a fresh owner's context/discovery consistent", async () => {
    const first = await discoverSheet();
    sourceUrl = SHEETS_URL.replace("gid=42", "gid=7");
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: first.nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
      }),
    ).resolves.toMatchObject({ ok: true, context: { activeId: "42" } });
    testReaderInstanceId = "reader-new-owner";
    currentVersion = undefined;
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    ).resolves.toMatchObject({ ok: true, context: { activeId: "7" } });
    const second = await discoverSheet(2);
    expect(second.grid.sheetId).toBe("7");
    sourceUrl = SHEETS_URL;
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: second.nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
      }),
    ).resolves.toMatchObject({ ok: true, context: { activeId: "7" } });
  });

  it("retires late provider results when an unrelated tab activates in the source window", async () => {
    const { nextRequestId } = await discoverSheet();
    const loaded = await send({
      type: "WORKSPACE_READER_LOAD",
      requestId: nextRequestId,
      sourceTabId: SOURCE_TAB_ID,
      cursor: null,
    });
    if (!loaded?.ok || loaded.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected load");
    const pending = deferred<{ results: string[]; failures: never[] }>();
    mocks.translateText.mockReturnValueOnce(pending.promise);
    const translation = send({
      type: "WORKSPACE_READER_TRANSLATE",
      requestId: nextRequestId + 1,
      sourceTabId: SOURCE_TAB_ID,
      targetLanguage: "vi",
      records: [
        {
          id: loaded.records[0]!.id,
          sourceHash: loaded.records[0]!.sourceHash,
        },
      ],
    });
    await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledOnce());
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => ({
      id,
      windowId: 1,
      url:
        id === SOURCE_TAB_ID
          ? sourceUrl
          : "https://drive.google.com/drive/my-drive",
    }));
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 8, windowId: 1 });
    await Promise.resolve();
    pending.resolve({ results: ["late"], failures: [] });
    await expect(translation).resolves.toMatchObject({
      ok: false,
      error: "source-tab-changed",
    });
  });

  it.each([
    "bound-reader",
    "blank-to-reader",
    "local-reader",
    "foreign-extension",
    "foreign-window-source",
    "unsupported-source",
    "blank-only",
  ])(
    "validates Reader tab activation ownership before settling pending work: %s",
    async (route) => {
      const { nextRequestId } = await discoverSheet();
      const loaded = await send({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      });
      if (!loaded?.ok || loaded.type !== "WORKSPACE_READER_LOAD")
        throw new Error("Expected load");
      const pending = deferred<{ results: string[]; failures: never[] }>();
      mocks.translateText.mockReturnValueOnce(pending.promise);
      const translation = send({
        type: "WORKSPACE_READER_TRANSLATE",
        requestId: nextRequestId + 1,
        sourceTabId: SOURCE_TAB_ID,
        targetLanguage: "vi",
        records: [
          {
            id: loaded.records[0]!.id,
            sourceHash: loaded.records[0]!.sourceHash,
          },
        ],
      });
      await vi.waitFor(() =>
        expect(mocks.translateText).toHaveBeenCalledOnce(),
      );
      const boundUrl = `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}`;
      let activeUrl = route.startsWith("blank")
        ? "about:blank"
        : route === "local-reader"
          ? `${browser.runtime.getURL("/reader.html" as never)}?local=1`
          : route === "foreign-extension"
            ? "chrome-extension://foreign/reader.html?sourceTabId=7"
            : boundUrl;
      vi.mocked(browser.tabs.get).mockImplementation(async (id) => ({
        id,
        windowId:
          id === SOURCE_TAB_ID && route === "foreign-window-source" ? 2 : 1,
        url:
          id === SOURCE_TAB_ID
            ? route === "unsupported-source"
              ? DOCS_URL
              : sourceUrl
            : activeUrl,
      }));
      await fakeBrowser.tabs.onActivated.trigger({ tabId: 80, windowId: 1 });
      if (route === "blank-to-reader") {
        await vi.advanceTimersByTimeAsync(50);
        activeUrl = boundUrl;
        await fakeBrowser.tabs.onUpdated.trigger(80, { url: activeUrl }, {
          id: 80,
          windowId: 1,
          active: true,
          url: activeUrl,
        } as never);
      }
      await vi.advanceTimersByTimeAsync(250);
      pending.resolve({ results: ["original-owner-result"], failures: [] });
      if (route === "bound-reader" || route === "blank-to-reader")
        await expect(translation).resolves.toMatchObject({
          ok: true,
          generation: loaded.generation,
          results: [{ text: "original-owner-result" }],
        });
      else
        await expect(translation).resolves.toMatchObject({
          ok: false,
          error:
            route === "unsupported-source"
              ? "unsupported-url"
              : "source-tab-changed",
        });
      expect(mocks.translateText).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["workbook", "application/vnd.google-apps.spreadsheet", "native"],
    [
      "workbook.xlsm",
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      "office",
    ],
  ])(
    "dormant Drive path: identifies %s from bounded metadata without reading values or media",
    async (name, mimeType, sourceKind) => {
      mocks.driveOfficeReader.mockReturnValue(true);
      const response = json({ id: "sheet_123", name, mimeType });
      Object.defineProperty(response, "url", {
        value: "https://www.googleapis.com/drive/v3/files/sheet_123",
      });
      fetchMock.mockResolvedValueOnce(response);
      await expect(
        send({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
          identifySource: true,
        }),
      ).resolves.toMatchObject({
        ok: true,
        sourceKind,
        sourceTitle: name,
        targetLanguage: "vi",
      });
      expect(fetchMock).toHaveBeenCalledTimes(sourceKind === "native" ? 2 : 1);
      if (sourceKind === "native") {
        const catalogUrl = new URL(String(fetchMock.mock.calls[1]![0]));
        expect(catalogUrl.searchParams.get("fields")).toBe(
          "spreadsheetId,sheets(properties(sheetId,title,sheetType))",
        );
        expect(catalogUrl.searchParams.get("includeGridData")).toBe("false");
      }
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.searchParams.get("fields")).toBe("id,name,mimeType");
      expect(url.searchParams.has("alt")).toBe(false);
      expect(mocks.translateText).not.toHaveBeenCalled();
    },
  );

  it("dormant Drive path: rejects suffix-only metadata and malformed identify flag", async () => {
    mocks.driveOfficeReader.mockReturnValue(true);
    const response = json({
      id: "sheet_123",
      name: "file.xlsx",
      mimeType: "application/pdf",
    });
    Object.defineProperty(response, "url", {
      value: "https://www.googleapis.com/drive/v3/files/sheet_123",
    });
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        identifySource: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: "unsupported-file-type" });
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 2,
        sourceTabId: SOURCE_TAB_ID,
        identifySource: false,
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("returns ordered native titles and resolves a missing/non-GRID gid without reading values", async () => {
    sourceUrl = SHEETS_URL.replace("gid=42", "gid=99");
    fetchMock.mockResolvedValueOnce(
      json({
        spreadsheetId: "sheet_123",
        properties: { title: "Native workbook" },
      }),
    );
    const result = await send({
      type: "WORKSPACE_READER_CONTEXT",
      requestId: 1,
      sourceTabId: SOURCE_TAB_ID,
      identifySource: true,
    });
    expect(result).toMatchObject({
      ok: true,
      context: { activeId: "42" },
      sheets: [
        { sheetId: "42", title: "Sheet 1", index: 0 },
        { sheetId: "7", title: "Sheet 2", index: 2 },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/values/"),
      ),
    ).toBe(false);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("identifies a native Sheet with only the Sheets API at launch (ADR 0015)", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        spreadsheetId: "sheet_123",
        properties: { title: "Native workbook" },
      }),
    );
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        identifySource: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      sourceKind: "native",
      sourceTitle: "Native workbook",
    });
    const identify = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(identify.origin).toBe("https://sheets.googleapis.com");
    expect(identify.pathname).toBe("/v4/spreadsheets/sheet_123");
    expect(identify.searchParams.get("fields")).toBe(
      "spreadsheetId,properties(title)",
    );
    expect(
      fetchMock.mock.calls.every(
        ([input]) =>
          new URL(String(input)).hostname === "sheets.googleapis.com",
      ),
    ).toBe(true);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("asks for a download when the Sheets API refuses a Drive Office workbook (ADR 0015)", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 400,
            status: "FAILED_PRECONDITION",
            message: "This operation is not supported for this document",
          },
        },
        400,
      ),
    );
    await expect(
      send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        identifySource: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: "office-download-required" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("www.googleapis.com/drive"),
      ),
    ).toBe(false);
  });

  it("gates every native Sheets Reader request on the build flag, default off (ADR 0020)", async () => {
    mocks.sheetsReaderOn = false;
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
          identifySource: true,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "sheets-reader-unavailable" });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONNECT",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          version: { backgroundEpoch: "any", sourceRevision: 0 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "sheets-reader-unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(mocks.translateText).not.toHaveBeenCalled();

    // Docs keeps its own unavailable state.
    sourceUrl = DOCS_URL;
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 3,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "unsupported-url" });

    // The flag is read per request.
    sourceUrl = SHEETS_URL;
    mocks.sheetsReaderOn = true;
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 4,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, connected: true });
  });

  it("tells Reader to re-identify when a navigation arrives with no remembered source (worker restart)", async () => {
    // Initialise the background instance (its listeners) on another tab.
    await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    const notify = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    try {
      await fakeBrowser.tabs.onUpdated.trigger(
        SOURCE_TAB_ID + 1,
        { url: SHEETS_URL },
        { id: SOURCE_TAB_ID + 1, url: SHEETS_URL } as never,
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "WORKSPACE_READER_SOURCE_CHANGED",
          sourceTabId: SOURCE_TAB_ID + 1,
          version: expect.objectContaining({ sourceRevision: 0 }),
        }),
      );
      // Non-workspace navigations never notify.
      notify.mockClear();
      await fakeBrowser.tabs.onUpdated.trigger(
        SOURCE_TAB_ID + 2,
        { url: "https://example.com/" },
        { id: SOURCE_TAB_ID + 2, url: "https://example.com/" } as never,
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(notify).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid source changes, rejects old A after A-B-A, and keeps the Google session", async () => {
    const context = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    if (!context?.ok || context.type !== "WORKSPACE_READER_CONTEXT")
      throw new Error("Expected context");
    const originalVersion = context.version;
    const storedToken = await browser.storage.session.get(WORKSPACE_TOKEN_KEY);
    const notify = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);
    vi.useFakeTimers();
    try {
      for (const gid of ["43", "44"]) {
        sourceUrl = SHEETS_URL.replace("sheet_123", `sheet_${gid}`);
        await fakeBrowser.tabs.onUpdated.trigger(
          SOURCE_TAB_ID,
          { url: sourceUrl },
          { id: SOURCE_TAB_ID, url: sourceUrl } as never,
        );
      }
      await vi.advanceTimersByTimeAsync(199);
      expect(notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenLastCalledWith({
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId: SOURCE_TAB_ID,
        version: {
          backgroundEpoch: originalVersion.backgroundEpoch,
          sourceRevision: 2,
        },
      });

      sourceUrl = SHEETS_URL;
      await fakeBrowser.tabs.onUpdated.trigger(
        SOURCE_TAB_ID,
        { url: sourceUrl },
        { id: SOURCE_TAB_ID, url: sourceUrl } as never,
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          readerInstanceId: testReaderInstanceId,
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          version: originalVersion,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "source-tab-changed",
      version: { sourceRevision: 3 },
    });
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual(
      storedToken,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not collide reopened Readers when sender documentId is absent", async () => {
    const withoutDocument = sender({
      documentId: undefined,
      url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}`,
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          readerInstanceId: "reader-open-1",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
        withoutDocument,
      ),
    ).resolves.toMatchObject({ ok: true, readerInstanceId: "reader-open-1" });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          readerInstanceId: "reader-open-2",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
        withoutDocument,
      ),
    ).resolves.toMatchObject({ ok: true, readerInstanceId: "reader-open-2" });
  });

  it("rejects an old worker epoch and rebuilds fresh context with the session token", async () => {
    const first = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: "reader-before-restart",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    if (!first?.ok || first.type !== "WORKSPACE_READER_CONTEXT")
      throw new Error("Expected context");

    fakeBrowser.runtime.resetState();
    backgroundStarted = false;
    const stale = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        readerInstanceId: "reader-after-restart",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        version: first.version,
        cursor: null,
      }),
    );
    expect(stale).toMatchObject({ ok: false, error: "source-tab-changed" });
    if (!stale || !("version" in stale)) throw new Error("Expected version");
    expect(stale.version.backgroundEpoch).not.toBe(
      first.version.backgroundEpoch,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const rebuilt = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: "reader-after-restart",
        requestId: 2,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    expect(rebuilt).toMatchObject({ ok: true, connected: true });
  });

  it("notifies a surviving Reader when its source tab closes without clearing Google access", async () => {
    const context = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    if (!context?.ok || context.type !== "WORKSPACE_READER_CONTEXT")
      throw new Error("Expected context");
    const storedToken = await browser.storage.session.get(WORKSPACE_TOKEN_KEY);
    const notify = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);

    await fakeBrowser.tabs.onRemoved.trigger(SOURCE_TAB_ID, {
      isWindowClosing: false,
      windowId: 1,
    });

    expect(notify).toHaveBeenCalledOnce();
    const notification = notify.mock.calls[0]![0];
    expect(notification).toEqual({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: SOURCE_TAB_ID,
      version: {
        backgroundEpoch: context.version.backgroundEpoch,
        sourceRevision: 1,
      },
    });
    expect(JSON.stringify(notification)).not.toContain("google-access-token");
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual(
      storedToken,
    );
  });

  it("keeps ordinary checks noninteractive and clears session state on Disconnect", async () => {
    await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    await send(
      request({
        type: "WORKSPACE_READER_CONNECT",
        requestId: 2,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCONNECT",
          requestId: 3,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, connected: false });

    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual({});
  });

  it("disconnects globally with a stale source version and without rereading the source tab", async () => {
    const context = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    if (!context?.ok || context.type !== "WORKSPACE_READER_CONTEXT")
      throw new Error("Expected context");
    await discoverSheet(2);

    sourceUrl = SHEETS_URL.replace("gid=42", "gid=7");
    await fakeBrowser.tabs.onUpdated.trigger(
      SOURCE_TAB_ID,
      { url: sourceUrl },
      { id: SOURCE_TAB_ID, url: sourceUrl } as never,
    );
    const tabsGet = vi.mocked(browser.tabs.get);
    tabsGet.mockClear();

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCONNECT",
          requestId: 50,
          sourceTabId: SOURCE_TAB_ID,
          version: context.version,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      connected: false,
      version: context.version,
    });

    expect(tabsGet).not.toHaveBeenCalled();
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual({});
  });

  it("treats a malformed web client ID as not configured", async () => {
    vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "not-a-google-client-id");
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, configured: false, connected: false });
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("bootstraps without the optional identity permission and refuses Connect until it is granted", async () => {
    await useWebOauth();
    // ADR 0015: `identity` is optional, so its API is absent until Connect.
    Object.defineProperty(browser, "identity", {
      configurable: true,
      value: {},
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, configured: true, connected: false });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONNECT",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "google-permission-denied" });
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("uses web OAuth once, stores only a bounded session record, and restores it after worker recreation", async () => {
    await useWebOauth();
    const before = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    expect(before).toMatchObject({
      ok: true,
      configured: true,
      connected: false,
    });
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();

    const connected = await send(
      request({
        type: "WORKSPACE_READER_CONNECT",
        requestId: 2,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    expect(connected).toMatchObject({ ok: true, connected: true });
    expect(mocks.launchWebAuthFlow).toHaveBeenCalledOnce();
    expect(mocks.getRedirectURL).toHaveBeenCalledWith("google-workspace");
    const [{ url, interactive }] = mocks.launchWebAuthFlow.mock.calls[0]!;
    const authorization = new URL(url);
    expect(interactive).toBe(true);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(authorization.searchParams)).toEqual({
      client_id: WEB_CLIENT_ID,
      redirect_uri: WEB_REDIRECT,
      response_type: "token",
      scope: GOOGLE_SCOPES.join(" "),
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      include_granted_scopes: "false",
      prompt: "select_account",
    });

    const { nextRequestId } = await discoverSheet(3);
    const loaded = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    expect(loaded).toMatchObject({ ok: true, title: "Sheet 1" });
    expect(mocks.launchWebAuthFlow).toHaveBeenCalledOnce();
    expect(
      fetchMock.mock.calls.every(
        ([, init]) =>
          new Headers(init?.headers).get("authorization") ===
          "Bearer web-access-token",
      ),
    ).toBe(true);
    expect(JSON.stringify([before, connected, loaded])).not.toContain(
      "web-access-token",
    );
    expect(JSON.stringify(mocks.values)).not.toContain("web-access-token");
    expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain(
      "web-access-token",
    );
    expect(JSON.stringify(await browser.storage.sync.get(null))).not.toContain(
      "web-access-token",
    );

    fakeBrowser.runtime.resetState();
    backgroundStarted = false;
    const restored = await send(
      request({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    expect(restored).toMatchObject({ ok: true, connected: true });
    expect(mocks.launchWebAuthFlow).toHaveBeenCalledOnce();
    expect(mocks.setSessionAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  });

  it.each([
    [
      "a state mismatch",
      (url: string) => oauthReturn(url, [["state", "wrong-state"]]),
      "google-oauth-response",
    ],
    [
      "a wrong redirect",
      (url: string) =>
        oauthReturn(url, [], "https://attacker.example/google-workspace"),
      "google-oauth-configuration",
    ],
    [
      "a duplicate critical parameter",
      (url: string) => oauthReturn(url, [["+access_token", "second-token"]]),
      "google-oauth-response",
    ],
    [
      "a missing scope",
      (url: string) => oauthReturn(url, [["scope", ""]]),
      "google-oauth-scope",
    ],
    [
      "a broader scope set",
      (url: string) =>
        oauthReturn(url, [
          [
            "scope",
            `${GOOGLE_SCOPES.join(" ")} https://www.googleapis.com/auth/drive`,
          ],
        ]),
      "google-oauth-scope",
    ],
    [
      "an access token inside the expiry skew",
      (url: string) => oauthReturn(url, [["expires_in", "60"]]),
      "google-oauth-expired",
    ],
    [
      "an OAuth denial",
      (url: string) =>
        oauthReturn(url, [
          ["access_token", ""],
          ["error", "access_denied"],
        ]),
      "google-access-denied",
    ],
  ])("rejects %s with a precise safe error", async (_, result, error) => {
    await useWebOauth();
    mocks.launchWebAuthFlow.mockImplementationOnce(async ({ url }) =>
      result(url),
    );

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONNECT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error,
    });
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual({});
  });

  it.each([
    [new Error("Network connection failed"), "google-oauth-network"],
    [new Error("The user closed the window"), "google-access-denied"],
    [new Error("Unexpected identity failure"), "google-oauth-failed"],
  ])("classifies launch failure %s safely", async (failure, error) => {
    await useWebOauth();
    mocks.launchWebAuthFlow.mockRejectedValueOnce(failure);
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONNECT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error });
  });

  it("expires, disconnects and clears its session token on API 401", async () => {
    await useWebOauth();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await send(
      request({
        type: "WORKSPACE_READER_CONNECT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    now.mockReturnValue(1_000_000 + 3_540_000);
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "google-oauth-expired",
    });
    expect(mocks.launchWebAuthFlow).toHaveBeenCalledOnce();

    now.mockReturnValue(2_000_000);
    await send(
      request({
        type: "WORKSPACE_READER_CONNECT",
        requestId: 3,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 4,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "google-auth-required",
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 5,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, connected: false });

    await send(
      request({
        type: "WORKSPACE_READER_CONNECT",
        requestId: 6,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCONNECT",
          requestId: 7,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, connected: false });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 8,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, connected: false });
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual({});
  });

  it("reports missing OAuth configuration without probing identity", async () => {
    vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "");
    Reflect.deleteProperty(browser, "identity");
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      configured: false,
      connected: false,
    });
  });

  it("restores a session token without the identity API (permission revoked or not yet loaded)", async () => {
    Reflect.deleteProperty(browser, "identity");
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, configured: true, connected: true });
  });

  it.each([
    ["malformed", "invalid"],
    ["legacy token version", { version: 1 }],
    ["wrong client", { clientId: "999-other.apps.googleusercontent.com" }],
    ["wrong extension", { extensionId: "other-extension" }],
    // A pre-launch token with the removed Docs/Drive scopes (ADR 0015).
    [
      "wrong scopes",
      {
        scopes: [
          "https://www.googleapis.com/auth/documents.readonly",
          ...GOOGLE_SCOPES,
          "https://www.googleapis.com/auth/drive.readonly",
        ],
      },
    ],
    ["wrong managed account", { managedAccountId: "user-2" }],
  ])("rejects and clears a %s session record", async (_, mutation) => {
    const current = (await browser.storage.session.get(WORKSPACE_TOKEN_KEY))[
      WORKSPACE_TOKEN_KEY
    ] as Record<string, unknown>;
    await browser.storage.session.set({
      [WORKSPACE_TOKEN_KEY]:
        typeof mutation === "string" ? mutation : { ...current, ...mutation },
    });

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "google-auth-required" });
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual({});
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
  });

  it("reads only fixed Sheets GETs and translates background-owned records once", async () => {
    const { grid, nextRequestId } = await discoverSheet();
    const loaded = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    expect(loaded).toMatchObject({
      type: "WORKSPACE_READER_LOAD",
      ok: true,
      generation: 1,
      title: "Sheet 1",
      cursor: { kind: "sheets", nextRow: 100 },
      page: {
        sheetId: "42",
        generation: grid.generation,
        startRow: 0,
        rowCount: 100,
      },
    });
    if (!loaded?.ok || loaded.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected load success");
    expect(loaded.records).toHaveLength(2);
    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://sheets.googleapis.com");
      expect(url.pathname).toMatch(
        /^\/v4\/spreadsheets\/sheet_123(?:\/values\/|$)/,
      );
      expect(init).toMatchObject({ method: "GET" });
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer google-access-token",
      );
    }
    const pageRequest = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((url) => url.searchParams.get("includeGridData") === "true");
    expect(pageRequest?.searchParams.get("ranges")).toBe("'Sheet 1'!A1:B100");

    const translated = await send(
      request({
        type: "WORKSPACE_READER_TRANSLATE",
        requestId: nextRequestId + 1,
        sourceTabId: SOURCE_TAB_ID,
        targetLanguage: "vi",
        records: [
          {
            id: loaded.records[0]!.id,
            sourceHash: loaded.records[0]!.sourceHash,
          },
        ],
      }),
    );
    expect(translated).toMatchObject({
      type: "WORKSPACE_READER_TRANSLATE",
      ok: true,
      generation: 1,
      results: [{ text: "Xin chào" }],
    });
    expect(mocks.translateText).toHaveBeenCalledOnce();
    expect(mocks.translateText).toHaveBeenCalledWith(["こんにちは"], "vi");
    expect(JSON.stringify(translated)).not.toContain("google-access-token");
  });

  it("discovers right to left, splits oversized rows and rejects a stale opaque cursor", async () => {
    const metadata = {
      ...sheetMetadata,
      sheets: [
        {
          properties: {
            ...sheetMetadata.sheets[0]!.properties,
            gridProperties: {
              ...sheetMetadata.sheets[0]!.properties.gridProperties,
              rowCount: 64,
              columnCount: 70,
            },
          },
        },
      ],
    };
    const gridMetadata = {
      ...metadata,
      sheets: [
        {
          ...metadata.sheets[0],
          merges: [],
          data: [
            {
              startColumn: 0,
              columnMetadata: [
                { pixelSize: 80 },
                { pixelSize: 90, hiddenByUser: true },
              ],
            },
          ],
        },
      ],
    };
    const ranges: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(init).toMatchObject({ method: "GET" });
      expect(init?.body).toBeUndefined();
      if (!url.pathname.includes("/values/"))
        return json(url.searchParams.has("ranges") ? gridMetadata : metadata);
      const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
      ranges.push(range);
      if (ranges.length === 1)
        return json({}, 200, {
          "content-length": String(2_097_153),
        });
      if (range === "'Sheet 1'!AM33:BR64") {
        const values = Array.from({ length: 32 }, () => [] as string[]);
        values[31] = ["far-right"];
        return json({ majorDimension: "COLUMNS", values });
      }
      if (range === "'Sheet 1'!A1:BR64") {
        const rows = Array.from({ length: 33 }, () => [] as string[]);
        rows[32] = Array<string>(70).fill("");
        rows[32]![69] = "far-right";
        return json({ majorDimension: "ROWS", values: rows });
      }
      return json({
        majorDimension:
          url.searchParams.get("majorDimension") === "ROWS"
            ? "ROWS"
            : "COLUMNS",
      });
    });

    const initial = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (
      !initial?.ok ||
      initial.type !== "WORKSPACE_READER_DISCOVER" ||
      initial.progress.status !== "scanning"
    )
      throw new Error("Expected discovery cursor");
    const cursor = initial.progress.cursor;
    expect(cursor.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: {
        status: "scanning",
        cursor,
        axis: "columns",
        scanned: 0,
      },
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 3,
          sourceTabId: SOURCE_TAB_ID,
          cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: { status: "scanning", axis: "rows", scanned: 0, cursor },
    });
    const complete = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 4,
        sourceTabId: SOURCE_TAB_ID,
        cursor,
      }),
    );
    expect(complete).toMatchObject({
      ok: true,
      progress: {
        status: "complete",
        grid: {
          lastUsedColumn: 69,
          columns: expect.arrayContaining([
            { index: 0, pixelSize: 80, hidden: false },
            { index: 1, pixelSize: 90, hidden: true },
            { index: 69, pixelSize: 100, hidden: false },
          ]),
        },
      },
    });
    expect(ranges).toEqual([
      "'Sheet 1'!AM1:BR64",
      "'Sheet 1'!AM1:BR32",
      "'Sheet 1'!AM33:BR64",
      "'Sheet 1'!A1:BR64",
    ]);
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 6,
          sourceTabId: SOURCE_TAB_ID,
          cursor,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(mocks.storageSet).not.toHaveBeenCalled();
    expect(mocks.storageSetMany).not.toHaveBeenCalled();
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("completes a small Sheet discovery in one authenticated message", async () => {
    const { grid, nextRequestId } = await discoverSheet();
    expect(nextRequestId).toBe(2);
    expect(grid.columns.map(({ index }) => index)).toEqual([0, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  describe("discovers A1:lastUsedCell bounds", () => {
    it("reuses complete column evidence and ignores empty layout tails", async () => {
      const metadata = {
        ...sheetMetadata,
        sheets: [
          {
            properties: {
              ...sheetMetadata.sheets[0]!.properties,
              gridProperties: {
                ...sheetMetadata.sheets[0]!.properties.gridProperties,
                rowCount: 300,
                columnCount: 6,
                frozenRowCount: 5,
                frozenColumnCount: 4,
              },
            },
          },
        ],
      };
      const gridMetadata = {
        ...metadata,
        sheets: [
          {
            ...metadata.sheets[0],
            merges: [
              {
                startRowIndex: 2,
                endRowIndex: 8,
                startColumnIndex: 1,
                endColumnIndex: 5,
              },
              {
                startRowIndex: 20,
                endRowIndex: 22,
                startColumnIndex: 0,
                endColumnIndex: 2,
              },
            ],
            data: [
              {
                startColumn: 0,
                columnMetadata: [
                  { pixelSize: 80 },
                  { pixelSize: 90, hiddenByUser: true },
                  { pixelSize: 200 },
                ],
              },
            ],
          },
        ],
      };
      const valueRanges: string[] = [];
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (!url.pathname.includes("/values/"))
          return json(url.searchParams.has("ranges") ? gridMetadata : metadata);
        valueRanges.push(
          decodeURIComponent(url.pathname.split("/values/")[1]!),
        );
        expect(url.searchParams.get("majorDimension")).toBe("COLUMNS");
        return json({
          majorDimension: "COLUMNS",
          values: [
            ["text", "", 0],
            [false, "", '=""'],
            ["", "", ""],
          ],
        });
      });

      const { grid } = await discoverSheet();

      expect(valueRanges).toEqual(["'Sheet 1'!A1:F300"]);
      expect(grid).toMatchObject({
        rowCount: 3,
        lastUsedColumn: 1,
        frozenRowCount: 3,
        frozenColumnCount: 2,
        columns: [
          { index: 0, pixelSize: 80, hidden: false },
          { index: 1, pixelSize: 90, hidden: true },
        ],
        merges: [{ startRow: 2, endRow: 3, startColumn: 1, endColumn: 2 }],
      });
      expect(mocks.storageSet).not.toHaveBeenCalled();
      expect(mocks.storageSetMany).not.toHaveBeenCalled();
      expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it("returns the ordered GRID catalog and binds Reader-only selection to its owner", async () => {
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/values/"))
          return json({
            majorDimension: "COLUMNS",
            values: [["選択"]],
          });
        if (url.searchParams.has("ranges")) {
          const range = url.searchParams.get("ranges") ?? "";
          return json(
            range.includes("Sheet 2")
              ? selectedSheetGridMetadata
              : sheetGridMetadata,
          );
        }
        return json(sheetMetadata);
      });
      const context = await send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      );
      expect(context).toMatchObject({ ok: true });
      const originalUrl = sourceUrl;

      await expect(
        send(
          request({
            type: "WORKSPACE_READER_SELECT_SHEET",
            requestId: 2,
            sourceTabId: SOURCE_TAB_ID,
            sheetId: "7",
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        context: { fileId: "sheet_123", activeId: "7" },
        sheets: [
          { sheetId: "42", title: "Sheet 1", index: 0 },
          { sheetId: "7", title: "Sheet 2", index: 2 },
        ],
      });
      expect(sourceUrl).toBe(originalUrl);

      const selected = await discoverSheet(3);
      expect(selected.grid).toMatchObject({ sheetId: "7", title: "Sheet 2" });
      expect(selected.sheets).toEqual([
        { sheetId: "42", title: "Sheet 1", index: 0 },
        { sheetId: "7", title: "Sheet 2", index: 2 },
      ]);

      for (const gid of ["7", "42"]) {
        sourceUrl = SHEETS_URL.replace("gid=42", `gid=${gid}`);
        await fakeBrowser.tabs.onUpdated.trigger(
          SOURCE_TAB_ID,
          { url: sourceUrl },
          { id: SOURCE_TAB_ID, url: sourceUrl } as never,
        );
      }
      currentVersion = undefined;
      const browserSelected = await discoverSheet(selected.nextRequestId);
      expect(browserSelected.grid).toMatchObject({
        sheetId: "7",
        title: "Sheet 2",
      });

      testReaderInstanceId = "reader-instance-2";
      currentVersion = undefined;
      const canonical = await discoverSheet(1);
      expect(canonical.grid).toMatchObject({ sheetId: "42", title: "Sheet 1" });
      expect(sourceUrl).toBe(originalUrl);
    });

    it("rejects foreign or forged worksheet selections without accepting file or range input", async () => {
      await send(
        request({
          type: "WORKSPACE_READER_CONTEXT",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        }),
      );
      for (const selection of [
        { sheetId: "404" },
        { sheetId: "7", fileId: "foreign" },
        { sheetId: "7", range: "A:Z" },
        { sheetId: "-1" },
      ]) {
        await expect(
          send(
            request({
              type: "WORKSPACE_READER_SELECT_SHEET",
              requestId: 2,
              sourceTabId: SOURCE_TAB_ID,
              ...selection,
            }),
          ),
        ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
        testReaderInstanceId = `${testReaderInstanceId}-next`;
        currentVersion = undefined;
      }
    });

    it("scans rows bottom-up when the terminal column range starts after A", async () => {
      const metadata = {
        ...sheetMetadata,
        sheets: [
          {
            properties: {
              ...sheetMetadata.sheets[0]!.properties,
              gridProperties: {
                ...sheetMetadata.sheets[0]!.properties.gridProperties,
                rowCount: 1000,
                columnCount: 64,
              },
            },
          },
        ],
      };
      const ranges: string[] = [];
      const dimensions: string[] = [];
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (!url.pathname.includes("/values/")) return json(metadata);
        const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
        ranges.push(range);
        dimensions.push(url.searchParams.get("majorDimension") ?? "");
        if (range === "'Sheet 1'!AG1:BL1000") {
          const columns = Array.from({ length: 9 }, () => [] as string[]);
          columns[8] = ["", "", "rightmost"];
          return json({ majorDimension: "COLUMNS", values: columns });
        }
        if (range === "'Sheet 1'!A1:AO300") {
          const row = Array<string>(41).fill("");
          row[40] = '=""';
          return json({ majorDimension: "ROWS", values: [[], [], row] });
        }
        return json({ majorDimension: "ROWS" });
      });

      const { grid } = await discoverSheet();

      expect(ranges).toEqual([
        "'Sheet 1'!AG1:BL1000",
        "'Sheet 1'!A901:AO1000",
        "'Sheet 1'!A701:AO900",
        "'Sheet 1'!A301:AO700",
        "'Sheet 1'!A1:AO300",
      ]);
      expect(dimensions).toEqual(["COLUMNS", "ROWS", "ROWS", "ROWS", "ROWS"]);
      expect(grid.rowCount).toBe(3);
      expect(grid.lastUsedColumn).toBe(40);
      expect(grid.columns.map(({ index }) => index)).toEqual(
        Array.from({ length: 41 }, (_, index) => index),
      );
      expect(mocks.storageSetMany).not.toHaveBeenCalled();
      expect(mocks.translateText).not.toHaveBeenCalled();
    });

    it("completes an empty allocated sheet without grid metadata or page reads", async () => {
      const metadata = {
        ...sheetMetadata,
        sheets: [
          {
            properties: {
              ...sheetMetadata.sheets[0]!.properties,
              gridProperties: {
                ...sheetMetadata.sheets[0]!.properties.gridProperties,
                rowCount: 300,
                columnCount: 40,
              },
            },
          },
        ],
      };
      const requests: URL[] = [];
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        if (url.pathname.includes("/values/"))
          return json({ majorDimension: "COLUMNS" });
        return json(metadata);
      });

      const { grid } = await discoverSheet();

      expect(grid).toMatchObject({ lastUsedColumn: -1, columns: [] });
      expect(
        requests.filter(
          (url) =>
            url.searchParams.has("ranges") ||
            url.searchParams.get("includeGridData") === "true",
        ),
      ).toEqual([]);
      expect(mocks.translateText).not.toHaveBeenCalled();
    });
  });

  describe("resumes row discovery and stops paging at the used row boundary", () => {
    const metadataFor = (rowCount: number) => {
      const metadata = structuredClone(sheetMetadata);
      metadata.sheets[0]!.properties.gridProperties.rowCount = rowCount;
      metadata.sheets[0]!.properties.gridProperties.columnCount = 40;
      return metadata;
    };
    const gridMetadataFor = (rowCount: number) => {
      const metadata = metadataFor(rowCount);
      return {
        ...metadata,
        sheets: [{ ...metadata.sheets[0], merges: [], data: [] }],
      };
    };

    it("splits oversized and timed-out row ranges lower-first, then by columns", async () => {
      const metadata = metadataFor(4);
      const gridMetadata = gridMetadataFor(4);
      const ranges: string[] = [];
      let activeRequests = 0;
      let maximumActiveRequests = 0;
      fetchMock.mockImplementation(async (input) => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        try {
          const url = new URL(String(input));
          if (!url.pathname.includes("/values/"))
            return json(
              url.searchParams.has("ranges") ? gridMetadata : metadata,
            );
          const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
          ranges.push(range);
          if (range === "'Sheet 1'!I1:AN4")
            return json({ majorDimension: "COLUMNS", values: [["right"]] });
          if (range === "'Sheet 1'!A1:I4" || range === "'Sheet 1'!A4:I4")
            return json({}, 200, { "content-length": "2097153" });
          if (range === "'Sheet 1'!A3:I4")
            throw new DOMException("Timed out", "AbortError");
          if (range === "'Sheet 1'!A3:I3")
            return json({ majorDimension: "ROWS", values: [["used"]] });
          return json({ majorDimension: "ROWS" });
        } finally {
          activeRequests -= 1;
        }
      });

      const { grid } = await discoverSheet();

      expect(ranges).toEqual([
        "'Sheet 1'!I1:AN4",
        "'Sheet 1'!A1:I4",
        "'Sheet 1'!A3:I4",
        "'Sheet 1'!A4:I4",
        "'Sheet 1'!A4:D4",
        "'Sheet 1'!E4:I4",
        "'Sheet 1'!A3:I3",
      ]);
      expect(maximumActiveRequests).toBe(1);
      expect(grid).toMatchObject({ rowCount: 3, lastUsedColumn: 8 });
    });

    it.each([429, 503])(
      "keeps the row cursor and resumes the failed rectangle after HTTP %s",
      async (status) => {
        const metadata = metadataFor(4);
        const gridMetadata = gridMetadataFor(4);
        const rowRanges: string[] = [];
        let upperAttempts = 0;
        fetchMock.mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (!url.pathname.includes("/values/"))
            return json(
              url.searchParams.has("ranges") ? gridMetadata : metadata,
            );
          const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
          if (range === "'Sheet 1'!I1:AN4")
            return json({ majorDimension: "COLUMNS", values: [["right"]] });
          rowRanges.push(range);
          if (range === "'Sheet 1'!A1:I4")
            return json({}, 200, { "content-length": "2097153" });
          if (range === "'Sheet 1'!A3:I4")
            return json({ majorDimension: "ROWS" });
          upperAttempts += 1;
          if (upperAttempts === 1) return json({}, status);
          return json({ majorDimension: "ROWS", values: [[], ["used"]] });
        });

        const initial = await send(
          request({
            type: "WORKSPACE_READER_DISCOVER",
            requestId: 1,
            sourceTabId: SOURCE_TAB_ID,
            cursor: null,
          }),
        );
        if (
          !initial?.ok ||
          initial.type !== "WORKSPACE_READER_DISCOVER" ||
          initial.progress.status !== "scanning"
        )
          throw new Error("Expected row discovery cursor");
        const cursor = initial.progress.cursor;
        await send(
          request({
            type: "WORKSPACE_READER_DISCOVER",
            requestId: 2,
            sourceTabId: SOURCE_TAB_ID,
            cursor,
          }),
        );
        await send(
          request({
            type: "WORKSPACE_READER_DISCOVER",
            requestId: 3,
            sourceTabId: SOURCE_TAB_ID,
            cursor,
          }),
        );
        const paused = await send(
          request({
            type: "WORKSPACE_READER_DISCOVER",
            requestId: 4,
            sourceTabId: SOURCE_TAB_ID,
            cursor,
          }),
        );
        expect(paused).toMatchObject({
          ok: false,
          error: status === 429 ? "rate-limited" : "temporarily-unavailable",
          discoveryCursor: cursor,
        });
        const resumed = await send(
          request({
            type: "WORKSPACE_READER_DISCOVER",
            requestId: 5,
            sourceTabId: SOURCE_TAB_ID,
            cursor,
          }),
        );
        expect(resumed).toMatchObject({
          ok: true,
          progress: { status: "complete", grid: { rowCount: 2 } },
        });
        expect(rowRanges).toEqual([
          "'Sheet 1'!A1:I4",
          "'Sheet 1'!A3:I4",
          "'Sheet 1'!A1:I2",
          "'Sheet 1'!A1:I2",
        ]);
        await expect(
          send(
            request({
              type: "WORKSPACE_READER_DISCOVER",
              requestId: 5,
              sourceTabId: SOURCE_TAB_ID,
              cursor,
            }),
          ),
        ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
        await expect(
          send(
            request({
              type: "WORKSPACE_READER_DISCOVER",
              requestId: 6,
              sourceTabId: SOURCE_TAB_ID,
              cursor,
            }),
          ),
        ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
      },
    );

    it("loads an empty sheet without a Google page request", async () => {
      const metadata = metadataFor(300);
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/values/"))
          return json({ majorDimension: "COLUMNS" });
        if (
          url.searchParams.has("ranges") ||
          url.searchParams.get("includeGridData") === "true"
        )
          throw new Error(`Unexpected empty-Sheet page request: ${url}`);
        return json(metadata);
      });
      const discovered = await discoverSheet();
      const loaded = await send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      );
      expect(loaded).toMatchObject({ ok: true, records: [], cursor: null });
    });

    it.each([1, 3, 99, 100, 101])(
      "bounds final pages and cursors for %s used rows",
      async (usedRows) => {
        const metadata = metadataFor(usedRows);
        const gridMetadata = gridMetadataFor(usedRows);
        const pageRanges: string[] = [];
        fetchMock.mockImplementation(async (input) => {
          const url = new URL(String(input));
          if (url.pathname.includes("/values/")) {
            const majorDimension = url.searchParams.get("majorDimension");
            if (majorDimension === "COLUMNS") {
              const column = Array<string>(usedRows).fill("");
              column[usedRows - 1] = "used";
              return json({ majorDimension, values: [column] });
            }
            const rowCount = Math.min(100, usedRows);
            const rows = Array.from({ length: rowCount }, () => [] as string[]);
            rows[rowCount - 1] = ["used"];
            return json({ majorDimension, values: rows });
          }
          if (url.searchParams.get("includeGridData") === "true") {
            pageRanges.push(url.searchParams.get("ranges")!);
            return json({
              ...metadata,
              sheets: [{ ...metadata.sheets[0], data: [] }],
            });
          }
          return json(url.searchParams.has("ranges") ? gridMetadata : metadata);
        });

        const discovered = await discoverSheet();
        const first = await send(
          request({
            type: "WORKSPACE_READER_LOAD",
            requestId: discovered.nextRequestId,
            sourceTabId: SOURCE_TAB_ID,
            cursor: null,
          }),
        );
        expect(first).toMatchObject({
          ok: true,
          page: {
            startRow: 0,
            rowCount: Math.min(100, usedRows),
            cursor: usedRows === 101 ? { kind: "sheets", nextRow: 100 } : null,
          },
        });
        let requestId = discovered.nextRequestId + 1;
        if (
          first?.ok &&
          first.type === "WORKSPACE_READER_LOAD" &&
          first.cursor
        ) {
          const last = await send(
            request({
              type: "WORKSPACE_READER_LOAD",
              requestId: requestId++,
              sourceTabId: SOURCE_TAB_ID,
              cursor: first.cursor,
            }),
          );
          expect(last).toMatchObject({
            ok: true,
            page: { startRow: 100, rowCount: 1, cursor: null },
          });
        }
        const pageFetchCount = pageRanges.length;
        await expect(
          send(
            request({
              type: "WORKSPACE_READER_LOAD",
              requestId,
              sourceTabId: SOURCE_TAB_ID,
              cursor: {
                kind: "sheets",
                nextRow: usedRows <= 100 ? 100 : 200,
              },
            }),
          ),
        ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
        expect(pageRanges).toHaveLength(pageFetchCount);
        expect(pageRanges).toEqual(
          usedRows === 101
            ? ["'Sheet 1'!A1:I100", "'Sheet 1'!A101:I101"]
            : [`'Sheet 1'!A1:I${usedRows}`],
        );
      },
    );
  });

  it.each([false, true])(
    "bounds empty-range growth on a wide Sheet and retains late-row data: %s",
    async (hasData) => {
      const metadata = {
        ...sheetMetadata,
        sheets: [
          {
            properties: {
              ...sheetMetadata.sheets[0]!.properties,
              gridProperties: {
                ...sheetMetadata.sheets[0]!.properties.gridProperties,
                rowCount: 1024,
                columnCount: 2048,
              },
            },
            merges: [],
          },
        ],
      };
      const ranges: string[] = [];
      fetchMock.mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (!url.pathname.includes("/values/")) return json(metadata);
        const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
        ranges.push(range);
        const values =
          hasData && range === "'Sheet 1'!A1:AF1024"
            ? [
                ["A"],
                [],
                ["C"],
                [],
                [],
                [...Array<string>(1023).fill(""), "F1024"],
              ]
            : [];
        return json({ majorDimension: "COLUMNS", values });
      });

      const { grid } = await discoverSheet();
      expect(ranges).toEqual([
        "'Sheet 1'!BYO1:BZT1024",
        "'Sheet 1'!BWC1:BYN1024",
        "'Sheet 1'!BRE1:BWB1024",
        "'Sheet 1'!BHI1:BRD1024",
        "'Sheet 1'!ANQ1:BHH1024",
        "'Sheet 1'!TY1:ANP1024",
        "'Sheet 1'!AG1:TX1024",
        "'Sheet 1'!A1:AF1024",
      ]);
      expect(grid.lastUsedColumn).toBe(hasData ? 5 : -1);
      expect(grid.columns.map(({ index }) => index)).toEqual(
        hasData ? [0, 1, 2, 3, 4, 5] : [],
      );
      expect(mocks.translateText).not.toHaveBeenCalled();
      expect(mocks.storageSetMany).not.toHaveBeenCalled();
    },
  );

  it("resets empty-chunk growth after splitting an oversized response", async () => {
    const metadata = {
      ...sheetMetadata,
      sheets: [
        {
          properties: {
            ...sheetMetadata.sheets[0]!.properties,
            gridProperties: {
              ...sheetMetadata.sheets[0]!.properties.gridProperties,
              rowCount: 64,
              columnCount: 256,
            },
          },
        },
      ],
    };
    const ranges: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.includes("/values/")) return json(metadata);
      const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
      ranges.push(range);
      if (ranges.length === 2)
        return json({}, 200, { "content-length": "2097153" });
      return json({ majorDimension: "COLUMNS" });
    });
    const { grid } = await discoverSheet();
    expect(grid.columns).toEqual([]);
    const columns = (label: string) =>
      [...label].reduce(
        (index, letter) => index * 26 + letter.charCodeAt(0) - 64,
        0,
      );
    expect(
      ranges.map((range) => {
        const [, start, startRow, end, endRow] =
          /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)!;
        return [
          columns(end!) - columns(start!) + 1,
          Number(startRow),
          Number(endRow),
        ];
      }),
    ).toEqual([
      [32, 1, 64],
      [64, 1, 64],
      [64, 1, 32],
      [64, 33, 64],
      [32, 1, 64],
      [64, 1, 64],
      [64, 1, 64],
    ]);
  });

  it("keeps the exact discovery cursor and range after a temporary Google failure", async () => {
    const metadata = structuredClone(sheetMetadata);
    metadata.sheets[0]!.properties.gridProperties.columnCount = 40;
    const gridMetadata = {
      ...metadata,
      sheets: [{ ...metadata.sheets[0], merges: [], data: [] }],
    };
    const ranges: string[] = [];
    let failedRangeAttempts = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.includes("/values/"))
        return json(url.searchParams.has("ranges") ? gridMetadata : metadata);
      const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
      ranges.push(range);
      if (range === "'Sheet 1'!I1:AN150")
        return json({}, 200, { "content-length": "2097153" });
      if (range === "'Sheet 1'!I1:AN75" && failedRangeAttempts++ === 0)
        return json({}, 503);
      if (range === "'Sheet 1'!I76:AN150")
        return json({ majorDimension: "COLUMNS", values: [["right"]] });
      if (range === "'Sheet 1'!A51:I150") {
        const rows = Array.from({ length: 100 }, () => [] as string[]);
        rows[99] = ["used"];
        return json({ majorDimension: "ROWS", values: rows });
      }
      return json({ majorDimension: "COLUMNS" });
    });
    const initial = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (
      !initial?.ok ||
      initial.type !== "WORKSPACE_READER_DISCOVER" ||
      initial.progress.status !== "scanning"
    )
      throw new Error("Expected discovery cursor");
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          cursor: initial.progress.cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "temporarily-unavailable",
    });
    const failedRange = String(fetchMock.mock.calls.at(-1)![0]);
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 3,
          sourceTabId: SOURCE_TAB_ID,
          cursor: initial.progress.cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: { status: "scanning", cursor: initial.progress.cursor },
    });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(failedRange);
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 4,
          sourceTabId: SOURCE_TAB_ID,
          cursor: initial.progress.cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: {
        status: "scanning",
        axis: "rows",
        cursor: initial.progress.cursor,
      },
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 5,
          sourceTabId: SOURCE_TAB_ID,
          cursor: initial.progress.cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: { status: "complete", grid: { rowCount: 150 } },
    });
    expect(ranges).toEqual([
      "'Sheet 1'!I1:AN150",
      "'Sheet 1'!I1:AN75",
      "'Sheet 1'!I1:AN75",
      "'Sheet 1'!I76:AN150",
      "'Sheet 1'!A51:I150",
    ]);
  });

  it("pauses an aborted discovery without subdividing its range", async () => {
    fetchMock.mockResolvedValueOnce(json(sheetMetadata));
    fetchMock.mockRejectedValueOnce(
      new DOMException("Timed out", "AbortError"),
    );
    const paused = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    expect(paused).toMatchObject({
      ok: false,
      error: "temporarily-unavailable",
    });
    if (
      !paused ||
      paused.ok ||
      paused.type !== "WORKSPACE_READER_DISCOVER" ||
      !paused.discoveryCursor
    )
      throw new Error("Expected resumable discovery timeout");
    const failedCall = fetchMock.mock.calls.length - 1;
    const failedRange = String(fetchMock.mock.calls[failedCall]![0]);

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          cursor: paused.discoveryCursor,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, progress: { status: "complete" } });
    expect(String(fetchMock.mock.calls[failedCall + 1]![0])).toBe(failedRange);
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/values/"),
      ),
    ).toHaveLength(2);
  });

  it("returns an aborted page read without requesting child ranges", async () => {
    const discovered = await discoverSheet();
    const before = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce(json(sheetMetadata));
    fetchMock.mockRejectedValueOnce(
      new DOMException("Timed out", "AbortError"),
    );

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "temporarily-unavailable",
    });

    const pageRanges = fetchMock.mock.calls
      .slice(before)
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.searchParams.get("includeGridData") === "true")
      .map((url) => url.searchParams.get("ranges"));
    expect(pageRanges).toEqual(["'Sheet 1'!A1:B100"]);
  });

  it.each([429, 503])(
    "preserves initial discovery progress when final metadata returns %s",
    async (status) => {
      fetchMock.mockResolvedValueOnce(json(sheetMetadata));
      fetchMock.mockResolvedValueOnce(json(sheetValues));
      fetchMock.mockResolvedValueOnce(json({}, status));
      const paused = await send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      );
      expect(paused).toMatchObject({
        ok: false,
        error: status === 429 ? "rate-limited" : "temporarily-unavailable",
      });
      if (
        !paused ||
        paused.ok ||
        paused.type !== "WORKSPACE_READER_DISCOVER" ||
        !paused.discoveryCursor
      )
        throw new Error("Expected resumable error");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await expect(
        send(
          request({
            type: "WORKSPACE_READER_DISCOVER",
            requestId: 2,
            sourceTabId: SOURCE_TAB_ID,
            cursor: paused.discoveryCursor,
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        progress: { status: "complete", grid: { lastUsedColumn: 1 } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(
        new URL(String(fetchMock.mock.calls.at(-1)![0])).searchParams.get(
          "ranges",
        ),
      ).toBe("'Sheet 1'!A:B");
      await discoverSheet(3);
      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/values/"),
        ),
      ).toHaveLength(2);
    },
  );

  it("does not expose an initial resume cursor after the source tab changes during failure", async () => {
    fetchMock.mockResolvedValueOnce(json(sheetMetadata));
    fetchMock.mockResolvedValueOnce(json(sheetValues));
    fetchMock.mockImplementationOnce(async () => {
      sourceUrl = SHEETS_URL.replace("sheet_123", "sheet_other");
      return json({}, 503);
    });
    const response = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    expect(response).toMatchObject({ ok: false, error: "source-tab-changed" });
    expect(response).not.toHaveProperty("discoveryCursor");
  });

  it("resumes final metadata after a temporary failure without rereading confirmed values", async () => {
    const metadata = structuredClone(sheetMetadata);
    metadata.sheets[0]!.properties.gridProperties.columnCount = 40;
    const ranges: string[] = [];
    let gridAttempts = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/values/")) {
        const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
        ranges.push(range);
        return json({
          majorDimension: "COLUMNS",
          values: range === "'Sheet 1'!A1:H150" ? [["A"], [], ["C"]] : [],
        });
      }
      if (url.searchParams.has("ranges") && ++gridAttempts === 1)
        return json({}, 503);
      return json(metadata);
    });
    const initial = await send(
      request({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (
      !initial?.ok ||
      initial.type !== "WORKSPACE_READER_DISCOVER" ||
      initial.progress.status !== "scanning"
    )
      throw new Error("Expected discovery cursor");
    const cursor = initial.progress.cursor;
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 2,
          sourceTabId: SOURCE_TAB_ID,
          cursor,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "temporarily-unavailable" });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 3,
          sourceTabId: SOURCE_TAB_ID,
          cursor,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: { status: "complete", grid: { lastUsedColumn: 2 } },
    });
    expect(ranges).toEqual(["'Sheet 1'!I1:AN150", "'Sheet 1'!A1:H150"]);
    expect(gridAttempts).toBe(2);
  });

  it("completes an empty Sheet without inventing column A", async () => {
    const emptyMetadata = {
      ...sheetMetadata,
      sheets: [
        {
          properties: {
            ...sheetMetadata.sheets[0]!.properties,
            gridProperties: {
              ...sheetMetadata.sheets[0]!.properties.gridProperties,
              columnCount: 40,
            },
          },
        },
      ],
    };
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/values/"))
        return json({ majorDimension: "COLUMNS" });
      if (
        url.searchParams.has("ranges") ||
        url.searchParams.get("includeGridData") === "true"
      )
        throw new Error(`Unexpected empty-Sheet grid request: ${url}`);
      return json(emptyMetadata);
    });

    const discovered = await discoverSheet();
    expect(discovered.grid).toMatchObject({
      lastUsedColumn: -1,
      columns: [],
      merges: [],
      frozenColumnCount: 0,
    });
    const loaded = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: discovered.nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    expect(loaded).toMatchObject({
      ok: true,
      records: [],
      cursor: null,
      page: { startRow: 0, rows: [], cursor: null },
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => {
        const url = new URL(String(input));
        return (
          !url.pathname.includes("/values/") &&
          (url.searchParams.has("ranges") ||
            url.searchParams.get("includeGridData") === "true")
        );
      }),
    ).toHaveLength(0);
  });

  it("splits an oversized page and commits it once after every rectangle validates", async () => {
    const { nextRequestId } = await discoverSheet();
    const firstPageResponse = deferred<Response>();
    const pageRanges: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("includeGridData") !== "true")
        return json(sheetMetadata);
      const range = url.searchParams.get("ranges")!;
      pageRanges.push(range);
      if (pageRanges.length === 1) return firstPageResponse.promise;
      if (range === "'Sheet 1'!A1:B50") return json(sheetPage);
      return json({
        ...sheetPage,
        sheets: [
          {
            ...sheetPage.sheets[0],
            data: [{ startRow: 50, startColumn: 0, rowData: [] }],
          },
        ],
      });
    });
    const loading = send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    await vi.waitFor(() => expect(pageRanges).toHaveLength(1));
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: nextRequestId + 1,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    firstPageResponse.resolve(
      json({}, 200, { "content-length": String(2_097_153) }),
    );
    await expect(loading).resolves.toMatchObject({
      ok: true,
      page: { startRow: 0, rowCount: 100 },
      records: [{ anchor: "A1" }, { anchor: "B1" }],
    });
    expect(pageRanges).toEqual([
      "'Sheet 1'!A1:B100",
      "'Sheet 1'!A1:B50",
      "'Sheet 1'!A51:B100",
    ]);
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: nextRequestId + 2,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
  });

  it("reloads aligned evicted pages without rewinding the forward cursor", async () => {
    const largeText = "x".repeat(MAX_TRANSLATION_RECORD_CHARACTERS);
    const metadata = {
      ...sheetMetadata,
      sheets: [
        {
          properties: {
            ...sheetMetadata.sheets[0]!.properties,
            gridProperties: {
              ...sheetMetadata.sheets[0]!.properties.gridProperties,
              rowCount: 400,
              columnCount: 40,
            },
          },
        },
      ],
    };
    const gridMetadata = {
      ...metadata,
      sheets: [{ ...metadata.sheets[0], merges: [] }],
    };
    const page = (startRow: number) => ({
      ...sheetPage,
      sheets: [
        {
          properties: metadata.sheets[0]!.properties,
          data: [
            {
              startRow,
              startColumn: 0,
              rowData: [
                {
                  values: Array.from({ length: 40 }, () => ({
                    userEnteredValue: { stringValue: largeText },
                    effectiveValue: { stringValue: largeText },
                    formattedValue: largeText,
                  })),
                },
              ],
            },
          ],
        },
      ],
    });
    const reloadZero = deferred<Response>();
    const reloadHundred = deferred<Response>();
    let pageZeroRequests = 0;
    let pageHundredRequests = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/values/")) {
        const majorDimension = url.searchParams.get("majorDimension");
        return json(
          majorDimension === "ROWS"
            ? {
                majorDimension,
                values: [...Array.from({ length: 99 }, () => []), ["used"]],
              }
            : {
                majorDimension: "COLUMNS",
                values: Array.from({ length: 32 }, () => ["used"]),
              },
        );
      }
      if (url.searchParams.get("includeGridData") !== "true")
        return json(url.searchParams.has("ranges") ? gridMetadata : metadata);
      const range = url.searchParams.get("ranges");
      if (range === "'Sheet 1'!A1:AN100") {
        pageZeroRequests += 1;
        return pageZeroRequests === 1 ? json(page(0)) : reloadZero.promise;
      }
      if (range === "'Sheet 1'!A101:AN200") {
        pageHundredRequests += 1;
        return pageHundredRequests === 1
          ? json(page(100))
          : reloadHundred.promise;
      }
      if (range === "'Sheet 1'!A201:AN300") return json(page(200));
      if (range === "'Sheet 1'!A301:AN400") return json(page(300));
      throw new Error(`Unexpected range: ${range}`);
    });

    const discovered = await discoverSheet();
    const first = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: discovered.nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (!first?.ok || first.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected page zero");
    const second = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: discovered.nextRequestId + 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: first.cursor,
      }),
    );
    if (!second?.ok || second.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected page 100");
    const third = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: discovered.nextRequestId + 2,
        sourceTabId: SOURCE_TAB_ID,
        cursor: second.cursor,
      }),
    );
    expect(third).toMatchObject({ ok: true, page: { startRow: 200 } });

    const pageFetches = fetchMock.mock.calls.length;
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 3,
          sourceTabId: SOURCE_TAB_ID,
          cursor: { kind: "sheets", nextRow: 150 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 4,
          sourceTabId: SOURCE_TAB_ID,
          cursor: { kind: "sheets", nextRow: 400 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(fetchMock.mock.calls).toHaveLength(pageFetches);

    const reloadingHundred = send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: discovered.nextRequestId + 5,
        sourceTabId: SOURCE_TAB_ID,
        cursor: { kind: "sheets", nextRow: 100 },
      }),
    );
    await vi.waitFor(() => expect(pageHundredRequests).toBe(2));
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 6,
          sourceTabId: SOURCE_TAB_ID,
          cursor: { kind: "sheets", nextRow: 100 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    reloadHundred.resolve(json(page(100)));
    await expect(reloadingHundred).resolves.toMatchObject({
      ok: true,
      page: { startRow: 100 },
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 7,
          sourceTabId: SOURCE_TAB_ID,
          cursor: { kind: "sheets", nextRow: 100 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(pageHundredRequests).toBe(2);

    const reloadingZero = send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: discovered.nextRequestId + 8,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    await vi.waitFor(() => expect(pageZeroRequests).toBe(2));
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 9,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    reloadZero.resolve(json(page(0)));
    await expect(reloadingZero).resolves.toMatchObject({
      ok: true,
      page: { startRow: 0 },
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 10,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(pageZeroRequests).toBe(2);

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 11,
          sourceTabId: SOURCE_TAB_ID,
          cursor:
            third?.ok && third.type === "WORKSPACE_READER_LOAD"
              ? third.cursor
              : null,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, page: { startRow: 300 } });

    sourceUrl = "https://docs.google.com/spreadsheets/d/sheet_other/edit";
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: discovered.nextRequestId + 12,
          sourceTabId: SOURCE_TAB_ID,
          cursor: { kind: "sheets", nextRow: 100 },
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "source-tab-changed" });
  });

  it("keeps Reader A loaded state while Reader B selects and refreshes another worksheet", async () => {
    const first = await discoverSheet();
    const loaded = await send({
      type: "WORKSPACE_READER_LOAD",
      requestId: first.nextRequestId,
      sourceTabId: SOURCE_TAB_ID,
      cursor: null,
    });
    expect(loaded).toMatchObject({ ok: true, context: { activeId: "42" } });
    if (!loaded?.ok || loaded.type !== "WORKSPACE_READER_LOAD")
      throw new Error("expected loaded sheet");
    const record = loaded.records.find((record) => record.translatable)!;
    testReaderInstanceId = "reader-instance-2";
    await expect(
      send({
        type: "WORKSPACE_READER_SELECT_SHEET",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        sheetId: "7",
      }),
    ).resolves.toMatchObject({ ok: true });
    const second = await discoverSheet(2);
    expect(second.grid.sheetId).toBe("7");
    testReaderInstanceId = "reader-instance-1";
    await expect(
      send({
        type: "WORKSPACE_READER_TRANSLATE",
        requestId: first.nextRequestId + 1,
        sourceTabId: SOURCE_TAB_ID,
        targetLanguage: "vi",
        records: [{ id: record.id, sourceHash: record.sourceHash }],
      }),
    ).resolves.toMatchObject({
      ok: true,
      generation: loaded.generation,
      results: [{ id: record.id, text: "Xin chào" }],
    });
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.searchParams.get("includeGridData") === "true" &&
        url.searchParams.get("ranges")?.includes("A101")
      )
        return json({
          ...sheetPage,
          sheets: [
            {
              ...sheetPage.sheets[0],
              data: [
                {
                  startRow: 100,
                  startColumn: 0,
                  rowData: [
                    {
                      values: [
                        {
                          userEnteredValue: { stringValue: "next page" },
                          effectiveValue: { stringValue: "next page" },
                          formattedValue: "next page",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        });
      return defaultFetch(input, init);
    });
    await expect(
      send({
        type: "WORKSPACE_READER_LOAD",
        requestId: first.nextRequestId + 2,
        sourceTabId: SOURCE_TAB_ID,
        cursor: { kind: "sheets", nextRow: 100 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      context: { activeId: "42" },
      generation: loaded.generation,
    });
  });

  it("rejects another Reader's discovery cursor without retiring the original discovery", async () => {
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (
        url.hostname === "sheets.googleapis.com" &&
        !url.pathname.includes("/values/") &&
        !url.searchParams.has("ranges")
      )
        return json({
          ...sheetMetadata,
          sheets: [
            {
              ...sheetMetadata.sheets[0],
              properties: {
                ...sheetMetadata.sheets[0]!.properties,
                gridProperties: {
                  ...sheetMetadata.sheets[0]!.properties.gridProperties,
                  columnCount: 100,
                },
              },
            },
          ],
        });
      if (url.pathname.includes("/values/"))
        return json({ majorDimension: "COLUMNS", values: [] });
      return defaultFetch(input, init);
    });
    const first = await send({
      type: "WORKSPACE_READER_DISCOVER",
      requestId: 1,
      sourceTabId: SOURCE_TAB_ID,
      cursor: null,
    });
    if (
      !first?.ok ||
      first.type !== "WORKSPACE_READER_DISCOVER" ||
      first.progress.status === "complete"
    )
      throw new Error("expected scanning cursor");
    testReaderInstanceId = "reader-instance-2";
    await expect(
      send({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: first.progress.cursor,
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    testReaderInstanceId = "reader-instance-1";
    await expect(
      send({
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 2,
        sourceTabId: SOURCE_TAB_ID,
        cursor: first.progress.cursor,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects temporarily unsupported Docs bootstrap and content operations without Google requests", async () => {
    sourceUrl = DOCS_URL;
    expect(
      await send({
        type: "WORKSPACE_READER_CONTEXT",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      }),
    ).toMatchObject({ ok: false, error: "unsupported-url" });
    for (const [index, type] of [
      "WORKSPACE_READER_CONNECT",
      "WORKSPACE_READER_LOAD",
      "WORKSPACE_READER_DISCOVER",
    ].entries()) {
      const response = await send({
        type,
        requestId: index + 2,
        sourceTabId: SOURCE_TAB_ID,
        version: { backgroundEpoch: "unsupported-docs", sourceRevision: 0 },
        ...(type === "WORKSPACE_READER_CONNECT" ? {} : { cursor: null }),
      });
      expect(response).toMatchObject({ ok: false, error: "unsupported-url" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.launchWebAuthFlow).not.toHaveBeenCalled();
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("paginates a resolved Sheet when the editor URL has no gid", async () => {
    sourceUrl = "https://docs.google.com/spreadsheets/d/sheet_123/edit";
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/values/")) return json(sheetValues);
      if (url.searchParams.get("includeGridData") !== "true")
        return json(
          url.searchParams.has("ranges") ? sheetGridMetadata : sheetMetadata,
        );
      if (url.searchParams.get("ranges") === "'Sheet 1'!A101:B150") {
        return json({
          ...sheetPage,
          sheets: [
            {
              ...sheetPage.sheets[0],
              data: [
                {
                  startRow: 100,
                  startColumn: 0,
                  rowData: [
                    {
                      values: [
                        {
                          userEnteredValue: { stringValue: "次のページ" },
                          effectiveValue: { stringValue: "次のページ" },
                          formattedValue: "次のページ",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      return json(sheetPage);
    });
    const { nextRequestId } = await discoverSheet();
    const first = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (!first?.ok || first.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected first page");
    const second = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId + 1,
        sourceTabId: SOURCE_TAB_ID,
        cursor: first.cursor,
      }),
    );
    expect(second).toMatchObject({
      ok: true,
      generation: first.generation,
      records: [{ anchor: "A101", source: "次のページ" }],
      cursor: null,
    });
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_TRANSLATE",
          requestId: nextRequestId + 2,
          sourceTabId: SOURCE_TAB_ID,
          targetLanguage: "vi",
          records: [
            {
              id: first.records[0]!.id,
              sourceHash: first.records[0]!.sourceHash,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects pagination when the current file changes", async () => {
    const { nextRequestId } = await discoverSheet();
    const first = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (!first?.ok || first.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected first page");
    const fetchCount = fetchMock.mock.calls.length;
    sourceUrl = "https://docs.google.com/spreadsheets/d/sheet_other/edit";

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: nextRequestId + 1,
          sourceTabId: SOURCE_TAB_ID,
          cursor: first.cursor,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "source-tab-changed" });

    const paginationFetches = fetchMock.mock.calls
      .slice(fetchCount)
      .map(([input]) => new URL(String(input)));
    expect(paginationFetches).toHaveLength(0);
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("rejects a single logical page over the source-character bound", async () => {
    const formulaDisplay = "x".repeat(MAX_TRANSLATION_RECORD_CHARACTERS);
    const formulaCell = {
      userEnteredValue: { formulaValue: "=A1" },
      effectiveValue: { stringValue: formulaDisplay },
      formattedValue: formulaDisplay,
    };
    const pageCells = Array.from(
      {
        length:
          MAX_LOADED_SOURCE_CHARACTERS / MAX_TRANSLATION_RECORD_CHARACTERS + 1,
      },
      () => formulaCell,
    );
    const wideMetadata = {
      ...sheetMetadata,
      sheets: [
        {
          properties: {
            ...sheetMetadata.sheets[0]!.properties,
            gridProperties: {
              ...sheetMetadata.sheets[0]!.properties.gridProperties,
              columnCount: pageCells.length,
            },
          },
        },
      ],
    };
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/values/")) {
        const majorDimension = url.searchParams.get("majorDimension");
        const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
        return json(
          majorDimension === "ROWS"
            ? {
                majorDimension,
                values: range.startsWith("'Sheet 1'!A1:") ? [["=A1"]] : [],
              }
            : {
                majorDimension: "COLUMNS",
                values: Array.from({ length: 32 }, () => ["=A1"]),
              },
        );
      }
      if (url.searchParams.get("includeGridData") !== "true")
        return json(
          url.searchParams.has("ranges")
            ? {
                ...wideMetadata,
                sheets: [{ ...wideMetadata.sheets[0], merges: [] }],
              }
            : wideMetadata,
        );
      return json({
        ...sheetPage,
        sheets: [
          {
            ...sheetPage.sheets[0],
            data: [
              {
                startRow: 0,
                startColumn: 0,
                rowData: [
                  {
                    values: pageCells,
                  },
                ],
              },
            ],
          },
        ],
      });
    });
    const { nextRequestId } = await discoverSheet();
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_LOAD",
          requestId: nextRequestId,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "content-too-large" });
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("rejects forged records and Office/API failures before provider dispatch", async () => {
    const { nextRequestId } = await discoverSheet();
    const loaded = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (!loaded?.ok || loaded.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected load success");

    await expect(
      send(
        request({
          type: "WORKSPACE_READER_TRANSLATE",
          requestId: nextRequestId + 1,
          sourceTabId: SOURCE_TAB_ID,
          targetLanguage: "en",
          records: [{ id: loaded.records[0]!.id, sourceHash: "0".repeat(40) }],
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    await expect(
      send({
        type: "WORKSPACE_READER_TRANSLATE",
        requestId: nextRequestId + 2,
        sourceTabId: SOURCE_TAB_ID,
        targetLanguage: "en",
        records: Array.from({ length: 129 }, (_, index) => ({
          id: `forged-${index}`,
          sourceHash: "0".repeat(40),
        })),
      }),
    ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    expect(mocks.translateText).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(json({}, 400));
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: nextRequestId + 3,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "unsupported-file-type" });
    expect(mocks.translateText).not.toHaveBeenCalled();
  });

  it("evicts a 401 token and enforces the streaming response ceiling", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "google-auth-required" });
    expect(await browser.storage.session.get(WORKSPACE_TOKEN_KEY)).toEqual({});

    await send(
      request({
        type: "WORKSPACE_READER_CONNECT",
        requestId: 2,
        sourceTabId: SOURCE_TAB_ID,
      }),
    );

    fetchMock.mockResolvedValueOnce(
      json({}, 200, { "content-length": String(2_097_153) }),
    );
    await expect(
      send(
        request({
          type: "WORKSPACE_READER_DISCOVER",
          requestId: 3,
          sourceTabId: SOURCE_TAB_ID,
          cursor: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: "response-too-large" });
  });

  it("discards provider results after a file change", async () => {
    const { nextRequestId } = await discoverSheet();
    const loaded = await send(
      request({
        type: "WORKSPACE_READER_LOAD",
        requestId: nextRequestId,
        sourceTabId: SOURCE_TAB_ID,
        cursor: null,
      }),
    );
    if (!loaded?.ok || loaded.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Expected load success");
    const pending = deferred<{ results: string[]; failures: never[] }>();
    mocks.translateText.mockReturnValueOnce(pending.promise);
    const translation = send(
      request({
        type: "WORKSPACE_READER_TRANSLATE",
        requestId: nextRequestId + 1,
        sourceTabId: SOURCE_TAB_ID,
        targetLanguage: "en",
        records: [
          {
            id: loaded.records[0]!.id,
            sourceHash: loaded.records[0]!.sourceHash,
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(mocks.translateText).toHaveBeenCalledOnce());
    sourceUrl = "https://docs.google.com/spreadsheets/d/sheet_other/edit";
    pending.resolve({ results: ["late"], failures: [] });
    await expect(translation).resolves.toMatchObject({
      ok: false,
      error: "source-tab-changed",
    });
  });

  it("suppresses stored always-translate on exact editor routes", async () => {
    mocks.values.set("alwaysTranslate:docs.google.com", {
      enabled: true,
      targetLanguage: "en",
    });
    const sendMessage = vi
      .spyOn(browser.tabs, "sendMessage")
      .mockResolvedValue(undefined as never);
    const detectLanguage = vi
      .spyOn(browser.tabs, "detectLanguage")
      .mockResolvedValue(undefined);

    ensureBackground();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "CONTENT_READY", htmlLang: "ja" },
      {
        id: browser.runtime.id,
        tab: { id: SOURCE_TAB_ID, url: SHEETS_URL },
        frameId: 0,
      } as never,
      vi.fn(),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(detectLanguage).not.toHaveBeenCalled();
  });

  it("keeps stored always-translate on non-editor Google URLs", async () => {
    const url = "https://docs.google.com/spreadsheets/u/0/";
    mocks.values.set("alwaysTranslate:docs.google.com", {
      enabled: true,
      targetLanguage: "en",
    });
    const sendMessage = vi
      .spyOn(browser.tabs, "sendMessage")
      .mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, "detectLanguage").mockResolvedValue(undefined);

    ensureBackground();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "CONTENT_READY", htmlLang: "ja" },
      {
        id: browser.runtime.id,
        tab: { id: SOURCE_TAB_ID, url },
        frameId: 0,
      } as never,
      vi.fn(),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      SOURCE_TAB_ID,
      { type: "START_TRANSLATION", targetLanguage: "en" },
      { frameId: 0 },
    );
  });
});
