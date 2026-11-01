import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import {
  GOOGLE_DRIVE_OFFICE_PORT_NAME,
  GOOGLE_DRIVE_OFFICE_XLSM_MIME,
  MAX_GOOGLE_DRIVE_OFFICE_BYTES,
  MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES,
  decodeGoogleDriveOfficeChunk,
  type GoogleDriveOfficePortMessage,
  type GoogleDriveOfficeStartRequest,
} from "@/lib/google-drive-office-reader";
import type {
  WorkspaceReaderResponse,
  WorkspaceSourceVersion,
} from "@/lib/google-workspace-reader";
import { GOOGLE_WORKSPACE_SCOPES } from "@/shared/google-workspace-config";

const mocks = vi.hoisted(() => ({
  // ADR 0015 launch flags: Sheets Reader on for these suites.
  sheetsReaderOn: true,
  driveOfficeReader: vi.fn(() => true),
  values: new Map<string, unknown>(),
  backendUser: vi.fn(),
  backendLogin: vi.fn(),
  backendSignOut: vi.fn(),
  backendStage: vi.fn(),
  createOpenAI: vi.fn(),
  createNative: vi.fn(),
  generation: 0,
}));

vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: async (key: string) => mocks.values.get(key),
    getMany: async () => ({}),
    getByPrefix: async () => ({}),
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

const SOURCE_TAB_ID = 7;
const FILE_ID = "office-file-123";
const SOURCE_URL = `https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`;
const WEB_CLIENT_ID = "123-web.apps.googleusercontent.com";
const WORKSPACE_TOKEN_KEY = "workspaceReaderGoogleToken:v1";
/** ADR 0020: the one local identity the background uses (no accounts). */
const AUTHENTICATED = {
  authenticated: true as const,
  user: { id: "local", email: "" },
};

interface TestPort {
  name: string;
  sender: {
    id: string;
    url: string;
    documentId?: string;
    tab?: { id: number };
  };
  postMessage: Mock<(message: GoogleDriveOfficePortMessage) => void>;
  disconnect: Mock<() => void>;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  emit(message: unknown): void;
}

let connectListener: ((port: unknown) => void) | undefined;
let sourceUrl = SOURCE_URL;
let version: WorkspaceSourceVersion;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let bootstrapCounter = 0;
let panelOpened:
  ((info: { windowId: number; tabId?: number }) => void) | undefined;
let contextsMock: ReturnType<typeof vi.fn>;
let panelClosed: ((info: { windowId: number }) => void) | undefined;
const DOCUMENT_WINDOWS_KEY = "workspaceReaderDocumentWindows:v1";

const GOOGLE_API_RESPONSE_URL =
  "https://www.googleapis.com/drive/v3/files/test";
const GOOGLE_DOWNLOAD_RESPONSE_URL =
  "https://drive-usercontent.googleusercontent.com/download?id=test";
const responseAt = (response: Response, url: string) => {
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
};
const jsonResponse = (
  value: unknown,
  status = 200,
  url = GOOGLE_API_RESPONSE_URL,
) => {
  const text = JSON.stringify(value);
  return responseAt(
    new Response(text, {
      status,
      headers: {
        "content-type": "application/json",
        "content-length": String(text.length),
      },
    }),
    url,
  );
};
const mediaResponse = (
  bytes: BodyInit | null,
  init?: ResponseInit,
  url = GOOGLE_DOWNLOAD_RESPONSE_URL,
) => responseAt(new Response(bytes, init), url);

const metadata = (size: number, overrides: Record<string, unknown> = {}) => ({
  id: FILE_ID,
  name: "workbook.xlsm",
  mimeType: GOOGLE_DRIVE_OFFICE_XLSM_MIME,
  size: String(size),
  modifiedTime: "2026-09-28T01:02:03.456Z",
  md5Checksum: "a".repeat(32),
  capabilities: { canDownload: true },
  ...overrides,
});

