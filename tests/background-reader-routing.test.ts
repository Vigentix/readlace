import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

const mocks = vi.hoisted(() => ({
  // ADR 0015 launch flags: Sheets Reader on for these suites.
  sheetsReaderOn: true,
  driveOfficeReader: vi.fn(() => false),
  values: new Map<string, unknown>(),
  user: vi.fn(),
  signOut: vi.fn(),
  login: vi.fn(),
  translate: vi.fn(),
}));
vi.mock("@/lib/translate/openai-html", () => ({
  createOpenAIHtmlTranslator: () => ({
    translateText: mocks.translate,
    invalidatePendingWork: vi.fn(),
  }),
}));
vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: async (key: string) => mocks.values.get(key),
    getMany: async (keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, mocks.values.get(key)])),
    getByPrefix: async () => ({}),
    remove: vi.fn(),
    set: vi.fn(),
    setMany: vi.fn(),
  },
}));
vi.mock("@/lib/workspace-features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-features")>()),
  sheetsReaderEnabled: () => mocks.sheetsReaderOn,
  driveOfficeReaderEnabled: mocks.driveOfficeReader,
}));
import background from "@/entrypoints/background";

const url = "https://docs.google.com/spreadsheets/d/workbook_123/edit#gid=2";
const signedIn = {
  authenticated: true,
  user: { id: "user-1", email: "user@example.test" },
};
let sourceUrl: string;
let popup: ReturnType<typeof vi.fn>;
let panelOptions: ReturnType<typeof vi.fn>;
let panelOpen: ReturnType<typeof vi.fn>;
let panelClose: ReturnType<typeof vi.fn>;
const start = () => (background.main as () => void)();
const message = async (type: string) =>
  fakeBrowser.runtime.onMessage.trigger(
    { type },
    {
      id: browser.runtime.id,
      url: browser.runtime.getURL("/popup.html" as never),
    } as never,
    vi.fn(),
  );
