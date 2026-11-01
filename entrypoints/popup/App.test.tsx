import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

const { indexedDbStore, extensionStorageMock } = vi.hoisted(() => {
  const indexedDbStore: Record<string, unknown> = {};
  return {
    indexedDbStore,
    extensionStorageMock: {
      get: vi.fn(async (key: string) => indexedDbStore[key]),
      getMany: vi.fn(async (keys: string[]) =>
        Object.fromEntries(
          keys
            .filter((key) => key in indexedDbStore)
            .map((key) => [key, indexedDbStore[key]]),
        ),
      ),
      getByPrefix: vi.fn(async (prefix: string) =>
        Object.fromEntries(
          Object.entries(indexedDbStore).filter(([key]) =>
            key.startsWith(prefix),
          ),
        ),
      ),
      set: vi.fn(async (key: string, value: unknown) => {
        indexedDbStore[key] = value;
      }),
      setMany: vi.fn(async (entries: Record<string, unknown>) => {
        Object.assign(indexedDbStore, entries);
      }),
      remove: vi.fn(async (keys: string[]) => {
        for (const key of keys) delete indexedDbStore[key];
      }),
    },
  };
});

vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: extensionStorageMock,
}));

// ADR 0015 remote flag; on by default so Reader-mode tests reach the Reader.
const featureMocks = vi.hoisted(() => ({
  sheetsReaderFlag: vi.fn(async () => true),
}));
vi.mock("@/lib/workspace-features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-features")>()),
  readSheetsReaderFlag: featureMocks.sheetsReaderFlag,
}));

import App from "./App";

const YAHOO_NEWS_URL = "https://news.yahoo.co.jp/pickup/6501234";
const SHEETS_URL =
  "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
const WWW_YAHOO_PREF_KEY = "alwaysTranslate:www.yahoo.co.jp";
const WWW_YAHOO_PREF = { enabled: true, targetLanguage: "en" as const };
const AUTH_STATUS = {
  authenticated: true,
  backendConfigured: true,
  user: { id: "user-1", email: "translator@example.com" },
};

function runtimeResponse(message: unknown, detection: unknown) {
  return (message as { type?: string } | undefined)?.type === "AUTH_STATUS"
    ? AUTH_STATUS
    : detection;
}

function mockActiveTab(url: string) {
  vi.spyOn(browser.tabs, "query").mockImplementation(
    async () => [{ id: 1, windowId: 10, url, active: true }] as never,
  );
  vi.spyOn(browser.tabs, "get").mockImplementation(
    async () => ({ id: 1, windowId: 10, url, active: true }) as never,
  );
}

function configureWorkspaceReader(open = vi.fn(async () => undefined)) {
  vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
    manifest_version: 3,
    name: "Readlace",
    version: "0.0.1",
    oauth2: {
      client_id: "123-client.apps.googleusercontent.com",
      scopes: [
        "https://www.googleapis.com/auth/documents.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
    },
  } as never);
  Object.defineProperty(browser, "identity", {
    configurable: true,
    value: {
      getAuthToken: vi.fn(),
      removeCachedAuthToken: vi.fn(),
    },
  });
  const setOptions = vi.fn(async () => undefined);
  Object.defineProperty(browser, "sidePanel", {
    configurable: true,
    value: { setOptions, open },
  });
  return { setOptions, open };
}

function configureWorkspaceWebReader(
  identity: { getRedirectURL?: unknown; launchWebAuthFlow?: unknown } = {
    getRedirectURL: vi.fn(),
    launchWebAuthFlow: vi.fn(),
  },
) {
  vi.stubEnv(
    "WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID",
    "123456789012-readlacereader-web.apps.googleusercontent.com",
  );
  vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
    manifest_version: 3,
    name: "Readlace",
    version: "0.0.1",
  } as never);
  Object.defineProperty(browser, "identity", {
    configurable: true,
    value: identity,
  });
  const setOptions = vi.fn(async () => undefined);
  const open = vi.fn(async () => undefined);
  Object.defineProperty(browser, "sidePanel", {
    configurable: true,
    value: { setOptions, open },
  });
  return { setOptions, open };
}

function messageType(call: unknown[]) {
  return (call[1] as { type?: string } | undefined)?.type;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForPopupReady() {
  await waitFor(() => {
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false");
  });
}

function expectFooterStatus(message?: string) {
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  const status = statuses[0]!;
  expect(status).toHaveAttribute("aria-live", "polite");
  // No divider; an empty footer collapses instead of reserving a row.
  expect(status).toHaveClass("px-4", "text-xs");
  expect(status).not.toHaveClass("border-t");
  expect(status).toBe(screen.getByRole("main").lastElementChild);
  if (message) expect(status).toHaveTextContent(message);
  return status;
}

/** The language row's detected side; its label is for screen readers only. */
function detectedLanguageLine() {
  const label = screen.getByText("Detected language:");
  expect(label).toHaveClass("sr-only");
  return label.parentElement!;
}

/** Opens the header menu (Clear saved translations, language). */
function openAccountMenu() {
  const account = screen.getByRole("button", { name: "Menu" });
  if (account.getAttribute("aria-expanded") !== "true")
    fireEvent.click(account);
}

async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  await user.click(await screen.findByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  for (const key of Object.keys(indexedDbStore)) delete indexedDbStore[key];
  vi.clearAllMocks();
  featureMocks.sheetsReaderFlag.mockResolvedValue(true);
  Reflect.deleteProperty(browser, "identity");
  Reflect.deleteProperty(browser, "sidePanel");
  vi.stubEnv("BROWSER", "chrome");
  vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "");
  vi.spyOn(window, "close").mockImplementation(() => undefined);
  mockActiveTab("https://example.com/page");
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      runtimeResponse(message, { pageLanguage: "English" }) as never,
  );
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockResolvedValue({
      state: "original",
      targetLanguage: "en",
      translated: false,
      hasUnresolved: false,
    }),
  });
  vi.spyOn(browser.scripting, "insertCSS").mockImplementation(
    (async () => undefined) as never,
  );
  vi.spyOn(browser.scripting, "executeScript").mockImplementation(
    (async () => []) as never,
  );
  vi.spyOn(browser.tabs, "reload");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("keeps a full-shell skeleton until parallel bootstrap reads settle", async () => {
  const tab = deferred<{ id: number; url: string; active: boolean }[]>();
  const preference = deferred<Record<string, unknown>>();
  const auth = deferred<typeof AUTH_STATUS>();
  const detection = deferred<{
    pageLanguage: string;
    sourceLanguage: string;
  }>();
  const content = deferred<{
    state: "original";
    targetLanguage: "en";
    translated: false;
    hasUnresolved: false;
  }>();
  vi.mocked(browser.tabs.query).mockImplementation(() => tab.promise as never);
  extensionStorageMock.getMany.mockImplementation(
    () => preference.promise as never,
  );
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    (message) =>
      ((message as { type?: string }).type === "AUTH_STATUS"
        ? auth.promise
        : detection.promise) as never,
  );
  vi.mocked(browser.tabs.sendMessage).mockImplementation(
    () => content.promise as never,
  );

  const { container } = render(<App />);

  expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Loading popup…")).toHaveClass("sr-only");
  expect(container.querySelectorAll(".animate-pulse")).toHaveLength(11);
  for (const fill of container.querySelectorAll(".animate-pulse"))
    expect(fill).toHaveClass("motion-reduce:animate-none", "bg-line");
  // One placeholder per authenticated popup row, including the Spreadsheet
  // tools row, so the ready popup does not shift the layout.
  expect(
    [...container.querySelectorAll("[data-skeleton-row]")].map((row) =>
      row.getAttribute("data-skeleton-row"),
    ),
  ).toEqual(["header", "page", "always", "spreadsheet-tools", "status"]);
  // Always translate sits at the foot of the page card; the empty footer
  // status reserves no row of its own.
  expect(
    container.querySelector('[data-skeleton-row="always"]')?.parentElement,
  ).toHaveAttribute("data-skeleton-row", "page");
  expect(container.querySelector('[data-skeleton-row="status"]')).toHaveClass(
    "-mt-3",
    "px-4",
    "pb-1",
  );
  expect(
    container.querySelector('[data-skeleton-row="status"]'),
  ).toBeEmptyDOMElement();
  expect(
    screen.queryByRole("button", { name: "Sign in" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
  expect(screen.queryByText("Detected language:")).not.toBeInTheDocument();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Translate" }),
  ).not.toBeInTheDocument();
  expect(browser.tabs.query).toHaveBeenCalledOnce();
  expect(extensionStorageMock.getMany).not.toHaveBeenCalledWith([
    "translationProvider",
  ]);
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
    type: "AUTH_STATUS",
  });
  expect(browser.tabs.sendMessage).not.toHaveBeenCalled();

  tab.resolve([{ id: 1, url: "https://example.com/page", active: true }]);
  await waitFor(() => {
    expect(extensionStorageMock.getMany).toHaveBeenCalledWith([
      "alwaysTranslate:example.com",
      "alwaysTranslate:example.com",
    ]);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "DETECT_TAB_LANGUAGE",
      tabId: 1,
    });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      { type: "CONTENT_STATE" },
      { frameId: 0 },
    );
  });

  preference.resolve({
    "alwaysTranslate:example.com": {
      enabled: true,
      targetLanguage: "vi",
    },
  });
  auth.resolve(AUTH_STATUS);
  detection.resolve({ pageLanguage: "Japanese", sourceLanguage: "ja" });
  await Promise.resolve();
  expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

  content.resolve({
    state: "original",
    targetLanguage: "en",
    translated: false,
    hasUnresolved: false,
  });
  await waitForPopupReady();
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Vietnamese");
  expect(detectedLanguageLine()).toHaveTextContent(
    "Detected language: Japanese",
  );
  expect(screen.getByLabelText("Always translate this site")).toBeChecked();
});

