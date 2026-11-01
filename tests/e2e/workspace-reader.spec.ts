import {
  expect,
  test,
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
  type Worker,
} from "@playwright/test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { routeE2EProvider } from "@/e2e/provider-stage";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

const extensionPath = path.resolve(
  process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const backendUrl = "https://api.example.test";
const refreshTokenKey = "auth:v1:refresh-token";
const googleToken = "deterministic-google-token";
// ADR 0015: the launch scope set is exactly `spreadsheets.readonly`.
const googleScopes = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const;
// ADR 0015: `identity` and the Sheets API host are optional permissions.
const workspaceOptionalPermissions = ["identity"] as const;
const workspaceOptionalOrigins = ["https://sheets.googleapis.com/*"] as const;
// ADR 0015: the Drive Office workbook path needs a Drive scope, so it is off
// at launch (`office-download-required`). These scenarios are kept, not
// deleted, and return with the `drive.file` + Google Picker release.
const DRIVE_OFFICE_DEFERRED =
  "Drive Office workbook path is disabled at launch (ADR 0015); returns with the drive.file + Google Picker release.";
const webClientId =
  "123456789012-readlacereader-web.apps.googleusercontent.com";

interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
  userDataDir: string;
}

interface MockState {
  /** Served by `GET /v1/features` (ADR 0015 remote flag). */
  features: { workspaceSheetsReader: boolean };
  providerCalls: number;
  providerPending: number;
  maxProviderPending: number;
  providerRequests: string[][];
  backendArtifacts: string[];
  googleCalls: string[];
  unexpected: string[];
  translate(sources: string[]): Promise<string[]>;
}

interface IdentityMockSnapshot {
  mode: "native" | "web";
  getAuthTokenCalls: number;
  removeCachedAuthTokenCalls: number;
  redirectPaths: string[];
  webFlows: {
    interactive: boolean;
    returnedState: string;
    returnedUrl: string;
    url: string;
  }[];
}

interface ProtocolResponse<T> {
  id: number;
  result?: T;
  error?: unknown;
}

class ActionPopup {
  private commandId = 0;

  constructor(
    private readonly control: CDPSession,
    private readonly sessionId: string,
  ) {}

  async send<T>(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.commandId;
    return new Promise<T>((resolve, reject) => {
      const listener = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== this.sessionId) return;
        const response = JSON.parse(event.message) as ProtocolResponse<T>;
        if (response.id !== id) return;
        this.control.off("Target.receivedMessageFromTarget", listener);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result as T);
      };
      this.control.on("Target.receivedMessageFromTarget", listener);
      void this.control
        .send("Target.sendMessageToTarget", {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(reject);
    });
  }

  async evaluate<T>(expression: string) {
    const response = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.result.description ?? "Popup evaluation failed.",
      );
    }
    return response.result.value as T;
  }
}

async function executablePath() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : undefined,
    process.platform === "win32"
      ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed Chromium candidate.
    }
  }
  throw new Error("Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.");
}

async function launchExtension({
  workspaceSheetsReader = true,
}: { workspaceSheetsReader?: boolean } = {}): Promise<ExtensionSession> {
  const executable = await executablePath();
  await access(extensionPath);
  const userDataDir = await mkdtemp(path.join(tmpdir(), "readlace-reader-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: executable,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  // The worker reads the remote Sheets Reader flag at startup (ADR 0015),
  // before a test installs its backend mocks; serve it before loading.
  // `installMocks` serves later reads from its own state.
  await context.route(`${backendUrl}/v1/features`, (route) =>
    route.fulfill({ json: { workspaceSheetsReader } }),
  );
  const browser = context.browser();
  if (!browser) throw new Error("Installed Chrome browser is unavailable.");
  const session = await browser.newBrowserCDPSession();
  const { id: loadedExtensionId } = (await session.send(
    "Extensions.loadUnpacked",
    { path: extensionPath },
  )) as { id: string };
  await session.detach();
  const isLoadedExtension = (candidate: Worker) =>
    candidate.url().startsWith(`chrome-extension://${loadedExtensionId}/`);
  let worker = context.serviceWorkers().find(isLoadedExtension);
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", {
      predicate: isLoadedExtension,
      timeout: 30_000,
    });
  }
  return {
    context,
    extensionId: loadedExtensionId,
    worker,
    userDataDir,
  };
}

async function closeExtension(session: ExtensionSession) {
  await session.context.close();
  await rm(session.userDataDir, { force: true, recursive: true });
}

async function stopExtensionWorker(session: ExtensionSession) {
  const browser = session.context.browser();
  if (!browser) throw new Error("Installed Chrome browser is unavailable.");
  const control = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = (await control.send("Target.getTargets", {
      filter: [{ type: "service_worker" }],
    })) as {
      targetInfos: { targetId: string; type: string; url: string }[];
    };
    const target = targetInfos.find(
      ({ type, url }) =>
        type === "service_worker" &&
        url.startsWith(`chrome-extension://${session.extensionId}/`),
    );
    if (!target)
      throw new Error("Extension service worker target unavailable.");
    await control.send("Target.closeTarget", { targetId: target.targetId });
  } finally {
    await control.detach();
  }
}

async function builtAuthMode() {
  const manifest = JSON.parse(
    await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
  ) as { oauth2?: unknown; optional_permissions?: string[] };
  // ADR 0015: a web Reader build lists `identity` only as optional.
  return manifest.oauth2
    ? ("native" as const)
    : manifest.optional_permissions?.includes("identity")
      ? ("web" as const)
      : ("disabled" as const);
}

/**
 * ADR 0015: Reader requests optional `identity` + the Sheets API host inside
 * the Connect click. The harness grants them up front, from a real user
 * gesture in an extension page, so the worker exposes `chrome.identity` for
 * the deterministic OAuth mock. Chrome grants both without a prompt: the
 * `identity` permission has no warning and `<all_urls>` already covers the
 * host. The Connect click then finds them granted.
 */