const update = async (nextUrl: string) => {
  sourceUrl = nextUrl;
  await fakeBrowser.tabs.onUpdated.trigger(7, { url: nextUrl }, {
    id: 7,
    url: nextUrl,
    windowId: 1,
    active: true,
  } as never);
};
beforeEach(() => {
  mocks.sheetsReaderOn = true;
  sourceUrl = url;
  mocks.values.clear();
  mocks.user.mockResolvedValue(signedIn);
  mocks.signOut.mockResolvedValue(undefined);
  mocks.login.mockResolvedValue(signedIn);
  mocks.translate.mockResolvedValue({ results: ["accepted"], failures: [] });
  vi.stubEnv(
    "WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID",
    "123-web.apps.googleusercontent.com",
  );
  vi.spyOn(browser.tabs, "query").mockImplementation(async () => [
    { id: 7, url: sourceUrl, windowId: 1, active: true },
  ]);
  vi.spyOn(browser.tabs, "get").mockImplementation(async (id) => ({
    id,
    url: sourceUrl,
    windowId: 1,
  }));
  popup = vi.spyOn(browser.action, "setPopup").mockResolvedValue(undefined);
  panelOptions = vi.fn().mockResolvedValue(undefined);
  panelOpen = vi.fn().mockResolvedValue(undefined);
  panelClose = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(browser, "sidePanel", {
    configurable: true,
    value: { setOptions: panelOptions, open: panelOpen, close: panelClose },
  });
  Object.defineProperty(browser, "identity", {
    configurable: true,
    value: { getRedirectURL: vi.fn(), launchWebAuthFlow: vi.fn() },
  });
  Object.defineProperty(browser.runtime, "getContexts", {
    configurable: true,
    value: vi.fn(async () => [
      {
        contextType: "SIDE_PANEL",
        documentId: "routing-reader-document",
        documentUrl: browser.runtime.getURL("/reader.html" as never),
        windowId: 1,
      },
    ]),
  });
  vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
    manifest_version: 3,
    name: "Readlace",
    version: "1",
  } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Reader toolbar routing", () => {
  it("keeps the popup notice on a native Sheet while the build flag is off (ADR 0020)", async () => {
    mocks.sheetsReaderOn = false;
    start();
    await message("AUTH_STATUS");
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "popup.html" }),
    );
    await fakeBrowser.action.onClicked.trigger({
      id: 7,
      url,
      windowId: 1,
    } as never);
    expect(panelOpen).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalledWith({ tabId: 7, popup: "" });
    await expect(message("WORKSPACE_FEATURES")).resolves.toEqual([
      { workspaceSheetsReader: false },
    ]);
  });
  it("opens directly inside the click gesture with no authentication/network wait or Translate intent", async () => {
    const opened = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);
    start();
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "" }),
    );
    const clicked = fakeBrowser.action.onClicked.trigger({
      id: 7,
      url,
      windowId: 1,
    } as never);
    expect(panelOpen).toHaveBeenCalledWith({ windowId: 1 });
    await clicked;
    await vi.waitFor(() =>
      expect(opened).toHaveBeenCalledWith({
        type: "WORKSPACE_READER_OPEN",
        sourceTabId: 7,
        sourceWindowId: 1,
      }),
    );
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it("notifies a reusable Reader only after open succeeds and never after failure", async () => {
    const opened = vi
      .spyOn(browser.runtime, "sendMessage")
      .mockResolvedValue(undefined as never);
    let resolve!: () => void;
    panelOpen.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    start();
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "" }),
    );
    await fakeBrowser.action.onClicked.trigger({
      id: 7,
      url,
      windowId: 1,
    } as never);
    expect(opened).not.toHaveBeenCalled();
    resolve();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    panelOpen.mockRejectedValueOnce(new Error("not opened"));
    await fakeBrowser.action.onClicked.trigger({
      id: 7,
      url,
      windowId: 1,
    } as never);
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "popup.html" }),
    );
    expect(opened).toHaveBeenCalledOnce();
  });
  it("hides for same-tab Drive navigation and leaves returning file closed until another click", async () => {
    start();
    await vi.waitFor(() => expect(popup).toHaveBeenCalled());
    await update("https://drive.google.com/drive/u/0/folders/folder_123");
    await vi.waitFor(() =>
      expect(panelClose).toHaveBeenCalledWith({ windowId: 1 }),
    );
    expect(panelOptions).toHaveBeenLastCalledWith({
      path: "reader.html",
      enabled: true,
    });
    await update(url);
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "" }),
    );
    expect(panelOpen).not.toHaveBeenCalled();
  });
  it("closes the global panel on an unrelated activated tab", async () => {
    start();
    sourceUrl = "chrome://newtab/";
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 8, windowId: 1 });
    await vi.waitFor(() =>
      expect(panelClose).toHaveBeenCalledWith({ windowId: 1 }),
    );
    expect(panelOpen).not.toHaveBeenCalled();
  });
  it("serializes routing writes so a delayed supported route cannot win over Drive", async () => {
    let resolve!: () => void;
    panelOptions.mockReturnValueOnce(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    start();
    await vi.waitFor(() => expect(panelOptions).toHaveBeenCalledOnce());
    await update("https://drive.google.com/drive/my-drive");
    resolve();
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "popup.html" }),
    );
    expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "popup.html" });
  });

  it("keeps a global opened Reader through supported tabs, then closes that window and never auto-opens on return", async () => {
    start();
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "" }),
    );
    await fakeBrowser.action.onClicked.trigger({
      id: 7,
      url,
      windowId: 1,
    } as never);
    sourceUrl = url.replace("workbook_123", "workbook_456");
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 8, windowId: 1 });
    await vi.waitFor(() =>
      expect(popup).toHaveBeenCalledWith({ tabId: 8, popup: "" }),
    );
    expect(panelClose).not.toHaveBeenCalled();
    expect(panelOpen).toHaveBeenCalledOnce();
    sourceUrl = "https://example.test/unrelated";
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 9, windowId: 1 });
    await vi.waitFor(() =>
      expect(panelClose).toHaveBeenCalledWith({ windowId: 1 }),
    );
    sourceUrl = url;
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 7, windowId: 1 });
    await vi.waitFor(() =>
      expect(popup).toHaveBeenCalledWith({ tabId: 7, popup: "" }),
    );
    expect(panelOpen).toHaveBeenCalledOnce();
    expect(
      panelOptions.mock.calls.every(([options]) => options.tabId === undefined),
    ).toBe(true);
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it("registers trusted popup opens and safely disables globally on older Chromium without close", async () => {
    Object.defineProperty(browser, "sidePanel", {
      configurable: true,
      value: { setOptions: panelOptions, open: panelOpen },
    });
    start();
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "WORKSPACE_READER_OPEN", sourceTabId: 7, sourceWindowId: 1 },
      {
        id: browser.runtime.id,
        url: browser.runtime.getURL("/popup.html" as never),
      } as never,
      vi.fn(),
    );
    sourceUrl = "https://drive.google.com/drive/my-drive";
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 8, windowId: 1 });
    await vi.waitFor(() =>
      expect(panelOptions).toHaveBeenLastCalledWith({
        path: "reader.html",
        enabled: false,
      }),
    );
    sourceUrl = url;
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 7, windowId: 1 });
    await vi.waitFor(() =>
      expect(panelOptions).toHaveBeenLastCalledWith({
        path: "reader.html",
        enabled: true,
      }),
    );
    expect(panelOpen).not.toHaveBeenCalled();
  });

  it("ignores a held obsolete unrelated activation after supported Reader opens and preserves its pending work", async () => {
    start();
    await vi.waitFor(() =>
      expect(popup).toHaveBeenLastCalledWith({ tabId: 7, popup: "" }),
    );
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => ({
      id,
      windowId: 1,
      url:
        id === 70
          ? `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7`
          : sourceUrl,
    }));
    const readerSender = {
      id: browser.runtime.id,
      url: `${browser.runtime.getURL("/reader.html" as never)}?sourceTabId=7`,
      tab: { id: 70 },
    };
    await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "WORKSPACE_READER_CONTEXT",
        sourceTabId: 7,
        readerInstanceId: "held-reader",
        requestId: 1,
      },
      readerSender as never,
      vi.fn(),
    );
    let finishTranslation!: (value: {
      results: string[];
      failures: never[];
    }) => void;
    mocks.translate.mockReturnValueOnce(
      new Promise((resolve) => {
        finishTranslation = resolve;
      }),
    );
    const translation = fakeBrowser.runtime.onMessage.trigger(
      {
        type: "LOCAL_SPREADSHEET_TRANSLATE",
        readerInstanceId: "held-reader",
        requestId: 1,
        generation: 1,
        targetLanguage: "vi",
        records: [
          { id: "cell-1", sourceHash: "a".repeat(40), text: "eligible" },
        ],
      },
      readerSender as never,
      vi.fn(),
    );
    await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
    let releaseLookup!: (tab: {
      id: number;
      windowId: number;
      url: string;
    }) => void;
    const held = new Promise<{ id: number; windowId: number; url: string }>(
      (resolve) => {
        releaseLookup = resolve;
      },
    );
    vi.mocked(browser.tabs.get).mockImplementation(async (id) =>
      id === 8 ? held : { id, windowId: 1, url },
    );
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 8, windowId: 1 });
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 7, windowId: 1 });
    await fakeBrowser.action.onClicked.trigger({
      id: 7,
      url,
      windowId: 1,
    } as never);
    expect(panelOpen).toHaveBeenCalledWith({ windowId: 1 });
    releaseLookup({
      id: 8,
      windowId: 1,
      url: "https://example.test/unrelated",
    });
    await held;
    await Promise.resolve();
    expect(panelClose).not.toHaveBeenCalled();
    finishTranslation({ results: ["accepted"], failures: [] });
    const [response] = await translation;
    expect(response).toMatchObject({
      ok: true,
      results: [{ text: "accepted" }],
    });
    expect(panelClose).not.toHaveBeenCalled();
  });

  it("keeps activation ownership independent across windows", async () => {
    start();
    let releaseLookup!: (tab: {
      id: number;
      windowId: number;
      url: string;
    }) => void;
    const held = new Promise<{ id: number; windowId: number; url: string }>(
      (resolve) => {
        releaseLookup = resolve;
      },
    );
    vi.mocked(browser.tabs.get).mockImplementation(async (id) =>
      id === 8 ? held : { id, windowId: 1, url },
    );
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 8, windowId: 2 });
    await fakeBrowser.tabs.onActivated.trigger({ tabId: 7, windowId: 1 });
    releaseLookup({
      id: 8,
      windowId: 2,
      url: "https://example.test/unrelated",
    });
    await vi.waitFor(() =>
      expect(panelClose).toHaveBeenCalledWith({ windowId: 2 }),
    );
    expect(panelClose).not.toHaveBeenCalledWith({ windowId: 1 });
  });
});