test("ignores bootstrap completion after unmount", async () => {
  const auth = deferred<typeof AUTH_STATUS>();
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    (message) =>
      ((message as { type?: string }).type === "AUTH_STATUS"
        ? auth.promise
        : Promise.resolve({ pageLanguage: "English" })) as never,
  );
  const addListener = vi.spyOn(browser.runtime.onMessage, "addListener");
  const removeListener = vi.spyOn(browser.runtime.onMessage, "removeListener");
  const { unmount } = render(<App />);
  expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  const listener = addListener.mock.calls[0]?.[0];

  unmount();
  auth.resolve(AUTH_STATUS);
  await Promise.resolve();
  await Promise.resolve();

  expect(listener).toBeDefined();
  expect(removeListener).toHaveBeenCalledWith(listener);
});

test("cleans up the auth event listener", async () => {
  const addListener = vi.spyOn(browser.runtime.onMessage, "addListener");
  const removeListener = vi.spyOn(browser.runtime.onMessage, "removeListener");
  const { unmount } = render(<App />);
  await waitForPopupReady();
  const listener = addListener.mock.calls[0]?.[0];

  unmount();

  expect(listener).toBeDefined();
  expect(removeListener).toHaveBeenCalledWith(listener);
});

test("blocks translation when the background does not answer", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) => {
    if ((message as { type?: string }).type === "AUTH_STATUS")
      throw new Error("Backend unavailable");
    return { pageLanguage: "English" } as never;
  });
  render(<App />);

  expect(
    await screen.findByText("Translation service is unavailable."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Translate" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open local spreadsheet" }),
  ).not.toBeInTheDocument();
});

test("shows the configured surface with ordered header actions and one reserved footer status", async () => {
  render(<App />);
  await waitForPopupReady();
  expect(screen.getByRole("heading", { name: "Readlace" })).toBeInTheDocument();
  expect(document.querySelector("header svg[data-mark]")).toBeInTheDocument();
  // ADR 0020: no accounts, so no email anywhere.
  expect(screen.queryByText("translator@example.com")).not.toBeInTheDocument();
  expect(detectedLanguageLine()).toHaveTextContent(
    "Detected language: English",
  );
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  const localSpreadsheet = screen.getByRole("button", {
    name: "Open local spreadsheet",
  });
  expect(localSpreadsheet).toContainHTML("svg");
  expect(localSpreadsheet.closest("section")).toHaveAccessibleName(
    "Spreadsheet tools",
  );
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("English");
  // One-line language row: the select label stays for screen readers only.
  expect(screen.getByText("Translate to")).toHaveClass("sr-only");
  // Always translate lives at the foot of the page card.
  expect(
    screen
      .getByRole("switch", { name: "Always translate this site" })
      .closest("section"),
  ).toHaveAccessibleName("This page");
  // Show original appears with the Translation | Original toggle once the
  // page is translated.
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("API key")).not.toBeInTheDocument();
  // Menu actions live behind the header menu button, next to Settings.
  expect(
    screen.getByRole("button", { name: "Settings" }).closest("header"),
  ).not.toBeNull();
  const account = screen.getByRole("button", { name: "Menu" });
  expect(account.closest("header")).not.toBeNull();
  expect(account).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("button", { name: "Clear saved translations" }),
  ).not.toBeInTheDocument();
  fireEvent.click(account);
  expect(account).toHaveAttribute("aria-expanded", "true");
  const clear = screen.getByRole("button", {
    name: "Clear saved translations",
  });
  expect(clear).toContainHTML("svg");
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(clear).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(account).toHaveAttribute("aria-expanded", "false");
  expect(account).toHaveFocus();
  expectFooterStatus();
  expect(browser.scripting.insertCSS).not.toHaveBeenCalled();
  expect(browser.scripting.executeScript).not.toHaveBeenCalled();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});

test.each([true, false])(
  "Google Docs is explicitly unsupported when Reader configuration is %s",
  async (configured) => {
    mockActiveTab("https://docs.google.com/document/d/doc_123/edit");
    const panel = configured ? configureWorkspaceWebReader() : undefined;
    render(<App />);
    await waitForPopupReady();
    expect(
      screen.getByText("Google Docs is temporarily unsupported."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Translate" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Always translate this site"),
    ).not.toBeInTheDocument();
    expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    if (panel) expect(panel.setOptions).not.toHaveBeenCalled();
    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "WORKSPACE_READER_OPEN" }),
    );
  },
);