async function grantWorkspacePermissions(session: ExtensionSession) {
  if ((await builtAuthMode()) !== "web") return false;
  const page = await session.context.newPage();
  try {
    await page.goto(`chrome-extension://${session.extensionId}/popup.html`);
    const cdp = await session.context.newCDPSession(page);
    try {
      const response = (await cdp.send("Runtime.evaluate", {
        expression: `chrome.permissions.request(${JSON.stringify({
          permissions: workspaceOptionalPermissions,
          origins: workspaceOptionalOrigins,
        })})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      })) as { result: { value?: unknown } };
      return response.result.value === true;
    } finally {
      await cdp.detach();
    }
  } finally {
    await page.close();
  }
}

async function setExtensionStorage(page: Page, key: string, value: unknown) {
  await page.evaluate(
    ({ key, value }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("web-page-translation", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("kv");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction("kv", "readwrite");
          transaction.objectStore("kv").put(value, key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { key, value },
  );
}

async function sourceTabId(session: ExtensionSession, url: string) {
  const setup = await session.context.newPage();
  await setup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await setExtensionStorage(setup, refreshTokenKey, "mock-refresh");
  const id = await setup.evaluate(async (sourceUrl) => {
    const runtime = globalThis as unknown as {
      chrome: {
        tabs: {
          query(
            options: Record<string, never>,
          ): Promise<{ id?: number; url?: string }[]>;
        };
      };
    };
    const tabs = await runtime.chrome.tabs.query({});
    return tabs.find(
      (tab: { id?: number; url?: string }) => tab.url === sourceUrl,
    )?.id;
  }, url);
  await setup.close();
  if (id === undefined) throw new Error(`No source tab found for ${url}`);
  return id;
}

async function mockGoogleIdentity(
  session: ExtensionSession,
  webResult: "success" | "denied" | "malformed" = "success",
) {
  if ((await builtAuthMode()) === "web") {
    expect(await grantWorkspacePermissions(session)).toBe(true);
    // A granted optional API appears in the running worker's bindings.
    await expect
      .poll(() =>
        session.worker.evaluate(() =>
          Boolean(
            (globalThis as unknown as { chrome: { identity?: unknown } }).chrome
              .identity,
          ),
        ),
      )
      .toBe(true);
  }
  await installSheetsIdentification(session.worker, false);
  return session.worker.evaluate((webResult) => {
    const runtime = globalThis as unknown as {
      chrome: {
        identity: {
          getAuthToken?: unknown;
          getRedirectURL?: unknown;
          launchWebAuthFlow?: unknown;
          removeCachedAuthToken?: unknown;
        };
        runtime: {
          getManifest(): { oauth2?: unknown };
          id: string;
        };
      };
      __workspaceIdentityMock?: IdentityMockSnapshot;
    };
    const identity = runtime.chrome.identity;
    const mode = runtime.chrome.runtime.getManifest().oauth2 ? "native" : "web";
    const calls: IdentityMockSnapshot = {
      mode,
      getAuthTokenCalls: 0,
      removeCachedAuthTokenCalls: 0,
      redirectPaths: [],
      webFlows: [],
    };
    runtime.__workspaceIdentityMock = calls;
    const getAuthToken = async () => {
      calls.getAuthTokenCalls += 1;
      return { token: "deterministic-google-token" };
    };
    const removeCachedAuthToken = async () => {
      calls.removeCachedAuthTokenCalls += 1;
    };
    const getRedirectURL = (path = "") => {
      calls.redirectPaths.push(path);
      return `https://${runtime.chrome.runtime.id}.chromiumapp.org/${path}`;
    };
    const launchWebAuthFlow = async ({
      interactive,
      url,
    }: {
      interactive: boolean;
      url: string;
    }) => {
      const authorization = new URL(url);
      const state = authorization.searchParams.get("state") ?? "";
      const result =
        webResult === "denied"
          ? new URLSearchParams({ error: "access_denied", state })
          : new URLSearchParams({
              access_token: "deterministic-google-token",
              token_type: "Bearer",
              expires_in: "3600",
              scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
              state: webResult === "malformed" ? "wrong-state" : state,
            });
      const returnedUrl = `https://${runtime.chrome.runtime.id}.chromiumapp.org/google-workspace#${result}`;
      calls.webFlows.push({
        interactive,
        returnedState: state,
        returnedUrl,
        url,
      });
      return returnedUrl;
    };
    try {
      if (mode === "native") {
        Object.defineProperty(identity, "getAuthToken", {
          configurable: true,
          value: getAuthToken,
        });
        Object.defineProperty(identity, "removeCachedAuthToken", {
          configurable: true,
          value: removeCachedAuthToken,
        });
      } else {
        Object.defineProperty(identity, "getRedirectURL", {
          configurable: true,
          value: getRedirectURL,
        });
        Object.defineProperty(identity, "launchWebAuthFlow", {
          configurable: true,
          value: launchWebAuthFlow,
        });
      }
    } catch {
      return false;
    }
    return mode === "native"
      ? identity.getAuthToken === getAuthToken &&
          identity.removeCachedAuthToken === removeCachedAuthToken
      : identity.getRedirectURL === getRedirectURL &&
          identity.launchWebAuthFlow === launchWebAuthFlow;
  }, webResult);
}

async function identityMockSnapshot(worker: Worker) {
  return worker.evaluate(() => {
    const runtime = globalThis as unknown as {
      __workspaceIdentityMock?: IdentityMockSnapshot;
    };
    return runtime.__workspaceIdentityMock;
  });
}

async function connectReaderIfNeeded(reader: Page) {
  if ((await builtAuthMode()) !== "web") return;
  await expect(reader.locator("main.reader-shell")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const connect = reader.getByRole("button", {
    name: "Connect Google Workspace",
  });
  if (await connect.isVisible()) await connect.click();
}

async function captureReaderMessages(reader: Page) {
  await reader.addInitScript(() => {
    const runtime = globalThis as unknown as {
      __workspaceReaderMessages?: unknown[];
      chrome: {
        runtime: {
          sendMessage(...args: unknown[]): Promise<unknown>;
        };
      };
    };
    const messages: unknown[] = [];
    const sendMessage = runtime.chrome.runtime.sendMessage.bind(
      runtime.chrome.runtime,
    );
    runtime.__workspaceReaderMessages = messages;
    runtime.chrome.runtime.sendMessage = async (...args: unknown[]) => {
      const response = await sendMessage(...args);
      messages.push({ request: args[0], response });
      return response;
    };
  });
}

async function installMocks(
  context: BrowserContext,
  { workspaceSheetsReader = true }: { workspaceSheetsReader?: boolean } = {},
) {
  const state: MockState = {
    features: { workspaceSheetsReader },
    providerCalls: 0,
    providerPending: 0,
    maxProviderPending: 0,
    providerRequests: [],
    backendArtifacts: [],
    googleCalls: [],
    unexpected: [],
    translate: async (sources) => sources.map(() => "<b>translated-result</b>"),
  };
  await context.route("**/*", (route) => {
    if (route.request().url().startsWith("chrome-extension://")) {
      return route.continue();
    }
    state.unexpected.push(route.request().url());
    return route.abort();
  });
  const handleBackend = async (route: Route) => {
    // ADR 0015 remote flag: public, carries no account or Google data.
    if (new URL(route.request().url()).pathname === "/v1/features") {
      await route.fulfill({ json: { ...state.features } });
      return;
    }
    state.backendArtifacts.push(
      JSON.stringify({
        body: route.request().postData(),
        headers: await route.request().allHeaders(),
        url: route.request().url(),
      }),
    );
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/v1/auth/refresh" || pathname === "/v1/auth/login") {
      await route.fulfill({
        json: {
          accessToken: "mock-access",
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "mock-refresh-next",
          refreshExpiresAt: "2099-02-01T00:00:00.000Z",
        },
      });
      return;
    }
    if (pathname === "/v1/me") {
      await route.fulfill({
        json: {
          authenticated: true,
          user: { id: "mock-user", email: "reader@example.test" },
        },
      });
      return;
    }
    // One routed backend stage; Reader never names an engine.
    if (pathname === "/v1/translation-stages") {
      state.providerCalls += 1;
      state.providerPending += 1;
      state.maxProviderPending = Math.max(
        state.maxProviderPending,
        state.providerPending,
      );
      const body = route.request().postDataJSON() as {
        sources: string[][];
      } & Record<string, unknown>;
      if ("provider" in body) state.unexpected.push("provider-in-stage-body");
      const sources = body.sources.flat();
      state.providerRequests.push(sources);
      try {
        const translated = await state.translate(sources);
        await route.fulfill({
          json: {
            results: [translated],
            provenance: [
              translated.map((value, index) =>
                value.trim() && value !== sources[index] ? "openai" : null,
              ),
            ],
            failures: [],
            diagnostics: {
              records: body.sources.flat().length,
              sourceCharacters: body.sources.flat().join("").length,
              requestCount: 1,
              requestMs: 1,
            },
          },
        });
      } finally {
        state.providerPending -= 1;
      }
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  };
  await context.route(`${backendUrl}/v1/**`, handleBackend);
  // ADR 0020: translation goes to OpenAI with the user's key; this stub
  // answers it through the stage adapter.
  await routeE2EProvider(context, handleBackend);
  // ADR 0015: launch identification uses the Sheets API, never Drive; a
  // Drive request falls through to the catch-all and is recorded unexpected.
  return state;
}

/** Launch source identification (ADR 0015): `fields=spreadsheetId,properties(title)`. */
function isSheetsIdentification(url: URL) {
  return (
    url.origin === "https://sheets.googleapis.com" &&
    /^\/v4\/spreadsheets\/[^/]+$/.test(url.pathname) &&
    url.searchParams.get("fields") === "spreadsheetId,properties(title)"
  );
}

function sheetsIdentification(fileId: string) {
  return {
    spreadsheetId: fileId,
    properties: {
      title: fileId === "sheet_456" ? "Native B fixture" : "Native fixture",
    },
  };
}

function sheetMetadata(rowCount = 150, columnCount = 1) {
  return {
    spreadsheetId: "sheet_123",
    sheets: [
      {
        properties: {
          sheetId: 42,
          title: "Active sheet",
          sheetType: "GRID",
          rightToLeft: false,
          gridProperties: {
            rowCount,
            columnCount,
            frozenRowCount: 0,
            frozenColumnCount: 0,
            hideGridlines: false,
          },
        },
      },
    ],
  };
}

function sheetGridMetadata(rowCount = 150) {
  const metadata = sheetMetadata(rowCount);
  return {
    ...metadata,
    sheets: [
      {
        ...metadata.sheets[0],
        merges: [],
        data: [
          {
            startColumn: 0,
            columnMetadata: [{ pixelSize: 100 }],
          },
        ],
      },
    ],
  };
}

function sheetPage(startRow = 0, source = "こんにちは") {
  return {
    ...sheetMetadata(),
    sheets: [
      {
        ...sheetMetadata().sheets[0],
        data: [
          {
            startRow,
            startColumn: 0,
            rowData: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: source },
                    effectiveValue: { stringValue: source },
                    formattedValue: source,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const switchSheets = [
  { id: 42, title: "Sheet A", source: "Source A" },
  { id: 43, title: "Sheet B", source: "Source B" },
  { id: 44, title: "Sheet C", source: "Source C" },
  { id: 45, title: "Sheet D", source: "Source D" },
] as const;

function switchingSheetProperties(sheet: (typeof switchSheets)[number]) {
  return {
    sheetId: sheet.id,
    title: sheet.title,
    sheetType: "GRID",
    rightToLeft: false,
    gridProperties: {
      rowCount: 150,
      columnCount: 1,
      frozenRowCount: 0,
      frozenColumnCount: 0,
      hideGridlines: false,
    },
  };
}

function switchingMetadata() {
  return {
    spreadsheetId: "sheet_123",
    sheets: switchSheets.map((sheet) => ({
      properties: switchingSheetProperties(sheet),
    })),
  };
}

function switchingGridMetadata(sheet: (typeof switchSheets)[number]) {
  return {
    spreadsheetId: "sheet_123",
    sheets: [
      {
        properties: switchingSheetProperties(sheet),
        merges: [],
        data: [{ startColumn: 0, columnMetadata: [{ pixelSize: 100 }] }],
      },
    ],
  };
}

function switchingPage(sheet: (typeof switchSheets)[number]) {
  return {
    spreadsheetId: "sheet_123",
    sheets: [
      {
        properties: switchingSheetProperties(sheet),
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              {
                values: [
                  {
                    userEnteredValue: { stringValue: sheet.source },
                    effectiveValue: { stringValue: sheet.source },
                    formattedValue: sheet.source,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function sheetFromRequest(url: URL) {
  const requestText = decodeURIComponent(
    `${url.pathname} ${url.searchParams.get("ranges") ?? ""}`,
  );
  return switchSheets.find(({ title }) => requestText.includes(`'${title}'`));
}

async function fulfillSwitchingSheet(route: Route, state: MockState) {
  const request = route.request();
  const url = new URL(request.url());
  state.googleCalls.push(url.href);
  const sheet = sheetFromRequest(url);
  if (url.pathname.includes("/values/")) {
    if (!sheet) throw new Error(`Missing sheet in discovery URL ${url.href}`);
    await route.fulfill({
      json: { majorDimension: "COLUMNS", values: [[sheet.source]] },
    });
    return;
  }
  if (url.searchParams.get("includeGridData") === "true") {
    if (!sheet) throw new Error(`Missing sheet in page URL ${url.href}`);
    await route.fulfill({ json: switchingPage(sheet) });
    return;
  }
  await route.fulfill({
    json: sheet ? switchingGridMetadata(sheet) : switchingMetadata(),
  });
}

async function fulfillBasicSheet(
  route: Route,
  state: MockState,
  sources: { first?: string; second?: string } = {},
) {
  const request = route.request();
  const url = new URL(request.url());
  const fileId = /spreadsheets\/([^/]+)/.exec(url.pathname)?.[1] ?? "sheet_123";
  // A restarted worker loses `installSheetsIdentification`; answer the
  // launch identification here, uncounted like the worker mock.
  if (isSheetsIdentification(url)) {
    await route.fulfill({ json: sheetsIdentification(fileId) });
    return;
  }
  state.googleCalls.push(url.href);
  if (url.pathname.includes("/values/")) {
    await route.fulfill({
      json: {
        majorDimension: "COLUMNS",
        values: [[sources.first ?? "こんにちは"]],
      },
    });
    return;
  }
  const range = url.searchParams.get("ranges");
  if (url.searchParams.get("includeGridData") === "true") {
    const second = range?.includes("101:150") ?? false;
    await route.fulfill({
      json: {
        ...sheetPage(
          second ? 100 : 0,
          second
            ? (sources.second ?? "次のページ")
            : (sources.first ?? "こんにちは"),
        ),
        spreadsheetId: fileId,
      },
    });
    return;
  }
  await route.fulfill({
    json: {
      ...(range ? sheetGridMetadata() : sheetMetadata()),
      spreadsheetId: fileId,
    },
  });
}

function gridProofMetadata() {
  const metadata = sheetMetadata(300, 64);
  metadata.sheets[0]!.properties.rightToLeft = true;
  metadata.sheets[0]!.properties.gridProperties.frozenRowCount = 1;
  metadata.sheets[0]!.properties.gridProperties.frozenColumnCount = 1;
  return metadata;
}

function gridProofCell(value: string, wrap = false) {
  return {
    userEnteredValue: { stringValue: value },
    effectiveValue: { stringValue: value },
    formattedValue: value,
    effectiveFormat: wrap ? { wrapStrategy: "WRAP" } : {},
  };
}

function gridProofPage(startRow: number, rowCount: number) {
  const metadata = gridProofMetadata();
  const endRow = startRow + rowCount;
  const data: unknown[] = [];
  if (startRow === 0) {
    const firstRow = Array.from({ length: 27 }, () => ({}));
    firstRow[0] = gridProofCell("A source\nwrapped", true);
    firstRow[2] = gridProofCell("C source");
    firstRow[5] = gridProofCell(
      '<img src=x onerror="globalThis.readerPwned=true"><script>bad()</script>',
    );
    firstRow[25] = gridProofCell("Z source");
    firstRow[26] = gridProofCell("AA source");
    data.push({ startRow: 0, startColumn: 0, rowData: [{ values: firstRow }] });
  }
  if (startRow <= 1 && endRow > 1) {
    data.push({
      startRow: 1,
      startColumn: 0,
      rowMetadata: [{ pixelSize: 1_200 }],
      rowData: [
        {
          values: [
            {
              effectiveValue: { numberValue: 1 },
              formattedValue: "Merged display",
            },
          ],
        },
      ],
    });
  }
  if (startRow <= 2 && endRow > 2) {
    data.push({
      startRow: 2,
      startColumn: 0,
      rowMetadata: [{ pixelSize: 21 }],
      rowData: [
        {
          values: [
            {
              userEnteredValue: { numberValue: 3 },
              effectiveValue: { numberValue: 3 },
              formattedValue: "3",
            },
          ],
        },
      ],
    });
  }
  const pageStart = Math.floor(startRow / 100) * 100;
  const pressureStart = Math.max(pageStart + 60, startRow);
  if (pressureStart < endRow) {
    data.push({
      startRow: pressureStart,
      startColumn: 3,
      rowData: Array.from({ length: endRow - pressureStart }, (_, index) => ({
        values: [
          {
            effectiveValue: {
              errorValue: {
                type: "ERROR",
                message: `${pressureStart + index}:`.padEnd(2_200, "x"),
              },
            },
          },
        ],
      })),
    });
  }
  return {
    ...metadata,
    sheets: [{ ...metadata.sheets[0], data }],
  };
}

function docsPage() {
  return {
    documentId: "doc_123",
    tabs: [
      {
        tabProperties: { tabId: "t.root", title: "Overview" },
        documentTab: {
          body: {
            content: [
              {
                startIndex: 1,
                paragraph: {
                  elements: [{ textRun: { content: "Overview text\n" } }],
                },
              },
            ],
          },
        },
        childTabs: [
          {
            tabProperties: {
              tabId: "t.child",
              title: "Details",
              parentTabId: "t.root",
            },
            documentTab: {
              body: {
                content: [
                  {
                    startIndex: 2,
                    paragraph: {
                      elements: [{ textRun: { content: "Details text\n" } }],
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
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function routeSyntheticEditor(
  context: BrowserContext,
  url: string,
  label: string,
) {
  await context.route(url.split("#")[0]!, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body><main id="editor">${label}</main></body></html>`,
    }),
  );
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

async function openActionPopup(
  context: BrowserContext,
  extensionId: string,
  source: Page,
  forcePopup = false,
) {
  await source.bringToFront();
  if (forcePopup) {
    const worker = context
      .serviceWorkers()
      .find((candidate) =>
        candidate.url().startsWith(`chrome-extension://${extensionId}/`),
      );
    if (!worker) throw new Error("Fixture extension worker missing");
    await worker.evaluate(async (sourceUrl) => {
      const runtime = globalThis as unknown as {
        chrome: {
          tabs: {
            query(query: object): Promise<{ id: number; url?: string }[]>;
          };
          action: {
            setPopup(options: { tabId: number; popup: string }): Promise<void>;
          };
        };
      };
      const tabs = await runtime.chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === sourceUrl);
      if (!tab) throw new Error("Fixture popup source missing");
      // Signed-in supported editors route the normal toolbar to Reader. This
      // fixture deliberately exercises the popup's fallback handoff instead.
      await runtime.chrome.action.setPopup({
        tabId: tab.id,
        popup: "popup.html",
      });
    }, source.url());
  }
  const browser = context.browser();
  if (!browser) throw new Error("Installed Chrome browser is unavailable.");
  const control = await browser.newBrowserCDPSession();
  const { targetInfos } = (await control.send("Target.getTargets", {
    filter: [{}],
  })) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const sourceTarget = targetInfos.find(
    (target) => target.type === "tab" && target.url === source.url(),
  );
  if (!sourceTarget) throw new Error(`No tab target matched ${source.url()}`);
  const before = new Set(targetInfos.map(({ targetId }) => targetId));
  const action = await browser.newBrowserCDPSession();
  void action.send("Extensions.triggerAction", {
    id: extensionId,
    targetId: sourceTarget.targetId,
  });
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  let popupTarget: { targetId: string } | undefined;
  await expect
    .poll(async () => {
      const current = (await control.send("Target.getTargets", {
        filter: [{}],
      })) as {
        targetInfos: { targetId: string; type: string; url: string }[];
      };
      popupTarget = current.targetInfos.find(
        (target) =>
          target.type === "page" &&
          target.url === popupUrl &&
          !before.has(target.targetId),
      );
      return Boolean(popupTarget);
    })
    .toBe(true);
  const { sessionId } = (await control.send("Target.attachToTarget", {
    targetId: popupTarget!.targetId,
  })) as { sessionId: string };
  return {
    popup: new ActionPopup(control, sessionId),
    isOpen: async () => {
      const current = (await control.send("Target.getTargets", {
        filter: [{}],
      })) as {
        targetInfos: { targetId: string }[];
      };
      return current.targetInfos.some(
        ({ targetId }) => targetId === popupTarget!.targetId,
      );
    },
    close: async () => {
      for (const session of [control, action]) {
        try {
          await session.detach();
        } catch (error) {
          // A successful handoff closes its popup target before cleanup.
          if (
            !/Target page, context or browser has been closed/.test(
              String(error),
            )
          )
            throw error;
        }
      }
    },
  };
}

/**
 * Serves launch source identification (ADR 0015) inside the worker, so test
 * routes keep counting only Reader metadata, discovery and page requests.
 * Native file IDs return their title; an `office_*` ID is a Drive-stored
 * Office workbook, which the Sheets API refuses with 400, so Reader shows
 * the download guidance (`office-download-required`). Idempotent per worker;
 * `reset` clears the recorded identification calls.
 */
async function installSheetsIdentification(worker: Worker, reset: boolean) {
  await worker.evaluate((reset) => {
    const runtime = globalThis as typeof globalThis & {
      __sourceMetadataCalls?: string[];
      __holdSourceMetadataFileId?: string;
      __releaseSourceMetadata?: () => void;
      __sourceMetadataFailureStatus?: number;
      __sheetsIdentificationInstalled?: boolean;
    };
    if (reset || !runtime.__sourceMetadataCalls)
      runtime.__sourceMetadataCalls = [];
    if (runtime.__sheetsIdentificationInstalled) return;
    runtime.__sheetsIdentificationInstalled = true;
    const original = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      if (
        url.origin !== "https://sheets.googleapis.com" ||
        !/^\/v4\/spreadsheets\/[^/]+$/.test(url.pathname) ||
        url.searchParams.get("fields") !== "spreadsheetId,properties(title)"
      )
        return original(input, init);
      const fileId = decodeURIComponent(url.pathname.split("/").at(-1)!);
      runtime.__sourceMetadataCalls!.push(url.href);
      if (runtime.__holdSourceMetadataFileId === fileId)
        await new Promise<void>((resolve) => {
          runtime.__releaseSourceMetadata = resolve;
        });
      const response = runtime.__sourceMetadataFailureStatus
        ? Response.json(
            { error: { message: "Deterministic Google failure" } },
            { status: runtime.__sourceMetadataFailureStatus },
          )
        : fileId.startsWith("office_")
          ? Response.json(
              {
                error: {
                  code: 400,
                  message: "This operation is not supported for this document",
                  status: "FAILED_PRECONDITION",
                },
              },
              { status: 400 },
            )
          : Response.json({
              spreadsheetId: fileId,
              properties: {
                title:
                  fileId === "sheet_456"
                    ? "Native B fixture"
                    : "Native fixture",
              },
            });
      Object.defineProperty(response, "url", { value: url.href });
      return response;
    };
  }, reset);
}

/**
 * Resets launch identification for a (possibly restarted) worker. Workbook
 * bytes are accepted for the deferred Drive Office scenarios, which return
 * with the `drive.file` + Google Picker release; launch never downloads.
 */
async function mockSourceMetadata(
  session: ExtensionSession,
  workbookBytes?: Buffer,
) {
  if (workbookBytes) test.skip(true, DRIVE_OFFICE_DEFERRED);
  await installSheetsIdentification(session.worker, true);
}

async function toolbarOptions(session: ExtensionSession, tabId: number) {
  return session.worker.evaluate(async (tabId) => {
    const runtime = globalThis as unknown as {
      chrome: {
        action: { getPopup(options: { tabId: number }): Promise<string> };
        sidePanel: {
          getOptions(options: {
            tabId: number;
          }): Promise<{ enabled?: boolean; path?: string }>;
        };
      };
    };
    return {
      popup: await runtime.chrome.action.getPopup({ tabId }),
      panel: await runtime.chrome.sidePanel.getOptions({ tabId }),
    };
  }, tabId);
}

async function triggerToolbar(session: ExtensionSession, source: Page) {
  await source.bringToFront();
  const browser = session.context.browser()!;
  const control = await browser.newBrowserCDPSession();
  const targets = (await control.send("Target.getTargets", {
    filter: [{}],
  })) as { targetInfos: { targetId: string; type: string; url: string }[] };
  const target = targets.targetInfos.find(
    ({ type, url }) => type === "tab" && url === source.url(),
  );
  if (!target) throw new Error("Fixture tab target missing");
  void control.send("Extensions.triggerAction", {
    id: session.extensionId,
    targetId: target.targetId,
  });
  return control;
}

async function readerTargets(control: CDPSession, extensionId: string) {
  const targets = (await control.send("Target.getTargets", {
    filter: [{}],
  })) as { targetInfos: { targetId: string; type: string; url: string }[] };
  return targets.targetInfos.filter(
    (target) =>
      target.type === "page" &&
      target.url.startsWith(`chrome-extension://${extensionId}/reader.html`),
  );
}

async function attachReader(control: CDPSession, targetId: string) {
  const attached = (await control.send("Target.attachToTarget", {
    targetId,
  })) as { sessionId: string };
  const reader = new ActionPopup(control, attached.sessionId);
  await expect
    .poll(() =>
      reader.evaluate<boolean>(
        "document.body !== null && document.getElementById('root') !== null",
      ),
    )
    .toBe(true);
  return reader;
}

async function clickReaderButton(reader: ActionPopup, label: string) {
  await reader.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('button')].find(button => button.innerText === ${JSON.stringify(label)})?.click()`,
    userGesture: true,
  });
}

async function clickReaderElement(reader: ActionPopup, expression: string) {
  await reader.evaluate<void>(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))",
  );
  const point = await reader.evaluate<{ x: number; y: number }>(`(() => {
    const node = ${expression};
    if (!(node instanceof HTMLElement)) throw new Error("Reader control unavailable");
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await reader.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await reader.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
}

async function selectReaderWorksheet(reader: ActionPopup, title: string) {
  await expect
    .poll(() =>
      reader.evaluate<boolean>(
        "document.querySelectorAll('[role=combobox]')[0]?.disabled === false",
      ),
    )
    .toBe(true);
  await clickReaderElement(
    reader,
    "document.querySelectorAll('[role=combobox]')[0]",
  );
  await expect
    .poll(() =>
      reader.evaluate<boolean>(
        `[...document.querySelectorAll('[role=option]')].some(node => node.textContent?.trim() === ${JSON.stringify(title)})`,
      ),
    )
    .toBe(true);
  await clickReaderElement(
    reader,
    `[...document.querySelectorAll('[role=option]')].find(node => node.textContent?.trim() === ${JSON.stringify(title)})`,
  );
  await expect
    .poll(() =>
      reader.evaluate<string>(
        "document.querySelectorAll('[role=combobox]')[0]?.textContent ?? ''",
      ),
    )
    .toBe(title);
}

async function openToolbarFixture(
  session: ExtensionSession,
  sourceUrl: string,
  workbookBytes?: Buffer,
) {
  const mock = await installMocks(session.context);
  await mockSourceMetadata(session, workbookBytes);
  expect(await mockGoogleIdentity(session)).toBe(true);
  const source = await routeSyntheticEditor(
    session.context,
    sourceUrl,
    "Reader stability fixture",
  );
  const tabId = await sourceTabId(session, sourceUrl);
  const setup = await session.context.newPage();
  await setup.goto(`chrome-extension://${session.extensionId}/popup.html`);
  await setup.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: {
          runtime: { sendMessage(message: unknown): Promise<unknown> };
        };
      }
    ).chrome.runtime.sendMessage({ type: "AUTH_STATUS" }),
  );
  await setup.close();
  await expect
    .poll(async () => (await toolbarOptions(session, tabId)).popup)
    .toBe("");
  const control = await triggerToolbar(session, source);
  await expect
    .poll(
      async () => (await readerTargets(control, session.extensionId)).length,
    )
    .toBe(1);
  const reader = await attachReader(
    control,
    (await readerTargets(control, session.extensionId))[0]!.targetId,
  );
  await expect
    .poll(() => reader.evaluate<string>("document.body.innerText"))
    .toContain("Connect Google Workspace");
  return { mock, source, tabId, control, reader };
}

test("Office transfers survive switching tabs and another Office download", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  test.setTimeout(90_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const firstUrl =
      "https://docs.google.com/spreadsheets/d/office_parallel_xlsx/edit#gid=42";
    const fixture = await openToolbarFixture(
      session,
      firstUrl,
      stabilityWorkbookBytes(),
    );
    control = fixture.control;
    const reader = fixture.reader;
    await clickReaderButton(reader, "Connect Google Workspace");
    const cell = () =>
      reader.evaluate<string>(
        "document.querySelector('.reader-pane[data-active=true] [data-cell-address=\"A1\"]')?.textContent ?? ''",
      );
    await expect.poll(cell).toBe(switchSheets[0]!.source);
    await session.worker.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __releaseOfficeTransfer?: () => void;
        __officeTransferHeld?: boolean;
      };
      const original = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("office_parallel_xlsx") && url.includes("alt=media")) {
          runtime.__officeTransferHeld = true;
          await new Promise<void>((resolve, reject) => {
            runtime.__releaseOfficeTransfer = resolve;
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return original(input, init);
      };
    });
    await clickReaderButton(reader, "Refresh");
    await expect
      .poll(() =>
        session.worker.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __officeTransferHeld?: boolean;
              }
            ).__officeTransferHeld,
        ),
      )
      .toBe(true);
    const secondUrl =
      "https://docs.google.com/spreadsheets/d/office_parallel_xlsm/edit#gid=42";
    await session.context.route(secondUrl.split("#")[0]!, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Second Office</main>",
      }),
    );
    const created = session.context.waitForEvent("page");
    await session.worker.evaluate(
      async ({ sourceId }) => {
        const tabs = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                get(id: number): Promise<{ windowId: number }>;
                create(options: unknown): Promise<unknown>;
              };
            };
          }
        ).chrome.tabs;
        await tabs.create({
          url: "about:blank",
          windowId: (await tabs.get(sourceId)).windowId,
          active: false,
        });
      },
      { sourceId: fixture.tabId, url: secondUrl },
    );
    const second = await created;
    await second.goto(secondUrl);
    await second.bringToFront();
    await expect
      .poll(() =>
        reader.evaluate<string>(
          "document.querySelector('.reader-pane[data-active=true]')?.innerText ?? ''",
        ),
      )
      .toContain("Click Translate");
    await reader.send("Runtime.evaluate", {
      expression:
        "[...document.querySelectorAll('.reader-pane[data-active=true] button')].find(button=>button.innerText==='Translate')?.click()",
      userGesture: true,
    });
    await expect.poll(cell).toContain("translated-result");
    await expect
      .poll(() =>
        reader.evaluate<boolean>(
          "document.querySelector('.reader-pane[data-active=false] .spreadsheet-grid-skeleton') !== null",
        ),
      )
      .toBe(true);
    expect(
      await reader.evaluate<string>("document.body.innerText"),
    ).not.toContain("source tab changed");
    await session.worker.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __releaseOfficeTransfer?: () => void;
        }
      ).__releaseOfficeTransfer?.(),
    );
    await expect
      .poll(() =>
        reader.evaluate<string>(
          "document.querySelector('.reader-pane[data-active=false] [data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe(switchSheets[0]!.source);
    await fixture.source.bringToFront();
    await expect.poll(cell).toBe(switchSheets[0]!.source);
    expect(fixture.mock.providerCalls).toBe(1);
    expect(fixture.mock.unexpected).toEqual([]);
    const screenshot = await reader.send<{ data: string }>(
      "Page.captureScreenshot",
      { fromSurface: true, captureBeyondViewport: false },
    );
    await writeFile(
      test.info().outputPath("office-independent-transfers.png"),
      Buffer.from(screenshot.data, "base64"),
    );
  } finally {
    await control?.detach().catch(() => undefined);
    await closeExtension(session);
  }
});

function stabilityWorkbookBytes() {
  const workbook = XLSX.utils.book_new();
  for (const sheet of switchSheets)
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([[sheet.source]]),
      sheet.title,
    );
  return Buffer.from(
    XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
  );
}

function verticalMergeWorkbookBytes() {
  const sheet = XLSX.utils.aoa_to_sheet([["Fixture"]]);
  sheet["!ref"] = "A1:M59";
  const sources: Record<string, string> = {
    A45: "New menu",
    B45: "Navigation",
    D45: "Report menu",
    G45: "Notes",
    B46: "Report settings",
    D46: "Notification",
    D47: "Survey",
    D48: "Guidance",
    D49: "Survey documents",
    D52: "Certificates",
    D53: "Other certificates",
    D55: "Administration",
    D57: "Staff",
    G46: "Keep the notification settings",
    G47: "Survey notes",
    G48: "Guidance notes",
    G49: "First survey note",
    G50: "Second survey note",
    G51: "Third survey note",
    G52: "Certificate notes",
    G53: "First certificate note",
    G54: "Second certificate note",
    G55: "First administration note",
    G56: "Second administration note",
    G57: "Staff notes",
    A59: "End",
  };
  for (const [address, value] of Object.entries(sources))
    sheet[address] = { t: "s", v: value };
  sheet["!cols"] = [91, 46, 46, 44, ...Array<number>(9).fill(100)].map(
    (wpx) => ({ wpx }),
  );
  sheet["!merges"] = [
    "B45:C45",
    "D45:F45",
    "G45:M45",
    "B46:C57",
    "D46:F46",
    "D47:F47",
    "D48:F48",
    "D49:F51",
    "D52:F52",
    "D53:F54",
    "D55:F56",
    "D57:F57",
    ...Array.from({ length: 12 }, (_, i) => `G${46 + i}:M${46 + i}`),
  ].map(XLSX.utils.decode_range);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Vertical merges");
  return Buffer.from(
    XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
  );
}

test("reader vertical merges stay on their source columns before and after translation and scrolling", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  const testInfo = test.info();
  test.setTimeout(60_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const privateWorkbook = process.env.READER_LAYOUT_WORKBOOK;
    const fixture = await openToolbarFixture(
      session,
      "https://docs.google.com/spreadsheets/d/office_vertical_merges/edit#gid=42",
      privateWorkbook
        ? await readFile(privateWorkbook)
        : verticalMergeWorkbookBytes(),
    );
    control = fixture.control;
    await clickReaderButton(fixture.reader, "Connect Google Workspace");
    if (privateWorkbook)
      await selectReaderWorksheet(fixture.reader, "帳票設定作業用");
    const mergedSource = privateWorkbook ? "帳票設定" : "Report settings";
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"B46\"]')?.textContent ?? ''",
        ),
      )
      .toBe(mergedSource);
    await fixture.reader.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await fixture.reader.evaluate<void>(`(() => {
      const viewport = document.querySelector('.sheets-grid-viewport');
      viewport.scrollTop = document.querySelector('[data-sheet-row-index="44"]').offsetTop - 28;
      viewport.dispatchEvent(new Event('scroll'));
    })()`);
    const geometry = () =>
      fixture.reader.evaluate<
        {
          address: string;
          startDelta: number;
          endDelta: number;
          topDelta: number;
          bottomDelta: number;
        }[]
      >(`(() => {
      const header = letter => [...document.querySelectorAll('.sheets-column-header')].find(node=>node.textContent===letter).getBoundingClientRect();
      return [['B46','B','C',45,57],['D49','D','F',48,51],['D53','D','F',52,54],['D55','D','F',54,56]].map(([address,start,end,row,afterRow])=>{
        const cell = document.querySelector('[data-cell-address="'+address+'"]').getBoundingClientRect();
        const line = document.querySelector('[data-sheet-row-index="'+row+'"]').getBoundingClientRect();
        const after = document.querySelector('[data-sheet-row-index="'+afterRow+'"]');
        const grid = document.querySelector('[role="grid"]');
        if (!after && Number(grid.getAttribute('aria-rowcount'))-1 !== afterRow) throw new Error('Missing merge end row');
        const endTop = after ? after.getBoundingClientRect().top : grid.getBoundingClientRect().bottom;
        return {address,startDelta:cell.left-header(start).left,endDelta:cell.right-header(end).right,topDelta:cell.top-line.top,bottomDelta:cell.bottom-endTop};
      });
    })()`);
    const assertGeometry = async () => {
      await expect
        .poll(async () =>
          (await geometry()).every(
            ({ startDelta, endDelta, topDelta, bottomDelta }) =>
              [startDelta, endDelta, topDelta, bottomDelta].every(
                (value) => Math.abs(value) <= 1,
              ),
          ),
        )
        .toBe(true);
      expect(
        await fixture.reader.evaluate<number>(
          'document.querySelectorAll(\'[data-cell-address="C46"],[data-cell-address="E49"],[data-cell-address="F49"]\').length',
        ),
      ).toBe(0);
    };
    const capture = async (name: string) => {
      await fixture.reader.evaluate<void>(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const shot = await fixture.reader.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
      );
      await writeFile(
        testInfo.outputPath(name),
        Buffer.from(shot.data, "base64"),
      );
    };
    console.log("vertical merge source geometry", await geometry());
    await assertGeometry();
    await capture("vertical-merges-original.png");
    fixture.mock.translate = async (sources) =>
      sources.map(
        (source) =>
          `Bản dịch ${!privateWorkbook && source.includes("Survey documents") ? "Nội dung dịch dài cần xuống dòng trong ô gộp nhiều hàng. ".repeat(20) : source.replace(/<[^>]*>/g, "")}`,
      );
    await clickReaderButton(fixture.reader, "Translate");
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"B46\"]')?.textContent ?? ''",
        ),
      )
      .toContain("Bản dịch");
    if (!privateWorkbook) {
      await expect
        .poll(() =>
          fixture.reader.evaluate<string>(
            "document.querySelector('[data-cell-address=\"D49\"]')?.textContent ?? ''",
          ),
        )
        .toContain("Nội dung dịch dài");
      expect(
        await fixture.reader.evaluate<number>(
          "document.querySelector('[data-cell-address=\"D49\"]').getBoundingClientRect().height",
        ),
      ).toBeGreaterThan(100);
    }
    await assertGeometry();
    await capture("vertical-merges-translated.png");
    await fixture.reader.evaluate<void>(`(() => {
      const viewport = document.querySelector('.sheets-grid-viewport');
      viewport.scrollLeft=180; viewport.dispatchEvent(new Event('scroll'));
    })()`);
    await expect
      .poll(() =>
        fixture.reader.evaluate<number>(
          "document.querySelector('.sheets-grid-viewport').scrollLeft",
        ),
      )
      .toBeGreaterThan(0);
    await assertGeometry();
    await fixture.reader.evaluate<void>(`(() => {
      const viewport = document.querySelector('.sheets-grid-viewport');
      viewport.scrollTop=0; viewport.scrollLeft=0; viewport.dispatchEvent(new Event('scroll'));
    })()`);
    await fixture.reader.evaluate<void>(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await fixture.reader.evaluate<void>(`(() => {
      const viewport = document.querySelector('.sheets-grid-viewport');
      viewport.scrollTop=document.querySelector('[data-sheet-row-index="44"]').offsetTop-28;
      viewport.dispatchEvent(new Event('scroll'));
    })()`);
    await assertGeometry();
    await expect.poll(() => fixture.mock.providerPending).toBe(0);
    expect(
      fixture.mock.providerRequests
        .flat()
        .filter((source) => source === `${mergedSource}`),
    ).toHaveLength(1);
    expect(fixture.mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

test("reader native RTL frozen vertical merges keep their grid areas while scrolling", async () => {
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const fixture = await openToolbarFixture(
      session,
      "https://docs.google.com/spreadsheets/d/native_merge_fixture/edit#gid=42",
    );
    control = fixture.control;
    await fixture.reader.send("Emulation.setDeviceMetricsOverride", {
      width: 1000,
      height: 850,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const merges = [
      {
        startRowIndex: 1,
        endRowIndex: 4,
        startColumnIndex: 1,
        endColumnIndex: 3,
      },
      {
        startRowIndex: 1,
        endRowIndex: 4,
        startColumnIndex: 5,
        endColumnIndex: 7,
      },
    ];
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        if (new URL(route.request().url()).pathname.includes("/values/")) {
          await route.fulfill({
            json: {
              majorDimension: "COLUMNS",
              values: Array.from({ length: 12 }, () => [
                "Source",
                "",
                "",
                "End",
              ]),
            },
          });
          return;
        }
        const metadata = sheetMetadata(4, 12);
        metadata.spreadsheetId = "native_merge_fixture";
        metadata.sheets[0]!.properties.rightToLeft = true;
        metadata.sheets[0]!.properties.gridProperties.frozenColumnCount = 3;
        await route.fulfill({
          json: {
            ...metadata,
            sheets: [
              {
                ...metadata.sheets[0],
                merges,
                data: [
                  {
                    startRow: 0,
                    startColumn: 0,
                    columnMetadata: Array.from({ length: 12 }, () => ({
                      pixelSize: 100,
                    })),
                    rowData: [
                      {
                        values: Array.from({ length: 12 }, (_, index) =>
                          gridProofCell(`Value ${index}`),
                        ),
                      },
                      {
                        values: Array.from({ length: 12 }, (_, index) =>
                          index === 1
                            ? gridProofCell("Frozen merge")
                            : index === 5
                              ? gridProofCell("Regular merge")
                              : {},
                        ),
                      },
                      { values: [] },
                      { values: [gridProofCell("End")] },
                    ],
                  },
                ],
              },
            ],
          },
        });
      },
    );
    await clickReaderButton(fixture.reader, "Connect Google Workspace");
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"B2\"]')?.textContent ?? ''",
        ),
      )
      .toBe("Frozen merge");
    const errors = () =>
      fixture.reader.evaluate<number[]>(`(() => {
      const header = letter => [...document.querySelectorAll('.sheets-column-header')].find(node=>node.textContent===letter).getBoundingClientRect();
      return [['B2','B','C'],['F2','F','G']].flatMap(([address,start,end])=>{
        const rect=document.querySelector('[data-cell-address="'+address+'"]').getBoundingClientRect();
        return [rect.right-header(start).right,rect.left-header(end).left];
      });
    })()`);
    const assertAlignment = async () => {
      await expect
        .poll(async () =>
          (await errors()).every((value) => Math.abs(value) <= 1),
        )
        .toBe(true);
    };
    await assertAlignment();
    fixture.mock.translate = async (sources) =>
      sources.map((source) => `Dịch ${source}`);
    await clickReaderButton(fixture.reader, "Translate");
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"B2\"]')?.textContent ?? ''",
        ),
      )
      .toBe("Dịch Frozen merge");
    await assertAlignment();
    await fixture.reader.evaluate<void>(`(() => {
      const viewport=document.querySelector('.sheets-grid-viewport');
      viewport.scrollLeft=-180;viewport.dispatchEvent(new Event('scroll'));
    })()`);
    await expect
      .poll(() =>
        fixture.reader.evaluate<number>(
          "Math.abs(document.querySelector('.sheets-grid-viewport').scrollLeft)",
        ),
      )
      .toBeGreaterThan(0);
    await assertAlignment();
    expect(fixture.mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

function savedLayoutWorkbookBytes() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["A", null, "Hidden"],
    ["Hidden row"],
    [
      "Merge",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "Tail",
    ],
  ]);
  sheet["!merges"] = [XLSX.utils.decode_range("A3:B3")];
  XLSX.utils.book_append_sheet(workbook, sheet, "Saved layout");
  const archive = XLSX.CFB.read(
    Buffer.from(
      XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    ),
    { type: "buffer" },
  );
  for (let index = 0; index < archive.FullPaths.length; index += 1) {
    const name = archive.FullPaths[index]!;
    const entry = archive.FileIndex[index];
    if (!entry?.content) continue;
    let xml = new TextDecoder().decode(entry.content);
    if (name.endsWith("/xl/styles.xml")) {
      xml = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <fonts count="2"><font><sz val="10"/><name val="Arial"/><color rgb="FF000000"/></font><font><sz val="10"/><name val="Arial"/><b/><i/><color rgb="FFFF0000"/></font></fonts>
        <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF123456"/></patternFill></fill></fills>
        <borders count="2"><border/><border><top style="thin"><color rgb="FFABCDEF"/></top><right style="thin"><color rgb="FF000000"/></right><bottom style="thin"><color rgb="FF000000"/></bottom><left style="thin"><color rgb="FF000000"/></left></border></borders>
        <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
        <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>
      </styleSheet>`;
    } else if (name.endsWith("/xl/worksheets/sheet1.xml")) {
      xml = xml
        .replace('<c r="A1"', '<c r="A1" s="1"')
        .replace('<row r="1"', '<row r="1" ht="15.75" customHeight="1"')
        .replace('<row r="2"', '<row r="2" hidden="1"')
        .replace("</row>", '<c r="B1" s="1"/></row>')
        .replace(
          "<sheetData>",
          '<cols><col min="1" max="1" width="11.38" customWidth="1"/><col min="2" max="2" width="5.75" customWidth="1"/><col min="3" max="3" width="5.75" customWidth="1" hidden="1"/><col min="4" max="4" width="5.5" customWidth="1"/></cols><sheetData>',
        );
    }
    if (name.endsWith(".xml")) entry.content = Buffer.from(xml);
  }
  return Buffer.from(
    XLSX.CFB.write(archive, { type: "buffer", fileType: "zip" }),
  );
}

test("reader saved layout preserves measured font widths, narrow columns and saved styles through translation and horizontal scroll", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  test.setTimeout(90_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const fixture = await openToolbarFixture(
      session,
      "https://docs.google.com/spreadsheets/d/office_saved_layout/edit#gid=42",
      savedLayoutWorkbookBytes(),
    );
    control = fixture.control;
    await clickReaderButton(fixture.reader, "Connect Google Workspace");
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("A");
    const measuredDigitWidth = await fixture.reader.evaluate<number>(`(() => {
      const context = new OffscreenCanvas(1, 1).getContext('2d');
      if (!context) throw new Error("OffscreenCanvas font measurement unavailable");
      context.font = '13.333333333333334px "Arial"';
      return Math.ceil(Math.max(...Array.from({length:10}, (_,digit)=>context.measureText(String(digit)).width)));
    })()`);
    expect(measuredDigitWidth).toBe(8);
    const proof = () =>
      fixture.reader.evaluate<{
        tracks: number[];
        rowMinimum: string;
        rowHeight: number;
        cell: {
          background: string;
          color: string;
          bold: string;
          italic: string;
          top: string;
          right: string;
          bottom: string;
          left: string;
          horizontal: string;
        };
        blankStyled: boolean;
        hiddenRow: boolean;
        mergeWidth: number;
        centered: boolean;
      }>(`(() => {
      const cell = document.querySelector('[data-cell-address="A1"]');
      const blank = document.querySelector('[data-cell-address="B1"]');
      const row = document.querySelector('[data-sheet-row-index="0"]');
      const merge = document.querySelector('[data-cell-address="A3"]');
      const style = getComputedStyle(cell);
      const range = document.createRange();
      range.selectNodeContents(cell);
      const textRect = range.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      return {
        tracks: (document.querySelector('.sheets-grid-header').style.gridTemplateColumns.match(/\\d+(?:\\.\\d+)?px/g) ?? []).map(parseFloat),
        rowMinimum: row.style.height, rowHeight: row.getBoundingClientRect().height,
        cell: { background: style.backgroundColor, color: style.color, bold:style.fontWeight, italic:style.fontStyle, top:style.borderTopColor, right:style.borderRightColor, bottom:style.borderBottomColor, left:style.borderLeftColor, horizontal:getComputedStyle(cell.querySelector('.sheets-cell-text') ?? cell).textAlign },
        blankStyled: blank?.textContent === '' && getComputedStyle(blank).backgroundColor === style.backgroundColor,
        hiddenRow: document.querySelector('[data-sheet-row-index="1"]') === null,
        mergeWidth: merge.getBoundingClientRect().width,
        centered: Math.abs((textRect.left + textRect.right) / 2 - (cellRect.left + cellRect.right) / 2) <= 1,
      };
    })()`);
    const original = await proof();
    expect(original.tracks.slice(0, 4)).toEqual([91, 46, 0, 44]);
    expect(original.rowMinimum).toBe("21px");
    expect(original.rowHeight).toBe(21);
    expect(original.cell).toEqual({
      background: "rgb(18, 52, 86)",
      color: "rgb(255, 0, 0)",
      bold: "700",
      italic: "italic",
      top: "rgb(171, 205, 239)",
      right: "rgb(0, 0, 0)",
      bottom: "rgb(0, 0, 0)",
      left: "rgb(0, 0, 0)",
      horizontal: "center",
    });
    expect(original.blankStyled).toBe(true);
    expect(original.hiddenRow).toBe(true);
    expect(original.mergeWidth).toBe(137);
    expect(original.centered).toBe(true);
    const originalScreenshot = await fixture.reader.send<{ data: string }>(
      "Page.captureScreenshot",
      { fromSurface: true, captureBeyondViewport: false },
    );
    await writeFile(
      test.info().outputPath("reader-saved-layout-original.png"),
      Buffer.from(originalScreenshot.data, "base64"),
    );
    fixture.mock.translate = async (sources) => sources.map(() => "Dịch");
    await clickReaderButton(fixture.reader, "Translate");
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("Dịch");
    const translated = await proof();
    expect(translated).toEqual(original);
    const translatedScreenshot = await fixture.reader.send<{ data: string }>(
      "Page.captureScreenshot",
      { fromSurface: true, captureBeyondViewport: false },
    );
    await writeFile(
      test.info().outputPath("reader-saved-layout-translated.png"),
      Buffer.from(translatedScreenshot.data, "base64"),
    );
    expect(fixture.mock.providerCalls).toBe(1);
    await fixture.reader.evaluate<void>(
      "(()=>{const scroller=document.querySelector('.sheets-grid-viewport');scroller.scrollLeft=400;scroller.dispatchEvent(new Event('scroll'));})()",
    );
    await expect
      .poll(() =>
        fixture.reader.evaluate<number>(
          "document.querySelector('.sheets-grid-viewport').scrollLeft",
        ),
      )
      .toBeGreaterThan(0);
    // Zero pending can precede the scroll scheduler's next dispatch. Wait
    // for the newly visible source's accepted result before measuring reuse.
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"L3\"]')?.textContent ?? ''",
        ),
      )
      .toBe("Dịch");
    await expect.poll(() => fixture.mock.providerPending).toBe(0);
    const scrollCalls = fixture.mock.providerCalls;
    await fixture.reader.evaluate<void>(
      "(()=>{const scroller=document.querySelector('.sheets-grid-viewport');scroller.scrollLeft=0;scroller.dispatchEvent(new Event('scroll'));})()",
    );
    await expect
      .poll(() =>
        fixture.reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("Dịch");
    expect(await proof()).toEqual(original);
    expect(fixture.mock.providerCalls).toBe(scrollCalls);
    expect(
      fixture.mock.providerRequests.flat().filter((source) => source === "A"),
    ).toHaveLength(1);
    expect(fixture.mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

for (const scenario of [
  "continue",
  "stop",
  "changed source",
  "partial",
] as const) {
  test(`reader scroll recovery preserves a hidden native tab after a real worker restart: ${scenario}`, async () => {
    test.setTimeout(90_000);
    const session = await launchExtension();
    let control: CDPSession | undefined;
    let workerControl: CDPSession | undefined;
    const heldDiscovery = deferred<void>();
    const heldTranslation = deferred<void>();
    let holdingDiscovery = false;
    try {
      const fixture = await openToolbarFixture(
        session,
        "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42",
      );
      control = fixture.control;
      let firstSource = "First viewport source";
      const serveSheet = async (route: Route) => {
        const url = new URL(route.request().url());
        fixture.mock.googleCalls.push(url.href);
        if (url.pathname.includes("/values/")) {
          await route.fulfill({
            json: {
              majorDimension: "COLUMNS",
              values: [
                Array.from({ length: 350 }, (_, row) =>
                  [0, 100, 200, 349].includes(row) ? `Source ${row}` : "",
                ),
              ],
            },
          });
          return;
        }
        const range = url.searchParams.get("ranges");
        if (url.searchParams.get("includeGridData") === "true") {
          const start = Number(/![A-Z]*(\d+):/.exec(range ?? "")?.[1] ?? 1) - 1;
          const page = sheetPage(
            start,
            start === 0 ? firstSource : `Second viewport source ${start}`,
          );
          if (scenario === "partial" && start === 0)
            page.sheets[0]!.data[0]!.rowData.push({
              values: [
                {
                  userEnteredValue: { stringValue: "Unresolved source" },
                  effectiveValue: { stringValue: "Unresolved source" },
                  formattedValue: "Unresolved source",
                },
              ],
            });
          page.sheets[0]!.properties!.gridProperties.rowCount = 350;
          await route.fulfill({
            json: {
              ...page,
              spreadsheetId: /spreadsheets\/([^/]+)/.exec(url.pathname)?.[1],
            },
          });
        } else {
          await route.fulfill({
            json: {
              ...(range ? sheetGridMetadata(350) : sheetMetadata(350)),
              spreadsheetId: /spreadsheets\/([^/]+)/.exec(url.pathname)?.[1],
            },
          });
        }
      };
      await session.context.route(
        "https://sheets.googleapis.com/**",
        serveSheet,
      );
      await clickReaderButton(fixture.reader, "Connect Google Workspace");
      const cell = (address: string) =>
        fixture.reader.evaluate<string>(
          `document.querySelector('[data-cell-address="${address}"]')?.textContent ?? ''`,
        );
      const scroll = (row: number) =>
        fixture.reader.evaluate<void>(
          `(() => { const viewport=document.querySelector('.sheets-grid-viewport'); viewport.scrollTop=${row * 21}; viewport.dispatchEvent(new Event('scroll')); })()`,
        );
      await expect.poll(() => cell("A1")).toBe("First viewport source");
      fixture.mock.translate = async (sources) => {
        if (sources.some((source) => source.includes("changed")))
          await heldTranslation.promise;
        return sources.map((source) =>
          source.includes("Unresolved source") ? source : "translated-result",
        );
      };
      await clickReaderButton(fixture.reader, "Translate");
      await expect.poll(() => cell("A1")).toContain("translated-result");
      await expect.poll(() => fixture.mock.providerPending).toBe(0);
      if (scenario === "partial")
        await expect
          .poll(() =>
            fixture.reader.evaluate<string>("document.body.innerText"),
          )
          .toContain("1 translated; 1 unresolved");
      const unresolvedCalls = fixture.mock.providerRequests
        .flat()
        .filter((source) => source.includes("Unresolved source")).length;
      const firstCalls = fixture.mock.providerCalls;
      await scroll(100);
      await expect.poll(() => cell("A101")).toContain("translated-result");
      expect(fixture.mock.providerCalls).toBe(firstCalls + 1);
      const afterNewViewport = fixture.mock.providerCalls;
      const googleAfterPageLoad = fixture.mock.googleCalls.length;
      await scroll(0);
      await expect.poll(() => cell("A1")).toContain("translated-result");
      await scroll(100);
      await expect.poll(() => cell("A101")).toContain("translated-result");
      expect(fixture.mock.providerCalls).toBe(afterNewViewport);
      expect(fixture.mock.googleCalls.length).toBe(googleAfterPageLoad);
      const otherUrl =
        "https://docs.google.com/spreadsheets/d/sheet_456/edit#gid=42";
      await session.context.route(otherUrl.split("#")[0]!, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Other source tab</main>",
        }),
      );
      const createdPage = session.context.waitForEvent("page");
      await session.worker.evaluate(
        async ({ sourceId, url }) => {
          const api = (
            globalThis as unknown as {
              chrome: {
                tabs: {
                  get(id: number): Promise<{ windowId: number }>;
                  create(options: unknown): Promise<unknown>;
                };
              };
            }
          ).chrome.tabs;
          const source = await api.get(sourceId);
          await api.create({ url, windowId: source.windowId, active: false });
        },
        { sourceId: fixture.tabId, url: otherUrl },
      );
      const otherSource = await createdPage;
      await otherSource.waitForLoadState();
      await otherSource.bringToFront();
      await expect
        .poll(() =>
          fixture.reader.evaluate<number>(
            "document.querySelectorAll('.reader-pane').length",
          ),
        )
        .toBe(2);
      await expect
        .poll(() =>
          fixture.reader.evaluate<string>(
            "document.querySelector('.reader-pane[data-active=true]').innerText",
          ),
        )
        .toContain("Click Translate");
      const oldWorker = session.worker;
      await oldWorker.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __scrollDiagnosticMarker?: string;
          }
        ).__scrollDiagnosticMarker = "before-restart";
      });
      workerControl = await session.context.newCDPSession(fixture.source);
      const versions: {
        versionId: string;
        scriptURL: string;
        runningStatus: string;
      }[] = [];
      workerControl.on(
        "ServiceWorker.workerVersionUpdated",
        (event: { versions: typeof versions }) =>
          versions.push(...event.versions),
      );
      await workerControl.send("ServiceWorker.enable");
      await expect
        .poll(() =>
          versions.some(
            (v) =>
              v.scriptURL === oldWorker.url() && v.runningStatus === "running",
          ),
        )
        .toBe(true);
      const version = versions.findLast(
        (v) => v.scriptURL === oldWorker.url() && v.runningStatus === "running",
      )!;
      await workerControl.send("ServiceWorker.stopWorker", {
        versionId: version.versionId,
      });
      await expect
        .poll(() =>
          versions.some(
            (v) =>
              v.versionId === version.versionId &&
              v.runningStatus === "stopped",
          ),
        )
        .toBe(true);
      await fixture.reader.evaluate(
        "chrome.runtime.sendMessage({type:'AUTH_STATUS'})",
      );
      const targets = (await control.send("Target.getTargets", {
        filter: [{}],
      })) as { targetInfos: { targetId: string; type: string; url: string }[] };
      const newTarget = targets.targetInfos.find(
        (t) => t.type === "service_worker" && t.url === oldWorker.url(),
      )!;
      const attached = (await control.send("Target.attachToTarget", {
        targetId: newTarget.targetId,
      })) as { sessionId: string };
      const restarted = new ActionPopup(control, attached.sessionId);
      expect(
        await restarted.evaluate<string>(
          "typeof globalThis.__scrollDiagnosticMarker",
        ),
      ).toBe("undefined");
      session.worker = {
        url: () => newTarget.url,
        evaluate: (fn: (argument?: unknown) => unknown, argument?: unknown) =>
          restarted.evaluate(
            `(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})`,
          ),
      } as unknown as Worker;
      await mockSourceMetadata(session);
      if (scenario === "changed source")
        firstSource = "First viewport source changed";
      let restartedDiscovery = 0;
      await session.context.route(
        "https://sheets.googleapis.com/**",
        async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.includes("/values/")) {
            restartedDiscovery += 1;
            if (scenario === "stop") {
              holdingDiscovery = true;
              await heldDiscovery.promise;
            }
          }
          await serveSheet(route);
        },
      );
      const beforeRecovery = fixture.mock.googleCalls.length;
      // Recovery revalidates source without replacing the mounted grid or its scroll.
      await scroll(200);
      if (scenario === "stop") {
        await expect.poll(() => holdingDiscovery).toBe(true);
        await fixture.source.bringToFront();
        await expect
          .poll(() =>
            fixture.reader.evaluate<boolean>(
              "document.querySelector('.reader-pane').dataset.active === 'true'",
            ),
          )
          .toBe(true);
        await clickReaderButton(fixture.reader, "Stop");
        heldDiscovery.resolve();
        await expect
          .poll(() =>
            fixture.reader.evaluate<string>("document.body.innerText"),
          )
          .toContain("Resume translation");
        await expect
          .poll(() => cell("A201"))
          .toContain("Second viewport source 200");
        expect(fixture.mock.providerCalls).toBe(afterNewViewport);
        await clickReaderButton(fixture.reader, "Resume translation");
      }
      await expect.poll(() => restartedDiscovery).toBeGreaterThan(0);
      await expect.poll(() => cell("A201")).toContain("translated-result");
      expect(fixture.mock.providerCalls).toBe(afterNewViewport + 1);
      expect(
        await fixture.reader.evaluate<number>(
          "document.querySelector('.sheets-grid-viewport').scrollTop",
        ),
      ).toBe(4200);
      await fixture.source.bringToFront();
      await expect
        .poll(() =>
          fixture.reader.evaluate<boolean>(
            "document.querySelector('.reader-pane').dataset.active === 'true'",
          ),
        )
        .toBe(true);
      await scroll(0);
      if (scenario === "changed source") {
        await expect
          .poll(() => fixture.mock.providerPending)
          .toBeGreaterThan(0);
        expect(await cell("A1")).toContain(firstSource);
        expect(await cell("A1")).not.toContain("translated-result");
        await expect
          .poll(() =>
            fixture.reader.evaluate<string>("document.body.innerText"),
          )
          .toContain("Translating");
        heldTranslation.resolve();
      }
      await expect.poll(() => cell("A1")).toContain("translated-result");
      const callsAfterRecovery = fixture.mock.providerCalls;
      await scroll(100);
      await expect.poll(() => cell("A101")).toContain("translated-result");
      expect(fixture.mock.providerCalls).toBe(callsAfterRecovery);
      expect(
        fixture.mock.providerRequests
          .flat()
          .filter((source) => source.includes("Unresolved source")).length,
      ).toBe(unresolvedCalls);
      if (scenario === "partial")
        await expect
          .poll(() =>
            fixture.reader.evaluate<string>("document.body.innerText"),
          )
          .toContain("3 translated; 1 unresolved");
      await test.info().attach("scroll-diagnosis.json", {
        body: JSON.stringify({
          firstCalls,
          afterNewViewport,
          repeatedScrollProviderCalls: afterNewViewport,
          googleAfterPageLoad,
          beforeRecovery,
          restartedDiscovery,
          explanation:
            "Viewport continuation and worker recovery preserve accepted results and scroll.",
        }),
        contentType: "application/json",
      });
    } finally {
      await workerControl?.detach();
      heldDiscovery.resolve();
      heldTranslation.resolve();
      await control?.detach();
      await closeExtension(session);
    }
  });
}
test("reader restart recovery preserves a real global Office panel across worker replacement and Refresh", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  test.setTimeout(90_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const bytes = stabilityWorkbookBytes();
    const fixture = await openToolbarFixture(
      session,
      "https://docs.google.com/spreadsheets/d/office_restart/edit#gid=42",
      bytes,
    );
    control = fixture.control;
    await clickReaderButton(fixture.reader, "Connect Google Workspace");
    const cell = () =>
      fixture.reader.evaluate<string>(
        "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
      );
    await expect.poll(cell).toBe("Source A");
    const oldWorker = session.worker;
    await oldWorker.evaluate(() => {
      (
        globalThis as typeof globalThis & { __readerRestartMarker?: string }
      ).__readerRestartMarker = "old-isolate";
    });
    const serviceWorkerControl = await session.context.newCDPSession(
      fixture.source,
    );
    const workerVersions: {
      versionId: string;
      scriptURL: string;
      runningStatus: string;
    }[] = [];
    serviceWorkerControl.on(
      "ServiceWorker.workerVersionUpdated",
      (event: { versions: typeof workerVersions }) =>
        workerVersions.push(...event.versions),
    );
    await serviceWorkerControl.send("ServiceWorker.enable");
    await expect
      .poll(() =>
        workerVersions.some(
          ({ scriptURL, runningStatus }) =>
            scriptURL === oldWorker.url() && runningStatus === "running",
        ),
      )
      .toBe(true);
    const version = workerVersions.findLast(
      ({ scriptURL, runningStatus }) =>
        scriptURL === oldWorker.url() && runningStatus === "running",
    )!;
    await serviceWorkerControl.send("ServiceWorker.stopWorker", {
      versionId: version.versionId,
    });
    await expect
      .poll(() =>
        workerVersions.some(
          (entry) =>
            entry.versionId === version.versionId &&
            entry.runningStatus === "stopped",
        ),
      )
      .toBe(true);
    await fixture.reader.evaluate(
      "chrome.runtime.sendMessage({type:'AUTH_STATUS'})",
    );
    const restartedTargets = (await control.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const restartedTarget = restartedTargets.targetInfos.find(
      (target) =>
        target.type === "service_worker" && target.url === oldWorker.url(),
    )!;
    expect(restartedTarget).toBeDefined();
    const attached = (await control.send("Target.attachToTarget", {
      targetId: restartedTarget.targetId,
    })) as { sessionId: string };
    const restarted = new ActionPopup(control, attached.sessionId);
    expect(
      await restarted.evaluate<string>(
        "typeof globalThis.__readerRestartMarker",
      ),
    ).toBe("undefined");
    // Chromium may retain Playwright's Worker wrapper without emitting a new event.
    session.worker = {
      url: () => restartedTarget.url,
      evaluate: (fn: (argument?: unknown) => unknown, argument?: unknown) =>
        restarted.evaluate(
          `(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})`,
        ),
    } as unknown as Worker;
    await serviceWorkerControl.detach();
    await mockSourceMetadata(session, bytes);
    expect(await mockGoogleIdentity(session)).toBe(true);
    await clickReaderButton(fixture.reader, "Refresh");
    await expect
      .poll(() =>
        session.worker.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __sourceMetadataCalls?: string[];
              }
            ).__sourceMetadataCalls?.filter((url) => url.includes("alt=media"))
              .length ?? 0,
        ),
      )
      .toBe(1);
    await expect.poll(cell).toBe("Source A");
    expect(
      await fixture.reader.evaluate<string>("document.body.innerText"),
    ).not.toMatch(
      /could not connect|temporarily unavailable|source tab changed/i,
    );
    const identity = await identityMockSnapshot(session.worker);
    expect(identity?.webFlows).toEqual([]);
    expect(identity?.getAuthTokenCalls).toBe(0);
    await clickReaderButton(fixture.reader, "Translate");
    await expect.poll(cell).toContain("translated-result");
    expect(fixture.mock.providerCalls).toBe(1);
    expect(fixture.mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

test("reader worksheet stability survives twelve Office swaps and keeps stopped UI results out of another worksheet", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  test.setTimeout(90_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const fixture = await openToolbarFixture(
      session,
      "https://docs.google.com/spreadsheets/d/office_stability/edit#gid=42",
      stabilityWorkbookBytes(),
    );
    control = fixture.control;
    const errors: string[] = [];
    control.on(
      "Target.receivedMessageFromTarget",
      ({ message }: { message: string }) => {
        const event = JSON.parse(message) as {
          method?: string;
          params?: { exceptionDetails?: { text?: string } };
        };
        if (event.method === "Runtime.exceptionThrown")
          errors.push(event.params?.exceptionDetails?.text ?? "Runtime error");
      },
    );
    await fixture.reader.send("Runtime.enable");
    await clickReaderButton(fixture.reader, "Connect Google Workspace");
    const cell = () =>
      fixture.reader.evaluate<string>(
        "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
      );
    await expect.poll(cell).toBe("Source A");
    const held = deferred<void>();
    fixture.mock.translate = async (sources) => {
      await held.promise;
      return sources.map(() => "Dịch A");
    };
    await clickReaderButton(fixture.reader, "Translate");
    await expect.poll(() => fixture.mock.providerCalls).toBe(1);
    expect(
      await fixture.reader.evaluate<boolean>(
        "document.querySelectorAll('[role=combobox]')[0].disabled",
      ),
    ).toBe(true);
    await clickReaderButton(fixture.reader, "Stop");
    await selectReaderWorksheet(fixture.reader, "Sheet B");
    await expect.poll(cell).toBe("Source B");
    fixture.mock.translate = async (sources) =>
      sources.map(
        (source) =>
          `Dịch ${switchSheets.find((sheet) => source.includes(sheet.source))!.title.at(-1)}`,
      );
    held.resolve();
    await expect.poll(() => fixture.mock.providerPending).toBe(0);
    expect(await cell()).toBe("Source B");
    await clickReaderButton(fixture.reader, "Translate");
    await expect.poll(cell).toBe("Dịch B");
    for (let index = 0; index < 12; index += 1) {
      const sheet = switchSheets[index % switchSheets.length]!;
      await selectReaderWorksheet(fixture.reader, sheet.title);
      await expect.poll(cell).toBe(`Dịch ${sheet.title.at(-1)}`);
    }
    const calls = fixture.mock.providerCalls;
    const googleCalls = await session.worker.evaluate(
      () =>
        (globalThis as typeof globalThis & { __sourceMetadataCalls?: string[] })
          .__sourceMetadataCalls?.length ?? 0,
    );
    await fixture.source.evaluate(() => {
      location.hash = "gid=999";
    });
    await fixture.source.waitForTimeout(350);
    expect(await cell()).toBe("Dịch D");
    expect(
      await fixture.reader.evaluate<string>(
        "document.querySelectorAll('[role=combobox]')[0].textContent",
      ),
    ).toBe("Sheet D");
    expect(fixture.mock.providerCalls).toBe(calls);
    expect(
      await session.worker.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __sourceMetadataCalls?: string[];
            }
          ).__sourceMetadataCalls?.length ?? 0,
      ),
    ).toBe(googleCalls);
    expect(fixture.mock.providerCalls).toBeLessThanOrEqual(5);
    // A valid unchanged-source cache may be reused; a new target must dispatch anew.
    const previousTargetCalls = fixture.mock.providerCalls;
    await clickReaderElement(
      fixture.reader,
      "document.querySelectorAll('[role=combobox]')[1]",
    );
    await expect
      .poll(() =>
        fixture.reader.evaluate<boolean>(
          "[...document.querySelectorAll('[role=option]')].some(node => node.textContent?.trim() === 'Japanese')",
        ),
      )
      .toBe(true);
    await clickReaderElement(
      fixture.reader,
      "[...document.querySelectorAll('[role=option]')].find(node => node.textContent?.trim() === 'Japanese')",
    );
    await selectReaderWorksheet(fixture.reader, "Sheet A");
    await expect.poll(cell).toBe("Source A");
    fixture.mock.translate = async (sources) => sources.map(() => "日本語 A");
    await clickReaderButton(fixture.reader, "Translate");
    await expect.poll(cell).toBe("日本語 A");
    expect(fixture.mock.providerCalls).toBe(previousTargetCalls + 1);
    expect(errors).toEqual([]);
    expect(fixture.mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

test("reader worksheet stability keeps the latest native dropdown through delayed metadata and twelve translating swaps", async () => {
  test.setTimeout(90_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const fixture = await openToolbarFixture(
      session,
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42",
    );
    control = fixture.control;
    const errors: string[] = [];
    control.on(
      "Target.receivedMessageFromTarget",
      ({ message }: { message: string }) => {
        const event = JSON.parse(message) as {
          method?: string;
          params?: { exceptionDetails?: { text?: string } };
        };
        if (event.method === "Runtime.exceptionThrown")
          errors.push(event.params?.exceptionDetails?.text ?? "Runtime error");
      },
    );
    await fixture.reader.send("Runtime.enable");
    const held = deferred<void>();
    let holdingB = false;
    let heldBOnce = false;
    let releasedB = false;
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        const url = new URL(route.request().url());
        if (
          !heldBOnce &&
          sheetFromRequest(url)?.id === 43 &&
          url.searchParams.has("ranges") &&
          url.searchParams.get("includeGridData") === "false"
        ) {
          heldBOnce = true;
          holdingB = true;
          await held.promise;
          releasedB = true;
        }
        await fulfillSwitchingSheet(route, fixture.mock);
      },
    );
    fixture.mock.translate = async (sources) =>
      sources.map(
        (source) =>
          `Dịch ${switchSheets.find((sheet) => source.includes(sheet.source))!.title.at(-1)}`,
      );
    await clickReaderButton(fixture.reader, "Connect Google Workspace");
    const cell = () =>
      fixture.reader.evaluate<string>(
        "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
      );
    await expect.poll(cell).toBe("Source A");
    await clickReaderButton(fixture.reader, "Translate");
    await expect.poll(cell).toBe("Dịch A");
    await selectReaderWorksheet(fixture.reader, "Sheet B");
    await expect.poll(() => holdingB).toBe(true);
    expect(
      await fixture.reader.evaluate<boolean>(
        `document.querySelectorAll('[role=combobox]').length === 2 && document.querySelector('.reader-header .connection')?.textContent === 'Connected' && document.querySelector('.spreadsheet-grid-skeleton') !== null && !document.body.innerText.includes('Preparing Reader')`,
      ),
    ).toBe(true);
    await fixture.reader.evaluate<void>(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const skeletonGeometry = await fixture.reader.evaluate<{
      height: number;
      width: number;
      visibility: string;
    }>(
      `(() => { const node = document.querySelector('.spreadsheet-grid-skeleton'); const bounds = node.getBoundingClientRect(); return {height:bounds.height,width:bounds.width,visibility:getComputedStyle(node).visibility}; })()`,
    );
    expect(skeletonGeometry.height).toBeGreaterThan(100);
    expect(skeletonGeometry.width).toBeGreaterThan(100);
    expect(skeletonGeometry.visibility).toBe("visible");
    await expect
      .poll(() =>
        fixture.reader.evaluate<number>(
          "Number(getComputedStyle(document.querySelector('.spreadsheet-grid-skeleton')).opacity)",
        ),
      )
      .toBe(1);
    const loadingScreenshot = await fixture.reader.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
    );
    const loadingPath = test.info().outputPath("worksheet-loading.png");
    await writeFile(loadingPath, Buffer.from(loadingScreenshot.data, "base64"));
    await test.info().attach("worksheet-loading", {
      path: loadingPath,
      contentType: "image/png",
    });
    expect(
      await fixture.reader.evaluate<boolean>(
        "document.querySelectorAll('[role=combobox]')[0].disabled",
      ),
    ).toBe(false);
    await selectReaderWorksheet(fixture.reader, "Sheet C");
    await expect.poll(cell).toBe("Dịch C");
    held.resolve();
    await expect.poll(() => releasedB).toBe(true);
    expect(await cell()).toBe("Dịch C");
    expect(
      fixture.mock.providerRequests.some((sources) =>
        sources.some((source) => source.includes("Source B")),
      ),
    ).toBe(false);
    for (let index = 0; index < 12; index += 1) {
      const sheet = switchSheets[index % switchSheets.length]!;
      await selectReaderWorksheet(fixture.reader, sheet.title);
      await expect.poll(cell).toBe(`Dịch ${sheet.title.at(-1)}`);
    }
    const googleCalls = fixture.mock.googleCalls.length;
    const providerCalls = fixture.mock.providerCalls;
    await fixture.source.evaluate(() => {
      location.hash = "gid=42";
    });
    await fixture.source.waitForTimeout(350);
    expect(await cell()).toBe("Dịch D");
    expect(
      await fixture.reader.evaluate<string>(
        "document.querySelectorAll('[role=combobox]')[0].textContent",
      ),
    ).toBe("Sheet D");
    expect(fixture.mock.googleCalls).toHaveLength(googleCalls);
    expect(fixture.mock.providerCalls).toBe(providerCalls);
    expect(fixture.mock.providerCalls).toBeLessThanOrEqual(4);
    expect(errors).toEqual([]);
    expect(fixture.mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

async function expectPanelClosed(control: CDPSession, extensionId: string) {
  await expect
    .poll(async () => {
      const targets = await readerTargets(control, extensionId);
      if (!targets.length) return true;
      for (const target of targets) {
        try {
          const reader = await attachReader(control, target.targetId);
          if (
            (await reader.evaluate<string>("document.visibilityState")) ===
            "visible"
          )
            return false;
        } catch (error) {
          if (
            !/No target with given id found|No session with given id|Session closed/.test(
              String(error),
            )
          )
            throw error;
          // A target can retire between discovery and attachment. A fresh
          // snapshot must confirm that retirement; a live target still fails.
          if (
            (await readerTargets(control, extensionId)).some(
              ({ targetId }) => targetId === target.targetId,
            )
          )
            throw error;
          return false;
        }
      }
      return true;
    })
    .toBe(true);
}

for (const format of ["xlsx", "xlsm"] as const) {
  test(`reader Drive port real toolbar first-open ${format} and Refresh recover with the original global sender`, async () => {
    test.skip(true, DRIVE_OFFICE_DEFERRED);
    test.setTimeout(90_000);
    const session = await launchExtension();
    let control: CDPSession | undefined;
    try {
      const mock = await installMocks(session.context);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([["Office source"]]),
        "Office worksheet",
      );
      const bytes = Buffer.from(
        XLSX.write(workbook, {
          type: "array",
          bookType: format,
        }) as ArrayBuffer,
      );
      await mockSourceMetadata(session, bytes);
      expect(await mockGoogleIdentity(session)).toBe(true);
      await session.worker.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          __drivePortSenders?: { url?: string; documentId?: string }[];
          chrome: {
            runtime: {
              onConnect: {
                addListener(
                  listener: (port: {
                    name: string;
                    sender?: { url?: string; documentId?: string };
                  }) => void,
                ): void;
              };
            };
          };
        };
        runtime.__drivePortSenders = [];
        runtime.chrome.runtime.onConnect.addListener((port) => {
          if (port.name === "google-drive-office-reader-v1")
            runtime.__drivePortSenders!.push({
              url: port.sender?.url,
              documentId: port.sender?.documentId,
            });
        });
      });
      const url = `https://docs.google.com/spreadsheets/d/office_first_${format}/edit#gid=7`;
      const source = await routeSyntheticEditor(
        session.context,
        url,
        "Office first-open fixture",
      );
      const tabId = await sourceTabId(session, url);
      const setup = await session.context.newPage();
      await setup.goto(`chrome-extension://${session.extensionId}/popup.html`);
      await setup.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: {
              runtime: { sendMessage(message: unknown): Promise<unknown> };
            };
          }
        ).chrome.runtime.sendMessage({ type: "AUTH_STATUS" }),
      );
      await setup.close();
      await expect
        .poll(async () => (await toolbarOptions(session, tabId)).popup)
        .toBe("");
      control = await triggerToolbar(session, source);
      const version = await control.send("Browser.getVersion");
      await test.info().attach("fixture-chromium-version", {
        body: JSON.stringify(version),
        contentType: "application/json",
      });
      await expect
        .poll(
          async () =>
            (await readerTargets(control!, session.extensionId)).length,
        )
        .toBe(1);
      const target = (await readerTargets(control, session.extensionId))[0]!;
      const reader = await attachReader(control, target.targetId);
      await expect
        .poll(() => reader.evaluate<string>("document.body.innerText"))
        .toContain("Connect Google Workspace");
      await clickReaderButton(reader, "Connect Google Workspace");
      const cell = () =>
        reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        );
      await expect.poll(cell).toBe("Office source");
      const senders = () =>
        session.worker.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __drivePortSenders?: { url?: string; documentId?: string }[];
              }
            ).__drivePortSenders ?? [],
        );
      expect((await senders()).map(({ url }) => url)).toEqual([
        `chrome-extension://${session.extensionId}/reader.html`,
      ]);
      await test.info().attach("original-drive-port-sender", {
        body: JSON.stringify(await senders()),
        contentType: "application/json",
      });
      const mediaCount = () =>
        session.worker.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __sourceMetadataCalls?: string[];
              }
            ).__sourceMetadataCalls?.filter((url) => url.includes("alt=media"))
              .length ?? 0,
        );
      expect(await mediaCount()).toBe(1);
      await session.worker.evaluate((fileId) => {
        (
          globalThis as typeof globalThis & {
            __holdSourceMetadataFileId?: string;
          }
        ).__holdSourceMetadataFileId = fileId;
      }, `office_first_${format}`);
      await clickReaderButton(reader, "Refresh");
      await expect
        .poll(() =>
          reader.evaluate<boolean>(
            "document.querySelector('.spreadsheet-grid-skeleton') !== null",
          ),
        )
        .toBe(true);
      for (const width of [320, 480, 1000]) {
        await reader.evaluate<void>(
          `document.documentElement.style.width = '${width}px';`,
        );
        const geometry = await reader.evaluate<{
          resultWidth: number;
          sourceWidth: number;
          resultHeight: number;
          sourceHeight: number;
          skeletonWidth: number;
          sourceTop: number;
          footerBottom: number;
        }>(`(() => {
            const results = document.querySelector('.sheets-results').getBoundingClientRect();
            const source = document.querySelector('.spreadsheet-source-state').getBoundingClientRect();
            const skeleton = document.querySelector('.spreadsheet-grid-skeleton').getBoundingClientRect();
            const footer = document.querySelector('.spreadsheet-connection-footer').getBoundingClientRect();
            return {resultWidth:results.width,sourceWidth:source.width,resultHeight:results.height,sourceHeight:source.height,skeletonWidth:skeleton.width,sourceTop:source.top,footerBottom:footer.bottom};
          })()`);
        expect(
          Math.abs(geometry.sourceWidth - geometry.resultWidth),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(geometry.sourceHeight - geometry.resultHeight),
        ).toBeLessThanOrEqual(1);
        expect(geometry.skeletonWidth).toBeGreaterThanOrEqual(
          geometry.resultWidth - 26,
        );
        expect(geometry.sourceTop).toBeGreaterThanOrEqual(
          geometry.footerBottom,
        );
      }
      await reader.evaluate<void>(
        "document.documentElement.style.width = ''; ",
      );
      await session.worker.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          __holdSourceMetadataFileId?: string;
          __releaseSourceMetadata?: () => void;
        };
        runtime.__holdSourceMetadataFileId = undefined;
        runtime.__releaseSourceMetadata?.();
      });
      await expect.poll(mediaCount).toBe(2);
      await expect.poll(cell).toBe("Office source");
      expect((await senders()).map(({ url }) => url)).toEqual(
        Array(2).fill(`chrome-extension://${session.extensionId}/reader.html`),
      );
      expect(mock.providerCalls).toBe(0);

      // A local channel failure must not claim an external Google outage.
      await reader.evaluate<void>(
        `globalThis.__restoreDriveConnect = chrome.runtime.connect; chrome.runtime.connect = () => { throw new Error("deterministic channel closure"); };`,
      );
      await clickReaderButton(reader, "Refresh");
      await expect
        .poll(() => reader.evaluate<string>("document.body.innerText"))
        .toContain("Reader could not connect to the extension background");
      expect(
        await reader.evaluate<string>("document.body.innerText"),
      ).not.toContain("Google Drive is temporarily unavailable");
      expect(await mediaCount()).toBe(2);
      await reader.evaluate<void>(
        "chrome.runtime.connect = globalThis.__restoreDriveConnect;",
      );
      await clickReaderButton(reader, "Refresh");
      await expect.poll(mediaCount).toBe(3);
      await expect.poll(cell).toBe("Office source");

      await session.worker.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __sourceMetadataFailureStatus?: number;
          }
        ).__sourceMetadataFailureStatus = 503;
      });
      await clickReaderButton(reader, "Refresh");
      await expect
        .poll(() => reader.evaluate<string>("document.body.innerText"))
        .toContain("Google Drive is temporarily unavailable");
      expect(await mediaCount()).toBe(3);
      await session.worker.evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __sourceMetadataFailureStatus?: number;
          }
        ).__sourceMetadataFailureStatus = undefined;
      });
      await clickReaderButton(reader, "Refresh");
      await expect.poll(mediaCount).toBe(4);
      await expect.poll(cell).toBe("Office source");
      expect(mock.providerCalls).toBe(0);
      await clickReaderButton(reader, "Translate");
      await expect.poll(cell).toContain("translated-result");
      expect(mock.providerCalls).toBe(1);
      if (format === "xlsx") {
        await reader.evaluate<void>(`globalThis.__restoreContextSend = chrome.runtime.sendMessage; globalThis.__heldDriveHandshake = false; chrome.runtime.sendMessage = (message, ...rest) => {
          if (message?.type === "WORKSPACE_READER_CONTEXT" && !message.identifySource) {
            globalThis.__heldDriveHandshake = true;
            return new Promise((resolve, reject) => { globalThis.__releaseDriveHandshake = () => globalThis.__restoreContextSend.call(chrome.runtime, message, ...rest).then(resolve, reject); });
          }
          return globalThis.__restoreContextSend.call(chrome.runtime, message, ...rest);
        };`);
        await clickReaderButton(reader, "Refresh");
        await expect
          .poll(() =>
            reader.evaluate<boolean>("globalThis.__heldDriveHandshake"),
          )
          .toBe(true);
        await session.context.route(
          "https://docs.google.com/spreadsheets/d/office_retired/edit*",
          (route) =>
            route.fulfill({
              contentType: "text/html",
              body: "<main>New Office source</main>",
            }),
        );
        await source.goto(
          "https://docs.google.com/spreadsheets/d/office_retired/edit#gid=8",
        );
        await expect
          .poll(() =>
            reader.evaluate<boolean>(
              "document.querySelector('[data-source-phase=\"awaiting-start\"]') !== null",
            ),
          )
          .toBe(true);
        await reader.evaluate<void>(
          "chrome.runtime.sendMessage = globalThis.__restoreContextSend; globalThis.__releaseDriveHandshake();",
        );
        await expect
          .poll(() =>
            reader.evaluate<number>(
              "document.querySelectorAll('[data-cell-address]').length",
            ),
          )
          .toBe(0);
        expect(await mediaCount()).toBe(4);
        expect(mock.providerCalls).toBe(1);
      }
      expect(mock.unexpected).toEqual([]);
    } finally {
      await control?.detach();
      await closeExtension(session);
    }
  });
}