function makePort(
  overrides: Partial<TestPort["sender"]> & { name?: string } = {},
) {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const port: TestPort = {
    name: overrides.name ?? GOOGLE_DRIVE_OFFICE_PORT_NAME,
    sender: {
      id: overrides.id ?? browser.runtime.id,
      url:
        overrides.url ??
        `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=${SOURCE_TAB_ID}`,
      documentId: overrides.documentId,
      tab:
        overrides.url === browser.runtime.getURL("/reader.html" as never)
          ? undefined
          : { id: 70 },
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(() => {
      for (const listener of disconnectListeners) listener();
    }),
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
    emit(message) {
      for (const listener of messageListeners) listener(message);
    },
  };
  connectListener?.(port);
  return port;
}

const startRequest = (
  requestId = 1,
  overrides: Partial<GoogleDriveOfficeStartRequest> = {},
): GoogleDriveOfficeStartRequest => ({
  type: "GOOGLE_DRIVE_OFFICE_START",
  readerInstanceId: "office-reader-1",
  requestId,
  sourceTabId: SOURCE_TAB_ID,
  version,
  ...overrides,
});

const posted = (port: TestPort) =>
  port.postMessage.mock.calls.map(
    ([message]) => message as GoogleDriveOfficePortMessage,
  );

async function bootstrapVersion() {
  bootstrapCounter += 1;
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    {
      type: "WORKSPACE_READER_CONTEXT",
      readerInstanceId: `bootstrap-reader-${bootstrapCounter}`,
      requestId: 1,
      sourceTabId: SOURCE_TAB_ID,
    },
    {
      id: browser.runtime.id,
      url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}`,
      tab: { id: 70 },
    } as never,
    vi.fn(),
  );
  const context = response as unknown as WorkspaceReaderResponse;
  if (!context.ok || context.type !== "WORKSPACE_READER_CONTEXT")
    throw new Error(`Context bootstrap failed: ${JSON.stringify(context)}`);
  version = context.version;
}
async function bindGlobal(
  owner = "office-reader-1",
  documentId = "global-reader",
  includeDocumentId = true,
) {
  const [response] = await fakeBrowser.runtime.onMessage.trigger(
    {
      type: "WORKSPACE_READER_CONTEXT",
      readerInstanceId: owner,
      requestId: 1,
      sourceTabId: SOURCE_TAB_ID,
    },
    {
      id: browser.runtime.id,
      url: browser.runtime.getURL("/reader.html" as never),
      ...(includeDocumentId ? { documentId } : {}),
    } as never,
    vi.fn(),
  );
  return response as unknown as WorkspaceReaderResponse;
}
const globalContext = (documentId = "global-reader", windowId = 1) => ({
  contextType: "SIDE_PANEL",
  documentId,
  documentUrl: browser.runtime.getURL("/reader.html" as never),
  windowId,
  tabId: -1,
});

const pendingMediaResponse = () =>
  new Promise<Response>((_resolve, reject) => {
    const signal = fetchMock.mock.calls.at(-1)?.[1]?.signal;
    signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });

describe("background Google Drive Office download", () => {
  beforeEach(async () => {
    // Dormant until Drive returns via drive.file + Picker (ADR 0015).
    mocks.driveOfficeReader.mockReturnValue(true);
    vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", WEB_CLIENT_ID);
    mocks.generation = 0;
    mocks.values.clear();
    mocks.createOpenAI.mockReturnValue({
      translateText: vi.fn(),
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
    sourceUrl = SOURCE_URL;
    contextsMock = vi.fn(async () => []);
    Object.defineProperty(browser.runtime, "getContexts", {
      configurable: true,
      value: contextsMock,
    });
    Object.defineProperty(browser, "sidePanel", {
      configurable: true,
      value: {
        setOptions: vi.fn(async () => undefined),
        open: vi.fn(async () => undefined),
        onOpened: {
          addListener: (listener: typeof panelOpened) => {
            panelOpened = listener;
          },
        },
        onClosed: {
          addListener: (listener: typeof panelClosed) => {
            panelClosed = listener;
          },
        },
      },
    });
    bootstrapCounter = 0;
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
        [{ id: SOURCE_TAB_ID, windowId: 1, url: SOURCE_URL }] as never,
    );
    vi.spyOn(browser.windows, "get").mockImplementation(async (id) => ({
      id,
      focused: true,
      incognito: false,
      alwaysOnTop: false,
    }));
    const issuedAt = Date.now();
    await browser.storage.session.set({
      [WORKSPACE_TOKEN_KEY]: {
        version: 2,
        accessToken: "drive-token",
        issuedAt,
        expiresAt: issuedAt + 3_600_000,
        clientId: WEB_CLIENT_ID,
        extensionId: browser.runtime.id,
        scopes: [...GOOGLE_WORKSPACE_SCOPES],
        managedAccountId: AUTHENTICATED.user.id,
      },
    });
    Object.defineProperty(browser.storage.session, "setAccessLevel", {
      configurable: true,
      value: vi.fn(),
    });
    const addConnectListener = vi.fn((listener: (port: unknown) => void) => {
      connectListener = listener;
    });
    Object.defineProperty(browser.runtime, "onConnect", {
      configurable: true,
      value: { addListener: addConnectListener },
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    (background.main as () => void)();
    expect(addConnectListener).toHaveBeenCalledOnce();
    await bootstrapVersion();
  });

  it("accepts workspace recovery only from the exact source-bound Office URL", async () => {
    const context = async (url: string, readerInstanceId: string) => {
      const [response] = await fakeBrowser.runtime.onMessage.trigger(
        {
          type: "WORKSPACE_READER_CONTEXT",
          readerInstanceId,
          requestId: 1,
          sourceTabId: SOURCE_TAB_ID,
        },
        { id: browser.runtime.id, url, tab: { id: 70 } } as never,
        vi.fn(),
      );
      return response as unknown as WorkspaceReaderResponse;
    };
    const readerUrl = browser.runtime.getURL("/reader.html" as never);
    await expect(
      context(
        `${readerUrl}?office=1&sourceTabId=${SOURCE_TAB_ID}`,
        "office-context-valid",
      ),
    ).resolves.toMatchObject({ ok: true });

    for (const [index, url] of [
      `${readerUrl}?office=1`,
      `${readerUrl}?office=1&sourceTabId=8`,
      `${readerUrl}?office=1&sourceTabId=${SOURCE_TAB_ID}&extra=1`,
      `${readerUrl}?sourceTabId=${SOURCE_TAB_ID}&office=1`,
      `${readerUrl}?office=1&sourceTabId=${SOURCE_TAB_ID}#hash`,
    ].entries()) {
      await expect(
        context(url, `office-context-invalid-${index}`),
      ).resolves.toMatchObject({ ok: false, error: "invalid-request" });
    }
  });
  it("binds a bare original global Reader and Refresh to its document, owner and browser window", async () => {
    contextsMock.mockResolvedValue([globalContext()]);
    expect(await bindGlobal()).toMatchObject({ ok: true });
    fetchMock.mockImplementation(async (input) =>
      new URL(String(input)).searchParams.get("alt") === "media"
        ? mediaResponse(new Uint8Array([1]))
        : jsonResponse(metadata(1)),
    );
    for (const id of [2, 4]) {
      if (id === 4) {
        const [rebound] = await fakeBrowser.runtime.onMessage.trigger(
          {
            type: "WORKSPACE_READER_CONTEXT",
            readerInstanceId: "office-reader-1",
            requestId: 3,
            sourceTabId: SOURCE_TAB_ID,
          },
          {
            id: browser.runtime.id,
            url: browser.runtime.getURL("/reader.html" as never),
            documentId: "global-reader",
          } as never,
          vi.fn(),
        );
        expect(rebound).toMatchObject({ ok: true });
      }
      const port = makePort({
        url: browser.runtime.getURL("/reader.html" as never),
        documentId: "global-reader",
      });
      port.emit(startRequest(id));
      await vi.waitFor(() =>
        expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it.each([
    "missing handshake",
    "wrong document",
    "wrong window",
    "stale version",
    "worker restart",
  ])("rejects global %s before Google dispatch", async (kind) => {
    contextsMock.mockResolvedValue([globalContext()]);
    if (kind !== "missing handshake")
      expect(await bindGlobal()).toMatchObject({ ok: true });
    if (kind === "wrong window")
      contextsMock.mockResolvedValue([globalContext("global-reader", 2)]);
    if (kind === "wrong document")
      contextsMock.mockResolvedValue([globalContext("forged-reader")]);
    if (kind === "worker restart") (background.main as () => void)();
    const port = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
      documentId: kind === "wrong document" ? "forged-reader" : "global-reader",
    });
    port.emit(
      startRequest(
        2,
        kind === "stale version"
          ? {
              version: {
                ...version,
                sourceRevision: version.sourceRevision + 1,
              },
            }
          : {},
      ),
    );
    await vi.waitFor(() =>
      expect(posted(port).at(-1)).toMatchObject({
        error: "reader-channel-unavailable",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses a unique browser onOpened document for Chromium contexts reporting windowId -1", async () => {
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    panelOpened?.({ windowId: 1, tabId: SOURCE_TAB_ID });
    expect(await bindGlobal()).toMatchObject({ ok: true });
    const port = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
      documentId: "global-reader",
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(1)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([1])));
    port.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );
  });
  it("correlates the single actual panel when Chrome omits documentId from Context and Port senders", async () => {
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    panelOpened?.({ windowId: 1, tabId: SOURCE_TAB_ID });
    expect(
      await bindGlobal("office-reader-1", "global-reader", false),
    ).toMatchObject({ ok: true });
    const port = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(1)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([1])));
    port.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("restores only a live browser-session document/window association across a held worker restart", async () => {
    const launchOauth = vi.spyOn(browser.identity, "launchWebAuthFlow");
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    panelOpened?.({ windowId: 1, tabId: SOURCE_TAB_ID });
    expect(
      await bindGlobal("office-reader-1", "global-reader", false),
    ).toMatchObject({ ok: true });
    const saved = await browser.storage.session.get(DOCUMENT_WINDOWS_KEY);
    expect(saved[DOCUMENT_WINDOWS_KEY]).toEqual({
      version: 1,
      extensionId: browser.runtime.id,
      documents: [{ documentId: "global-reader", windowId: 1 }],
    });
    const originalGet = browser.storage.session.get.bind(
      browser.storage.session,
    );
    let release!: (value: Record<string, unknown>) => void;
    const held = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    vi.spyOn(browser.storage.session, "get").mockImplementation(async (key) =>
      key === DOCUMENT_WINDOWS_KEY
        ? ((await held) as never)
        : originalGet(key as never),
    );
    fakeBrowser.runtime.resetState();
    (background.main as () => void)();
    const pending = bindGlobal("new-worker-reader", "global-reader", false);
    expect(fetchMock).not.toHaveBeenCalled();
    release(saved);
    const recovered = await pending;
    expect(recovered).toMatchObject({ ok: true, connected: true });
    if (!recovered.ok || recovered.type !== "WORKSPACE_READER_CONTEXT")
      throw new Error("Expected restored context");
    expect(recovered.version.backgroundEpoch).not.toBe(version.backgroundEpoch);
    const stale = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
    });
    stale.emit(startRequest(2, { readerInstanceId: "new-worker-reader" }));
    await vi.waitFor(() =>
      expect(posted(stale).at(-1)).toMatchObject({
        error: "reader-channel-unavailable",
      }),
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(1)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([1])));
    const fresh = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
    });
    fresh.emit(
      startRequest(3, {
        readerInstanceId: "new-worker-reader",
        version: recovered.version,
      }),
    );
    await vi.waitFor(() =>
      expect(posted(fresh).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(launchOauth).not.toHaveBeenCalled();
  });
  it.each([
    "closed document",
    "closed window",
    "wrong extension",
    "wrong version",
    "duplicate document",
  ])("fails closed for persisted %s identity", async (kind) => {
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    const documentId =
      kind === "closed document" ? "retired-reader" : "global-reader";
    const record = {
      version: kind === "wrong version" ? 2 : 1,
      extensionId:
        kind === "wrong extension" ? "foreign-extension" : browser.runtime.id,
      documents: [{ documentId, windowId: 1 }],
    };
    if (kind === "duplicate document")
      record.documents.push({ documentId, windowId: 2 });
    await browser.storage.session.set({ [DOCUMENT_WINDOWS_KEY]: record });
    if (kind === "closed window")
      vi.mocked(browser.windows.get).mockRejectedValue(
        new Error("No such window"),
      );
    fakeBrowser.runtime.resetState();
    (background.main as () => void)();
    expect(
      await bindGlobal("restored-invalid", "global-reader", false),
    ).toMatchObject({ ok: false, error: "reader-channel-unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      (await browser.storage.session.get(DOCUMENT_WINDOWS_KEY))[
        DOCUMENT_WINDOWS_KEY
      ],
    ).toMatchObject({ documents: [] });
  });
  it("keeps ambiguous or cross-window restored source claims fail-closed without narrowing by source", async () => {
    await browser.storage.session.set({
      [DOCUMENT_WINDOWS_KEY]: {
        version: 1,
        extensionId: browser.runtime.id,
        documents: [{ documentId: "global-reader", windowId: 2 }],
      },
    });
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    fakeBrowser.runtime.resetState();
    (background.main as () => void)();
    expect(
      await bindGlobal("wrong-window-reader", "global-reader", false),
    ).toMatchObject({ ok: false, error: "reader-channel-unavailable" });
    contextsMock.mockResolvedValue([
      globalContext("global-reader", -1),
      globalContext("another-reader", -1),
    ]);
    expect(
      await bindGlobal("ambiguous-restored-reader", "global-reader", false),
    ).toMatchObject({ ok: false, error: "reader-channel-unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("retires session metadata on close and never reinstalls it from a held restart read", async () => {
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    panelOpened?.({ windowId: 1, tabId: SOURCE_TAB_ID });
    expect(
      await bindGlobal("office-reader-1", "global-reader", false),
    ).toMatchObject({ ok: true });
    const saved = await browser.storage.session.get(DOCUMENT_WINDOWS_KEY);
    const originalGet = browser.storage.session.get.bind(
      browser.storage.session,
    );
    let release!: (value: Record<string, unknown>) => void;
    const held = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const get = vi
      .spyOn(browser.storage.session, "get")
      .mockImplementation(async (key) =>
        key === DOCUMENT_WINDOWS_KEY
          ? ((await held) as never)
          : originalGet(key as never),
      );
    fakeBrowser.runtime.resetState();
    (background.main as () => void)();
    const pending = bindGlobal("late-restored-owner", "global-reader", false);
    panelClosed?.({ windowId: 1 });
    release(saved);
    expect(await pending).toMatchObject({
      ok: false,
      error: "reader-channel-unavailable",
    });
    get.mockRestore();
    await vi.waitFor(async () =>
      expect(
        (await browser.storage.session.get(DOCUMENT_WINDOWS_KEY))[
          DOCUMENT_WINDOWS_KEY
        ],
      ).toMatchObject({ documents: [] }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["SIDE_PANEL", "TAB"])(
    "never narrows ambiguous %s Reader contexts by the claimed source window",
    async (contextType) => {
      contextsMock.mockResolvedValue([
        globalContext(),
        { ...globalContext("other-reader", 2), contextType },
      ]);
      expect(
        await bindGlobal("office-reader-1", "global-reader", false),
      ).toMatchObject({ ok: false, error: "reader-channel-unavailable" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("validates the actual Reader-tab host window for the exact awaiting-start fallback URL", async () => {
    const url = `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}&awaitStart=1`;
    const [context] = await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: "fallback-reader",
        requestId: 1,
        sourceTabId: SOURCE_TAB_ID,
      },
      { id: browser.runtime.id, url, tab: { id: 70 } } as never,
      vi.fn(),
    );
    expect(context).toMatchObject({ ok: true });
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => ({
      id,
      windowId: id === 70 ? 2 : 1,
      url: id === 70 ? url : SOURCE_URL,
    }));
    const port = makePort({ url });
    port.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)).toMatchObject({
        error: "reader-channel-unavailable",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reclaims only a previously authorized inactive source after worker restart", async () => {
    contextsMock.mockResolvedValue([globalContext()]);
    expect(await bindGlobal()).toMatchObject({ ok: true });
    const stored = await browser.storage.session.get(
      "workspaceReaderSourceClaims:v1",
    );
    expect(stored["workspaceReaderSourceClaims:v1"]).toMatchObject({
      version: 1,
      claims: [
        {
          documentId: "global-reader",
          windowId: 1,
          sourceTabId: 7,
          fileId: FILE_ID,
          accountId: AUTHENTICATED.user.id,
        },
      ],
    });
    fakeBrowser.runtime.resetState();
    (background.main as () => void)();
    vi.mocked(browser.tabs.query).mockResolvedValue([
      { id: 8, windowId: 1 },
    ] as never);
    expect(await bindGlobal("after-restart")).toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    "account",
    "file",
    "document",
    "window",
    "version",
    "extension",
    "extra field",
  ])("rejects a restored inactive source with wrong %s", async (kind) => {
    contextsMock.mockResolvedValue([globalContext()]);
    const claim = {
      documentId: kind === "document" ? "other-reader" : "global-reader",
      windowId: kind === "window" ? 2 : 1,
      sourceTabId: 7,
      fileId: kind === "file" ? "another-file" : FILE_ID,
      accountId: kind === "account" ? "other-account" : AUTHENTICATED.user.id,
      ...(kind === "extra field" ? { unexpected: true } : {}),
    };
    await browser.storage.session.set({
      "workspaceReaderSourceClaims:v1": {
        version: kind === "version" ? 2 : 1,
        extensionId:
          kind === "extension" ? "other-extension" : browser.runtime.id,
        claims: [claim],
      },
    });
    vi.mocked(browser.tabs.query).mockResolvedValue([
      { id: 8, windowId: 1 },
    ] as never);
    expect(await bindGlobal()).toMatchObject({
      ok: false,
      error: "reader-channel-unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects an inactive same-window editor source claim before Google work", async () => {
    contextsMock.mockResolvedValue([globalContext()]);
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => ({
      id,
      windowId: 1,
      url: SOURCE_URL,
    }));
    const [forged] = await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: "forged-source",
        requestId: 1,
        sourceTabId: 8,
      },
      {
        id: browser.runtime.id,
        url: browser.runtime.getURL("/reader.html" as never),
        documentId: "global-reader",
      } as never,
      vi.fn(),
    );
    expect(forged).toMatchObject({
      ok: false,
      error: "reader-channel-unavailable",
    });
    expect(await bindGlobal()).toMatchObject({ ok: true });
    vi.mocked(browser.tabs.query).mockImplementation(
      async () => [{ id: 8, windowId: 1 }] as never,
    );
    const port = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
      documentId: "global-reader",
    });
    // A pane already bound to tab 7 keeps working while tab 8 is active, so a
    // translation in a background tab is not cancelled by a tab switch.
    port.emit(startRequest(2));
    await vi.waitFor(() => expect(posted(port).length).toBeGreaterThan(0));
    expect(posted(port).at(-1)).not.toMatchObject({
      error: "reader-channel-unavailable",
    });
    // An unbound inactive tab still cannot be claimed.
    const forgedPort = makePort({
      url: browser.runtime.getURL("/reader.html" as never),
      documentId: "global-reader",
    });
    forgedPort.emit(startRequest(3, { sourceTabId: 9 }));
    await vi.waitFor(() =>
      expect(posted(forgedPort).at(-1)).toMatchObject({
        error: "reader-channel-unavailable",
      }),
    );
  });
  it("fails closed when the actual opened window has ambiguous or missing document identity", async () => {
    contextsMock.mockResolvedValue([
      globalContext("a", -1),
      globalContext("b", -1),
    ]);
    panelOpened?.({ windowId: 1, tabId: SOURCE_TAB_ID });
    expect(await bindGlobal("office-reader-1", "a")).toMatchObject({
      ok: false,
      error: "reader-channel-unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("binds the first Context when the actual opened renderer appears after open resolution", async () => {
    panelOpened?.({ windowId: 1, tabId: SOURCE_TAB_ID });
    await Promise.resolve();
    await Promise.resolve();
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    expect(await bindGlobal()).toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects one unidentified document when two browser windows await panel identity", async () => {
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => ({
      id,
      windowId: id === 8 ? 2 : 1,
      url: SOURCE_URL,
    }));
    panelOpened?.({ windowId: 1, tabId: 7 });
    panelOpened?.({ windowId: 2, tabId: 8 });
    await Promise.resolve();
    await Promise.resolve();
    contextsMock.mockResolvedValue([globalContext("global-reader", -1)]);
    expect(await bindGlobal()).toMatchObject({
      ok: false,
      error: "reader-channel-unavailable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the source-bound original navigation URL retained by Chrome Ports", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(1)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([1])));
    const readerUrl = browser.runtime.getURL("/reader.html" as never);
    const port = makePort({
      url: `${readerUrl}?sourceTabId=${SOURCE_TAB_ID}`,
    });
    port.emit(startRequest(1, { readerInstanceId: "original-url-reader" }));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("trusts only the exact named Office Reader URL and follows a validated Google download redirect", async () => {
    const bytes = new Uint8Array(MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES + 3);
    bytes.fill(23);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(bytes.byteLength)))
      .mockResolvedValueOnce(
        mediaResponse(bytes, {
          headers: { "content-length": String(bytes.byteLength) },
        }),
      );

    const ignored = makePort({ name: "another-port" });
    expect(ignored.disconnect).not.toHaveBeenCalled();
    const foreign = makePort({ id: "another-extension" });
    expect(foreign.disconnect).toHaveBeenCalledOnce();
    for (const url of [
      `${browser.runtime.getURL("/reader.html" as never)}?office=1`,
      `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}&office=1`,
      `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=0`,
      `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=07`,
      `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=${SOURCE_TAB_ID}&extra=1`,
      `${browser.runtime.getURL("/reader.html" as never)}?office=1&sourceTabId=${SOURCE_TAB_ID}#hash`,
      `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=0`,
      `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=07`,
      `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}&extra=1`,
      `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}#hash`,
    ]) {
      expect(makePort({ url }).disconnect).toHaveBeenCalledOnce();
    }

    const port = makePort();
    port.emit(startRequest());
    await vi.waitFor(() =>
      expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [metadataInput, metadataInit] = fetchMock.mock.calls[0]!;
    const metadataUrl = new URL(String(metadataInput));
    expect(metadataUrl.origin + metadataUrl.pathname).toBe(
      `https://www.googleapis.com/drive/v3/files/${FILE_ID}`,
    );
    expect([...metadataUrl.searchParams]).toEqual([
      [
        "fields",
        "id,name,mimeType,size,modifiedTime,md5Checksum,capabilities(canDownload)",
      ],
      ["supportsAllDrives", "true"],
    ]);
    expect(metadataInit).toMatchObject({
      method: "GET",
      headers: { authorization: "Bearer drive-token" },
    });
    const mediaUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect([...mediaUrl.searchParams]).toEqual([
      ["alt", "media"],
      ["supportsAllDrives", "true"],
    ]);
    expect(posted(port).map(({ type }) => type)).toEqual([
      "GOOGLE_DRIVE_OFFICE_METADATA",
      "GOOGLE_DRIVE_OFFICE_CHUNK",
      "GOOGLE_DRIVE_OFFICE_CHUNK",
      "GOOGLE_DRIVE_OFFICE_COMPLETE",
    ]);
    const chunks = posted(port).filter(
      (message) => message.type === "GOOGLE_DRIVE_OFFICE_CHUNK",
    );
    expect(chunks.map(({ sequence }) => sequence)).toEqual([0, 1]);
    expect(
      chunks.map(({ data }) => decodeGoogleDriveOfficeChunk(data).byteLength),
    ).toEqual([MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES, 3]);
    expect(mocks.backendStage).not.toHaveBeenCalled();
  });

  it("rejects a Drive response redirected to an unexpected final origin", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(metadata(1), 200, "https://attacker.example/download"),
    );
    const port = makePort();
    port.emit(startRequest());
    await vi.waitFor(() =>
      expect(posted(port).at(-1)).toMatchObject({
        type: "GOOGLE_DRIVE_OFFICE_ERROR",
        error: "invalid-response",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      posted(port).some(({ type }) => type === "GOOGLE_DRIVE_OFFICE_METADATA"),
    ).toBe(false);
  });

  it("disables the Drive Office download at launch with download guidance (ADR 0015)", async () => {
    mocks.driveOfficeReader.mockReturnValue(false);
    const port = makePort();
    port.emit(startRequest(1));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)).toMatchObject({
        type: "GOOGLE_DRIVE_OFFICE_ERROR",
        error: "office-download-required",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed requests, replay and Reader-supplied download authority", async () => {
    const malformedPort = makePort();
    malformedPort.emit({ ...startRequest(), fileId: "attacker-file" });
    expect(malformedPort.disconnect).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(1)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([1])));
    const port = makePort();
    port.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );
    port.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(port).at(-1)).toMatchObject({
        type: "GOOGLE_DRIVE_OFFICE_ERROR",
        error: "invalid-request",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      metadata(21, { capabilities: { canDownload: false } }),
      "download-not-allowed",
    ],
    [metadata(MAX_GOOGLE_DRIVE_OFFICE_BYTES + 1), "file-too-large"],
    [metadata(21, { name: "workbook.pdf" }), "unsupported-file-type"],
    [metadata(21, { size: "not-a-number" }), "invalid-response"],
  ] as const)("validates Drive metadata before media", async (input, error) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(input));
    const port = makePort();
    port.emit(startRequest());
    await vi.waitFor(() =>
      expect(posted(port).at(-1)).toMatchObject({
        type: "GOOGLE_DRIVE_OFFICE_ERROR",
        error,
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("evicts a rejected Google token and maps access and transient statuses", async () => {
    fetchMock.mockResolvedValueOnce(
      responseAt(new Response(null, { status: 401 }), GOOGLE_API_RESPONSE_URL),
    );
    const unauthorized = makePort();
    unauthorized.emit(startRequest());
    await vi.waitFor(() =>
      expect(posted(unauthorized).at(-1)).toMatchObject({
        error: "google-auth-required",
      }),
    );
    expect(
      (await browser.storage.session.get(WORKSPACE_TOKEN_KEY))[
        WORKSPACE_TOKEN_KEY
      ],
    ).toBeUndefined();

    for (const [index, [status, error]] of (
      [
        [403, "google-access-denied"],
        [429, "temporarily-unavailable"],
        [503, "temporarily-unavailable"],
        [206, "invalid-response"],
      ] as const
    ).entries()) {
      const issuedAt = Date.now();
      await browser.storage.session.set({
        [WORKSPACE_TOKEN_KEY]: {
          version: 2,
          accessToken: "drive-token",
          issuedAt,
          expiresAt: issuedAt + 3_600_000,
          clientId: WEB_CLIENT_ID,
          extensionId: browser.runtime.id,
          scopes: [...GOOGLE_WORKSPACE_SCOPES],
          managedAccountId: AUTHENTICATED.user.id,
        },
      });
      fetchMock.mockResolvedValueOnce(
        responseAt(new Response(null, { status }), GOOGLE_API_RESPONSE_URL),
      );
      const port = makePort();
      port.emit(startRequest(index + 2));
      await vi.waitFor(() =>
        expect(posted(port).at(-1)).toMatchObject({ error }),
      );
    }
  });

  it("keeps independent owners and queues downloads at concurrency two", async () => {
    const releases: (() => void)[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (!String(input).includes("alt=media"))
        return jsonResponse(metadata(1));
      return new Promise<Response>((resolve, reject) => {
        releases.push(() => resolve(mediaResponse(new Uint8Array([9]))));
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    const ports = [makePort(), makePort(), makePort()];
    ports.forEach((port, index) =>
      port.emit(
        startRequest(1, {
          readerInstanceId: `independent-office-${index}`,
        }),
      ),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(posted(ports[0]!).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_METADATA");
    expect(posted(ports[1]!).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_METADATA");
    expect(posted(ports[2]!)).toEqual([]);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(posted(ports[0]!).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE");
    expect(posted(ports[1]!).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_METADATA");
    releases[1]!();
    releases[2]!();
    await vi.waitFor(() => {
      for (const port of ports)
        expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE");
    });
  });

  it("aborts on cancel, replacement, navigation and disconnect without completing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(5)))
      .mockImplementationOnce(pendingMediaResponse)
      .mockResolvedValueOnce(jsonResponse(metadata(1)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([9])));
    const first = makePort();
    first.emit(startRequest(1));
    await vi.waitFor(() =>
      expect(posted(first).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_METADATA"),
    );
    const second = makePort();
    second.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(second).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_COMPLETE"),
    );
    expect(posted(first).at(-1)).toMatchObject({
      type: "GOOGLE_DRIVE_OFFICE_ERROR",
      error: "source-tab-changed",
    });

    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(5)))
      .mockImplementationOnce(pendingMediaResponse);
    const cancelPort = makePort();
    const cancelStart = startRequest(3, { readerInstanceId: "cancel-reader" });
    cancelPort.emit(cancelStart);
    await vi.waitFor(() =>
      expect(posted(cancelPort).at(-1)?.type).toBe(
        "GOOGLE_DRIVE_OFFICE_METADATA",
      ),
    );
    cancelPort.emit({ ...cancelStart, type: "GOOGLE_DRIVE_OFFICE_CANCEL" });
    await Promise.resolve();
    expect(
      posted(cancelPort).some(
        ({ type }) => type === "GOOGLE_DRIVE_OFFICE_COMPLETE",
      ),
    ).toBe(false);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(5)))
      .mockImplementationOnce(pendingMediaResponse);
    const navigationPort = makePort();
    navigationPort.emit(startRequest(4, { readerInstanceId: "nav-reader" }));
    await vi.waitFor(() =>
      expect(posted(navigationPort).at(-1)?.type).toBe(
        "GOOGLE_DRIVE_OFFICE_METADATA",
      ),
    );
    sourceUrl = "https://example.test/left";
    await fakeBrowser.tabs.onUpdated.trigger(
      SOURCE_TAB_ID,
      { url: sourceUrl },
      { id: SOURCE_TAB_ID, url: sourceUrl } as never,
    );
    expect(posted(navigationPort).at(-1)).toMatchObject({
      error: "source-tab-changed",
    });

    sourceUrl = SOURCE_URL;
    await fakeBrowser.tabs.onUpdated.trigger(
      SOURCE_TAB_ID,
      { url: sourceUrl },
      { id: SOURCE_TAB_ID, url: sourceUrl } as never,
    );
    await bootstrapVersion();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(5)))
      .mockImplementationOnce(pendingMediaResponse);
    const disconnected = makePort();
    disconnected.emit(
      startRequest(5, { readerInstanceId: "disconnect-reader" }),
    );
    await vi.waitFor(() =>
      expect(posted(disconnected).at(-1)?.type).toBe(
        "GOOGLE_DRIVE_OFFICE_METADATA",
      ),
    );
    disconnected.disconnect();
    await Promise.resolve();
    expect(posted(disconnected).at(-1)?.type).toBe(
      "GOOGLE_DRIVE_OFFICE_METADATA",
    );
  });

  it("keeps a pending download through editor gid/URL noise and aborts on a real file change", async () => {
    let mediaSignal: AbortSignal | undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(5)))
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            mediaSignal = init?.signal ?? undefined;
            mediaSignal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
    const port = makePort();
    port.emit(startRequest());
    await vi.waitFor(() =>
      expect(posted(port).at(-1)?.type).toBe("GOOGLE_DRIVE_OFFICE_METADATA"),
    );

    const noisyUrl = `${SOURCE_URL}?utm_source=reader-regression#gid=17`;
    await fakeBrowser.tabs.onUpdated.trigger(SOURCE_TAB_ID, { url: noisyUrl }, {
      id: SOURCE_TAB_ID,
      url: noisyUrl,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mediaSignal?.aborted).toBe(false);
    expect(posted(port).map(({ type }) => type)).toEqual([
      "GOOGLE_DRIVE_OFFICE_METADATA",
    ]);

    const changedUrl =
      "https://docs.google.com/spreadsheets/d/another-office-file/edit";
    await fakeBrowser.tabs.onUpdated.trigger(
      SOURCE_TAB_ID,
      { url: changedUrl },
      { id: SOURCE_TAB_ID, url: changedUrl } as never,
    );
    expect(mediaSignal?.aborted).toBe(true);
    expect(posted(port).at(-1)).toMatchObject({
      type: "GOOGLE_DRIVE_OFFICE_ERROR",
      error: "source-tab-changed",
    });
    expect(
      posted(port).some(({ type }) => type === "GOOGLE_DRIVE_OFFICE_COMPLETE"),
    ).toBe(false);
  });

  it("aborts an active private workbook stream when a sibling Reader disconnects", async () => {
    const siblingTabId = 8;
    const siblingUrl =
      "https://docs.google.com/spreadsheets/d/sibling-office-file/edit";
    vi.mocked(browser.tabs.get).mockImplementation(async (tabId) => ({
      id: tabId,
      windowId: 1,
      url:
        tabId === 80
          ? `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${siblingTabId}`
          : tabId === 70
            ? `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${SOURCE_TAB_ID}`
            : tabId === siblingTabId
              ? siblingUrl
              : sourceUrl,
    }));
    const [siblingContextResult] = await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: "sibling-reader-context",
        requestId: 1,
        sourceTabId: siblingTabId,
      },
      {
        id: browser.runtime.id,
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${siblingTabId}`,
        tab: { id: 80 },
      } as never,
      vi.fn(),
    );
    const siblingContext =
      siblingContextResult as unknown as WorkspaceReaderResponse;
    if (
      !siblingContext.ok ||
      siblingContext.type !== "WORKSPACE_READER_CONTEXT"
    )
      throw new Error("Expected sibling Reader context");

    let mediaSignal: AbortSignal | undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(5)))
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            mediaSignal = init?.signal ?? undefined;
            mediaSignal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
    const privateWorkbook = makePort();
    privateWorkbook.emit(
      startRequest(1, { readerInstanceId: "private-workbook-reader" }),
    );
    await vi.waitFor(() =>
      expect(posted(privateWorkbook).at(-1)?.type).toBe(
        "GOOGLE_DRIVE_OFFICE_METADATA",
      ),
    );
    expect(mediaSignal?.aborted).toBe(false);

    const [disconnectResult] = await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "WORKSPACE_READER_DISCONNECT",
        readerInstanceId: "sibling-reader-disconnect",
        requestId: 1,
        sourceTabId: siblingTabId,
        version: siblingContext.version,
      },
      {
        id: browser.runtime.id,
        url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=${siblingTabId}`,
      } as never,
      vi.fn(),
    );
    expect(disconnectResult).toMatchObject({ ok: true, connected: false });
    expect(mediaSignal?.aborted).toBe(true);
    expect(posted(privateWorkbook).at(-1)).toMatchObject({
      type: "GOOGLE_DRIVE_OFFICE_ERROR",
      error: "google-auth-required",
    });
    expect(
      posted(privateWorkbook).some(
        ({ type }) => type === "GOOGLE_DRIVE_OFFICE_COMPLETE",
      ),
    ).toBe(false);
  });

  it("times out and rejects media byte mismatches without complete", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(jsonResponse(metadata(5)))
        .mockImplementationOnce(pendingMediaResponse);
      const timedOut = makePort();
      timedOut.emit(startRequest());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(posted(timedOut).at(-1)).toMatchObject({
        type: "GOOGLE_DRIVE_OFFICE_ERROR",
        error: "download-timeout",
      });
    } finally {
      vi.useRealTimers();
    }

    fetchMock
      .mockResolvedValueOnce(jsonResponse(metadata(2)))
      .mockResolvedValueOnce(mediaResponse(new Uint8Array([1, 2, 3])));
    const overflow = makePort();
    overflow.emit(startRequest(2));
    await vi.waitFor(() =>
      expect(posted(overflow).at(-1)).toMatchObject({
        type: "GOOGLE_DRIVE_OFFICE_ERROR",
        error: "invalid-response",
      }),
    );
    expect(
      posted(overflow).some(
        ({ type }) => type === "GOOGLE_DRIVE_OFFICE_COMPLETE",
      ),
    ).toBe(false);
  });
});