test("routes an exact Google editor Translate click to the tab side panel and restores old page UI", async () => {
  const user = userEvent.setup();
  const close = vi.mocked(window.close);
  mockActiveTab(SHEETS_URL);
  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 1,
    windowId: 10,
    url: SHEETS_URL,
  } as never);
  indexedDbStore["alwaysTranslate:docs.google.com"] = {
    enabled: true,
    targetLanguage: "vi",
  };
  vi.mocked(browser.tabs.sendMessage).mockResolvedValue({
    state: "partial",
    targetLanguage: "vi",
    translated: true,
    appliedTarget: "vi",
    hasUnresolved: true,
  } as never);
  const { setOptions, open } = configureWorkspaceReader();

  render(<App />);
  await waitForPopupReady();

  expect(setOptions).toHaveBeenCalledWith({
    path: "reader.html",
    enabled: true,
  });
  expect(screen.queryByText("Detected language:")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Always translate this site"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() => expect(open).toHaveBeenCalledWith({ windowId: 10 }));
  await waitFor(() =>
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "WORKSPACE_READER_OPEN",
      sourceTabId: 1,
      sourceWindowId: 10,
    }),
  );
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).toContain("SHOW_ORIGINAL");
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");
  expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "PREPARE_NATIVE_TRANSLATOR" }),
  );
  expect(indexedDbStore["alwaysTranslate:docs.google.com"]).toEqual({
    enabled: true,
    targetLanguage: "vi",
  });
  expect(
    (await browser.storage.session.get("workspaceReaderIntent:1"))[
      "workspaceReaderIntent:1"
    ],
  ).toMatchObject({
    context: {
      kind: "sheets",
      sourceTabId: 1,
      fileId: "sheet_123",
      activeId: "42",
    },
    targetLanguage: "vi",
    account: AUTH_STATUS.user.email,
  });
  expect(close).toHaveBeenCalledOnce();
});

test("a committed auth update permits a new Reader open while old completion cannot reset its busy state", async () => {
  mockActiveTab(SHEETS_URL);
  const firstOpen = deferred<undefined>();
  const secondOpen = deferred<undefined>();
  const { open } = configureWorkspaceWebReader();
  open.mockImplementationOnce(() => firstOpen.promise);
  open.mockImplementationOnce(() => secondOpen.promise);
  render(<App />);
  await waitForPopupReady();
  fireEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();

  await act(async () => {
    await fakeBrowser.runtime.onMessage.trigger(
      { type: "AUTH_STATE_CHANGED" },
      {},
      vi.fn(),
    );
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  await act(async () => {
    firstOpen.resolve(undefined);
  });
  expect(window.close).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
  await act(async () => {
    secondOpen.resolve(undefined);
  });
  await waitFor(() => expect(window.close).toHaveBeenCalledOnce());
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "WORKSPACE_READER_OPEN" }),
  );
});

test("binds one popup click to the sheet that is current when Translate is clicked", async () => {
  const user = userEvent.setup();
  mockActiveTab(SHEETS_URL);
  const { open } = configureWorkspaceReader();
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockResolvedValue({} as never);

  render(<App />);
  await waitForPopupReady();
  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 1,
    url: "https://docs.google.com/spreadsheets/d/sheet_123/edit?gid=41#gid=43",
  } as never);
  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  await waitFor(async () =>
    expect(
      (await browser.storage.session.get("workspaceReaderIntent:1"))[
        "workspaceReaderIntent:1"
      ],
    ).toMatchObject({
      context: {
        kind: "sheets",
        sourceTabId: 1,
        fileId: "sheet_123",
        activeId: "43",
      },
      targetLanguage: "vi",
      account: AUTH_STATUS.user.email,
    }),
  );
  expect(create).not.toHaveBeenCalled();
});

test("closes only after one Reader handoff has opened and persisted", async () => {
  const opening = deferred<undefined>();
  const saving = deferred<void>();
  const open = vi.fn(() => opening.promise);
  const close = vi.mocked(window.close);
  mockActiveTab(SHEETS_URL);
  configureWorkspaceReader(open);
  const sessionSet = vi
    .spyOn(browser.storage.session, "set")
    .mockImplementation(() => saving.promise);

  render(<App />);
  await waitForPopupReady();
  const translate = screen.getByRole("button", { name: "Translate" });
  fireEvent.click(translate);
  fireEvent.click(translate);

  expect(open).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(sessionSet).toHaveBeenCalledTimes(1));
  await act(async () => opening.resolve(undefined));
  expect(close).not.toHaveBeenCalled();
  await act(async () => saving.resolve());
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test("keeps the popup open when Reader intent persistence fails", async () => {
  const user = userEvent.setup();
  const close = vi.mocked(window.close);
  mockActiveTab(SHEETS_URL);
  configureWorkspaceReader();
  vi.spyOn(browser.storage.session, "set").mockRejectedValue(
    new Error("Session storage unavailable"),
  );

  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));

  expect(
    await screen.findByText("Could not open Google Workspace Reader."),
  ).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
});

test("falls back to a source-bound Reader tab only when side panel opening rejects", async () => {
  const user = userEvent.setup();
  const close = vi.mocked(window.close);
  mockActiveTab(SHEETS_URL);
  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 1,
    url: SHEETS_URL,
  } as never);
  const open = vi.fn(async () => {
    throw new Error("Side panel rejected");
  });
  configureWorkspaceReader(open);
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockResolvedValue({} as never);

  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      url: browser.runtime.getURL("/reader.html?sourceTabId=1" as never),
    }),
  );
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");
  expect(close).toHaveBeenCalledOnce();
});

test("creates the fallback Reader tab only after the Translate intent is saved", async () => {
  // The fallback tab takes focus and closes the action popup; an intent that
  // is not saved by then is lost and Reader opens without translating.
  const user = userEvent.setup();
  mockActiveTab(SHEETS_URL);
  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 1,
    url: SHEETS_URL,
  } as never);
  configureWorkspaceReader(
    vi.fn(async () => {
      throw new Error("Side panel rejected");
    }),
  );
  const saving = deferred<void>();
  const sessionSet = vi
    .spyOn(browser.storage.session, "set")
    .mockImplementation(() => saving.promise);
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockResolvedValue({} as never);

  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() => expect(sessionSet).toHaveBeenCalledOnce());
  expect(create).not.toHaveBeenCalled();
  await act(async () => saving.resolve());
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith({
      url: browser.runtime.getURL("/reader.html?sourceTabId=1" as never),
    }),
  );
});

test("offers Reader translation for an explicitly configured web OAuth build", async () => {
  const user = userEvent.setup();
  mockActiveTab(SHEETS_URL);
  const { setOptions, open } = configureWorkspaceWebReader();

  render(<App />);
  await waitForPopupReady();

  expect(setOptions).toHaveBeenCalledWith({
    path: "reader.html",
    enabled: true,
  });
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith({ windowId: 10 }));
});