// Uses the real built action handler and real Chromium sidePanel/action APIs.
test("reader Drive port popup Translate opens the real common panel and translates Office", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  test.setTimeout(90_000);
  const session = await launchExtension();
  let popup: Awaited<ReturnType<typeof openActionPopup>> | undefined;
  let control: CDPSession | undefined;
  try {
    const mock = await installMocks(session.context);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Popup Office source"]]),
      "Office worksheet",
    );
    await mockSourceMetadata(
      session,
      Buffer.from(
        XLSX.write(workbook, {
          type: "array",
          bookType: "xlsm",
        }) as ArrayBuffer,
      ),
    );
    expect(await mockGoogleIdentity(session)).toBe(true);
    const url =
      "https://docs.google.com/spreadsheets/d/office_popup_xlsm/edit#gid=7";
    const source = await routeSyntheticEditor(
      session.context,
      url,
      "Office popup source",
    );
    await sourceTabId(session, url);
    popup = await openActionPopup(session.context, session.extensionId, source);
    await expect
      .poll(() =>
        popup!.popup.evaluate<boolean>(
          "document.querySelector('main[aria-busy=\"false\"]') !== null && document.body.innerText.includes('reader@example.test')",
        ),
      )
      .toBe(true);
    await clickReaderButton(popup.popup, "Translate");
    await expect.poll(() => popup!.isOpen()).toBe(false);
    control = await session.context.browser()!.newBrowserCDPSession();
    await expect
      .poll(
        async () => (await readerTargets(control!, session.extensionId)).length,
      )
      .toBe(1);
    const reader = await attachReader(
      control,
      (await readerTargets(control, session.extensionId))[0]!.targetId,
    );
    await expect
      .poll(() => reader.evaluate<string>("document.body.innerText"))
      .toContain("Connect Google Workspace");
    await clickReaderButton(reader, "Connect Google Workspace");
    await expect
      .poll(() =>
        reader.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toContain("translated-result");
    expect(mock.providerCalls).toBe(1);
    expect(await reader.evaluate<string>("location.pathname")).toBe(
      "/reader.html",
    );
    expect(mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await popup?.close();
    await closeExtension(session);
  }
});