test("offers Reader before the optional identity permission is granted (ADR 0015)", async () => {
  mockActiveTab(SHEETS_URL);
  // `identity` is optional: its API is absent until Connect grants it.
  configureWorkspaceWebReader({});

  render(<App />);
  await waitForPopupReady();

  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
});

const COMING_SOON = "Reading Google Sheets directly is coming soon.";

test("shows the Sheets coming-soon notice with the Local Reader action while the remote flag is off (ADR 0015)", async () => {
  const user = userEvent.setup();
  featureMocks.sheetsReaderFlag.mockResolvedValue(false);
  mockActiveTab(SHEETS_URL);
  const { setOptions, open } = configureWorkspaceWebReader();
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockResolvedValue({ id: 2 } as never);

  render(<App />);
  await waitForPopupReady();

  const notice = screen.getByRole("region", { name: "Google Sheets" });
  expect(notice).toHaveTextContent(COMING_SOON);
  expect(notice).toHaveTextContent(
    "File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  );
  expect(
    screen.queryByRole("button", { name: "Translate" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getAllByRole("button", { name: "Open local spreadsheet" }),
  ).toHaveLength(1);
  expect(setOptions).not.toHaveBeenCalled();
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");

  await user.click(
    screen.getByRole("button", { name: "Open local spreadsheet" }),
  );
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/reader.html?local=1"),
      }),
    ),
  );
  expect(open).not.toHaveBeenCalled();
});

test("keeps Reader disabled in Firefox even when a web client ID is present", async () => {
  vi.stubEnv("BROWSER", "firefox");
  mockActiveTab(SHEETS_URL);
  configureWorkspaceWebReader();

  render(<App />);
  await waitForPopupReady();

  expect(screen.getByText(COMING_SOON)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Translate" }),
  ).not.toBeInTheDocument();
});

test.each([
  {
    name: "unconfigured",
    configure: () =>
      vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
        manifest_version: 3,
        name: "Readlace",
        version: "0.0.1",
      } as never),
    message: COMING_SOON,
  },
  {
    name: "unsupported",
    configure: () => {
      vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
        manifest_version: 3,
        name: "Readlace",
        version: "0.0.1",
        oauth2: {
          client_id: "123-client.apps.googleusercontent.com",
          scopes: [],
        },
      } as never);
    },
    message: COMING_SOON,
  },
])(
  "shows an explicit $name Reader state without DOM translation",
  async ({ configure, message }) => {
    mockActiveTab(SHEETS_URL);
    configure();

    render(<App />);
    await waitForPopupReady();

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Translate" }),
    ).not.toBeInTheDocument();
    expect(
      vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
    ).not.toContain("START_TRANSLATION");
  },
);

test("keeps non-editor Google pages on ordinary page translation", async () => {
  const user = userEvent.setup();
  const close = vi.mocked(window.close);
  mockActiveTab("https://docs.google.com/spreadsheets/u/0/");

  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() =>
    expect(
      vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
    ).toContain("START_TRANSLATION"),
  );
  expect(close).not.toHaveBeenCalled();
});

test("hides the local spreadsheet tool until a managed account is signed in", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) =>
    (message as { type?: string }).type === "AUTH_STATUS"
      ? ({ authenticated: false, backendConfigured: true } as never)
      : ({ pageLanguage: "English" } as never),
  );

  render(<App />);
  await waitForPopupReady();

  expect(
    screen.queryByRole("button", { name: "Open local spreadsheet" }),
  ).not.toBeInTheDocument();
});

test("keeps healthy content available when language detection fails", async () => {
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      if ((message as { type?: string }).type === "AUTH_STATUS")
        return AUTH_STATUS as never;
      throw new Error("Language detection failed");
    },
  );
  render(<App />);
  await waitForPopupReady();
  expect(detectedLanguageLine()).toHaveTextContent(
    "Detected language: Unknown",
  );
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  expect(browser.scripting.insertCSS).not.toHaveBeenCalled();
});

test("injects packaged CSS then JS once and performs one final content handshake", async () => {
  vi.mocked(browser.tabs.sendMessage)
    .mockRejectedValueOnce(new Error("Could not establish connection"))
    .mockImplementationOnce((async () => ({
      state: "original",
      targetLanguage: "en",
      translated: false,
      hasUnresolved: false,
    })) as never);
  render(<App />);

  await waitFor(() =>
    expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2),
  );
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  expect(browser.tabs.sendMessage).toHaveBeenCalledTimes(2);
  expect(browser.tabs.sendMessage).toHaveBeenNthCalledWith(
    1,
    1,
    { type: "CONTENT_STATE" },
    { frameId: 0 },
  );
  expect(browser.tabs.sendMessage).toHaveBeenNthCalledWith(
    2,
    1,
    { type: "CONTENT_STATE" },
    { frameId: 0 },
  );
  const target = { tabId: 1, allFrames: true };
  expect(browser.scripting.insertCSS).toHaveBeenCalledOnce();
  expect(browser.scripting.insertCSS).toHaveBeenCalledWith({
    target,
    files: ["content-scripts/content.css"],
  });
  expect(browser.scripting.executeScript).toHaveBeenCalledOnce();
  expect(browser.scripting.executeScript).toHaveBeenCalledWith({
    target,
    files: ["/content-scripts/content.js"],
  });
  expect(
    vi.mocked(browser.scripting.insertCSS).mock.invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(browser.scripting.executeScript).mock.invocationCallOrder[0]!,
  );
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});

test("does not inject when CONTENT_STATE fails for a responding runtime", async () => {
  vi.mocked(browser.tabs.sendMessage).mockRejectedValue(
    new Error("Content state handler failed"),
  );
  render(<App />);

  expect(
    await screen.findByText(
      "Translation tools could not be loaded on this page.",
    ),
  ).toBeInTheDocument();
  expect(browser.tabs.sendMessage).toHaveBeenCalledOnce();
  expect(browser.tabs.get).not.toHaveBeenCalled();
  expect(browser.scripting.insertCSS).not.toHaveBeenCalled();
  expect(browser.scripting.executeScript).not.toHaveBeenCalled();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});

test("does not inject into a restricted browser URL", async () => {
  mockActiveTab("chrome://extensions/");
  vi.mocked(browser.tabs.get).mockImplementation((async () => ({
    id: 1,
    url: "chrome://extensions/",
    active: true,
  })) as never);
  vi.mocked(browser.tabs.sendMessage).mockRejectedValue(
    new Error("Cannot access a chrome:// URL"),
  );
  render(<App />);

  expect(
    await screen.findByText("Translation is unavailable on this page."),
  ).toBeInTheDocument();
  expect(browser.tabs.sendMessage).not.toHaveBeenCalled();
  expect(browser.scripting.insertCSS).not.toHaveBeenCalled();
  expect(browser.scripting.executeScript).not.toHaveBeenCalled();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});

test.each([
  ["an ordinary page", "https://example.com/page"],
  ["a restricted Chrome page", "chrome://extensions/"],
  ["an unconfigured Google Sheet", SHEETS_URL],
])(
  "opens Local Spreadsheet Reader from %s without Google state mutation",
  async (_name, url) => {
    const user = userEvent.setup();
    const close = vi.mocked(window.close);
    mockActiveTab(url);
    const create = vi
      .spyOn(browser.tabs, "create")
      .mockResolvedValue({} as never);
    vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
      manifest_version: 3,
      name: "Readlace",
      version: "0.0.1",
    } as never);
    const sessionSet = vi.spyOn(browser.storage.session, "set");

    render(<App />);
    await waitForPopupReady();
    await user.click(
      screen.getByRole("button", { name: "Open local spreadsheet" }),
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      url: browser.runtime.getURL("/reader.html?local=1" as never),
    });
    expect(sessionSet).not.toHaveBeenCalled();
    expect(Reflect.get(browser, "sidePanel")).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  },
);

test("opens Local Spreadsheet Reader only once while tab creation is pending", async () => {
  const opening = deferred<Record<string, never>>();
  const close = vi.mocked(window.close);
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockImplementation(() => opening.promise as never);

  render(<App />);
  await waitForPopupReady();
  const open = screen.getByRole("button", { name: "Open local spreadsheet" });
  fireEvent.click(open);
  fireEvent.click(open);

  expect(create).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Opening local spreadsheet…" }),
  ).toBeDisabled();
  await act(async () => opening.resolve({}));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

test("keeps the popup open when Local Spreadsheet Reader cannot open", async () => {
  const user = userEvent.setup();
  const close = vi.mocked(window.close);
  vi.spyOn(browser.tabs, "create").mockRejectedValue(
    new Error("Tab creation rejected"),
  );

  render(<App />);
  await waitForPopupReady();
  await user.click(
    screen.getByRole("button", { name: "Open local spreadsheet" }),
  );

  expect(
    await screen.findByText(
      "Could not open the local spreadsheet reader. Try again.",
    ),
  ).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
});

test("stops after one failed packaged injection without exposing browser errors", async () => {
  vi.mocked(browser.tabs.sendMessage).mockRejectedValue(
    new Error("Could not establish connection"),
  );
  vi.mocked(browser.scripting.executeScript).mockImplementation((async () => {
    throw new Error("Missing host permission for the tab");
  }) as never);
  render(<App />);

  expect(
    await screen.findByText(
      "Translation tools could not be loaded on this page.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/Missing host permission/i),
  ).not.toBeInTheDocument();
  expect(browser.tabs.sendMessage).toHaveBeenCalledOnce();
  expect(browser.scripting.insertCSS).toHaveBeenCalledOnce();
  expect(browser.scripting.executeScript).toHaveBeenCalledOnce();
  expect(browser.tabs.reload).not.toHaveBeenCalled();
});

test("checking Always translate this site writes preference storage and does not start translation", async () => {
  const user = userEvent.setup();
  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByLabelText("Always translate this site"));
  await waitFor(() => {
    expect(extensionStorageMock.set).toHaveBeenCalledWith(
      "alwaysTranslate:example.com",
      {
        enabled: true,
        targetLanguage: "en",
      },
    );
  });
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");
});

test("keeps cache confirmation and success or failure feedback in the footer", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  let clearAttempts = 0;
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) => {
    if ((message as { type?: string }).type !== "CLEAR_SAVED_TRANSLATIONS")
      return runtimeResponse(message, { pageLanguage: "English" }) as never;
    clearAttempts += 1;
    if (clearAttempts === 2) throw new Error("Storage unavailable");
    return { removed: 2, bytes: 128 } as never;
  });
  render(<App />);
  await waitForPopupReady();
  // Choosing a menu action closes the account menu.
  const clickClear = async () => {
    openAccountMenu();
    await user.click(
      screen.getByRole("button", { name: "Clear saved translations" }),
    );
    expect(
      screen.queryByRole("button", { name: "Clear saved translations" }),
    ).not.toBeInTheDocument();
  };

  await clickClear();
  expect(confirm).toHaveBeenCalledWith(
    "Clear saved translations? Your site preferences will stay saved.",
  );
  expect(clearAttempts).toBe(0);
  expectFooterStatus();

  confirm.mockReturnValue(true);
  await clickClear();
  await waitFor(() => expectFooterStatus("Saved translations cleared."));
  expect(clearAttempts).toBe(1);

  await clickClear();
  await waitFor(() =>
    expectFooterStatus("Could not clear saved translations."),
  );
  expect(clearAttempts).toBe(2);
});

test("disables overlapping actions while saved translations are clearing", async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const clearing = deferred<{ removed: number }>();
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) =>
    (message as { type?: string }).type === "CLEAR_SAVED_TRANSLATIONS"
      ? (clearing.promise as never)
      : (runtimeResponse(message, { pageLanguage: "English" }) as never),
  );
  render(<App />);
  await waitForPopupReady();
  openAccountMenu();
  await user.click(
    screen.getByRole("button", { name: "Clear saved translations" }),
  );

  expectFooterStatus("Clearing saved translations…");
  openAccountMenu();
  const clear = screen.getByRole("button", {
    name: "Clear saved translations",
  });
  expect(clear).toBeDisabled();
  expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();

  await user.click(clear);
  expect(confirm).toHaveBeenCalledOnce();
  expect(
    vi
      .mocked(browser.runtime.sendMessage)
      .mock.calls.filter(
        ([message]) =>
          (message as { type?: string }).type === "CLEAR_SAVED_TRANSLATIONS",
      ),
  ).toHaveLength(1);

  clearing.resolve({ removed: 2 });
  await waitFor(() => expectFooterStatus("Saved translations cleared."));
  expect(clear).toBeEnabled();
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
});

test("Translate sends START_TRANSLATION without frameId", async () => {
  const user = userEvent.setup();
  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => {
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter((call) => messageType(call) === "START_TRANSLATION"),
    ).toEqual([[1, { type: "START_TRANSLATION", targetLanguage: "en" }]]);
  });
});