test("reader pre-start controls use catalog titles and metadata-only selection and Refresh", async () => {
  test.setTimeout(90_000);
  const session = await launchExtension();
  try {
    const mock = await installMocks(session.context);
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session);
    const catalog = [
      { id: 30002, title: "Overview", source: "Overview source" },
      { id: 30003, title: "Rules", source: "Rules source" },
      { id: 30004, title: "Latest choice", source: "Latest source" },
    ];
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        const url = new URL(route.request().url());
        if (!url.pathname.includes("sheet_456"))
          return fulfillBasicSheet(route, mock);
        mock.googleCalls.push(url.href);
        const selected =
          catalog.find(({ title }) =>
            decodeURIComponent(
              `${url.pathname} ${url.searchParams.get("ranges") ?? ""}`,
            ).includes(title),
          ) ?? catalog[0]!;
        const properties = (sheet: (typeof catalog)[number]) => ({
          ...sheetMetadata(1).sheets[0]!.properties,
          sheetId: sheet.id,
          title: sheet.title,
        });
        if (url.pathname.includes("/values/")) {
          await route.fulfill({
            json: { majorDimension: "COLUMNS", values: [[selected.source]] },
          });
        } else if (url.searchParams.get("includeGridData") === "true") {
          const page = sheetPage(0, selected.source);
          await route.fulfill({
            json: {
              ...page,
              spreadsheetId: "sheet_456",
              sheets: [{ ...page.sheets[0], properties: properties(selected) }],
            },
          });
        } else {
          await route.fulfill({
            json: {
              spreadsheetId: "sheet_456",
              sheets: (url.searchParams.has("ranges")
                ? [selected]
                : catalog
              ).map((sheet) => ({
                properties: properties(sheet),
                merges: [],
                data: [
                  { startColumn: 0, columnMetadata: [{ pixelSize: 100 }] },
                ],
              })),
            },
          });
        }
      },
    );
    const initialUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      initialUrl,
      "Initial native",
    );
    const tabId = await sourceTabId(session, initialUrl);
    const reader = await session.context.newPage();
    await captureReaderMessages(reader);
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveText(
      "こんにちは",
    );
    const nextUrl =
      "https://docs.google.com/spreadsheets/d/sheet_456/edit#gid=30002";
    await session.context.route(nextUrl.split("#")[0]!, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Catalog source</main>",
      }),
    );
    await source.goto(nextUrl);
    const worksheet = reader.getByRole("combobox", { name: "Worksheet" });
    await expect(
      reader.locator('[data-source-phase="awaiting-start"]'),
    ).toBeVisible();
    await expect(worksheet).toHaveText("Overview");
    await expect(worksheet).toBeEnabled();
    await expect(
      reader.getByRole("combobox", { name: "Provider" }),
    ).toHaveCount(0);
    const target = reader.getByRole("combobox", { name: "Translate to" });
    await expect(target).toBeEnabled();
    await target.click();
    await reader.getByRole("option", { name: "Japanese", exact: true }).click();
    await worksheet.click();
    await reader.getByRole("option", { name: "Rules", exact: true }).click();
    await expect(worksheet).toHaveText("Rules");
    await worksheet.click();
    await reader
      .getByRole("option", { name: "Latest choice", exact: true })
      .click();
    await expect(worksheet).toHaveText("Latest choice");
    await reader.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(reader.locator("main.reader-shell")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(worksheet).toHaveText("Latest choice");
    await expect(target).toHaveText("Japanese");
    const newFileCalls = () =>
      mock.googleCalls.filter((url) => url.includes("/sheet_456"));
    expect(newFileCalls().length).toBeGreaterThan(0);
    expect(
      newFileCalls().every(
        (url) =>
          !url.includes("/values/") &&
          !url.includes("includeGridData=true") &&
          !url.includes("ranges="),
      ),
    ).toBe(true);
    expect(mock.providerCalls).toBe(0);
    const callsBeforeEditorChange = newFileCalls().length;
    await source.evaluate(() => {
      location.hash = "gid=30003";
    });
    await expect(worksheet).toHaveText("Latest choice");
    await source.waitForTimeout(350);
    expect(newFileCalls()).toHaveLength(callsBeforeEditorChange);
    await reader
      .getByRole("button", { name: "Translate", exact: true })
      .click();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "translated-result",
    );
    expect(mock.providerRequests).toEqual([["Latest source"]]);
    const discoveryCalls = newFileCalls().filter((url) =>
      url.includes("/values/"),
    );
    expect(discoveryCalls.length).toBeGreaterThan(0);
    expect(
      discoveryCalls.every((url) =>
        decodeURIComponent(url).includes("Latest choice"),
      ),
    ).toBe(true);
    await session.context.route(
      "https://docs.google.com/spreadsheets/d/office_transition/edit*",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Office transition</main>",
        }),
    );
    await source.goto(
      "https://docs.google.com/spreadsheets/d/office_transition/edit#gid=7",
    );
    // ADR 0015: a Drive-stored Office workbook is refused by the Sheets API
    // at launch; Reader shows the download guidance and the Local Reader
    // action, and never downloads from Drive.
    await expect(reader.locator(".reader-status")).toContainText(
      "This Excel workbook is stored in Google Drive",
    );
    await expect(
      reader.getByRole("button", { name: "Open local spreadsheet" }),
    ).toBeVisible();
    await expect(
      reader.getByText("Google Drive Spreadsheet Reader"),
    ).toHaveCount(0);
    expect(
      await session.worker.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __sourceMetadataCalls?: string[];
            }
          ).__sourceMetadataCalls?.filter((url) =>
            url.includes("/office_transition"),
          ).length ?? 0,
      ),
    ).toBeGreaterThan(0);
    expect(mock.providerCalls).toBe(1);
    expect(mock.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("reader toolbar routing keeps supported tabs visible and closes until an explicit new icon click", async () => {
  test.setTimeout(90_000);
  const session = await launchExtension();
  let control: CDPSession | undefined;
  try {
    const mock = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mock),
    );
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Toolbar fixture A",
    );
    const tabId = await session.worker.evaluate(async () => {
      const chrome = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query(options: unknown): Promise<{ id?: number; url?: string }[]>;
            };
          };
        }
      ).chrome;
      return (await chrome.tabs.query({})).find((tab) =>
        tab.url?.includes("sheet_123"),
      )!.id!;
    });
    // ADR 0020: no sign-in, so a supported editor routes to the Reader
    // from the start.
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session);
    const sourceB = await routeSyntheticEditor(
      session.context,
      "https://docs.google.com/spreadsheets/d/sheet_456/edit#gid=42",
      "Toolbar fixture B",
    );
    await source.bringToFront();
    await expect
      .poll(async () => (await toolbarOptions(session, tabId)).popup)
      .toBe("");
    expect((await toolbarOptions(session, tabId)).panel).toMatchObject({
      enabled: true,
      path: "reader.html",
    });
    control = await triggerToolbar(session, source);
    const fixtureVersion = (await control.send("Browser.getVersion")) as {
      product: string;
    };
    console.info(`Fixture browser: ${fixtureVersion.product}`);
    await test.info().attach("fixture-chromium-version", {
      body: JSON.stringify(fixtureVersion),
      contentType: "application/json",
    });
    await expect
      .poll(
        async () => (await readerTargets(control!, session.extensionId)).length,
      )
      .toBe(1);
    const panelTarget = (await readerTargets(control, session.extensionId))[0]!;
    const panel = await attachReader(control, panelTarget.targetId);
    await expect
      .poll(() => panel.evaluate<string>("document.body.innerText"))
      .toMatch(/Connect Google Workspace|Translate/);
    expect(mock.providerCalls).toBe(0);
    await clickReaderButton(panel, "Connect Google Workspace");
    await expect
      .poll(() =>
        panel.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("こんにちは");
    const callsAfterA = mock.googleCalls.length;
    await sourceB.bringToFront();
    await expect
      .poll(() =>
        panel.evaluate<string>(
          "document.querySelector('.source-context strong')?.textContent ?? ''",
        ),
      )
      .toBe("Active sheet");
    await expect
      .poll(() =>
        panel.evaluate<boolean>(
          "document.querySelector('[data-source-phase=\"awaiting-start\"]') !== null",
        ),
      )
      .toBe(true);
    expect(await panel.evaluate<string>("document.visibilityState")).toBe(
      "visible",
    );
    expect(
      (await readerTargets(control, session.extensionId))[0]!.targetId,
    ).toBe(panelTarget.targetId);
    expect(
      await panel.evaluate<number>(
        "document.querySelector('.reader-pane[data-active=true]').querySelectorAll('[data-cell-address]').length",
      ),
    ).toBe(0);
    expect(
      await panel.evaluate<string>(
        "document.querySelector('.reader-pane[data-active=false] [data-cell-address=\"A1\"]')?.textContent ?? ''",
      ),
    ).toBe("こんにちは");
    const metadataCallsForB = mock.googleCalls.slice(callsAfterA);
    expect(metadataCallsForB.length).toBeGreaterThan(0);
    expect(
      metadataCallsForB.every(
        (url) =>
          url.includes("/sheet_456") &&
          !url.includes("/values/") &&
          !url.includes("includeGridData=true") &&
          !url.includes("ranges="),
      ),
    ).toBe(true);
    expect(mock.providerCalls).toBe(0);
    await routeSyntheticEditor(
      session.context,
      "https://example.test/article",
      "Unrelated fixture",
    );
    await expectPanelClosed(control, session.extensionId);
    await source.bringToFront();
    await expect
      .poll(async () => (await toolbarOptions(session, tabId)).popup)
      .toBe("");
    await expectPanelClosed(control, session.extensionId);
    const targets = (await control.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: { targetId: string; type: string; url: string }[] };
    void control.send("Extensions.triggerAction", {
      id: session.extensionId,
      targetId: targets.targetInfos.find(
        (target) => target.type === "tab" && target.url === source.url(),
      )!.targetId,
    });
    await expect
      .poll(
        async () => (await readerTargets(control!, session.extensionId)).length,
      )
      .toBe(1);
    const restored = await attachReader(
      control,
      (await readerTargets(control, session.extensionId))[0]!.targetId,
    );
    await expect
      .poll(() => restored.evaluate<string>("document.visibilityState"))
      .toBe("visible");
    await expect
      .poll(() =>
        restored.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("こんにちは");
    await session.context.route("https://drive.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Drive fixture</main>",
      }),
    );
    await source.goto("https://drive.google.com/drive/u/0/folders/fixture");
    await expectPanelClosed(control, session.extensionId);
    await source.goto(editorUrl);
    await expect
      .poll(async () => (await toolbarOptions(session, tabId)).popup)
      .toBe("");
    await expectPanelClosed(control, session.extensionId);
    expect(mock.providerCalls).toBe(0);
    expect(mock.unexpected).toEqual([]);
  } finally {
    await control?.detach();
    await closeExtension(session);
  }
});

test("reader multi-tab independence preserves pending work in the real global side panel", async () => {
  test.setTimeout(90_000);
  const session = await launchExtension();
  const held = deferred<void>();
  let control: CDPSession | undefined;
  try {
    const mock = await installMocks(session.context);
    await mockSourceMetadata(session);
    expect(await mockGoogleIdentity(session)).toBe(true);
    await session.context.route("https://sheets.googleapis.com/**", (route) => {
      const fileId = /spreadsheets\/([^/]+)/.exec(route.request().url())?.[1];
      return fulfillBasicSheet(route, mock, { first: `Source ${fileId}` });
    });
    const sources: Page[] = [];
    const tabIds: number[] = [];
    const fileIds = ["sheet_123", "sheet_456", "sheet_789", "sheet_012"];
    for (const fileId of fileIds) {
      const url = `https://docs.google.com/spreadsheets/d/${fileId}/edit#gid=42`;
      sources.push(await routeSyntheticEditor(session.context, url, fileId));
      tabIds.push(await sourceTabId(session, url));
    }
    await session.worker.evaluate(async () => {
      const runtime = globalThis as typeof globalThis & {
        chrome: {
          runtime: {
            sendMessage(message: unknown): Promise<unknown>;
            onMessage: {
              addListener(
                callback: (message: {
                  type?: string;
                  sourceTabId?: number;
                }) => void,
              ): void;
            };
          };
        };
        __multiTabMessages?: { type?: string; sourceTabId?: number }[];
      };
      runtime.__multiTabMessages = [];
      runtime.chrome.runtime.onMessage.addListener((message) => {
        if (message.type?.startsWith("WORKSPACE_READER_"))
          runtime.__multiTabMessages!.push({
            type: message.type,
            sourceTabId: message.sourceTabId,
          });
      });
    });
    const setup = await session.context.newPage();
    await setup.goto(`chrome-extension://${session.extensionId}/popup.html`);
    await setup.evaluate(() =>
      (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome.runtime.sendMessage({ type: "AUTH_STATUS" }),
    );
    await setup.close();
    await expect
      .poll(async () => (await toolbarOptions(session, tabIds[0]!)).popup)
      .toBe("");
    control = await triggerToolbar(session, sources[0]!);
    await expect
      .poll(
        async () => (await readerTargets(control!, session.extensionId)).length,
      )
      .toBe(1);
    const targetId = (await readerTargets(control, session.extensionId))[0]!
      .targetId;
    const reader = await attachReader(control, targetId);
    await expect
      .poll(() => reader.evaluate<string>("document.body.innerText"))
      .toContain("Connect Google Workspace");
    await clickReaderButton(reader, "Connect Google Workspace");
    const snapshot = () =>
      reader.evaluate<{ active: boolean; cells: string; text: string }[]>(
        `[...document.querySelectorAll('.reader-pane')].map(p => ({active:p.dataset.active === 'true',cells:[...p.querySelectorAll('[data-cell-address]')].map(c=>c.textContent).join('|'),text:p.innerText}))`,
      );
    await expect
      .poll(async () => (await snapshot())[0]?.cells)
      .toContain("Source sheet_123");
    mock.translate = async (sources) => {
      await held.promise;
      return sources.map(
        (source) =>
          `Independent translated ${/sheet_\d+/.exec(source)?.[0]} result`,
      );
    };
    await clickReaderButton(reader, "Translate");
    await expect.poll(() => mock.providerPending).toBe(1);
    const originalCalls = () =>
      session.worker.evaluate(
        (tabId) =>
          (
            (
              globalThis as typeof globalThis & {
                __multiTabMessages?: { type?: string; sourceTabId?: number }[];
              }
            ).__multiTabMessages ?? []
          ).filter(
            (m) =>
              m.sourceTabId === tabId &&
              [
                "WORKSPACE_READER_CONTEXT",
                "WORKSPACE_READER_DISCOVER",
                "WORKSPACE_READER_LOAD",
              ].includes(m.type ?? ""),
          ).length,
        tabIds[0]!,
      );
    const beforeSwitch = await originalCalls();
    await sources[1]!.bringToFront();
    await expect.poll(async () => (await snapshot()).length).toBe(2);
    await expect
      .poll(async () => (await snapshot())[1]?.text)
      .toContain("Translate");
    await test.info().attach("multi-tab-after-switch.json", {
      body: JSON.stringify({
        panes: await snapshot(),
        beforeSwitch,
        afterSwitch: await originalCalls(),
        providerPending: mock.providerPending,
      }),
      contentType: "application/json",
    });
    // The actual App must retain its grid and pending request while hidden.
    expect((await snapshot())[0]?.cells).toContain("Source sheet_123");
    expect(await originalCalls()).toBe(beforeSwitch);
    await clickReaderButton(reader, "Translate");
    await expect.poll(() => mock.providerPending).toBe(2);
    for (const source of sources.slice(2)) {
      await source.bringToFront();
      await expect
        .poll(async () => (await snapshot()).find((p) => p.active)?.text)
        .toContain("Click Translate");
      await clickReaderButton(reader, "Translate");
    }
    await expect.poll(async () => (await snapshot()).length).toBe(4);
    held.resolve();
    await expect
      .poll(
        async () =>
          (await snapshot()).filter((p) =>
            p.cells.includes("Independent translated"),
          ).length,
      )
      .toBe(4);
    const completedCalls = mock.providerCalls;
    const discoveryCalls = mock.googleCalls.length;
    for (const source of [...sources].reverse()) {
      await source.bringToFront();
      await expect
        .poll(async () => (await snapshot()).find((p) => p.active)?.cells)
        .toContain(
          `Independent translated ${fileIds[sources.indexOf(source)]} result`,
        );
    }
    expect(mock.providerCalls).toBe(completedCalls);
    expect(completedCalls).toBe(4);
    expect(mock.maxProviderPending).toBeLessThanOrEqual(2);
    expect(mock.googleCalls.length).toBe(discoveryCalls);
    expect(await originalCalls()).toBe(beforeSwitch);
    expect(await readerTargets(control, session.extensionId)).toEqual([
      expect.objectContaining({ targetId }),
    ]);
    const statePath = test.info().outputPath("multi-tab-reader-state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          panes: await snapshot(),
          providerCalls: mock.providerCalls,
          originalCalls: await originalCalls(),
          beforeSwitch,
          googleCalls: mock.googleCalls,
          maxProviderPending: mock.maxProviderPending,
        },
        null,
        2,
      ),
    );
    await test.info().attach("multi-tab-reader-state", {
      path: statePath,
      contentType: "application/json",
    });
    const screenshot = await reader.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png" },
    );
    const screenshotPath = test
      .info()
      .outputPath("multi-tab-reader-completed.png");
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    await test.info().attach("multi-tab-reader-completed", {
      path: screenshotPath,
      contentType: "image/png",
    });
    expect(mock.unexpected).toEqual([]);
  } finally {
    held.resolve();
    await control?.detach();
    await closeExtension(session);
  }
});

test("reader toolbar routing isolates OPEN and close across two browser windows", async () => {
  test.setTimeout(90_000);
  const session = await launchExtension();
  const controls: CDPSession[] = [];
  try {
    const mock = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mock),
    );
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session);
    const urlA = "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const sourceA = await routeSyntheticEditor(
      session.context,
      urlA,
      "Window A fixture",
    );
    const tabA = await sourceTabId(session, urlA);
    const setup = await session.context.newPage();
    await setup.goto(`chrome-extension://${session.extensionId}/popup.html`);
    await setup.evaluate(() =>
      (
        globalThis as unknown as {
          chrome: {
            runtime: { sendMessage(message: unknown): Promise<unknown> };
          };
        }
      ).chrome.runtime.sendMessage({ type: "AUTH_STATUS" }),
    );
    await setup.close();
    await expect
      .poll(async () => (await toolbarOptions(session, tabA)).popup)
      .toBe("");
    const controlA = await triggerToolbar(session, sourceA);
    controls.push(controlA);
    await expect
      .poll(
        async () => (await readerTargets(controlA, session.extensionId)).length,
      )
      .toBe(1);
    const targetA = (await readerTargets(controlA, session.extensionId))[0]!;
    const readerA = await attachReader(controlA, targetA.targetId);
    await expect
      .poll(() => readerA.evaluate<string>("document.body.innerText"))
      .toContain("Connect Google Workspace");
    await clickReaderButton(readerA, "Connect Google Workspace");
    await expect
      .poll(() =>
        readerA.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("こんにちは");
    const originalAUrl = await readerA.evaluate<string>("location.href");
    await readerA.evaluate<void>(
      `globalThis.__fixtureSourceChanges = []; chrome.runtime.onMessage.addListener(message => { if (message?.type === 'WORKSPACE_READER_SOURCE_CHANGED') globalThis.__fixtureSourceChanges.push(message); });`,
    );
    const urlB = "https://docs.google.com/spreadsheets/d/sheet_456/edit#gid=42";
    await session.context.route(urlB.split("#")[0]!, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Window B fixture</main>",
      }),
    );
    await session.context.route(
      "https://example.test/window-b-setup",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Window B source setup</main>",
        }),
    );
    const createdPage = session.context.waitForEvent("page");
    const windowB = await session.worker.evaluate(async () =>
      (
        globalThis as unknown as {
          chrome: {
            windows: {
              create(
                options: unknown,
              ): Promise<{ id: number; tabs: { id: number }[] }>;
            };
          };
        }
      ).chrome.windows.create({
        url: "about:blank",
        focused: true,
        type: "normal",
      }),
    );
    const sourceB = await createdPage;
    await sourceB.goto("https://example.test/window-b-setup");
    await sourceB.goto(urlB);
    const tabB = windowB.tabs[0]!.id;
    // Wait for the real coalesced navigation notification before this first Reader open.
    // Source changes in an already-open Reader are exercised by the separate A→B test.
    await expect
      .poll(() =>
        readerA.evaluate<number>(
          `globalThis.__fixtureSourceChanges.filter(message => message.sourceTabId === ${tabB}).length`,
        ),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () => (await toolbarOptions(session, tabB)).popup)
      .toBe("");
    const controlB = await triggerToolbar(session, sourceB);
    controls.push(controlB);
    await expect
      .poll(
        async () =>
          (await readerTargets(controlB, session.extensionId)).filter(
            (target) => target.targetId !== targetA.targetId,
          ).length,
      )
      .toBe(1);
    const targetB = (await readerTargets(controlB, session.extensionId)).find(
      (target) => target.targetId !== targetA.targetId,
    )!;
    const globalReaderB = await attachReader(controlB, targetB.targetId);
    await expect
      .poll(() => globalReaderB.evaluate<string>("document.body.innerText"))
      .toContain("Open Reader in a tab");
    const callsBeforeFallback = mock.googleCalls.length;
    expect(mock.googleCalls.some((url) => url.includes("/sheet_456"))).toBe(
      false,
    );
    expect(mock.providerCalls).toBe(0);
    expect(
      await readerA.evaluate<string>(
        "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
      ),
    ).toBe("こんにちは");
    await clickReaderButton(globalReaderB, "Open Reader in a tab");
    await expect
      .poll(async () =>
        (await readerTargets(controlB, session.extensionId)).some((target) =>
          target.url.includes(`sourceTabId=${tabB}`),
        ),
      )
      .toBe(true);
    const fallbackTargetB = (
      await readerTargets(controlB, session.extensionId)
    ).find((target) => target.url.includes(`sourceTabId=${tabB}`))!;
    const readerB = await attachReader(controlB, fallbackTargetB.targetId);
    await expect
      .poll(() =>
        readerB.evaluate<string>(
          "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
        ),
      )
      .toBe("こんにちは");
    expect(
      mock.googleCalls.some((url) => url.includes("/sheet_456/values/")),
    ).toBe(true);
    expect(mock.googleCalls.length).toBeGreaterThan(callsBeforeFallback);
    expect(mock.providerCalls).toBe(0);
    expect(await readerA.evaluate<string>("location.href")).toBe(originalAUrl);
    expect(
      await readerA.evaluate<string>(
        "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
      ),
    ).toBe("こんにちは");
    await session.context.route("https://example.test/window-b", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Unrelated B</main>",
      }),
    );
    await sourceB.goto("https://example.test/window-b");
    await expect
      .poll(() =>
        readerB.evaluate<number>(
          "document.querySelectorAll('[data-cell-address]').length",
        ),
      )
      .toBe(0);
    expect(await readerA.evaluate<string>("location.href")).toBe(originalAUrl);
    expect(await readerA.evaluate<string>("document.visibilityState")).toBe(
      "visible",
    );
    expect(
      await readerA.evaluate<string>(
        "document.querySelector('[data-cell-address=\"A1\"]')?.textContent ?? ''",
      ),
    ).toBe("こんにちは");
    expect(mock.providerCalls).toBe(0);
    expect(mock.unexpected).toEqual([]);
  } finally {
    for (const control of controls) await control.detach();
    await closeExtension(session);
  }
});