test("shows loading and disables conflicting actions while translation is pending", async () => {
  const user = userEvent.setup();
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    async (message) =>
      runtimeResponse(message, {
        pageLanguage: "Japanese",
        sourceLanguage: "ja",
      }) as never,
  );
  let finishTranslation!: (value: unknown) => void;
  const pendingTranslation = new Promise((resolve) => {
    finishTranslation = resolve;
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockImplementation(async (_tabId, message) => {
      if ((message as { type?: string }).type === "START_TRANSLATION")
        return pendingTranslation;
      return {
        state: "original",
        targetLanguage: "en",
        translated: false,
        hasUnresolved: false,
      };
    }),
  });
  render(<App />);
  await waitForPopupReady();

  await user.click(screen.getByRole("button", { name: "Translate" }));

  const loading = await screen.findByRole("button", {
    name: "Translating…",
  });
  const status = expectFooterStatus();
  expect(loading.parentElement).not.toContainElement(status);
  expect(status).toBeEmptyDOMElement();
  expect(screen.getAllByText("Translating…")).toEqual([
    loading.firstElementChild,
  ]);
  expect(loading).toBeDisabled();
  expect(loading).toHaveAttribute("aria-busy", "true");
  expect(loading).toHaveAttribute("data-state", "busy");
  expect(loading.querySelector("[data-thread]")).not.toBeNull();
  // Stop is a separate, enabled control while the page run is busy.
  const stop = screen.getByRole("button", {
    name: "Stop translating and show the original",
  });
  expect(stop).toBeEnabled();
  expect(stop).toHaveTextContent("Stop");
  // No card status line while busy.
  expect(document.querySelector("[data-page-status]")).toBeNull();
  const targetLanguage = screen.getByRole("combobox", {
    name: "Translate to",
  });
  expect(targetLanguage).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  openAccountMenu();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeDisabled();

  await user.click(
    screen.getByRole("button", { name: "Clear saved translations" }),
  );
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("SHOW_ORIGINAL");
  expect(confirm).not.toHaveBeenCalled();

  finishTranslation({ state: "partial", appliedTarget: "en" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Translate the rest" }),
    ).toBeEnabled(),
  );
  expect(
    document.querySelector('[data-page-status="partial"]'),
  ).toHaveTextContent("Partly translated.");
  expect(targetLanguage).toBeEnabled();
  expect(screen.getByRole("button", { name: "Show original" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeEnabled();
});

test("trusted Google click starts native preparation before page translation without setup or retry controls", async () => {
  const user = userEvent.setup();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      (message as { type?: string }).type === "PREPARE_NATIVE_TRANSLATOR"
        ? ({
            availability: "downloading",
            ready: false,
            progress: { phase: "downloading", loaded: 0, total: 1 },
          } as never)
        : (runtimeResponse(message, {
            pageLanguage: "ja",
            autoSkipTarget: "ja",
            sourceLanguage: "ja",
          }) as never),
  );
  render(<App />);
  await waitForPopupReady();

  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() => {
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja",
      targetLanguage: "en",
    });
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.some((call) => messageType(call) === "START_TRANSLATION"),
    ).toBe(true);
  });
  const prepareOrder = vi
    .mocked(browser.runtime.sendMessage)
    .mock.invocationCallOrder.find(
      (_, index) =>
        (
          vi.mocked(browser.runtime.sendMessage).mock.calls[index]?.[0] as {
            type?: string;
          }
        )?.type === "PREPARE_NATIVE_TRANSLATOR",
    );
  const startOrder = vi
    .mocked(browser.tabs.sendMessage)
    .mock.invocationCallOrder.find(
      (_, index) =>
        messageType(vi.mocked(browser.tabs.sendMessage).mock.calls[index]!) ===
        "START_TRANSLATION",
    );
  expect(prepareOrder).toBeDefined();
  expect(startOrder).toBeDefined();
  expect(prepareOrder!).toBeLessThan(startOrder!);
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/install|setup/i)).not.toBeInTheDocument();
});

test("trusted Translate click starts native preparation before page translation", async () => {
  const user = userEvent.setup();
  // A provider saved by an earlier build is ignored.
  indexedDbStore.translationProvider = "google";
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      if ((message as { type?: string }).type === "PREPARE_NATIVE_TRANSLATOR") {
        return { availability: "available", ready: true } as never;
      }
      return runtimeResponse(message, {
        pageLanguage: "ja",
        autoSkipTarget: "ja",
        sourceLanguage: "ja",
      }) as never;
    },
  );
  render(<App />);
  await waitForPopupReady();
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Translate" }));

  await waitFor(() => {
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: "PREPARE_NATIVE_TRANSLATOR",
      sourceLanguage: "ja",
      targetLanguage: "en",
    });
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.some((call) => messageType(call) === "START_TRANSLATION"),
    ).toBe(true);
  });
  const prepareIndex = vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.findIndex(
      ([message]) =>
        (message as { type?: string }).type === "PREPARE_NATIVE_TRANSLATOR",
    );
  const startIndex = vi
    .mocked(browser.tabs.sendMessage)
    .mock.calls.findIndex((call) => messageType(call) === "START_TRANSLATION");
  expect(
    vi.mocked(browser.runtime.sendMessage).mock.invocationCallOrder[
      prepareIndex
    ],
  ).toBeLessThan(
    vi.mocked(browser.tabs.sendMessage).mock.invocationCallOrder[startIndex]!,
  );
});

test("reopened popup follows preparing to partial with one terminal-state wait", async () => {
  let finishWait!: (value: unknown) => void;
  const terminalState = new Promise((resolve) => {
    finishWait = resolve;
  });
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockImplementation(async (_tabId, message) =>
      (message as { type?: string }).type === "WAIT_FOR_CONTENT_TERMINAL_STATE"
        ? terminalState
        : {
            state: "preparing",
            targetLanguage: "en",
            translated: false,
            hasUnresolved: true,
            nativeRecoveryProgress: {
              phase: "downloading",
              loaded: 1,
              total: 2,
            },
          },
    ),
  });
  render(<App />);
  await waitForPopupReady();
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(status).not.toHaveClass("sr-only");
  const preparing = screen.getByRole("button", { name: "Preparing…" });
  expect(preparing).toBeDisabled();
  expect(preparing).toHaveAttribute("aria-busy", "true");
  expect(preparing).toHaveAttribute("data-state", "busy");
  expect(
    screen.getByRole("button", {
      name: "Stop translating and show the original",
    }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  openAccountMenu();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter(
          (call) => messageType(call) === "WAIT_FOR_CONTENT_TERMINAL_STATE",
        ),
    ).toEqual([
      [1, { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" }, { frameId: 0 }],
    ]),
  );
  expect(browser.scripting.insertCSS).not.toHaveBeenCalled();
  expect(browser.scripting.executeScript).not.toHaveBeenCalled();

  finishWait({
    state: "partial",
    targetLanguage: "en",
    translated: true,
    appliedTarget: "en",
    hasUnresolved: true,
  });
  // Partial: the card says so and offers the rest; the view switch shows.
  const translateRest = await screen.findByRole("button", {
    name: "Translate the rest",
  });
  expect(translateRest).toBeEnabled();
  expect(translateRest.closest("[data-page-status]")).toHaveAttribute(
    "data-page-status",
    "partial",
  );
  expect(
    screen.queryByRole("button", { name: "Preparing…" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Show translation" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Show original" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeEnabled();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");

  expectFooterStatus();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(
    screen.queryByText("Preparing language support…"),
  ).not.toBeInTheDocument();
});

test("reopened popup follows scroll-triggered translating to translated with one terminal-state wait", async () => {
  let finishWait!: (value: unknown) => void;
  const terminalState = new Promise((resolve) => {
    finishWait = resolve;
  });
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockImplementation(async (_tabId, message) =>
      (message as { type?: string }).type === "WAIT_FOR_CONTENT_TERMINAL_STATE"
        ? terminalState
        : {
            state: "translating",
            targetLanguage: "en",
            translated: true,
            appliedTarget: "en",
            hasUnresolved: true,
          },
    ),
  });
  render(<App />);
  await waitForPopupReady();

  const translating = screen.getByRole("button", { name: "Translating…" });
  expect(translating).toBeDisabled();
  expect(translating).toHaveAttribute("aria-busy", "true");
  // The coral thread runs along the button's bottom edge while busy.
  expect(translating.querySelector("[data-thread]")).toHaveClass(
    "animate-rl-thread",
  );
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  openAccountMenu();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Translate to" })).toBeDisabled();
  expect(
    screen.getByRole("switch", { name: "Always translate this site" }),
  ).toBeEnabled();
  expect(screen.getByRole("main")).not.toHaveClass(
    "m-1",
    "overflow-hidden",
    "rounded-lg",
    "shadow-sm",
  );
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/install|setup/i)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter(
          (call) => messageType(call) === "WAIT_FOR_CONTENT_TERMINAL_STATE",
        ),
    ).toEqual([
      [1, { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" }, { frameId: 0 }],
    ]),
  );
  expect(browser.scripting.insertCSS).not.toHaveBeenCalled();
  expect(browser.scripting.executeScript).not.toHaveBeenCalled();

  finishWait({
    state: "translated",
    targetLanguage: "en",
    translated: true,
    appliedTarget: "en",
    hasUnresolved: false,
  });
  const translated = await screen.findByRole("button", {
    name: "Show translation",
  });
  expect(translated).toHaveAttribute("aria-pressed", "true");
  expect(translated).not.toHaveAttribute("aria-busy", "true");
  expect(
    document.querySelector('[data-page-status="translated"]'),
  ).toHaveTextContent("Translated to English");
  // The pressed side is a no-op: it never restarts translation.
  fireEvent.click(translated);
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");
  expect(screen.getByRole("button", { name: "Show original" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeEnabled();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
});

test("Show original sends SHOW_ORIGINAL without frameId", async () => {
  const user = userEvent.setup();
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockResolvedValue({
      state: "translated",
      targetLanguage: "en",
      translated: true,
      appliedTarget: "en",
      hasUnresolved: false,
    }),
  });
  render(<App />);
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Show original" })).toBeEnabled();
  });
  await user.click(screen.getByRole("button", { name: "Show original" }));
  await waitFor(() => {
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter((call) => messageType(call) === "SHOW_ORIGINAL"),
    ).toEqual([[1, { type: "SHOW_ORIGINAL" }]]);
  });
  // Signed in, the card's status line says it; the footer stays empty.
  await waitFor(() =>
    expect(
      document.querySelector('[data-page-status="original"]'),
    ).toHaveTextContent("Showing the original"),
  );
  expect(expectFooterStatus()).toBeEmptyDOMElement();
});

test("Stop sends SHOW_ORIGINAL without frameId and returns to the idle Translate button", async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  vi.mocked(browser.tabs.sendMessage).mockImplementation(
    async (_tab, message) => {
      const type = (message as { type?: string }).type;
      if (type === "START_TRANSLATION") return pending.promise as never;
      if (type === "SHOW_ORIGINAL") return { ok: true } as never;
      return {
        state: "original",
        targetLanguage: "en",
        translated: false,
        hasUnresolved: false,
      } as never;
    },
  );
  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));
  const stop = await screen.findByRole("button", {
    name: "Stop translating and show the original",
  });
  expect(stop).toBeEnabled();
  expect(stop).toHaveTextContent("Stop");
  expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();

  await user.click(stop);
  await waitFor(() =>
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter((call) => messageType(call) === "SHOW_ORIGINAL"),
    ).toEqual([[1, { type: "SHOW_ORIGINAL" }]]),
  );
  expect(
    await screen.findByRole("button", { name: "Translate" }),
  ).toBeEnabled();
  expectFooterStatus("Translation stopped. The page is back to the original.");
  expect(
    screen.queryByRole("button", { name: "Translating…" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", {
      name: "Stop translating and show the original",
    }),
  ).not.toBeInTheDocument();
  // Stopped is not "Show original": no view switch and no status line.
  expect(
    screen.queryByRole("group", { name: "Page view" }),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-page-status]")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Translate to" })).toBeEnabled();
});

test("a late START_TRANSLATION response after Stop does not flip the popup to translated", async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  vi.mocked(browser.tabs.sendMessage).mockImplementation(
    async (_tab, message) => {
      const type = (message as { type?: string }).type;
      if (type === "START_TRANSLATION") return pending.promise as never;
      if (type === "SHOW_ORIGINAL") return { ok: true } as never;
      return {
        state: "original",
        targetLanguage: "en",
        translated: false,
        hasUnresolved: false,
      } as never;
    },
  );
  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Stop translating and show the original",
    }),
  );
  await screen.findByRole("button", { name: "Translate" });

  await act(async () => {
    pending.resolve({
      state: "translated",
      translated: true,
      appliedTarget: "en",
      hasUnresolved: false,
    });
  });
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Show translation" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-page-status]")).toBeNull();
  expectFooterStatus("Translation stopped. The page is back to the original.");
});

test("a failed Stop reports that the page cannot be translated", async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  vi.mocked(browser.tabs.sendMessage).mockImplementation(
    async (_tab, message) => {
      const type = (message as { type?: string }).type;
      if (type === "START_TRANSLATION") return pending.promise as never;
      if (type === "SHOW_ORIGINAL") throw new Error("Receiving end missing");
      return {
        state: "original",
        targetLanguage: "en",
        translated: false,
        hasUnresolved: false,
      } as never;
    },
  );
  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await user.click(
    await screen.findByRole("button", {
      name: "Stop translating and show the original",
    }),
  );
  await waitFor(() => expectFooterStatus("This page cannot be translated"));
  expect(screen.queryByText(/Translation stopped/)).not.toBeInTheDocument();
});

test("Translate stays enabled when automatic language evidence matches the selected Japanese target", async () => {
  const user = userEvent.setup();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      runtimeResponse(message, {
        pageLanguage: "ja",
        autoSkipTarget: "ja",
      }) as never,
  );
  render(<App />);
  await waitForPopupReady();
  expect(detectedLanguageLine()).toHaveTextContent(
    "Detected language: Japanese",
  );
  expect(screen.queryByText("ja")).not.toBeInTheDocument();
  await chooseOption(user, "Translate to", "Japanese");
  const translate = screen.getByRole("button", { name: "Translate" });
  expect(translate).toBeEnabled();
  await user.click(translate);
  await waitFor(() =>
    expect(
      vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
    ).toContain("START_TRANSLATION"),
  );
});

test("Translate stays enabled when page language is ja but autoSkipTarget is null", async () => {
  const user = userEvent.setup();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      runtimeResponse(message, {
        pageLanguage: "ja",
        autoSkipTarget: null,
      }) as never,
  );
  render(<App />);
  await waitForPopupReady();
  await chooseOption(user, "Translate to", "Japanese");
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
});