test("reader source ownership reclassifies native to Office in the same tab and waits for Translate", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  test.setTimeout(90_000);
  const session = await launchExtension();
  try {
    const mock = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mock, { first: "Native source" }),
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Office source"]]),
      "Office worksheet",
    );
    const bytes = Buffer.from(
      XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session, bytes);
    const url = "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      url,
      "Native fixture",
    );
    const tabId = await sourceTabId(session, url);
    await session.context.route(
      "https://docs.google.com/spreadsheets/d/office_123/edit*",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Office fixture</main>",
        }),
    );
    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveText(
      "Native source",
    );
    await reader.getByRole("combobox", { name: "Translate to" }).click();
    await reader.getByRole("option", { name: "Japanese" }).click();
    const held = deferred<void>();
    mock.translate = async (sources) => {
      await held.promise;
      return sources.map(() => "Late native translation");
    };
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect.poll(() => mock.providerCalls).toBe(1);
    await source.goto(
      "https://docs.google.com/spreadsheets/d/office_123/edit#gid=7",
    );
    await expect(
      reader.getByText("Google Drive Spreadsheet Reader"),
    ).toBeVisible();
    await expect(
      reader.locator('[data-source-phase="awaiting-start"]'),
    ).toBeVisible();
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveCount(0);
    await expect(
      reader.getByRole("combobox", { name: "Translate to" }),
    ).toHaveText("Japanese");
    held.resolve();
    await expect.poll(() => mock.providerPending).toBe(0);
    expect(mock.providerCalls).toBe(1);
    await expect(reader.getByText("Late native translation")).toHaveCount(0);
    mock.translate = async (sources) => sources.map(() => "Office translated");
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveText(
      "Office translated",
    );
    await expect(
      reader.getByRole("combobox", { name: "Worksheet" }),
    ).toHaveText("Office worksheet");
    expect(mock.providerCalls).toBe(2);
    await reader.getByRole("button", { name: "Stop" }).click();
    await reader.getByRole("combobox", { name: "Translate to" }).click();
    await reader.getByRole("option", { name: "Vietnamese" }).click();
    const lateOffice = deferred<void>();
    mock.translate = async (sources) => {
      await lateOffice.promise;
      return sources.map(() => "Late Office result");
    };
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect.poll(() => mock.providerCalls).toBe(3);
    await session.context.route("https://drive.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<main>Drive list fixture</main>",
      }),
    );
    await source.goto("https://drive.google.com/drive/u/0/folders/fixture");
    await expect
      .poll(async () => (await toolbarOptions(session, tabId)).popup)
      .toContain("popup.html");
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveCount(0);
    lateOffice.resolve();
    await expect.poll(() => mock.providerPending).toBe(0);
    await expect(reader.getByText("Late Office result")).toHaveCount(0);
    expect(mock.providerCalls).toBe(3);
    expect(mock.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("reader source ownership lets Root alone identify an Office switch before explicit media work", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  const session = await launchExtension();
  try {
    const mock = await installMocks(session.context);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Office source"]]),
      "Office worksheet",
    );
    const bytes = Buffer.from(
      XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session, bytes);
    const firstUrl =
      "https://docs.google.com/spreadsheets/d/office_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      firstUrl,
      "Office initial fixture",
    );
    const tabId = await sourceTabId(session, firstUrl);
    await session.context.route(
      "https://docs.google.com/spreadsheets/d/office_456/edit*",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Office next fixture</main>",
        }),
    );
    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveText(
      "Office source",
    );
    await session.worker.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __holdSourceMetadataFileId?: string;
        }
      ).__holdSourceMetadataFileId = "office_456";
    });
    await source.goto(
      "https://docs.google.com/spreadsheets/d/office_456/edit#gid=7",
    );
    await expect(
      reader.locator('[data-source-phase="identifying"]'),
    ).toBeVisible();
    await expect(reader.locator("[data-cell-address]")).toHaveCount(0);
    const callsForNewFile = () =>
      session.worker.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __sourceMetadataCalls?: string[];
            }
          ).__sourceMetadataCalls?.filter((url) =>
            url.includes("/office_456"),
          ) ?? [],
      );
    await expect.poll(async () => (await callsForNewFile()).length).toBe(1);
    expect(
      (await callsForNewFile()).some((url) => url.includes("alt=media")),
    ).toBe(false);
    expect(mock.providerCalls).toBe(0);
    await session.worker.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __holdSourceMetadataFileId?: string;
        __releaseSourceMetadata?: () => void;
      };
      runtime.__holdSourceMetadataFileId = undefined;
      runtime.__releaseSourceMetadata?.();
    });
    await expect(
      reader.locator('[data-source-phase="awaiting-start"]'),
    ).toBeVisible();
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Fixture-office_456.xlsx",
    );
    expect(
      (await callsForNewFile()).some((url) => url.includes("alt=media")),
    ).toBe(false);
    expect(mock.providerCalls).toBe(0);
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "translated-result",
    );
    expect(
      (await callsForNewFile()).filter((url) => url.includes("alt=media")),
    ).toHaveLength(1);
    expect(mock.providerCalls).toBe(1);
    expect(mock.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("reader loading states settle empty awaiting-start and dropdown sheets without provider work", async () => {
  const session = await launchExtension();
  try {
    const mock = await installMocks(session.context);
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session);
    const emptyProperties = {
      ...switchingSheetProperties(switchSheets[0]),
      sheetId: 46,
      title: "Empty worksheet",
    };
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        const url = new URL(route.request().url());
        const empty = decodeURIComponent(url.href).includes("Empty worksheet");
        if (
          url.pathname.includes("empty_123") &&
          url.pathname.includes("/values/")
        ) {
          mock.googleCalls.push(url.href);
          await route.fulfill({
            json: { majorDimension: "COLUMNS", values: [] },
          });
          return;
        }
        if (empty) {
          mock.googleCalls.push(url.href);
          await route.fulfill({
            json: url.pathname.includes("/values/")
              ? { majorDimension: "COLUMNS", values: [] }
              : {
                  spreadsheetId: "sheet_123",
                  sheets: [
                    {
                      properties: emptyProperties,
                      merges: [],
                      data: [
                        {
                          startColumn: 0,
                          columnMetadata: [{ pixelSize: 100 }],
                        },
                      ],
                    },
                  ],
                },
          });
          return;
        }
        if (
          !url.pathname.includes("/values/") &&
          !url.searchParams.get("ranges")
        ) {
          mock.googleCalls.push(url.href);
          await route.fulfill({
            json: {
              ...switchingMetadata(),
              spreadsheetId: url.pathname.includes("empty_123")
                ? "empty_123"
                : "sheet_123",
              sheets: [
                ...switchingMetadata().sheets,
                { properties: emptyProperties },
              ],
            },
          });
          return;
        }
        await fulfillSwitchingSheet(route, mock);
      },
    );
    const url = "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      url,
      "Empty switch fixture",
    );
    const tabId = await sourceTabId(session, url);
    await session.context.route(
      "https://docs.google.com/spreadsheets/d/empty_123/edit*",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Empty file</main>",
        }),
    );
    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveText(
      "Source A",
    );
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "translated-result",
    );
    await reader.getByRole("combobox", { name: "Worksheet" }).click();
    await reader.getByRole("option", { name: "Empty worksheet" }).click();
    await expect(reader.locator('[data-source-phase="empty"]')).toBeVisible();
    await expect(reader.locator("main.reader-shell")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(reader.getByTestId("reader-spinner")).toHaveCount(0);
    expect(mock.providerCalls).toBe(1);
    await source.goto(
      "https://docs.google.com/spreadsheets/d/empty_123/edit#gid=42",
    );
    await expect(
      reader.locator('[data-source-phase="awaiting-start"]'),
    ).toBeVisible();
    expect(mock.providerCalls).toBe(1);
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect(reader.locator('[data-source-phase="empty"]')).toBeVisible();
    await expect(reader.locator("main.reader-shell")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(reader.getByTestId("reader-spinner")).toHaveCount(0);
    expect(mock.providerCalls).toBe(1);
    expect(mock.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("reader loading states keep skeleton and action geometry stable", async () => {
  const session = await launchExtension();
  const release = deferred<void>();
  try {
    const mock = await installMocks(session.context);
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        if (new URL(route.request().url()).pathname.includes("/values/"))
          await release.promise;
        await fulfillBasicSheet(route, mock, { first: "Skeleton source" });
      },
    );
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session);
    const url = "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      url,
      "Loading fixture",
    );
    const tabId = await sourceTabId(session, url);
    const reader = await session.context.newPage();
    await reader.emulateMedia({ reducedMotion: "reduce" });
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    const connect = reader.getByRole("button", {
      name: "Connect Google Workspace",
    });
    await connect.click();
    const skeleton = reader.locator(".spreadsheet-grid-skeleton");
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute("aria-hidden", "true");
    await expect(reader.locator(".reader-status.warning")).toHaveCount(0);
    await expect(reader.getByText(/Discovering columns 0\/0/)).toHaveCount(0);
    await expect(
      reader.locator('[data-source-phase="discovering"]'),
    ).toHaveAttribute("aria-busy", "true");
    await expect(
      reader.getByRole("button", { name: "Loading…" }),
    ).toBeDisabled();
    await expect(reader.getByRole("button", { name: "Stop" })).toBeDisabled();
    for (const width of [320, 480, 1000]) {
      await reader.setViewportSize({ width, height: 720 });
      const geometry = await reader.evaluate(() => {
        const button = document.querySelector<HTMLElement>(".stop-button")!;
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const label = button.querySelector("span")!.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        const skeleton = document.querySelector<HTMLElement>(
          ".spreadsheet-grid-skeleton",
        )!;
        const results = document
          .querySelector(".sheets-results")!
          .getBoundingClientRect();
        const source = document
          .querySelector(".spreadsheet-source-state")!
          .getBoundingClientRect();
        const footer = document
          .querySelector(".spreadsheet-connection-footer")!
          .getBoundingClientRect();
        return {
          iconWidth: icon.width,
          iconHeight: icon.height,
          center: (icon.left + label.right) / 2,
          buttonCenter: rect.left + rect.width / 2,
          overflow: document.documentElement.scrollWidth > innerWidth,
          skeletonHeight: skeleton.getBoundingClientRect().height,
          skeletonWidth: skeleton.getBoundingClientRect().width,
          resultsWidth: results.width,
          resultsHeight: results.height,
          sourceWidth: source.width,
          sourceHeight: source.height,
          sourceTop: source.top,
          footerBottom: footer.bottom,
          animation: getComputedStyle(skeleton.querySelector("span")!)
            .animationName,
        };
      });
      expect(geometry.iconWidth).toBe(16);
      expect(geometry.iconHeight).toBe(16);
      expect(
        Math.abs(geometry.center - geometry.buttonCenter),
      ).toBeLessThanOrEqual(1);
      expect(geometry.overflow).toBe(false);
      expect(geometry.skeletonHeight).toBeGreaterThan(250);
      expect(
        Math.abs(geometry.sourceWidth - geometry.resultsWidth),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.sourceHeight - geometry.resultsHeight),
      ).toBeLessThanOrEqual(1);
      expect(geometry.skeletonWidth).toBeGreaterThanOrEqual(
        geometry.resultsWidth - 26,
      );
      expect(geometry.sourceTop).toBeGreaterThanOrEqual(geometry.footerBottom);
      expect(geometry.animation).toBe("none");
      await reader.screenshot({
        path: test.info().outputPath(`reader-skeleton-${width}.png`),
      });
    }
    release.resolve();
    await expect(reader.locator('[data-cell-address="A1"]')).toHaveText(
      "Skeleton source",
    );
    await expect(skeleton).toHaveCount(0);
    await session.worker.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __holdSourceMetadataFileId?: string;
        }
      ).__holdSourceMetadataFileId = "sheet_loading_next";
    });
    await session.context.route(
      "https://docs.google.com/spreadsheets/d/sheet_loading_next/edit*",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<main>Next source</main>",
        }),
    );
    await source.goto(
      "https://docs.google.com/spreadsheets/d/sheet_loading_next/edit#gid=42",
    );
    await expect(
      reader.locator('[data-source-phase="identifying"]'),
    ).toBeVisible();
    await expect(
      reader.getByRole("heading", { name: "Readlace" }),
    ).toBeVisible();
    await expect(skeleton).toBeVisible();
    const identifyingGeometry = await reader.evaluate(() => {
      const header = document
        .querySelector(".reader-header")!
        .getBoundingClientRect();
      const results = document
        .querySelector(".sheets-results")!
        .getBoundingClientRect();
      const source = document
        .querySelector(".spreadsheet-source-state")!
        .getBoundingClientRect();
      const skeleton = document
        .querySelector(".spreadsheet-grid-skeleton")!
        .getBoundingClientRect();
      return {
        headerBottom: header.bottom,
        sourceTop: source.top,
        sourceWidth: source.width,
        resultWidth: results.width,
        skeletonHeight: skeleton.height,
        sourceHeight: source.height,
        resultHeight: results.height,
      };
    });
    expect(identifyingGeometry.sourceTop).toBeGreaterThanOrEqual(
      identifyingGeometry.headerBottom,
    );
    expect(
      Math.abs(
        identifyingGeometry.sourceWidth - identifyingGeometry.resultWidth,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        identifyingGeometry.sourceHeight - identifyingGeometry.resultHeight,
      ),
    ).toBeLessThanOrEqual(1);
    expect(identifyingGeometry.skeletonHeight).toBeGreaterThan(500);
    await reader.screenshot({
      path: test.info().outputPath("reader-identifying.png"),
    });
    await session.worker.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __holdSourceMetadataFileId?: string;
        __releaseSourceMetadata?: () => void;
      };
      runtime.__holdSourceMetadataFileId = undefined;
      runtime.__releaseSourceMetadata?.();
    });
    await expect(
      reader.locator('[data-source-phase="awaiting-start"]'),
    ).toBeVisible();
    await expect(skeleton).toHaveCount(0);
    expect(mock.providerCalls).toBe(0);
    expect(mock.unexpected).toEqual([]);
  } finally {
    release.resolve();
    await closeExtension(session);
  }
});

test("web OAuth Connect launches one exact flow and keeps the Google token out of Reader artifacts", async () => {
  test.skip(
    (await builtAuthMode()) !== "web",
    "This proof runs against the explicit Comet web OAuth build.",
  );
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    const googleAuthorizations: (string | null)[] = [];
    const googleTransports: {
      method: string;
      url: string;
      body: string | null;
    }[] = [];
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        googleAuthorizations.push(
          (await route.request().allHeaders()).authorization ?? null,
        );
        googleTransports.push({
          method: route.request().method(),
          url: route.request().url(),
          body: route.request().postData(),
        });
        await fulfillBasicSheet(route, mockState);
      },
    );
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    await routeSyntheticEditor(session.context, editorUrl, "Web OAuth source");
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);

    const logArtifacts: string[] = [];
    session.worker.on("console", (message) =>
      logArtifacts.push(message.text()),
    );
    const reader = await session.context.newPage();
    reader.on("console", (message) => logArtifacts.push(message.text()));
    reader.on("pageerror", (error) => logArtifacts.push(error.message));
    await captureReaderMessages(reader);
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await reader
      .getByRole("button", { name: "Connect Google Workspace" })
      .click();
    await reader
      .getByRole("button", { name: "Translate", exact: true })
      .click();
    await expect(reader.locator('[data-cell-address="A1"]')).toBeVisible();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "translated-result",
    );
    await expect.poll(() => mockState.providerPending).toBe(0);

    const identity = await identityMockSnapshot(session.worker);
    expect(identity).toBeDefined();
    expect(identity!.mode).toBe("web");
    expect(identity!.getAuthTokenCalls).toBe(0);
    expect(identity!.removeCachedAuthTokenCalls).toBe(0);
    expect(identity!.redirectPaths).toEqual(["google-workspace"]);
    expect(identity!.webFlows).toHaveLength(1);
    const flow = identity!.webFlows[0]!;
    const authorization = new URL(flow.url);
    expect(flow.interactive).toBe(true);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(authorization.searchParams)).toEqual({
      client_id: webClientId,
      redirect_uri: `https://${session.extensionId}.chromiumapp.org/google-workspace`,
      response_type: "token",
      scope: googleScopes.join(" "),
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      include_granted_scopes: "false",
      prompt: "select_account",
    });
    expect(flow.returnedState).toBe(authorization.searchParams.get("state"));
    expect(googleTransports.length).toBeGreaterThan(0);
    expect(
      googleTransports.every(
        ({ method, url, body }) =>
          method === "GET" &&
          body === null &&
          new URL(url).origin === "https://sheets.googleapis.com" &&
          new URL(url).pathname.startsWith("/v4/spreadsheets/sheet_123"),
      ),
    ).toBe(true);
    expect(
      googleTransports.some(({ url }) =>
        new URL(url).pathname.includes("/values/"),
      ),
    ).toBe(true);
    expect(
      googleTransports.some(
        ({ url }) =>
          new URL(url).searchParams.get("includeGridData") === "true",
      ),
    ).toBe(true);
    expect(new Set(googleAuthorizations)).toEqual(
      new Set([`Bearer ${googleToken}`]),
    );

    const googleRequestsBeforeRefresh = googleAuthorizations.length;
    await stopExtensionWorker(session);
    await reader.getByRole("button", { name: "Refresh" }).click();
    await expect(reader.locator('[data-cell-address="A1"]')).toBeVisible();
    await expect(reader.locator(".reader-header .connection")).toHaveText(
      "Connected",
    );
    expect(googleAuthorizations.length).toBeGreaterThan(
      googleRequestsBeforeRefresh,
    );
    expect(new Set(googleAuthorizations)).toEqual(
      new Set([`Bearer ${googleToken}`]),
    );

    // The explicit first run continues through Refresh and can reuse its
    // accepted cache. Completion has no second actionable Translate button.
    await expect(reader.getByText("<b>translated-result</b>")).toBeVisible();
    const readerMessages = await reader.evaluate(() => {
      const runtime = globalThis as unknown as {
        __workspaceReaderMessages?: unknown[];
      };
      return runtime.__workspaceReaderMessages;
    });
    expect(JSON.stringify(readerMessages)).not.toContain(googleToken);
    expect(await reader.locator("html").innerHTML()).not.toContain(googleToken);
    expect(mockState.backendArtifacts.join("\n")).not.toContain(googleToken);
    expect(logArtifacts.join("\n")).not.toContain(googleToken);
    const protocol = readerMessages as {
      request?: {
        readerInstanceId?: string;
        requestId?: number;
        type?: string;
      };
      response?: {
        version?: { backgroundEpoch?: string; sourceRevision?: number };
      };
    }[];
    const owned = protocol.filter(({ request }) => request?.readerInstanceId);
    expect(
      new Set(owned.map(({ request }) => request!.readerInstanceId)).size,
    ).toBe(1);
    expect(new Set(owned.map(({ request }) => request!.requestId)).size).toBe(
      owned.length,
    );
    expect(
      protocol.some(
        ({ response }) =>
          typeof response?.version?.backgroundEpoch === "string" &&
          Number.isSafeInteger(response.version.sourceRevision),
      ),
    ).toBe(true);
    expect(mockState.providerCalls).toBe(1);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("web OAuth denial leaves Reader disconnected without dispatching source or provider work", async () => {
  test.skip(
    (await builtAuthMode()) !== "web",
    "This proof runs against the explicit Comet web OAuth build.",
  );
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) => {
      mockState.googleCalls.push(route.request().url());
      return route.abort();
    });
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Denied OAuth source",
    );
    const originalHtml = await source
      .locator("#editor")
      .evaluate((node) => node.outerHTML);
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session, "denied")).toBe(true);

    const logArtifacts: string[] = [];
    session.worker.on("console", (message) =>
      logArtifacts.push(message.text()),
    );
    const reader = await session.context.newPage();
    reader.on("console", (message) => logArtifacts.push(message.text()));
    reader.on("pageerror", (error) => logArtifacts.push(error.message));
    await captureReaderMessages(reader);
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await reader
      .getByRole("button", { name: "Connect Google Workspace" })
      .click();

    await expect(
      reader.getByText(
        "Google denied access. Check consent and file permissions.",
      ),
    ).toBeVisible();
    await expect(reader.getByText("Not connected")).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Connect Google Workspace" }),
    ).toBeVisible();

    const identity = await identityMockSnapshot(session.worker);
    expect(identity).toBeDefined();
    expect(identity!.mode).toBe("web");
    expect(identity!.getAuthTokenCalls).toBe(0);
    expect(identity!.removeCachedAuthTokenCalls).toBe(0);
    expect(identity!.redirectPaths).toEqual(["google-workspace"]);
    expect(identity!.webFlows).toHaveLength(1);
    const flow = identity!.webFlows[0]!;
    const authorization = new URL(flow.url);
    const returned = new URL(flow.returnedUrl);
    const returnedFragment = new URLSearchParams(returned.hash.slice(1));
    expect(flow.interactive).toBe(true);
    expect(flow.returnedState).toBe(authorization.searchParams.get("state"));
    expect(`${returned.origin}${returned.pathname}`).toBe(
      `https://${session.extensionId}.chromiumapp.org/google-workspace`,
    );
    expect(returned.search).toBe("");
    expect(Object.fromEntries(returnedFragment)).toEqual({
      error: "access_denied",
      state: authorization.searchParams.get("state"),
    });
    expect(returnedFragment.has("access_token")).toBe(false);

    const readerMessages = await reader.evaluate(() => {
      const runtime = globalThis as unknown as {
        __workspaceReaderMessages?: unknown[];
      };
      return runtime.__workspaceReaderMessages;
    });
    const deniedArtifacts = [
      JSON.stringify(readerMessages),
      await reader.locator("html").innerHTML(),
      mockState.backendArtifacts.join("\n"),
      logArtifacts.join("\n"),
    ].join("\n");
    expect(deniedArtifacts).not.toContain("access_token");
    expect(deniedArtifacts).not.toContain(flow.returnedState);
    expect(mockState.googleCalls).toEqual([]);
    expect(mockState.providerCalls).toBe(0);
    expect(
      await source.locator("#editor").evaluate((node) => node.outerHTML),
    ).toBe(originalHtml);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("malformed web OAuth return is rejected before source or provider work", async () => {
  test.skip(
    (await builtAuthMode()) !== "web",
    "This proof runs against the portable web OAuth build.",
  );
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) => {
      mockState.googleCalls.push(route.request().url());
      return route.abort();
    });
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Malformed OAuth source",
    );
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session, "malformed")).toBe(true);

    const reader = await session.context.newPage();
    await captureReaderMessages(reader);
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await reader
      .getByRole("button", { name: "Connect Google Workspace" })
      .click();

    await expect(
      reader.getByText("Google returned an invalid authorization response."),
    ).toBeVisible();
    await expect(reader.getByText("Access unavailable")).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Reconnect Google Workspace" }),
    ).toBeVisible();
    const readerMessages = await reader.evaluate(() => {
      const runtime = globalThis as unknown as {
        __workspaceReaderMessages?: unknown[];
      };
      return runtime.__workspaceReaderMessages;
    });
    expect(JSON.stringify(readerMessages)).not.toContain(googleToken);
    expect(mockState.googleCalls).toEqual([]);
    expect(mockState.providerCalls).toBe(0);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("Reader grid discovers, paginates and translates only the viewport without mutating Google or the editor", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    const googleRequests: {
      body: string | null;
      method: string;
      url: string;
    }[] = [];
    const discoveryRanges: string[] = [];
    const pageRanges: string[] = [];
    let oversizedDiscovery = true;
    let oversizedFirstPage = true;
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        googleRequests.push({
          body: request.postData(),
          method: request.method(),
          url: url.href,
        });
        mockState.googleCalls.push(url.href);
        if (url.pathname.includes("/values/")) {
          const range = decodeURIComponent(url.pathname.split("/values/")[1]!);
          discoveryRanges.push(range);
          if (oversizedDiscovery) {
            oversizedDiscovery = false;
            await route.fulfill({
              status: 200,
              headers: {
                "content-length": "2097153",
                "content-type": "application/json",
              },
              body: "{}",
            });
            return;
          }
          const match = /!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
          const firstColumn = match?.[1];
          const lastColumn = match?.[3];
          const values =
            firstColumn === "A" && lastColumn === "AF"
              ? Array.from({ length: 27 }, (_, index) =>
                  index === 0
                    ? ["A source", "", 3]
                    : index === 26
                      ? ["far-right"]
                      : [],
                )
              : undefined;
          await route.fulfill({
            json: { majorDimension: "COLUMNS", ...(values && { values }) },
          });
          return;
        }
        const range = url.searchParams.get("ranges");
        if (url.searchParams.get("includeGridData") === "true") {
          if (!range) throw new Error("Missing page range");
          pageRanges.push(range);
          if (range === "'Active sheet'!A1:AA3" && oversizedFirstPage) {
            oversizedFirstPage = false;
            await route.fulfill({
              status: 200,
              headers: {
                "content-length": "2097153",
                "content-type": "application/json",
              },
              body: "{}",
            });
            return;
          }
          const rowMatch = /!A(\d+):AA(\d+)$/.exec(range);
          if (!rowMatch) throw new Error(`Unexpected page range ${range}`);
          const startRow = Number(rowMatch[1]) - 1;
          await route.fulfill({
            json: gridProofPage(startRow, Number(rowMatch[2]) - startRow),
          });
          return;
        }
        if (range) {
          const metadata = gridProofMetadata();
          await route.fulfill({
            json: {
              ...metadata,
              sheets: [
                {
                  ...metadata.sheets[0],
                  merges: [
                    {
                      startRowIndex: 1,
                      endRowIndex: 2,
                      startColumnIndex: 0,
                      endColumnIndex: 2,
                    },
                  ],
                  data: [
                    {
                      startColumn: 0,
                      columnMetadata: Array.from(
                        { length: 27 },
                        (_, index) => ({
                          pixelSize:
                            index === 0
                              ? 50
                              : index === 2
                                ? 500
                                : index === 5
                                  ? 110
                                  : 100,
                          ...(index === 3 && { hiddenByUser: true }),
                        }),
                      ),
                    },
                  ],
                },
              ],
            },
          });
          return;
        }
        await route.fulfill({
          json: gridProofMetadata(),
        });
      },
    );
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Synthetic sheet source",
    );
    const originalHtml = await source
      .locator("#editor")
      .evaluate((node) => node.outerHTML);
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);

    const reader = await session.context.newPage();
    await reader.setViewportSize({ width: 420, height: 720 });
    await captureReaderMessages(reader);
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "A source\nwrapped",
    );
    await expect(reader.getByText(/^\d+ records loaded\.$/)).toHaveCount(0);
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Active sheet",
    );
    const grid = reader.getByRole("grid", { name: "Active sheet sheet" });
    await expect(grid).toHaveAttribute("dir", "rtl");
    await expect(grid).toHaveAttribute("aria-colcount", "28");
    await expect(grid).toHaveAttribute("aria-rowcount", "4");
    expect(mockState.providerCalls).toBe(0);

    expect(discoveryRanges).toEqual([
      "'Active sheet'!AG1:BL300",
      "'Active sheet'!AG1:BL150",
      "'Active sheet'!AG151:BL300",
      "'Active sheet'!A1:AF300",
    ]);
    expect(pageRanges.slice(0, 3)).toEqual([
      "'Active sheet'!A1:AA3",
      "'Active sheet'!A1:AA1",
      "'Active sheet'!A2:AA3",
    ]);
    expect(
      googleRequests.every(
        ({ body, method, url }) =>
          method === "GET" &&
          body === null &&
          new URL(url).origin === "https://sheets.googleapis.com",
      ),
    ).toBe(true);
    const urls = googleRequests.map(({ url }) => new URL(url));
    expect(
      urls.every((url) =>
        url.pathname.includes("/values/")
          ? url.searchParams.get("fields") === "majorDimension,range,values" &&
            url.searchParams.get("majorDimension") === "COLUMNS" &&
            url.searchParams.get("valueRenderOption") === "FORMULA" &&
            url.searchParams.get("dateTimeRenderOption") === "SERIAL_NUMBER"
          : url.searchParams.get("fields")?.startsWith("spreadsheetId,") &&
            url.searchParams.get("fields")?.includes("sheets(properties(") &&
            !url.searchParams.get("fields")?.includes("*"),
      ),
    ).toBe(true);

    const viewport = reader.locator(".sheets-grid-viewport");
    const panelGeometry = () =>
      viewport.evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        bottom: element.getBoundingClientRect().bottom,
        height: element.getBoundingClientRect().height,
        windowHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
      }));
    await expect
      .poll(async () => {
        const geometry = await panelGeometry();
        return Math.abs(geometry.bottom - geometry.windowHeight);
      })
      .toBeLessThanOrEqual(2);
    const initialPanel = await panelGeometry();
    expect(initialPanel.height).toBeGreaterThan(300);
    expect(initialPanel.documentHeight).toBeLessThanOrEqual(722);
    await reader.screenshot({
      path: test.info().outputPath("reader-narrow.png"),
    });
    await reader.setViewportSize({ width: 420, height: 900 });
    await expect
      .poll(async () => (await panelGeometry()).height - initialPanel.height)
      .toBeGreaterThan(175);
    await reader.setViewportSize({ width: 420, height: 720 });
    const narrowWidth = await reader
      .locator(".reader-shell")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(narrowWidth).toBe(420);
    await reader.setViewportSize({ width: 1_000, height: 720 });
    await expect
      .poll(() =>
        reader
          .locator(".reader-shell")
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBe(1_000);
    expect(
      await reader
        .locator('.sheets-grid-row[aria-rowindex="2"]')
        .evaluate(
          (element) => (element as HTMLElement).style.gridTemplateColumns,
        ),
    ).toContain("50px 100px 500px 0px 100px 110px");
    const a1 = reader.locator('[data-cell-address="A1"]');
    await expect(a1).toContainText("A source\nwrapped");
    expect(
      await a1.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        position: getComputedStyle(element).position,
        whiteSpace: getComputedStyle(
          element.querySelector(".sheets-cell-text")!,
        ).whiteSpace,
      })),
    ).toMatchObject({ position: "sticky", whiteSpace: "pre-wrap" });
    // The saved height is a minimum; explicit source WRAP remains readable
    // by growing the row instead of clipping text into the 21px source minimum.
    const wrappedSourceGeometry = await a1.evaluate((element) => {
      const text = element.querySelector(".sheets-cell-text")!;
      const cellRect = element.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      return {
        mode: element.getAttribute("data-text-mode"),
        cellHeight: cellRect.height,
        textHeight: textRect.height,
        topDelta: textRect.top - cellRect.top,
        bottomDelta: textRect.bottom - cellRect.bottom,
      };
    });
    expect(wrappedSourceGeometry.mode).toBe("wrap");
    expect(wrappedSourceGeometry.cellHeight).toBeGreaterThanOrEqual(21);
    expect(wrappedSourceGeometry.textHeight).toBeGreaterThan(0);
    expect(wrappedSourceGeometry.topDelta).toBeGreaterThanOrEqual(-1);
    expect(wrappedSourceGeometry.bottomDelta).toBeLessThanOrEqual(1);
    const firstRow = reader.locator('.sheets-grid-row[aria-rowindex="2"]');
    expect(
      await firstRow.evaluate((row) => {
        const number = row.querySelector('[role="rowheader"]')!;
        const cell = row.querySelector('[data-cell-address="A1"]')!;
        return Math.abs(
          number.getBoundingClientRect().top - cell.getBoundingClientRect().top,
        );
      }),
    ).toBeLessThanOrEqual(1);
    await expect(
      reader.getByRole("note", { name: "Column D hidden" }),
    ).toBeVisible();
    expect(
      await reader
        .locator('[data-cell-address="A2"]')
        .evaluate((element) => (element as HTMLElement).style.gridColumn),
    ).toBe("1 / span 2");
    expect(
      await reader
        .locator('.sheets-grid-row[aria-rowindex="2"]')
        .getAttribute("class"),
    ).toContain("frozen");
    expect(
      await reader
        .locator(
          '[data-cell-address="A1"], [data-cell-address="C1"], [data-cell-address="F1"]',
        )
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-cell-address")),
        ),
    ).toEqual(["A1", "C1", "F1"]);

    const centerX = (address: string) =>
      reader.locator(`[data-cell-address="${address}"]`).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left + rect.width / 2;
      });
    const b1 = reader.locator('[data-cell-address="B1"]');
    await a1.focus();
    await expect(a1).toBeFocused();
    const a1Center = await centerX("A1");
    await a1.press("ArrowLeft");
    await expect(b1).toBeFocused();
    const b1Center = await centerX("B1");
    expect(b1Center).toBeLessThan(a1Center);
    await b1.press("ArrowRight");
    await expect(a1).toBeFocused();
    expect(await centerX("A1")).toBeGreaterThan(b1Center);

    // Logical movement also skips the covered merge coordinate and the
    // hidden D column, then returns to the merge anchor in visual order.
    const a2 = reader.locator('[data-cell-address="A2"]');
    const c2 = reader.locator('[data-cell-address="C2"]');
    const e2 = reader.locator('[data-cell-address="E2"]');
    await expect(reader.locator('[data-cell-address="B2"]')).toHaveCount(0);
    await expect(reader.locator('[data-cell-address="D2"]')).toHaveCount(0);
    await a2.focus();
    await a2.press("ArrowLeft");
    await expect(c2).toBeFocused();
    await c2.press("ArrowLeft");
    await expect(e2).toBeFocused();
    await e2.press("ArrowRight");
    await expect(c2).toBeFocused();
    await c2.press("ArrowRight");
    await expect(a2).toBeFocused();
    expect(mockState.providerCalls).toBe(0);
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await a1.focus();

    const firstTranslation = deferred<void>();
    const releaseTranslation = deferred<void>();
    let holdFirst = true;
    mockState.translate = async (sources) => {
      if (holdFirst) {
        holdFirst = false;
        firstTranslation.resolve();
        await releaseTranslation.promise;
      }
      return sources.map((sourceText) => `Translated ${sourceText}`);
    };
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect.poll(() => mockState.providerPending).toBe(1);
    await firstTranslation.promise;
    expect(mockState.providerCalls).toBe(1);
    expect(mockState.providerPending).toBe(1);
    expect(mockState.providerRequests[0]).toEqual([
      "A source\nwrapped",
      "C source",
      '<img src=x onerror="globalThis.readerPwned=true"><script>bad()</script>',
    ]);
    // Stage sources are plain text: cell markup is sent as literal text and
    // the result renders as text, never as elements (asserted below).
    await expect(
      reader.getByRole("button", { name: "Original" }),
    ).toBeDisabled();
    expect(mockState.providerCalls).toBe(1);
    releaseTranslation.resolve();
    await expect.poll(() => mockState.providerPending).toBe(0);
    await expect(a1).toContainText("Translated A source\nwrapped");
    await reader.getByRole("button", { name: "Original" }).click();
    await expect(a1).toContainText("A source\nwrapped");
    await reader
      .getByRole("button", { name: "Translation", exact: true })
      .click();
    await expect(a1).toContainText("Translated A source\nwrapped");
    const malicious = reader.locator('[data-cell-address="F1"]');
    await expect(malicious).toContainText("<img src=x onerror=");
    expect(await malicious.locator("img, script").count()).toBe(0);
    expect(
      await reader.evaluate(() => Reflect.has(globalThis, "readerPwned")),
    ).toBe(false);

    const rowHeightBeforeHorizontal = await firstRow.evaluate(
      (row) => row.getBoundingClientRect().height,
    );
    await viewport.evaluate((element) => {
      element.scrollLeft = -10_000;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(reader.getByRole("columnheader", { name: "Z" })).toBeVisible();
    await expect(
      reader.getByRole("columnheader", { name: "AA" }),
    ).toBeVisible();
    await expect.poll(() => mockState.providerCalls).toBe(2);
    expect(mockState.providerRequests[1]).toEqual(["Z source", "AA source"]);
    expect(mockState.maxProviderPending).toBe(1);
    expect(
      await firstRow.evaluate((row) => row.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(rowHeightBeforeHorizontal - 1);
    await reader.screenshot({
      path: test.info().outputPath("reader-horizontal.png"),
    });

    await viewport.evaluate((element) => {
      element.scrollLeft = 0;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await reader.getByRole("button", { name: "Original" }).click();
    await expect(a1).toContainText("A source\nwrapped");
    await reader
      .getByRole("button", { name: "Translation", exact: true })
      .click();
    await expect(a1).toContainText("Translated A source\nwrapped");
    await reader.waitForTimeout(100);
    expect(mockState.providerCalls).toBe(2);

    const providerCallsBeforeEmptyView = mockState.providerCalls;
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(reader.locator('[data-cell-address="A3"]')).toBeVisible();
    await expect
      .poll(() =>
        viewport.evaluate(
          (element) =>
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 1,
        ),
      )
      .toBe(true);
    await reader.waitForTimeout(100);
    expect(mockState.providerCalls).toBe(providerCallsBeforeEmptyView);
    expect(
      pageRanges.every((range) => {
        const match = /!A\d+:AA(\d+)$/.exec(range);
        return match !== null && Number(match[1]) <= 3;
      }),
    ).toBe(true);

    await a1.focus();
    const details = reader.getByRole("complementary", {
      name: "Selected cell details",
    });
    await expect(details).toContainText("A source\nwrapped");
    await expect(details).toContainText("Translated A source\nwrapped");
    expect(
      await source.locator("#editor").evaluate((node) => node.outerHTML),
    ).toBe(originalHtml);
    expect(googleRequests.some(({ method }) => method !== "GET")).toBe(false);
    expect(
      mockState.googleCalls.some((url) =>
        /(?:batchUpdate|:append|:clear)/i.test(url),
      ),
    ).toBe(false);
    expect(pageRanges).toEqual([
      "'Active sheet'!A1:AA3",
      "'Active sheet'!A1:AA1",
      "'Active sheet'!A2:AA3",
    ]);
    expect(
      await reader.evaluate(() => {
        const runtime = globalThis as unknown as {
          __workspaceReaderMessages?: { request?: { type?: string } }[];
        };
        return runtime.__workspaceReaderMessages?.filter(
          ({ request }) => request?.type === "WORKSPACE_READER_TRANSLATE",
        ).length;
      }),
    ).toBe(2);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("reader source ownership keeps dropdown authoritative and preserves language", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    const googleMethods: string[] = [];
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        googleMethods.push(route.request().method());
        await fulfillSwitchingSheet(route, mockState);
      },
    );
    await session.context.route(
      "https://docs.google.com/spreadsheets/d/sheet_123/edit*",
      (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><main id="editor">Switching source</main>',
        }),
    );
    const baseUrl = "https://docs.google.com/spreadsheets/d/sheet_123/edit";
    const editorUrl = `${baseUrl}#gid=42`;
    const source = await session.context.newPage();
    await source.goto(editorUrl);
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);
    await mockSourceMetadata(session);

    const reader = await session.context.newPage();
    await captureReaderMessages(reader);
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Sheet A",
    );
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Source A",
    );
    expect(mockState.providerCalls).toBe(0);

    const worksheet = reader.getByRole("combobox", { name: "Worksheet" });
    await expect(worksheet).toHaveText("Sheet A");
    await worksheet.click();
    await expect(reader.getByRole("option")).toHaveCount(4);
    await reader.getByRole("option", { name: "Sheet B" }).click();
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Sheet B",
    );
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Source B",
    );
    expect(mockState.providerCalls).toBe(0);

    mockState.translate = async (sources) =>
      sources.map((sourceText) => `Translated ${sourceText}`);
    await reader.getByRole("button", { name: "Translate" }).click();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Translated Source B",
    );
    expect(mockState.providerCalls).toBe(1);

    await worksheet.click();
    await reader.getByRole("option", { name: "Sheet C" }).click();
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Sheet C",
    );
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Translated Source C",
    );
    expect(mockState.providerCalls).toBe(2);
    expect(mockState.maxProviderPending).toBe(1);

    const callsBeforeEditorSwitch = mockState.googleCalls.length;
    await source.goto(`${baseUrl}#gid=45`);
    await reader.waitForTimeout(350);
    await expect(worksheet).toHaveText("Sheet C");
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Translated Source C",
    );
    expect(mockState.googleCalls.length).toBe(callsBeforeEditorSwitch);
    expect(mockState.providerCalls).toBe(2);
    await expect(
      reader.getByRole("combobox", { name: "Translate to" }),
    ).toHaveText("Vietnamese");
    await reader.getByRole("button", { name: "Stop" }).click();
    await reader.getByRole("combobox", { name: "Translate to" }).click();
    await reader.getByRole("option", { name: "Japanese" }).click();
    await worksheet.click();
    await reader.getByRole("option", { name: "Sheet B" }).click();
    await reader.getByRole("button", { name: "Refresh" }).click();
    await expect(worksheet).toHaveText("Sheet B");
    await expect(
      reader.getByRole("combobox", { name: "Translate to" }),
    ).toHaveText("Japanese");
    expect(mockState.providerCalls).toBe(2);
    await reader.reload();
    await expect(worksheet).toHaveText("Sheet D");
    await expect(
      reader.getByRole("combobox", { name: "Translate to" }),
    ).toHaveText("Japanese");
    await reader.getByRole("button", { name: "Disconnect Google" }).click();
    await expect(
      reader.getByRole("button", { name: "Connect Google Workspace" }),
    ).toBeVisible();
    await expect(
      reader.getByText("Not connected", { exact: true }),
    ).toBeVisible();
    await expect(
      reader.getByText("Google Workspace could not disconnect. Try again."),
    ).toHaveCount(0);
    expect(googleMethods.every((method) => method === "GET")).toBe(true);
    expect(
      mockState.googleCalls.some((url) =>
        /(?:batchUpdate|:append|:clear)/i.test(url),
      ),
    ).toBe(false);

    const protocol = (await reader.evaluate(() => {
      const runtime = globalThis as unknown as {
        __workspaceReaderMessages?: unknown[];
      };
      return runtime.__workspaceReaderMessages;
    })) as {
      request?: {
        readerInstanceId?: string;
        requestId?: number;
        type?: string;
      };
      response?: {
        type?: string;
        version?: { backgroundEpoch?: string; sourceRevision?: number };
      };
    }[];
    const owned = protocol.filter(({ request }) => request?.readerInstanceId);
    expect(
      new Set(owned.map(({ request }) => request!.readerInstanceId)).size,
    ).toBe(1);
    expect(new Set(owned.map(({ request }) => request!.requestId)).size).toBe(
      owned.length,
    );
    const contextRevisions = protocol
      .filter(({ response }) => response?.type === "WORKSPACE_READER_CONTEXT")
      .map(({ response }) => response!.version!.sourceRevision!);
    expect(new Set(contextRevisions).size).toBe(1);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("second Translate is inert after completion and keeps the Reader usable", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mockState, { first: "Stable source" }),
    );
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Second Translate source",
    );
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);
    const reader = await session.context.newPage();
    const pageErrors: string[] = [];
    reader.on("pageerror", (error) => pageErrors.push(error.message));
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);

    const translate = reader.getByRole("button", { name: "Translate" });
    const stop = reader.getByRole("button", { name: "Stop" });
    const translation = reader.getByRole("button", {
      name: "Translation",
      exact: true,
    });
    const original = reader.getByRole("button", { name: "Original" });
    await expect(translate).toBeEnabled();
    await expect(stop).toBeDisabled();
    await expect(translation).toBeDisabled();
    await expect(original).toBeDisabled();

    const started = deferred<void>();
    const release = deferred<void>();
    mockState.translate = async (sources) => {
      started.resolve();
      await release.promise;
      return sources.map((sourceText) => `Translated ${sourceText}`);
    };
    await translate.click();
    await started.promise;
    const translating = reader.getByRole("button", { name: "Translating…" });
    await expect(translating).toBeDisabled();
    await expect(translating.getByTestId("reader-spinner")).toBeVisible();
    await expect(stop).toBeEnabled();
    await expect(translation).toBeDisabled();
    release.resolve();

    const translationOn = reader.getByRole("button", {
      name: "Translation on",
    });
    await expect(translationOn).toBeDisabled();
    await expect(translation).toBeEnabled();
    await expect(original).toBeEnabled();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Translated Stable source",
    );
    expect(mockState.providerCalls).toBe(1);
    expect(
      await reader.locator(".reader-sr-only").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          clipPath: style.clipPath,
          height: rect.height,
          position: style.position,
          width: rect.width,
        };
      }),
    ).toEqual({
      clipPath: "inset(50%)",
      height: 1,
      position: "absolute",
      width: 1,
    });
    await expect(reader.locator(".reader-status")).toHaveCount(0);

    await translationOn.evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );
    await reader.waitForTimeout(150);
    expect(mockState.providerCalls).toBe(1);
    expect(pageErrors).toEqual([]);

    await original.click();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Stable source",
    );
    await translation.click();
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "Translated Stable source",
    );
    await stop.click();
    await expect(
      reader.getByRole("button", { name: "Resume translation" }),
    ).toBeEnabled();
    await expect(stop).toBeDisabled();
    expect(pageErrors).toEqual([]);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("popup Reader handoff closes after fallback success", async () => {
  test.setTimeout(60_000);
  const session = await launchExtension();
  let popupControl:
    | {
        popup: ActionPopup;
        isOpen(): Promise<boolean>;
        close(): Promise<void>;
      }
    | undefined;
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mockState),
    );
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Popup routing source",
    );
    const originalHtml = await source
      .locator("#editor")
      .evaluate((node) => node.outerHTML);
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);
    // Granting Workspace access opens an extension page that verifies the
    // session, so the signed-in toolbar would open Reader directly; force the
    // popup to exercise its fallback handoff.
    popupControl = await openActionPopup(
      session.context,
      session.extensionId,
      source,
      true,
    );
    await expect
      .poll(
        () =>
          popupControl!.popup.evaluate<boolean>(
            `document.querySelector('main[aria-busy="false"]') !== null && document.body.innerText.includes("reader@example.test") && [...document.querySelectorAll("button")].some(candidate => candidate.textContent?.trim() === "Translate") && document.querySelector('[aria-label="Open local spreadsheet"]') !== null`,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(
      await popupControl.popup.evaluate<boolean>(`(() => {
          const tool = document.querySelector('[aria-label="Open local spreadsheet"]');
          if (!(tool instanceof HTMLElement)) return false;
          const style = getComputedStyle(tool);
          return tool.getBoundingClientRect().height < 64 && style.backgroundColor !== "rgb(37, 99, 235)" && tool.textContent?.includes("CSV, XLSX or XLSM") === true;
        })()`),
    ).toBe(true);
    await popupControl.popup.evaluate(`(() => {
      Object.defineProperty(chrome.sidePanel, "open", {
        configurable: true,
        value: () => Promise.reject(new Error("deterministic fallback")),
      });
      const button = [...document.querySelectorAll("button")].find(
        candidate => candidate.textContent?.trim() === "Translate",
      );
      if (!button) throw new Error("Translate button unavailable");
      button.click();
      return true;
    })()`);
    const readerUrl = `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`;
    await expect
      .poll(() => session.context.pages().map((page) => page.url()))
      .toContain(readerUrl);
    await expect.poll(() => popupControl!.isOpen()).toBe(false);
    const reader = session.context
      .pages()
      .find((page) => page.url() === readerUrl)!;
    await connectReaderIfNeeded(reader);
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Active sheet",
    );
    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "translated-result",
    );
    expect(
      await source.locator("#editor").evaluate((node) => node.outerHTML),
    ).toBe(originalHtml);

    await popupControl.close();
    popupControl = await openActionPopup(
      session.context,
      session.extensionId,
      source,
      true,
    );
    await expect
      .poll(() =>
        popupControl!.popup.evaluate<boolean>(
          `document.querySelector('main[aria-busy="false"]') !== null && [...document.querySelectorAll("button")].some(candidate => candidate.textContent?.trim() === "Translate")`,
        ),
      )
      .toBe(true);
    await popupControl.popup.evaluate(`(() => {
        Object.defineProperty(chrome.sidePanel, "open", {
          configurable: true,
          value: () => Promise.resolve(),
        });
        const button = [...document.querySelectorAll("button")].find(
          candidate => candidate.textContent?.trim() === "Translate",
        );
        if (!button) throw new Error("Translate button unavailable");
        button.click();
      })()`);
    await expect.poll(() => popupControl!.isOpen()).toBe(false);

    await popupControl.close();
    popupControl = await openActionPopup(
      session.context,
      session.extensionId,
      source,
      true,
    );
    await expect
      .poll(() =>
        popupControl!.popup.evaluate<boolean>(
          `document.querySelector('main[aria-busy="false"]') !== null && [...document.querySelectorAll("button")].some(candidate => candidate.textContent?.trim() === "Translate")`,
        ),
      )
      .toBe(true);
    await popupControl.popup.evaluate(`(() => {
        Object.defineProperty(chrome.sidePanel, "open", {
          configurable: true,
          value: () => Promise.resolve(),
        });
        Object.defineProperty(chrome.storage.session, "set", {
          configurable: true,
          value: () => Promise.reject(new Error("deterministic save failure")),
        });
        const button = [...document.querySelectorAll("button")].find(
          candidate => candidate.textContent?.trim() === "Translate",
        );
        if (!button) throw new Error("Translate button unavailable");
        button.click();
      })()`);
    await expect
      .poll(() =>
        popupControl!.popup.evaluate<boolean>(
          `document.body.innerText.includes("Could not open Google Workspace Reader.")`,
        ),
      )
      .toBe(true);
    expect(await popupControl.isOpen()).toBe(true);
    await popupControl.popup.evaluate("window.close()");
    await expect.poll(() => popupControl!.isOpen()).toBe(false);

    await popupControl.close();
    const ordinary = await routeSyntheticEditor(
      session.context,
      "https://example.test/popup-reader-proof",
      "Ordinary page source",
    );
    await sourceTabId(session, ordinary.url());
    popupControl = await openActionPopup(
      session.context,
      session.extensionId,
      ordinary,
    );
    await expect
      .poll(() =>
        popupControl!.popup.evaluate<boolean>(
          `document.querySelector('main[aria-busy="false"]') !== null && [...document.querySelectorAll("button")].some(candidate => candidate.textContent?.trim() === "Translate")`,
        ),
      )
      .toBe(true);
    await popupControl.popup.evaluate(`(() => {
        const button = [...document.querySelectorAll("button")].find(
          candidate => candidate.textContent?.trim() === "Translate",
        );
        if (!button) throw new Error("Translate button unavailable");
        button.click();
      })()`);
    await ordinary.waitForTimeout(250);
    expect(await popupControl.isOpen()).toBe(true);
    await popupControl.popup.evaluate("window.close()");
    await expect.poll(() => popupControl!.isOpen()).toBe(false);
    await ordinary.close();

    expect(mockState.providerCalls).toBeGreaterThan(0);
    expect(mockState.maxProviderPending).toBe(1);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await popupControl?.close();
    await closeExtension(session);
  }
});