test("the applied target shows the view switch and becomes Translate to Vietnamese after selecting Vietnamese", async () => {
  const user = userEvent.setup();
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockResolvedValue({
      state: "translated",
      translated: true,
      targetLanguage: "en",
      appliedTarget: "en",
      hasUnresolved: false,
    }),
  });
  render(<App />);
  await waitForPopupReady();
  const view = screen.getByRole("group", { name: "Page view" });
  const translated = screen.getByRole("button", { name: "Show translation" });
  expect(view).toContainElement(translated);
  expect(translated).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Show original" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Translate" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  await chooseOption(user, "Translate to", "Vietnamese");
  // A different target replaces the view switch with the indigo action.
  const retarget = screen.getByRole("button", {
    name: "Translate to Vietnamese",
  });
  expect(retarget).toBeEnabled();
  expect(
    screen.queryByRole("group", { name: "Page view" }),
  ).not.toBeInTheDocument();
  // The status line still names the language the page is translated to.
  expect(
    document.querySelector('[data-page-status="translated"]'),
  ).toHaveTextContent("Translated to English");
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");
  await user.click(retarget);
  await waitFor(() =>
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter((call) => messageType(call) === "START_TRANSLATION"),
    ).toEqual([[1, { type: "START_TRANSLATION", targetLanguage: "vi" }]]),
  );
});

test("opening popup on news.yahoo.co.jp with a www.yahoo.co.jp preference checks Always translate this site", async () => {
  mockActiveTab(YAHOO_NEWS_URL);
  indexedDbStore[WWW_YAHOO_PREF_KEY] = WWW_YAHOO_PREF;
  render(<App />);
  await waitForPopupReady();
  const checkbox = screen.getByLabelText("Always translate this site");
  expect(checkbox).toBeChecked();
  expect(screen.getByText("Always translate this site")).toBeInTheDocument();
});

test("skip START_TRANSLATION keeps Show original disabled and does not show Translated", async () => {
  const user = userEvent.setup();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      runtimeResponse(message, {
        pageLanguage: "English",
        autoSkipTarget: null,
      }) as never,
  );
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockImplementation(async (_tabId, message) => {
      if ((message as { type?: string }).type === "START_TRANSLATION") {
        return { ok: true, state: "original" };
      }
      return {
        state: "original",
        targetLanguage: "en",
        translated: false,
        hasUnresolved: false,
      };
    }),
  });
  render(<App />);
  await waitForPopupReady();
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => {
    expect(screen.queryByText("Translating…")).not.toBeInTheDocument();
  });
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  expect(document.querySelector("[data-page-status]")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Show translation" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
});

test("same-target partial offers Translate the rest without a Retry control", async () => {
  const user = userEvent.setup();
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockResolvedValue({
      state: "partial",
      targetLanguage: "en",
      translated: true,
      appliedTarget: "en",
      hasUnresolved: true,
    }),
  });
  render(<App />);
  await waitForPopupReady();
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(screen.getByRole("status")).not.toHaveClass("sr-only");
  expect(
    document.querySelector('[data-page-status="partial"]'),
  ).toHaveTextContent("Partly translated.");
  const translate = screen.getByRole("button", {
    name: "Translate the rest",
  });
  expect(translate).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Show translation" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Show original" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

  await user.click(translate);
  await waitFor(() =>
    expect(
      vi
        .mocked(browser.tabs.sendMessage)
        .mock.calls.filter((call) => messageType(call) === "START_TRANSLATION"),
    ).toEqual([[1, { type: "START_TRANSLATION", targetLanguage: "en" }]]),
  );
  await chooseOption(user, "Translate to", "Vietnamese");
  expect(
    screen.getByRole("button", { name: "Translate to Vietnamese" }),
  ).toBeEnabled();
  // The inline action belongs to the same target only.
  expect(
    screen.queryByRole("button", { name: "Translate the rest" }),
  ).not.toBeInTheDocument();
});

test("error state keeps the normal controls with an actionable retry label", async () => {
  Object.assign(browser.tabs, {
    sendMessage: vi.fn().mockResolvedValue({
      state: "error",
      targetLanguage: "en",
      translated: false,
      hasUnresolved: true,
    }),
  });
  render(<App />);
  await waitForPopupReady();
  // The card says it failed; the footer does not repeat page states.
  expect(
    document.querySelector('[data-page-status="error"]'),
  ).toHaveTextContent("Couldn’t translate this page. Try again.");
  expect(screen.getByRole("status")).not.toHaveTextContent(
    "Couldn’t translate this page.",
  );
  const retry = screen.getByRole("button", { name: "Try again" });
  expect(retry).toBeEnabled();
  expect(retry).toHaveAttribute("data-state", "error");
  expect(retry).toContainHTML("svg");
  expect(
    screen.queryByRole("button", { name: "Show original" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: "Always translate this site" }),
  ).toBeInTheDocument();
  openAccountMenu();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeInTheDocument();
});

test("checking Always translate this site on news.yahoo.co.jp writes the canonical yahoo.co.jp key", async () => {
  const user = userEvent.setup();
  mockActiveTab(YAHOO_NEWS_URL);
  render(<App />);
  await waitForPopupReady();
  await user.click(screen.getByLabelText("Always translate this site"));
  await waitFor(() => {
    expect(extensionStorageMock.set).toHaveBeenCalledWith(
      "alwaysTranslate:yahoo.co.jp",
      {
        enabled: true,
        targetLanguage: "en",
      },
    );
  });
  expect(
    vi.mocked(browser.tabs.sendMessage).mock.calls.map(messageType),
  ).not.toContain("START_TRANSLATION");
});

test("Reader popup retains saved preferences and defaults to Vietnamese without changing ordinary page defaults", async () => {
  mockActiveTab(SHEETS_URL);
  configureWorkspaceReader();
  const first = render(<App />);
  await waitForPopupReady();
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Vietnamese");
  await userEvent.click(screen.getByRole("combobox", { name: "Translate to" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Japanese" }),
  );
  expect(indexedDbStore["readerPreferences:v1:targetLanguage"]).toBe("ja");
  expect(indexedDbStore["alwaysTranslate:docs.google.com"]).toBeUndefined();
  first.unmount();
  render(<App />);
  await waitForPopupReady();
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Japanese");
});

test("Reader popup falls back safely when the source window was unavailable at bootstrap", async () => {
  mockActiveTab(SHEETS_URL);
  vi.mocked(browser.tabs.query).mockResolvedValue([
    { id: 1, url: SHEETS_URL, active: true },
  ] as never);
  const { open } = configureWorkspaceReader();
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockResolvedValue({} as never);
  render(<App />);
  await waitForPopupReady();
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(window.close).toHaveBeenCalledOnce());
  expect(open).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith({
    url: expect.stringContaining("reader.html?sourceTabId=1"),
  });
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
    type: "WORKSPACE_READER_OPEN",
    sourceTabId: 1,
    sourceWindowId: 10,
  });
});