// ADR 0015: the Drive Office workbook path is disabled at launch. The Sheets
// API refuses a Drive-stored Office file opened in the Sheets editor, and
// Reader shows the download guidance without any Drive request.
test("a Drive-stored Office workbook shows the download guidance without Drive work", async () => {
  test.skip(
    (await builtAuthMode()) !== "web",
    "Office identification needs the web OAuth Reader build.",
  );
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mockState),
    );
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/office_launch_xlsx/edit#gid=42";
    await routeSyntheticEditor(session.context, editorUrl, "Office source");
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);
    const reader = await session.context.newPage();
    const readerUrl = `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`;
    await reader.goto(readerUrl);
    await connectReaderIfNeeded(reader);
    await expect(reader.locator(".reader-status")).toContainText(
      "This Excel workbook is stored in Google Drive, which Reader cannot open yet.",
    );
    await expect(reader.locator(".reader-status")).toContainText(
      "File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
    );
    await expect(
      reader.getByRole("button", { name: "Open local spreadsheet" }),
    ).toBeVisible();
    await expect(reader).toHaveURL(readerUrl);
    await expect(
      reader.getByText("Google Drive Spreadsheet Reader"),
    ).toHaveCount(0);
    const identification = await session.worker.evaluate(
      () =>
        (globalThis as typeof globalThis & { __sourceMetadataCalls?: string[] })
          .__sourceMetadataCalls ?? [],
    );
    expect(
      identification.some((url) => url.includes("/office_launch_xlsx?")),
    ).toBe(true);
    expect(mockState.googleCalls).toEqual([]);
    expect(mockState.providerCalls).toBe(0);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("Google Docs is temporarily unsupported and dispatches no Reader API/provider work", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    const editorUrl =
      "https://docs.google.com/document/d/doc_123/edit?tab=t.child";
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Unsupported Docs source",
    );
    const originalHtml = await source
      .locator("#editor")
      .evaluate((node) => node.outerHTML);
    const tabId = await sourceTabId(session, editorUrl);
    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await expect(
      reader.getByText(/Google Docs is temporarily unsupported/),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: /^Translate/ }),
    ).toHaveCount(0);
    expect(mockState.googleCalls).toEqual([]);
    expect(mockState.providerRequests).toEqual([]);
    expect(
      await source.locator("#editor").evaluate((node) => node.outerHTML),
    ).toBe(originalHtml);
  } finally {
    await closeExtension(session);
  }
});

test.skip("reserved Google Docs Reader tab switching — temporarily unsupported", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route(
      "https://docs.googleapis.com/**",
      async (route) => {
        mockState.googleCalls.push(route.request().url());
        await route.fulfill({ json: docsPage() });
      },
    );
    const editorUrl =
      "https://docs.google.com/document/d/doc_123/edit?tab=t.child";
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Synthetic Docs source",
    );
    const originalHtml = await source
      .locator("#editor")
      .evaluate((node) => node.outerHTML);
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);

    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Details",
    );
    await expect(reader.getByText("Details text")).toBeVisible();
    await expect(reader.getByText("Overview text")).toHaveCount(0);

    await reader.getByRole("combobox", { name: "Document tab" }).click();
    await reader.getByRole("option", { name: "Overview" }).click();
    await expect(reader.locator(".source-context strong")).toHaveText(
      "Overview",
    );
    await expect(reader.getByText("Overview text")).toBeVisible();
    await expect(reader.getByText("Details text")).toHaveCount(0);

    await reader.getByRole("button", { name: "Translate loaded" }).click();
    await expect(reader.getByText("<b>translated-result</b>")).toBeVisible();
    expect(mockState.providerRequests).toHaveLength(1);
    expect(mockState.providerRequests[0]!.join("")).toContain("Overview text");
    expect(mockState.googleCalls).toHaveLength(2);
    expect(
      mockState.googleCalls.every((url) =>
        url.includes("includeTabsContent=true"),
      ),
    ).toBe(true);
    expect(
      await source.locator("#editor").evaluate((node) => node.outerHTML),
    ).toBe(originalHtml);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("late provider result is discarded and cross-file navigation stops continuation", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mockState),
    );
    await session.context.route("https://docs.googleapis.com/**", (route) => {
      mockState.googleCalls.push(route.request().url());
      return route.fulfill({ json: docsPage() });
    });
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    const movedUrl =
      "https://docs.google.com/document/d/doc_123/edit?tab=t.child";
    const source = await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Navigation source",
    );
    await session.context.route(movedUrl, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><main id="editor">Navigated source</main>',
      }),
    );
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);
    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(
      reader.getByRole("button", { name: "Translate", exact: true }),
    ).toBeEnabled();

    const started = deferred<void>();
    const release = deferred<void>();
    mockState.translate = async () => {
      started.resolve();
      await release.promise;
      return ["late-navigation-result"];
    };
    await reader.getByRole("button", { name: "Translate" }).click();
    await started.promise;
    await source.goto(movedUrl);
    release.resolve();

    await expect(reader.getByRole("alert")).toContainText(
      "Open a supported spreadsheet and click the extension icon to continue.",
    );
    await expect(reader.getByText("late-navigation-result")).toHaveCount(0);
    await expect(reader.getByRole("grid")).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: "Translate", exact: true }),
    ).toHaveCount(0);
    await expect.poll(() => mockState.providerPending).toBe(0);
    expect(mockState.providerCalls).toBe(1);
    expect(
      mockState.googleCalls.some(
        (url) => new URL(url).origin === "https://docs.googleapis.com",
      ),
    ).toBe(false);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("opening another Reader keeps the original Reader's in-flight result valid", async () => {
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    await session.context.route("https://sheets.googleapis.com/**", (route) =>
      fulfillBasicSheet(route, mockState),
    );
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    await routeSyntheticEditor(session.context, editorUrl, "Generation source");
    const tabId = await sourceTabId(session, editorUrl);
    expect(await mockGoogleIdentity(session)).toBe(true);
    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await connectReaderIfNeeded(reader);
    await expect(
      reader.getByRole("button", { name: "Translate", exact: true }),
    ).toBeEnabled();

    const started = deferred<void>();
    const release = deferred<void>();
    mockState.translate = async () => {
      started.resolve();
      await release.promise;
      return ["late-generation-result"];
    };
    await reader.getByRole("button", { name: "Translate" }).click();
    await started.promise;
    const newerReader = await session.context.newPage();
    await newerReader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await expect(
      newerReader.getByRole("button", { name: "Translate", exact: true }),
    ).toBeEnabled();
    // A loaded same-file source can be reused, but opening a new owner must
    // not inherit the first owner's translation intent or pending result.
    await expect(newerReader.getByText("late-generation-result")).toHaveCount(
      0,
    );
    expect(mockState.providerCalls).toBe(1);
    release.resolve();

    await expect(reader.locator('[data-cell-address="A1"]')).toContainText(
      "late-generation-result",
    );
    await expect(newerReader.getByText("late-generation-result")).toHaveCount(
      0,
    );
    await expect(
      reader.getByText("The source tab changed. Refresh Reader to continue."),
    ).toHaveCount(0);
    expect(mockState.providerCalls).toBe(1);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("Drive Office shared spreadsheet controls load saved workbooks and fail closed", async () => {
  test.skip(true, DRIVE_OFFICE_DEFERRED);
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    const firstSheet = XLSX.utils.aoa_to_sheet([
      ["Drive first sheet", "Cached display"],
      [],
      ["Merged Drive cell"],
    ]);
    firstSheet["!merges"] = [XLSX.utils.decode_range("A3:B3")];
    firstSheet["!rows"] = [{ hpx: 33.6 }];
    firstSheet["!cols"] = [{ wpx: 131.6 }, { wpx: 97.2 }];
    const secondSheet = XLSX.utils.aoa_to_sheet([
      ["Drive second sheet", "Provider-visible text"],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, firstSheet, "First");
    XLSX.utils.book_append_sheet(workbook, secondSheet, "Second");
    const workbookBytes = Buffer.from(
      XLSX.write(workbook, {
        type: "array",
        bookType: "xlsm",
        cellStyles: true,
      }) as ArrayBuffer,
    );
    await session.context.route(
      "https://sheets.googleapis.com/**",
      async (route) => {
        const url = new URL(route.request().url());
        mockState.googleCalls.push(url.href);
        await route.fulfill({ status: 400, body: "{}" });
      },
    );
    expect(await mockGoogleIdentity(session)).toBe(true);
    await session.worker.evaluate((workbookBase64) => {
      const runtime = globalThis as typeof globalThis & {
        __driveOfficeFetchRequests?: {
          authorization: string | null;
          body: boolean;
          url: string;
        }[];
      };
      const originalFetch = runtime.fetch.bind(runtime);
      const bytes = Uint8Array.from(atob(workbookBase64), (value) =>
        value.charCodeAt(0),
      );
      const requests: NonNullable<typeof runtime.__driveOfficeFetchRequests> =
        [];
      const responseAt = (response: Response, finalUrl: string) => {
        Object.defineProperty(response, "url", { value: finalUrl });
        return response;
      };
      runtime.__driveOfficeFetchRequests = requests;
      runtime.fetch = async (input, init) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        if (!url.href.startsWith("https://www.googleapis.com/drive/v3/files/"))
          return originalFetch(input, init);
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: init?.body !== undefined && init.body !== null,
          url: url.href,
        });
        const fileId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        if (fileId === "drive_access_denied")
          return responseAt(new Response("{}", { status: 403 }), url.href);
        const media = url.searchParams.get("alt") === "media";
        const byteLength =
          fileId === "drive_too_large"
            ? 20 * 1024 * 1024 + 1
            : fileId === "drive_invalid_stream"
              ? bytes.byteLength + 1
              : bytes.byteLength;
        if (!media)
          return responseAt(
            Response.json({
              id: fileId,
              name: `${fileId}.xlsm`,
              mimeType: "application/vnd.ms-excel.sheet.macroenabled.12",
              size: String(byteLength),
              modifiedTime: "2026-09-28T01:02:03.000Z",
              md5Checksum: "0123456789abcdef0123456789abcdef",
              capabilities: {
                canDownload: fileId !== "drive_download_blocked",
              },
            }),
            url.href,
          );
        if (fileId === "drive_timeout")
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        return responseAt(
          new Response(bytes.slice(), {
            headers:
              fileId === "drive_invalid_stream"
                ? undefined
                : { "content-length": String(bytes.byteLength) },
          }),
          `https://drive-usercontent.googleusercontent.com/download?id=${encodeURIComponent(fileId)}`,
        );
      };
    }, workbookBytes.toString("base64"));
    const officeUrl =
      "https://docs.google.com/spreadsheets/d/drive_office_xlsm/edit#gid=42";
    const officeSource = await routeSyntheticEditor(
      session.context,
      officeUrl,
      "Synthetic Drive Office source",
    );
    const officeTabId = await sourceTabId(session, officeUrl);
    const officeReader = await session.context.newPage();
    await officeReader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${officeTabId}`,
    );
    await connectReaderIfNeeded(officeReader);
    await expect(officeReader).toHaveURL(
      `chrome-extension://${session.extensionId}/reader.html?office=1&sourceTabId=${officeTabId}`,
    );
    await expect(
      officeReader.getByText("Google Drive Spreadsheet Reader"),
    ).toBeVisible();
    await expect(officeReader.locator(".local-dropzone")).toHaveCount(0);
    await expect(officeReader.locator('input[type="file"]')).toHaveCount(0);
    await expect(officeReader.getByLabel("Open local spreadsheet")).toHaveCount(
      0,
    );
    await expect(
      officeReader.getByText("drive_office_xlsm.xlsm", { exact: true }),
    ).toBeVisible();
    await expect(officeReader.locator("main.reader-shell")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    const worksheet = officeReader.getByRole("combobox", {
      name: "Worksheet",
    });
    await expect(officeReader.getByRole("combobox")).toHaveCount(2);
    await expect(worksheet).toHaveText("First");
    await expect(
      officeReader.getByRole("button", { name: "Stop" }),
    ).toBeDisabled();
    await expect(
      officeReader.getByRole("button", {
        name: "Translation",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      officeReader.locator('[role="gridcell"][data-cell-address="A1"]'),
    ).toHaveText("Drive first sheet");
    await expect(
      officeReader.locator('[role="gridcell"][data-cell-address="A3"]'),
    ).toHaveText("Merged Drive cell");
    const geometry = await officeReader.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".sheets-grid-header");
      const row = document.querySelector<HTMLElement>(
        '[data-sheet-row-index="0"]',
      );
      return {
        columnTracks: header?.style.gridTemplateColumns ?? "",
        rowMinimum: row?.style.height ?? "",
        columns: ["A", "B"].map((label) => {
          const heading = [
            ...(header?.querySelectorAll<HTMLElement>(
              ".sheets-column-header",
            ) ?? []),
          ].find((node) => node.textContent === label)!;
          const cell = document.querySelector<HTMLElement>(
            `[data-cell-address="${label}1"]`,
          )!;
          const headingRect = heading.getBoundingClientRect();
          const cellRect = cell.getBoundingClientRect();
          return {
            label,
            width: cellRect.width,
            headingWidth: headingRect.width,
            leftDelta: cellRect.left - headingRect.left,
            rightDelta: cellRect.right - headingRect.right,
          };
        }),
        mergeWidth: document
          .querySelector('[data-cell-address="A3"]')!
          .getBoundingClientRect().width,
      };
    });
    const columnTracks = geometry.columnTracks.match(/\d+(?:\.\d+)?px/g);
    // Virtual spreadsheet padding columns are separate from the two saved
    // columns. Prove the saved dimensions and actual header/cell geometry.
    expect(columnTracks?.slice(0, 2)).toEqual(["197px", "146px"]);
    expect(
      columnTracks?.every(
        (track) => /^\d+px$/.test(track) && Number.parseInt(track, 10) > 0,
      ),
    ).toBe(true);
    expect(
      geometry.columns.map(({ label, width }) => ({ label, width })),
    ).toEqual([
      { label: "A", width: 197 },
      { label: "B", width: 146 },
    ]);
    for (const column of geometry.columns) {
      expect(column.headingWidth).toBe(column.width);
      expect(Math.abs(column.leftDelta)).toBeLessThanOrEqual(1);
      expect(Math.abs(column.rightDelta)).toBeLessThanOrEqual(1);
    }
    expect(geometry.mergeWidth).toBe(343);
    expect(geometry.rowMinimum).toMatch(/^\d+px$/);
    expect(Number.parseInt(geometry.rowMinimum, 10)).toBeGreaterThan(0);
    await worksheet.click();
    await officeReader.getByRole("option", { name: "Second" }).click();
    await expect(worksheet).toHaveText("Second");
    const translatedCell = officeReader.locator(
      '[role="gridcell"][data-cell-address="A1"]',
    );
    await expect(translatedCell).toHaveText("Drive second sheet");
    await officeReader.getByRole("button", { name: "Translate" }).click();
    await expect(translatedCell).toContainText("translated-result");
    await expect(
      officeReader.getByRole("button", { name: "Translation on" }),
    ).toBeDisabled();
    await expect(
      officeReader.getByRole("button", { name: "Stop" }),
    ).toBeEnabled();
    await expect(officeReader.locator(".reader-sr-only")).toHaveCount(1);
    expect(mockState.providerRequests).toEqual([
      ["Drive second sheet", "Provider-visible text"],
    ]);
    const providerArtifacts = mockState.backendArtifacts.join("\n");
    expect(providerArtifacts).not.toContain("drive_office_xlsm.xlsm");
    expect(providerArtifacts).not.toContain("0123456789abcdef0123456789abcdef");
    expect(providerArtifacts).not.toMatch(
      /workbook|filename|arraybuffer|bytes|vba/i,
    );
    await officeReader.close();
    await officeSource.close();

    const providerCallsAfterSuccess = mockState.providerCalls;
    const cases = [
      {
        fileId: "drive_too_large",
        expected: "This file exceeds the 20 MiB Drive Reader limit.",
      },
      {
        fileId: "drive_access_denied",
        expected: "Google denied access. Check consent and file permissions.",
      },
      {
        fileId: "drive_download_blocked",
        expected:
          "The owner or organization does not allow this file to be downloaded.",
      },
      {
        fileId: "drive_invalid_stream",
        expected: "Reader received an invalid Drive download response.",
      },
      {
        fileId: "drive_timeout",
        expected:
          "Downloading from Google Drive took longer than 30 seconds. Refresh to try again.",
      },
    ];
    for (const { fileId, expected } of cases) {
      if (fileId === "drive_timeout")
        await session.worker.evaluate(() => {
          const original = globalThis.setTimeout.bind(globalThis);
          globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
            const [handler, delay, ...rest] = args;
            return original(handler, delay === 30_000 ? 25 : delay, ...rest);
          }) as typeof setTimeout;
        });
      const editorUrl = `https://docs.google.com/spreadsheets/d/${fileId}/edit#gid=42`;
      const source = await routeSyntheticEditor(
        session.context,
        editorUrl,
        `Synthetic ${fileId} source`,
      );
      const tabId = await sourceTabId(session, editorUrl);
      const reader = await session.context.newPage();
      await reader.goto(
        `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
      );
      await connectReaderIfNeeded(reader);
      await expect(reader.getByText(expected)).toBeVisible();
      await expect(reader.locator('input[type="file"]')).toHaveCount(0);
      await reader.close();
      await source.close();
    }
    expect(mockState.providerCalls).toBe(providerCallsAfterSuccess);
    const driveRequests = await session.worker.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        __driveOfficeFetchRequests?: {
          authorization: string | null;
          body: boolean;
          url: string;
        }[];
      };
      return runtime.__driveOfficeFetchRequests ?? [];
    });
    expect(driveRequests.length).toBeGreaterThan(0);
    expect(
      driveRequests.every(
        ({ authorization, body, url }) =>
          authorization === `Bearer ${googleToken}` &&
          body === false &&
          url.startsWith("https://www.googleapis.com/drive/v3/files/"),
      ),
    ).toBe(true);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});

test("unconfigured manifest state never requests Google data or a provider", async () => {
  test.skip(
    (await builtAuthMode()) === "web",
    "A compiled web client cannot be removed by changing manifest metadata.",
  );
  const session = await launchExtension();
  try {
    const mockState = await installMocks(session.context);
    const editorUrl =
      "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42";
    await routeSyntheticEditor(
      session.context,
      editorUrl,
      "Unconfigured source",
    );
    const tabId = await sourceTabId(session, editorUrl);
    const manifestMocked = await session.worker.evaluate(() => {
      const runtime = globalThis as unknown as {
        chrome: {
          runtime: {
            getManifest(): { oauth2?: unknown; [key: string]: unknown };
          };
        };
      };
      const configured = runtime.chrome.runtime.getManifest();
      const getManifest = () => {
        const unconfigured = { ...configured };
        delete unconfigured.oauth2;
        return unconfigured;
      };
      try {
        Object.defineProperty(runtime.chrome.runtime, "getManifest", {
          configurable: true,
          value: getManifest,
        });
      } catch {
        return false;
      }
      return runtime.chrome.runtime.getManifest === getManifest;
    });
    expect(manifestMocked).toBe(true);

    const reader = await session.context.newPage();
    await reader.goto(
      `chrome-extension://${session.extensionId}/reader.html?sourceTabId=${tabId}`,
    );
    await expect(
      reader.getByText(
        "Google Workspace Reader is not configured in this build.",
      ),
    ).toBeVisible();
    await expect(
      reader.getByRole("button", { name: "Connect Google Workspace" }),
    ).toHaveCount(0);
    expect(mockState.googleCalls).toEqual([]);
    expect(mockState.providerCalls).toBe(0);
    expect(mockState.unexpected).toEqual([]);
  } finally {
    await closeExtension(session);
  }
});
