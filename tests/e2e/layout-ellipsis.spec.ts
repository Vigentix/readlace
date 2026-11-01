import { expect, test } from "@playwright/test";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
  type Worker,
} from "@playwright/test";
import { createServer, type Server } from "node:http";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  EXTENSION_DB_NAME,
  EXTENSION_DB_VERSION,
  EXTENSION_STORE_NAME,
} from "@/lib/indexeddb-storage";
import { routeE2EProvider } from "@/e2e/provider-stage";

const extensionPath = path.resolve(
  process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const fixturePath = path.resolve("tests/fixtures/layout-ellipsis.html");
const openAiLatencyFixturePath = path.resolve(
  "tests/fixtures/openai-latency.html",
);
const openAiLatencyReportPath = path.resolve(
  "docs/test_results/2026-08-27-000003-openai-first-visible-total-latency-report.md",
);
const evidencePath = path.resolve("output");
/** Removed undocumented endpoint; the extension must never contact it. */
const legacyTranslatePaUrl =
  "https://translate-pa.googleapis.com/v1/translateHtml";
const openAiProviderUrl = "https://api.openai.com/v1/responses";
const stableExtensionId = "imlhpiikjakgljngkdalbfgdpkniejdb";
const vietnameseCharacter =
  /[ĂÂĐÊÔƠƯăâđêôơưÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ]/g;
const extensionDatabase = {
  name: EXTENSION_DB_NAME,
  store: EXTENSION_STORE_NAME,
  version: EXTENSION_DB_VERSION,
};

type ExtensionDatabaseOperation =
  | { type: "get"; keys?: string[] }
  | { type: "remove"; keys: string[] }
  | { type: "set"; entries: Record<string, unknown> };

async function accessExtensionDatabase(
  worker: Worker,
  operation: ExtensionDatabaseOperation,
) {
  return worker.evaluate(
    async ({ database, operation }) => {
      const opened = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database.name, database.version);
        request.addEventListener("upgradeneeded", () => {
          if (!request.result.objectStoreNames.contains(database.store))
            request.result.createObjectStore(database.store);
        });
        request.addEventListener("success", () => resolve(request.result), {
          once: true,
        });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
      try {
        const transaction = opened.transaction(
          database.store,
          operation.type === "get" ? "readonly" : "readwrite",
        );
        const done = new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve(), {
            once: true,
          });
          transaction.addEventListener(
            "abort",
            () => reject(transaction.error),
            { once: true },
          );
          transaction.addEventListener(
            "error",
            () => reject(transaction.error),
            { once: true },
          );
        });
        const store = transaction.objectStore(database.store);
        if (operation.type === "set") {
          for (const [key, value] of Object.entries(operation.entries))
            store.put(value, key);
          await done;
          return {};
        }
        if (operation.type === "remove") {
          for (const key of operation.keys) store.delete(key);
          await done;
          return {};
        }
        const keys =
          operation.keys ?? (await requestResult(store.getAllKeys()));
        const values = await Promise.all(
          keys.map(async (key) => [key, await requestResult(store.get(key))]),
        );
        await done;
        return Object.fromEntries(
          values.filter(([, value]) => value !== undefined),
        );

        function requestResult<T>(request: IDBRequest<T>) {
          return new Promise<T>((resolve, reject) => {
            request.addEventListener("success", () => resolve(request.result), {
              once: true,
            });
            request.addEventListener("error", () => reject(request.error), {
              once: true,
            });
          });
        }
      } finally {
        opened.close();
      }
    },
    { database: extensionDatabase, operation },
  );
}

const readExtensionDatabase = (worker: Worker, keys?: string[]) =>
  accessExtensionDatabase(worker, { type: "get", keys });
const setExtensionDatabase = (
  worker: Worker,
  entries: Record<string, unknown>,
) => accessExtensionDatabase(worker, { type: "set", entries });
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FrameSample extends Rect {
  blockLineCount: number;
  lineCount: number;
  markerCount: number;
  overflow: boolean;
  text: string;
  title: string | null;
  whiteSpace: string;
  wrapper: boolean;
  wrapperVerticalAlign: string | null;
}

type FrameSamples = Record<string, FrameSample[]>;

interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  worker: Worker;
  close: (removeProfile?: boolean) => Promise<void>;
}

interface LaunchExtensionOptions {
  headless?: boolean;
  unpackedExtensionPath?: string;
}

interface DeterministicProviderRequest {
  activeRequests: number;
  at: number;
  characters: number;
  completedAt?: number;
  durationMs?: number;
  encodedCharacters: number;
  mode?: "primary";
  /** Engine that produced the evidence inside the routed backend stage. */
  provider: "google" | "openai";
  provenance?: (string | null)[];
  recordCount: number;
  requests: string[];
  responseReadyAt?: number;
  results: string[];
  sourceLanguages?: Record<string, string>;
  sourceLanguage?: string;
  status: number;
  targetLanguage: string;
}

interface DeterministicProviderOptions {
  /** ADR 0020: leave the provider key unset (the on-device path). */
  withoutProviderKey?: boolean;
  delayMs?:
    | number
    | ((
        targetLanguage: string,
        requests: string[],
        requestNumber: number,
      ) => number);
  observeRequest?: (request: DeterministicProviderRequest) => void;
  openAiEntries?: (
    sources: Record<string, string>,
    requestNumber: number,
    targetLanguage: string,
  ) => unknown;
  googleTranslate?: (
    source: string,
    index: number,
    targetLanguage: string,
    sourceLanguage: string,
  ) => string;
  /**
   * Opt-in model of the backend router's in-stage OpenAI retries (ADR 0014):
   * after each delay, records OpenAI left empty or unchanged get another
   * OpenAI attempt inside the same stage, observed as its own `primary`
   * request. The client still dispatches one stage. Not combined with
   * `googleTranslate`.
   */
  openAiRetryDelaysMs?: number[];
  reply?: (
    requests: string[],
    requestNumber: number,
    targetLanguage: string,
  ) => {
    abort?: boolean;
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: string;
    status?: number;
  };
  translate?: (source: string, index: number, targetLanguage: string) => string;
}

function translatedText(text: string, index: number, targetLanguage = "vi") {
  if (["/", "·"].includes(text.trim())) return text;
  if (targetLanguage === "ja" && !/[ぁ-んァ-ヶ一-龯]/u.test(text))
    return `翻訳済みラベル ${index}`;
  if (targetLanguage === "en" && !/[ぁ-んァ-ヶ一-龯]/u.test(text))
    return `Translated ${text}`;
  if (text.includes("Repair trigger"))
    return "Nhãn đầu tiên cần được sửa hình học";
  if (text.includes("FAQ")) return "Hỏi và Đáp";
  if (text.includes("Inline alpha")) return "Nhãn điều hướng nội tuyến rất dài";
  if (text.includes("Nested label"))
    return "Nhãn lồng dài vượt phần văn bản gốc";
  if (text.includes("Auto news")) return "Tin tức tự động mở rộng";
  if (text.includes("Auto world")) return "Thế giới tự động mở rộng";
  if (text.includes("Auto sports")) return "Thể thao tự động mở rộng";
  if (text.includes("Fixed menu")) return "Tiếng nói nhân dân";
  if (text.includes("Fixed overflow"))
    return "Bản dịch cố định rất dài vượt quá ô riêng";
  if (text.includes("Go")) return "Bản dịch dài bị giới hạn trong ô riêng";
  if (text.includes("Incompatible bounded"))
    return "Bản dịch không tương thích với hình học gốc";
  if (text.includes("Menu item")) return "Mục phù hợp";
  if (text.includes("English hover item")) return "Mục menu tiếng Việt";
  if (text.includes("Mục menu tiếng Việt")) return "Mục phù hợp";
  if (text.includes("日本語メニュー")) return "Mục menu tiếng Nhật";
  if (text.includes("Long hover menu label"))
    return "Bản dịch tiếng Việt rất dài vượt quá ô menu này";
  if (text.includes("Moved host later batch")) return "Batch sau riêng biệt";
  if (text.includes("Delayed provider first"))
    return "Bản ghi đầu tiên từ nhà cung cấp chậm";
  if (text.includes("Delayed provider second"))
    return "Bản ghi thứ hai vừa hiện trong khung nhìn";
  if (text.includes("Dynamic Element")) return "Phần tử động đã được dịch";
  if (text.includes("Dynamic Text")) return "Nút văn bản động đã được dịch";
  if (text.includes("Dynamic Fragment")) return "Mảnh động đã được dịch";
  if (text.includes("Translation first flow"))
    return "Nội dung luồng đã được dịch và vẫn còn nguyên";
  if (text.includes("Translation first fit")) return "Nhãn vừa vặn";
  if (text.includes("Translation first overflow"))
    return "Nhãn dịch rất dài phải dùng dấu chấm lửng trong ô riêng";
  if (text.includes("Translation first story"))
    return "Tiêu đề thẻ đã dịch dài hơn và được giới hạn theo số dòng ban đầu";
  if (text.includes("Translation group alpha"))
    return "Nhóm alpha đã dịch dù hình học cần sửa cục bộ";
  if (text.includes("Translation group beta"))
    return "Nhóm beta vẫn giữ bản dịch độc lập";
  if (text.includes("Translation first successful slot"))
    return "Vị trí thành công vẫn được giữ";
  if (text.includes("Translation first transient slot"))
    return "Bản ghi được dịch trong lượt hiện tại";
  if (text.includes("Translation first nonretryable slot"))
    return "Không được trả về cho lỗi không thử lại";
  if (text.includes("Translation first dynamic record"))
    return "Bản ghi động đã được dịch và giữ lại";
  if (text.includes("Stale multi node kept"))
    return "Nút cùng nhóm vẫn được dịch một lần";
  if (text.includes("Stale multi node detached"))
    return "Nút đã tách không được áp dụng";
  if (text.includes("Dynamic in-place source"))
    return "Văn bản cập nhật tại chỗ đã được dịch";
  if (text.includes("Dynamic attribute root"))
    return "Thuộc tính gốc động đã được dịch";
  if (text.includes("Overlap scheduler source"))
    return "Bản ghi chồng lấn chỉ được giữ từ lượt mới";
  if (text.includes("Overlap dynamic source"))
    return "Bản ghi động sau chồng lấn";
  if (text.includes("Gap capacity source"))
    return "Nhãn khoảng cách rất dài phải nằm trong phần riêng";
  if (text.includes("Unbreakable multi source"))
    return "ChuỗiDịchKhôngThểNgắtRấtDàiPhảiBịGiớiHạnTrongThẻ";
  const row = text.match(/明細行\s+(\d{3})/);
  if (row) return `Translated row ${row[1]}`;
  if (text.includes("当月請求額")) return "Invoice amount";
  if (text.includes("請求月")) return "Billing month";
  if (text.includes("過入金")) return "Overpayment";
  if (text.includes("基本情報")) return "Basic information";
  if (text.includes("調整明細")) return "Adjustment details";
  if (text.includes("請求管理")) return "Invoice management";
  if (text.includes("請求")) return "Invoice";
  if (text.includes("累計")) return "Cumulative";
  if (text.includes("標準")) return "Standard";
  if (text.includes("例：Hotel Alpenrose")) return "Example: Hotel Alpenrose";
  return `Bản dịch tiếng Việt dài để kiểm tra việc giữ nguyên bố cục cho mục số ${index}`;
}

interface LiveProviderExchange {
  requests: string[];
  results: string[];
}

interface LiveRetentionEvidence {
  exchangeIndex: number;
  finalLength: number;
  requestIndex: number;
  resultLength: number;
  sourceCandidateIndex: number;
  sourceLength: number;
  sourceRecordIndex: number;
  successfulExchangeCount: number;
}

interface LiveCandidate {
  kind: "bounded" | "flow";
  mode: string | null;
  tag: string;
  textLength: number;
}

interface YahooSidebarMeasurement {
  rowIndex: number;
  row: Rect;
  cell: Rect;
  text: Rect;
  visibleText: Rect;
  icon: Rect;
  textLength: number;
  wrapper: boolean;
  overflow: boolean;
  titleLength: number;
}

interface AsahiIconRect extends Rect {
  domIndex: number;
  tagName: string;
  className: string;
  textContent: string;
  ariaHidden: string | null;
  role: string | null;
  backgroundImage: string;
  beforeContent: string;
  afterContent: string;
  primaryLiIndex: number;
  selector: string;
  layoutContext: {
    icon: AsahiElementLayoutSnapshot;
    anchor: AsahiElementLayoutSnapshot | null;
    primaryItem: AsahiElementLayoutSnapshot | null;
    navList: AsahiElementLayoutSnapshot | null;
    navContainer: AsahiElementLayoutSnapshot | null;
  };
}

interface AsahiElementLayoutSnapshot extends Rect {
  tagName: string;
  className: string;
  textContent: string;
  style: {
    textAlign: string;
    display: string;
    position: string;
    width: string;
    minWidth: string;
    maxWidth: string;
    padding: string;
    paddingTop: string;
    paddingRight: string;
    paddingBottom: string;
    paddingLeft: string;
    margin: string;
    marginTop: string;
    marginRight: string;
    marginBottom: string;
    marginLeft: string;
  };
  wrapper: null | {
    directChild: boolean;
    textContent: string;
    title: string | null;
    rect: Rect;
    style: AsahiElementLayoutSnapshot["style"];
  };
}

interface AsahiDropdownSnapshot {
  menuIndex: number;
  itemIndex: number;
  source: string;
  sourceWidth: number;
  sourceLineCount: number;
}

interface AsahiNavGeometry {
  container: Rect;
  items: Rect[];
}

interface AsahiViewportMetrics {
  innerWidth: number;
  clientWidth: number;
  scrollbarWidth: number;
}

function executablePath() {
  const executable =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    chromium.executablePath();
  if (!executable)
    throw new Error(
      "No Chromium executable was found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium binary; this test does not download browsers.",
    );
  return executable;
}

async function launchExtension(
  wakeUrl: string,
  existingUserDataDir?: string,
  options: LaunchExtensionOptions = {},
): Promise<ExtensionSession> {
  const unpackedExtensionPath = options.unpackedExtensionPath ?? extensionPath;
  const executable = executablePath();
  await access(executable).catch(() => {
    throw new Error(
      `Chromium executable was not found at ${executable}. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chromium binary; this test does not download browsers.`,
    );
  });
  await access(unpackedExtensionPath).catch(() => {
    throw new Error(
      `Built extension was not found at ${unpackedExtensionPath}. Run pnpm build before this Playwright suite.`,
    );
  });

  const userDataDir =
    existingUserDataDir ??
    (await mkdtemp(path.join(tmpdir(), "tryhand-layout-")));
  const nativeCapability = process.env.RUN_NATIVE_TRANSLATOR_PROBE === "1";
  const installedExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const loadExtensionViaCdp = nativeCapability || Boolean(installedExecutable);
  const context = await chromium.launchPersistentContext(
    userDataDir,
    nativeCapability
      ? {
          executablePath: executable,
          headless: false,
          ignoreDefaultArgs: true,
          args: [
            `--user-data-dir=${userDataDir}`,
            "--remote-debugging-pipe",
            "--no-first-run",
            "--no-default-browser-check",
            "--enable-unsafe-extension-debugging",
            "about:blank",
          ],
        }
      : installedExecutable
        ? {
            executablePath: executable,
            ignoreDefaultArgs: ["--disable-extensions"],
            headless:
              options.headless ?? process.env.PLAYWRIGHT_HEADLESS !== "0",
            args: ["--enable-unsafe-extension-debugging"],
          }
        : {
            executablePath: executable,
            ignoreDefaultArgs: ["--disable-extensions"],
            headless:
              options.headless ?? process.env.PLAYWRIGHT_HEADLESS !== "0",
            args: [
              `--disable-extensions-except=${unpackedExtensionPath}`,
              `--load-extension=${unpackedExtensionPath}`,
            ],
          },
  );
  const closeContext = async () => {
    const browser =
      installedExecutable && !nativeCapability && context.browser();
    if (browser) await browser.close();
    else await context.close();
  };
  let extensionId = "";
  if (loadExtensionViaCdp) {
    try {
      const browser = context.browser();
      if (!browser)
        throw new Error("Could not access the Chromium CDP session.");
      const cdp = await browser.newBrowserCDPSession();
      try {
        const loaded = await cdp.send("Extensions.loadUnpacked", {
          path: unpackedExtensionPath,
        });
        extensionId = loaded.id;
      } finally {
        await cdp.detach();
      }
    } catch (error) {
      await closeContext();
      await rm(userDataDir, { force: true, recursive: true });
      throw error;
    }
  }
  const isExtensionWorker = (candidate: Worker) =>
    !loadExtensionViaCdp || new URL(candidate.url()).host === extensionId;
  let worker = context.serviceWorkers().find(isExtensionWorker);
  try {
    if (!worker) {
      const workerReady = context.waitForEvent("serviceworker", {
        predicate: isExtensionWorker,
        timeout: 30_000,
      });
      const wakePage = await context.newPage();
      try {
        await wakePage.goto(wakeUrl);
        worker = await workerReady;
      } finally {
        await wakePage.close();
      }
    }
  } catch (error) {
    await closeContext();
    await rm(userDataDir, { force: true, recursive: true });
    throw error;
  }
  extensionId ||= new URL(worker.url()).host;
  if (!extensionId) {
    await closeContext();
    await rm(userDataDir, { force: true, recursive: true });
    throw new Error(
      "Could not determine the MV3 extension ID from its service worker.",
    );
  }

  let contextClosed = false;
  return {
    context,
    extensionId,
    userDataDir,
    worker,
    close: async (removeProfile = true) => {
      if (!contextClosed) {
        contextClosed = true;
        await closeContext();
      }
      if (removeProfile)
        await rm(userDataDir, { force: true, recursive: true });
    },
  };
}

async function startFixtureServer() {
  const [fixture, openAiLatencyFixture] = await Promise.all([
    readFile(fixturePath),
    readFile(openAiLatencyFixturePath),
  ]);
  let server: Server;
  await new Promise<void>((resolve) => {
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const body =
        pathname === "/layout-ellipsis.html"
          ? fixture
          : pathname === "/openai-latency.html"
            ? openAiLatencyFixture
            : undefined;
      if (body) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(body);
        return;
      }
      response.writeHead(404);
      response.end();
    }).listen(0, "127.0.0.1", resolve);
  });
  const address = server!.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback fixture did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}/layout-ellipsis.html`,
    openAiLatencyUrl: `http://127.0.0.1:${address.port}/openai-latency.html`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** The backend's official Google fallback returns decoded plain text. */
function googleFallbackText(source: string, index: number) {
  return translatedText(source, index);
}

/**
 * ADR 0020: the extension's own router makes at most this many OpenAI
 * attempts per record inside one stage (`shared/engine-router.ts`), then
 * leaves the record to the on-device stage. There is no Google fallback.
 */
const OPENAI_ATTEMPTS_PER_STAGE = 3;

async function routeDeterministicProvider(
  context: BrowserContext,
  observeRequests?: (requests: string[]) => void,
  requestedOptions: DeterministicProviderOptions = {},
) {
  // ADR 0020: every stub call is now one OpenAI attempt made by the
  // extension's own router with the user's key. The router retries quality
  // misses itself and has no Google fallback, so the stub models neither.
  const options: DeterministicProviderOptions = {
    ...requestedOptions,
    googleTranslate: undefined,
    openAiRetryDelaysMs: undefined,
  };
  let requestNumber = 0;
  let activeRequests = 0;
  const handleBackend = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/v1/auth/refresh") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          accessToken: "deterministic-access-token",
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "deterministic-refresh-token-next",
          refreshExpiresAt: "2099-02-01T00:00:00.000Z",
        }),
      });
      return;
    }
    if (url.pathname === "/v1/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          user: { id: "user-1", email: "member@example.com" },
        }),
      });
      return;
    }
    // One routed backend stage (ADR 0014). The stub models the backend router:
    // OpenAI values first, then — only when `googleTranslate` is configured —
    // the official Google fallback for records OpenAI left empty or unchanged.
    // Each record carries provenance `openai | google | null`.
    if (url.pathname === "/v1/translation-stages") {
      activeRequests += 1;
      let requestActive = true;
      try {
        const body = request.postDataJSON() as {
          targetLanguage: string;
          sources: string[][];
          sourceRoutes: string[][];
        } & Record<string, unknown>;
        if ("provider" in body || url.search)
          throw new Error("The extension must never name a provider.");
        const requests = body.sources.flat();
        const routes = body.sourceRoutes.flat();
        const sourceLanguages = Object.fromEntries(
          routes.map((source, index) => [`r${index}`, source]),
        );
        const currentRequest = requestNumber++;
        const entries = (options.openAiEntries?.(
          Object.fromEntries(
            requests.map((source, index) => [`r${index}`, source]),
          ),
          currentRequest,
          body.targetLanguage,
        ) ??
          Object.fromEntries(
            requests.map((source, index) => [
              `r${index}`,
              options.translate
                ? options.translate(source, index, body.targetLanguage)
                : translatedText(source, index, body.targetLanguage),
            ]),
          )) as Record<string, unknown> | undefined;
        const openAiResults = requests.map((_, index) =>
          typeof entries?.[`r${index}`] === "string"
            ? String(entries[`r${index}`])
            : "",
        );
        const qualityMiss = (index: number, value: string) =>
          !value.trim() ||
          (routes[index] !== body.targetLanguage &&
            value.trim() === requests[index]!.trim());
        const googleIndexes = options.googleTranslate
          ? requests.flatMap((_, index) =>
              qualityMiss(index, openAiResults[index]!) ? [index] : [],
            )
          : [];
        const googleResults = new Map(
          googleIndexes.map((index) => [
            index,
            options.googleTranslate!(
              requests[index]!,
              index,
              body.targetLanguage,
              routes[index] ?? "auto",
            ),
          ]),
        );
        const provenance: (string | null)[] = [];
        const flatResults = requests.map((_, index) => {
          if (!qualityMiss(index, openAiResults[index]!)) {
            provenance.push("openai");
            return openAiResults[index]!;
          }
          const google = googleResults.get(index);
          if (google !== undefined && !qualityMiss(index, google)) {
            provenance.push("google");
            return google;
          }
          provenance.push(null);
          return "";
        });
        const reply =
          options.reply?.(requests, currentRequest, body.targetLanguage) ?? {};
        const status =
          reply.status ??
          (reply.abort ||
          reply.body !== undefined ||
          reply.rawBody !== undefined
            ? 502
            : 200);
        const evidence: DeterministicProviderRequest = {
          activeRequests,
          at: Date.now(),
          characters: requests.reduce(
            (total, value) => total + value.length,
            0,
          ),
          encodedCharacters: JSON.stringify(body.sources).length,
          mode: "primary",
          provider: "openai",
          provenance,
          recordCount: requests.length,
          requests,
          results: flatResults,
          sourceLanguage: routes[0] ?? "auto",
          sourceLanguages,
          status,
          targetLanguage: body.targetLanguage,
        };
        observeRequests?.(requests);
        options.observeRequest?.(evidence);
        if (googleIndexes.length && status >= 200 && status < 300)
          options.observeRequest?.({
            ...evidence,
            mode: undefined,
            provider: "google",
            characters: googleIndexes.reduce(
              (total, index) => total + requests[index]!.length,
              0,
            ),
            recordCount: googleIndexes.length,
            requests: googleIndexes.map((index) => requests[index]!),
            results: googleIndexes.map((index) => googleResults.get(index)!),
            provenance: googleIndexes.map((index) => provenance[index]!),
          });
        if (options.openAiRetryDelaysMs && options.googleTranslate)
          throw new Error("In-stage OpenAI retries precede Google fallback.");
        for (const retryDelayMs of options.openAiRetryDelaysMs ?? []) {
          const missed = requests.flatMap((_, index) =>
            provenance[index] === null ? [index] : [],
          );
          if (!missed.length || status < 200 || status >= 300) break;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, retryDelayMs),
          );
          const retrySources = missed.map((index) => requests[index]!);
          const retryEntries = (options.openAiEntries?.(
            Object.fromEntries(
              retrySources.map((source, position) => [`r${position}`, source]),
            ),
            currentRequest,
            body.targetLanguage,
          ) ??
            Object.fromEntries(
              missed.map((index, position) => [
                `r${position}`,
                options.translate
                  ? options.translate(
                      requests[index]!,
                      index,
                      body.targetLanguage,
                    )
                  : translatedText(
                      requests[index]!,
                      index,
                      body.targetLanguage,
                    ),
              ]),
            )) as Record<string, unknown> | undefined;
          const retryResults = missed.map((_, position) =>
            typeof retryEntries?.[`r${position}`] === "string"
              ? String(retryEntries[`r${position}`])
              : "",
          );
          missed.forEach((index, position) => {
            if (qualityMiss(index, retryResults[position]!)) return;
            flatResults[index] = retryResults[position]!;
            provenance[index] = "openai";
          });
          options.observeRequest?.({
            ...evidence,
            at: Date.now(),
            characters: retrySources.reduce(
              (total, value) => total + value.length,
              0,
            ),
            encodedCharacters: JSON.stringify([retrySources]).length,
            recordCount: missed.length,
            requests: retrySources,
            results: retryResults,
            provenance: missed.map((index) => provenance[index]!),
            sourceLanguages: Object.fromEntries(
              missed.map((index, position) => [`r${position}`, routes[index]!]),
            ),
          });
        }
        let cursor = 0;
        const results = body.sources.map((row) =>
          row.map(() => flatResults[cursor++] ?? ""),
        );
        cursor = 0;
        const provenanceRows = body.sources.map((row) =>
          row.map(() => provenance[cursor++] ?? null),
        );
        const delayMs =
          typeof options.delayMs === "function"
            ? options.delayMs(body.targetLanguage, requests, currentRequest)
            : options.delayMs;
        if (delayMs)
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        evidence.responseReadyAt = Date.now();
        evidence.durationMs = evidence.responseReadyAt - evidence.at;
        activeRequests -= 1;
        requestActive = false;
        if (reply.abort) {
          await route.abort("failed");
          evidence.completedAt = Date.now();
          return;
        }
        await route.fulfill({
          status,
          headers: reply.headers,
          contentType: "application/json",
          body:
            reply.rawBody ??
            (reply.body !== undefined
              ? JSON.stringify(reply.body)
              : undefined) ??
            (status >= 200 && status < 300
              ? JSON.stringify({
                  results,
                  provenance: provenanceRows,
                  failures: [],
                  diagnostics: {
                    records: requests.length,
                    sourceCharacters: evidence.characters,
                    requestCount: 1 + (googleIndexes.length ? 1 : 0),
                    requestMs: evidence.durationMs,
                    inputTokens: 10,
                    outputTokens: 8,
                    reasoningTokens: 0,
                    cachedInputTokens: 0,
                  },
                })
              : JSON.stringify({
                  error: {
                    code:
                      status === 429
                        ? "PROVIDER_RATE_LIMITED"
                        : "PROVIDER_UNAVAILABLE",
                    message: `Translation provider failed (${status})`,
                  },
                })),
        });
        evidence.completedAt = Date.now();
      } finally {
        if (requestActive) activeRequests -= 1;
      }
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  };
  await context.route(/^https:\/\/api\.example\.test\/.*/, handleBackend);
  // ADR 0020: translation goes to OpenAI with the user's key; the same stub
  // answers it through the stage adapter, and a test key is saved first.
  await routeE2EProvider(context, handleBackend, {
    saveKey: !options.withoutProviderKey,
  });
}

async function sendTopFrameMessage(
  worker: Worker,
  url: string,
  message: Record<string, unknown>,
) {
  return worker.evaluate(
    async ({ targetUrl, payload }) => {
      const extensionBrowser = (
        globalThis as unknown as {
          browser: {
            tabs: {
              query: (
                query: object,
              ) => Promise<{ id?: number; url?: string }[]>;
              sendMessage: (
                tabId: number,
                message: Record<string, unknown>,
                options: { frameId: number },
              ) => Promise<unknown>;
            };
          };
        }
      ).browser;
      const tab = (await extensionBrowser.tabs.query({})).find(
        (candidate) => candidate.url === targetUrl,
      );
      if (tab?.id === undefined)
        throw new Error(`No extension tab matched ${targetUrl}`);
      return extensionBrowser.tabs.sendMessage(tab.id, payload, { frameId: 0 });
    },
    { targetUrl: url, payload: message },
  );
}

async function openPopupForTab(extension: ExtensionSession, activePage: Page) {
  const popup = await extension.context.newPage();
  await activePage.bringToFront();
  await popup.goto(`chrome-extension://${extension.extensionId}/popup.html`);
  await expect(popup.getByRole("heading", { name: "Readlace" })).toBeVisible();
  return popup;
}

async function sendExtensionMessage(
  page: Page,
  message: Record<string, unknown>,
) {
  return page.evaluate(async (payload) => {
    const extensionBrowser = (
      globalThis as unknown as {
        browser: {
          runtime: {
            sendMessage: (message: Record<string, unknown>) => Promise<unknown>;
          };
        };
      }
    ).browser;
    return extensionBrowser.runtime.sendMessage(payload);
  }, message);
}

async function waitForState(
  worker: Worker,
  url: string,
  state:
    | "error"
    | "original"
    | "partial"
    | "preparing"
    | "translated"
    | "translating",
) {
  await expect
    .poll(async () => {
      const result = await sendTopFrameMessage(worker, url, {
        type: "CONTENT_STATE",
      });
      return (result as { state?: string } | undefined)?.state;
    })
    .toBe(state);
}

async function startFrameSampler(page: Page, probes: string[]) {
  await page.evaluate((names) => {
    type SamplerWindow = Window & {
      __tryhandLayoutSampler?: { active: boolean; samples: FrameSamples };
    };
    const samplerWindow = window as SamplerWindow;
    const samples = Object.fromEntries(
      names.map((name) => [name, [] as FrameSample[]]),
    ) as FrameSamples;
    samplerWindow.__tryhandLayoutSampler = { active: true, samples };
    const sample = () => {
      for (const name of names) {
        const target = document.querySelector(`[data-layout-probe="${name}"]`);
        if (!target) continue;
        const wrapper = target.querySelector<HTMLElement>(
          "tryhand-ellipsis.tryhand-ellipsis",
        );
        const textWalker = document.createTreeWalker(
          target,
          NodeFilter.SHOW_TEXT,
        );
        const textNodes: Text[] = [];
        for (
          let node = textWalker.nextNode();
          node;
          node = textWalker.nextNode()
        )
          if (node.textContent?.trim()) textNodes.push(node as Text);
        const text = wrapper?.firstChild ?? textNodes[0];
        const range = document.createRange();
        if (text) range.selectNodeContents(text);
        const lineCount = new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.y * 2) / 2),
        ).size;
        const blockLines = new Set<number>();
        for (const textNode of textNodes) {
          const textRange = document.createRange();
          textRange.selectNodeContents(textNode);
          for (const rect of textRange.getClientRects())
            blockLines.add(Math.round(rect.y * 2) / 2);
        }
        const blockLineCount = blockLines.size;
        const { x, y, width, height } = target.getBoundingClientRect();
        samples[name]!.push({
          x,
          y,
          width,
          height,
          blockLineCount,
          lineCount,
          markerCount: document.querySelectorAll(
            "tryhand-baseline-marker.tryhand-baseline-marker",
          ).length,
          overflow: wrapper
            ? wrapper.scrollWidth > wrapper.clientWidth ||
              wrapper.scrollHeight > wrapper.clientHeight
            : target.scrollWidth > target.clientWidth ||
              target.scrollHeight > target.clientHeight,
          text: target.textContent?.trim() ?? "",
          title: wrapper?.getAttribute("title") ?? null,
          whiteSpace: getComputedStyle(wrapper ?? target).whiteSpace,
          wrapper: Boolean(wrapper),
          wrapperVerticalAlign: wrapper?.style.verticalAlign ?? null,
        });
      }
      if (samplerWindow.__tryhandLayoutSampler?.active)
        requestAnimationFrame(sample);
    };
    sample();
  }, probes);
}

async function stopFrameSampler(page: Page) {
  return page.evaluate(() => {
    type SamplerWindow = Window & {
      __tryhandLayoutSampler?: { active: boolean; samples: FrameSamples };
    };
    const samplerWindow = window as SamplerWindow;
    if (!samplerWindow.__tryhandLayoutSampler) return {} as FrameSamples;
    samplerWindow.__tryhandLayoutSampler.active = false;
    return samplerWindow.__tryhandLayoutSampler.samples;
  });
}

function maxGeometryDelta(samples: Rect[]) {
  const baseline = samples[0];
  if (!baseline) return Number.POSITIVE_INFINITY;
  return Math.max(
    ...samples.map((sample) =>
      Math.max(
        Math.abs(sample.x - baseline.x),
        Math.abs(sample.y - baseline.y),
        Math.abs(sample.width - baseline.width),
        Math.abs(sample.height - baseline.height),
      ),
    ),
  );
}

function relativeRect(rect: Rect, owner: Rect): Rect {
  return {
    x: rect.x - owner.x,
    y: rect.y - owner.y,
    width: rect.width,
    height: rect.height,
  };
}

function expectNoTransientLayout(samples: FrameSample[]) {
  for (const sample of samples) {
    expect(sample.markerCount).toBe(0);
    if (!sample.text.includes("Bản dịch tiếng Việt")) continue;
    if (!sample.wrapper) {
      expect(sample.overflow).toBe(false);
      expect(sample.lineCount).toBe(1);
      continue;
    }
    expect(sample.whiteSpace).toBe("nowrap");
    expect(sample.wrapperVerticalAlign).toMatch(/^-?\d+(?:\.\d+)?px$/);
  }
}

async function pseudoBox(
  session: CDPSession,
  selector: string,
  pseudoType: "before" | "after",
): Promise<Rect | null> {
  const { root } = await session.send("DOM.getDocument", {
    depth: 0,
    pierce: true,
  });
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) return null;
  const { node } = await session.send("DOM.describeNode", {
    nodeId,
    depth: 1,
    pierce: true,
  });
  const pseudo = node.pseudoElements?.find(
    (candidate) => candidate.pseudoType === pseudoType,
  );
  if (!pseudo) return null;
  const { model } = await session.send("DOM.getBoxModel", {
    nodeId: pseudo.nodeId,
  });
  const x = Math.min(
    model.border[0]!,
    model.border[2]!,
    model.border[4]!,
    model.border[6]!,
  );
  const y = Math.min(
    model.border[1]!,
    model.border[3]!,
    model.border[5]!,
    model.border[7]!,
  );
  return { x, y, width: model.width, height: model.height };
}

async function waitForFrames(page: Page, count = 3) {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
  }, count);
}

async function waitForSchedulerTicks(page: Page, count = 3) {
  await page.waitForTimeout(count * 300 + 50);
}

async function expectRetainedProviderRecord(
  page: Page,
  providerRequests: DeterministicProviderRequest[],
  record: { probe: string; source: string; translation: string },
) {
  const requestNumber = providerRequests.findIndex(
    ({ requests, status }) =>
      status >= 200 &&
      status < 300 &&
      requests.some((request) => request.includes(record.source)),
  );
  expect(
    requestNumber,
    `${record.source} was absent from provider requests`,
  ).toBeGreaterThanOrEqual(0);
  const request = providerRequests[requestNumber]!;
  const requestIndex = request.requests.findIndex((source) =>
    source.includes(record.source),
  );
  expect(requestIndex).toBeGreaterThanOrEqual(0);
  expect(request.results[requestIndex]).toContain(record.translation);
  await expect(
    page.locator(`[data-layout-probe='${record.probe}']`),
  ).toHaveText(record.translation);
  return {
    requestIndex,
    requestNumber,
    returned: request.results[requestIndex],
  };
}

async function captureEvidence(page: Page, filename: string) {
  await mkdir(evidencePath, { recursive: true });
  await page.screenshot({
    fullPage: true,
    path: path.join(evidencePath, filename),
  });
}

async function runtimeCandidate(page: Page): Promise<LiveCandidate | null> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const wrapper = [
      ...document.querySelectorAll("tryhand-ellipsis.tryhand-ellipsis"),
    ].find(visible);
    if (wrapper) {
      return {
        kind: "bounded" as const,
        mode: wrapper.getAttribute("data-tryhand-layout"),
        tag: wrapper.parentElement?.tagName.toLowerCase() ?? "span",
        textLength: wrapper.textContent?.trim().length ?? 0,
      };
    }
    const flow = [
      ...document.querySelectorAll("article, main, [role='main'], p"),
    ].find(
      (element) =>
        visible(element) &&
        !element.querySelector("tryhand-ellipsis.tryhand-ellipsis") &&
        Boolean(element.textContent?.trim()),
    );
    if (!flow) return null;
    return {
      kind: "flow" as const,
      mode: null,
      tag: flow.tagName.toLowerCase(),
      textLength: flow.textContent?.trim().length ?? 0,
    };
  });
}

async function yahooSidebarMeasurements(
  page: Page,
): Promise<YahooSidebarMeasurement[]> {
  return page.evaluate(() => {
    const rect = (element: Element): Rect => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        box.width > 0 &&
        box.height > 0
      );
    };
    const iconLike = (element: Element) => {
      const box = element.getBoundingClientRect();
      return (
        box.width >= 8 && box.width <= 64 && box.height >= 8 && box.height <= 64
      );
    };

    const rows = [...document.querySelectorAll("*")].filter((row) => {
      const style = getComputedStyle(row);
      const box = row.getBoundingClientRect();
      return (
        visible(row) &&
        (style.display === "flex" || style.display === "inline-flex") &&
        style.flexDirection === "row" &&
        style.flexWrap === "nowrap" &&
        box.x >= 0 &&
        box.x < window.innerWidth / 2 &&
        box.width >= 80 &&
        box.width <= 300
      );
    });

    const measurements: YahooSidebarMeasurement[] = [];
    for (const [rowIndex, row] of rows.entries()) {
      const children = [...row.children].filter(visible);
      for (let index = 1; index < children.length; index += 1) {
        const icon = children[index - 1]!;
        const cell = children[index]!;
        const linkOwned =
          row.matches("a, [role='link']") || cell.matches("a, [role='link']");
        if (!iconLike(icon) || !linkOwned) continue;
        const textWalker = document.createTreeWalker(
          cell,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) =>
              node.textContent?.trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT,
          },
        );
        const textNode = textWalker.nextNode();
        const wrapper = cell.querySelector<HTMLElement>(
          "tryhand-ellipsis.tryhand-ellipsis",
        );
        const text = wrapper?.firstChild ?? textNode;
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const textRect = range.getBoundingClientRect();
        if (textRect.width <= 0 || textRect.height <= 0) continue;
        const visibleTextRect = wrapper?.getBoundingClientRect() ?? textRect;
        measurements.push({
          rowIndex,
          row: rect(row),
          cell: rect(cell),
          text: {
            x: textRect.x,
            y: textRect.y,
            width: textRect.width,
            height: textRect.height,
          },
          visibleText: {
            x: visibleTextRect.x,
            y: visibleTextRect.y,
            width: visibleTextRect.width,
            height: visibleTextRect.height,
          },
          icon: rect(icon),
          textLength: text.textContent?.trim().length ?? 0,
          wrapper: Boolean(wrapper),
          overflow: Boolean(
            wrapper &&
            (wrapper.scrollWidth > wrapper.clientWidth ||
              wrapper.scrollHeight > wrapper.clientHeight),
          ),
          titleLength: wrapper?.getAttribute("title")?.length ?? 0,
        });
      }
    }
    return measurements;
  });
}

async function asahiPrimaryNavCandidate(page: Page): Promise<LiveCandidate> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const anchors = [
      ...document.querySelectorAll("#GlobalNav .MainNav > ul.Nav > li > a"),
    ].filter(visible);
    if (!anchors.length)
      throw new Error("Asahi primary navigation was not visible.");

    for (const anchor of anchors) {
      const wrapper = anchor.querySelector<HTMLElement>(
        "tryhand-ellipsis.tryhand-ellipsis[data-tryhand-layout='single-line']",
      );
      const text = wrapper?.firstChild ?? anchor.firstChild;
      const range = document.createRange();
      if (text) range.selectNodeContents(text);
      const lineCount = new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.y * 2) / 2),
      ).size;
      if (lineCount !== 1)
        throw new Error("An Asahi primary-nav label used more than one line.");
      if (wrapper) {
        const overflow =
          wrapper.scrollWidth > wrapper.clientWidth ||
          wrapper.scrollHeight > wrapper.clientHeight;
        const title = wrapper.getAttribute("title");
        if (Boolean(title) !== overflow)
          throw new Error(
            "Asahi primary-nav wrapper title does not match overflow.",
          );
        if (overflow && title !== wrapper.textContent)
          throw new Error(
            "Asahi primary-nav wrapper title is not its full translation.",
          );
        if (!/^-?\d+(?:\.\d+)?px$/.test(wrapper.style.verticalAlign))
          throw new Error(
            "Asahi primary-nav wrapper lacks numeric baseline correction.",
          );
      } else if (anchor.hasAttribute("title")) {
        throw new Error("An unwrapped Asahi primary-nav label gained a title.");
      }
    }

    return {
      kind: "bounded",
      mode: "single-line",
      tag: "a",
      textLength: anchors[0]?.textContent?.trim().length ?? 0,
    };
  });
}

async function asahiPrimaryNavIconRects(page: Page): Promise<AsahiIconRect[]> {
  return page.evaluate(() => {
    const wrapperSelector =
      "tryhand-ellipsis.tryhand-ellipsis[data-tryhand-layout='single-line']";
    const snapshotStyle = (style: CSSStyleDeclaration) => ({
      textAlign: style.textAlign,
      display: style.display,
      position: style.position,
      width: style.width,
      minWidth: style.minWidth,
      maxWidth: style.maxWidth,
      padding: style.padding,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      margin: style.margin,
      marginTop: style.marginTop,
      marginRight: style.marginRight,
      marginBottom: style.marginBottom,
      marginLeft: style.marginLeft,
    });
    const snapshotElement = (element: Element | null) => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      const wrapper = element.querySelector<HTMLElement>(wrapperSelector);
      const wrapperRect = wrapper?.getBoundingClientRect();
      return {
        x,
        y,
        width,
        height,
        tagName: element.tagName.toLowerCase(),
        className: element.getAttribute("class") ?? "",
        textContent: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
        style: snapshotStyle(getComputedStyle(element)),
        wrapper:
          wrapper && wrapperRect
            ? {
                directChild: wrapper.parentElement === element,
                textContent: wrapper.textContent ?? "",
                title: wrapper.getAttribute("title"),
                rect: {
                  x: wrapperRect.x,
                  y: wrapperRect.y,
                  width: wrapperRect.width,
                  height: wrapperRect.height,
                },
                style: snapshotStyle(getComputedStyle(wrapper)),
              }
            : null,
      };
    };
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const icons = [
      ...document.querySelectorAll(
        "#GlobalNav .MainNav > ul.Nav > li > a > span, #GlobalNav .MainNav > ul.Nav > li > a > img, #GlobalNav .MainNav > ul.Nav > li > a > svg",
      ),
    ];
    const visibleIcons = icons
      .map((icon) => {
        const style = getComputedStyle(icon);
        const beforeStyle = getComputedStyle(icon, "::before");
        const afterStyle = getComputedStyle(icon, "::after");
        return {
          icon,
          style,
          beforeStyle,
          afterStyle,
          tagName: icon.tagName.toLowerCase(),
        };
      })
      .filter(({ icon, style, beforeStyle, afterStyle, tagName }) => {
        if (!visible(icon)) return false;
        if (tagName === "img" || tagName === "svg") return true;
        const visiblePseudoContent = (pseudoStyle: CSSStyleDeclaration) =>
          pseudoStyle.display !== "none" &&
          pseudoStyle.visibility !== "hidden" &&
          !["none", "normal", '""', "''"].includes(pseudoStyle.content);
        return (
          icon.getAttribute("role") === "img" ||
          icon.getAttribute("aria-hidden") === "true" ||
          style.backgroundImage !== "none" ||
          visiblePseudoContent(beforeStyle) ||
          visiblePseudoContent(afterStyle)
        );
      });
    if (!visibleIcons.length)
      throw new Error(
        "Asahi primary navigation exposed no visible real-icon candidates.",
      );
    const primaryItems = [
      ...document.querySelectorAll("#GlobalNav .MainNav > ul.Nav > li"),
    ];
    return visibleIcons.map(
      ({ icon, style, beforeStyle, afterStyle, tagName }) => {
        const { x, y, width, height } = icon.getBoundingClientRect();
        const primaryLiIndex = primaryItems.indexOf(
          icon.closest("#GlobalNav .MainNav > ul.Nav > li")!,
        );
        const childIndex = [...icon.parentElement!.children].indexOf(icon) + 1;
        const anchor = icon.closest("a");
        const primaryItem = icon.closest("#GlobalNav .MainNav > ul.Nav > li");
        const navList =
          primaryItem?.closest("#GlobalNav .MainNav > ul.Nav") ?? null;
        const navContainer =
          primaryItem?.closest("#GlobalNav .MainNav") ?? null;
        return {
          x,
          y,
          width,
          height,
          domIndex: icons.indexOf(icon),
          tagName,
          className: icon.getAttribute("class") ?? "",
          textContent: icon.textContent?.replace(/\s+/g, " ").trim() ?? "",
          ariaHidden: icon.getAttribute("aria-hidden"),
          role: icon.getAttribute("role"),
          backgroundImage: style.backgroundImage,
          beforeContent: beforeStyle.content,
          afterContent: afterStyle.content,
          primaryLiIndex,
          selector: `#GlobalNav .MainNav > ul.Nav > li:nth-of-type(${primaryLiIndex + 1}) > a > ${tagName}:nth-child(${childIndex})`,
          layoutContext: {
            icon: snapshotElement(icon)!,
            anchor: snapshotElement(anchor),
            primaryItem: snapshotElement(primaryItem),
            navList: snapshotElement(navList),
            navContainer: snapshotElement(navContainer),
          },
        };
      },
    );
  });
}

async function asahiPrimaryNavRects(page: Page): Promise<AsahiNavGeometry> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const items = [
      ...document.querySelectorAll("#GlobalNav .MainNav > ul.Nav > li"),
    ].filter(visible);
    if (!items.length)
      throw new Error("Asahi primary navigation was not visible.");
    const container = document.querySelector("#GlobalNav .MainNav");
    if (!container)
      throw new Error("Asahi primary navigation container was not found.");
    const containerRect = container.getBoundingClientRect();
    return {
      container: {
        x: containerRect.x,
        y: containerRect.y,
        width: containerRect.width,
        height: containerRect.height,
      },
      items: items.map((item) => {
        const { x, y, width, height } = item.getBoundingClientRect();
        return { x, y, width, height };
      }),
    };
  });
}

async function asahiViewportMetrics(page: Page): Promise<AsahiViewportMetrics> {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
  }));
}

async function asahiPrimaryPseudoTargets(page: Page) {
  return page.evaluate(() => {
    const items = [
      ...document.querySelectorAll("#GlobalNav .MainNav > ul.Nav > li"),
    ];
    return items.flatMap((item, index) => {
      const anchor = item.querySelector(":scope > a");
      if (!anchor || anchor.getBoundingClientRect().width <= 0) return [];
      const selector = `#GlobalNav .MainNav > ul.Nav > li:nth-child(${index + 1}) > a`;
      return (["before", "after"] as const)
        .filter((pseudoType) => {
          const style = getComputedStyle(anchor, `::${pseudoType}`);
          return (
            style.display !== "none" &&
            style.content !== "none" &&
            style.content !== "normal"
          );
        })
        .map((pseudoType) => {
          const { x, y, width, height } = anchor.getBoundingClientRect();
          return {
            selector,
            pseudoType,
            ownerRect: { x, y, width, height },
          };
        });
    });
  });
}

async function asahiDropdownSnapshot(
  page: Page,
): Promise<AsahiDropdownSnapshot[] | null> {
  const snapshots: AsahiDropdownSnapshot[] = [];
  const menus = page.locator("#GlobalNav .MainNav > ul.Nav > li.HasSubNav");
  for (let menuIndex = 0; menuIndex < (await menus.count()); menuIndex += 1) {
    const menu = menus.nth(menuIndex);
    if (!(await menu.isVisible())) continue;
    await menu.hover();
    const dropdown = menu.locator("ul.SubNav").first();
    await waitForFrames(page);
    if (!(await dropdown.isVisible())) return null;
    snapshots.push(
      ...(await dropdown.locator(":scope > li > a:visible").evaluateAll(
        (anchors, currentMenuIndex) =>
          anchors.map((anchor, itemIndex) => {
            const text = [...anchor.childNodes].find(
              (node) => node instanceof Text && node.textContent?.trim(),
            );
            const range = document.createRange();
            if (text) range.selectNodeContents(text);
            return {
              menuIndex: currentMenuIndex,
              itemIndex,
              source: text?.textContent?.trim() ?? "",
              sourceWidth: text ? range.getBoundingClientRect().width : 0,
              sourceLineCount: text
                ? new Set(
                    [...range.getClientRects()]
                      .filter((rect) => rect.width > 0 && rect.height > 0)
                      .map((rect) => Math.round(rect.y * 2) / 2),
                  ).size
                : 0,
            };
          }),
        menuIndex,
      )),
    );
  }
  return snapshots.length ? snapshots : null;
}

async function measureAsahiDropdowns(
  page: Page,
  before: AsahiDropdownSnapshot[],
  providerExchanges: LiveProviderExchange[],
) {
  const measurements = [];
  const menus = page.locator("#GlobalNav .MainNav > ul.Nav > li.HasSubNav");
  for (const menuIndex of [
    ...new Set(before.map(({ menuIndex }) => menuIndex)),
  ]) {
    const menu = menus.nth(menuIndex);
    await menu.hover();
    const dropdown = menu.locator("ul.SubNav").first();
    await expect(dropdown).toBeVisible();
    const measureItems = () =>
      dropdown.locator(":scope > li > a:visible").evaluateAll((anchors) =>
        anchors.map((anchor, itemIndex) => {
          const wrapper = anchor.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          const text =
            wrapper?.firstChild ??
            [...anchor.childNodes].find(
              (node) => node instanceof Text && node.textContent?.trim(),
            );
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          const textWidth = text ? range.getBoundingClientRect().width : 0;
          const cellWidth = anchor.parentElement?.clientWidth ?? 0;
          const overflow = Boolean(
            wrapper &&
            (wrapper.scrollWidth > wrapper.clientWidth ||
              wrapper.scrollHeight > wrapper.clientHeight),
          );
          const pseudoStyles = ["::before", "::after"].map((pseudo) => {
            const { content, display, visibility, position, cssFloat } =
              getComputedStyle(anchor, pseudo);
            return {
              pseudo,
              content,
              display,
              visibility,
              position,
              cssFloat,
            };
          });
          const anchorRect = anchor.getBoundingClientRect();
          const anchorStyle = getComputedStyle(anchor);
          const parent = anchor.parentElement;
          const parentRect = parent?.getBoundingClientRect();
          const parentStyle = parent ? getComputedStyle(parent) : null;
          const hostShape = {
            anchor: {
              tagName: anchor.tagName,
              display: anchorStyle.display,
              backgroundImage: anchorStyle.backgroundImage,
              backgroundPosition: anchorStyle.backgroundPosition,
              backgroundSize: anchorStyle.backgroundSize,
              backgroundRepeat: anchorStyle.backgroundRepeat,
              clientWidth: anchor.clientWidth,
              rect: {
                x: anchorRect.x,
                y: anchorRect.y,
                width: anchorRect.width,
                height: anchorRect.height,
              },
              paddingInlineStart: anchorStyle.paddingInlineStart,
              paddingInlineEnd: anchorStyle.paddingInlineEnd,
            },
            parent:
              parent && parentRect && parentStyle
                ? {
                    tagName: parent.tagName,
                    clientWidth: parent.clientWidth,
                    backgroundImage: parentStyle.backgroundImage,
                    backgroundPosition: parentStyle.backgroundPosition,
                    backgroundSize: parentStyle.backgroundSize,
                    backgroundRepeat: parentStyle.backgroundRepeat,
                    rect: {
                      x: parentRect.x,
                      y: parentRect.y,
                      width: parentRect.width,
                      height: parentRect.height,
                    },
                    paddingInlineStart: parentStyle.paddingInlineStart,
                    paddingInlineEnd: parentStyle.paddingInlineEnd,
                  }
                : null,
            children: [...anchor.children].map((child) => {
              const rect = child.getBoundingClientRect();
              return {
                tagName: child.tagName,
                className: child.getAttribute("class") ?? "",
                rect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              };
            }),
          };
          return {
            connected: anchor.isConnected,
            itemIndex,
            text: text?.textContent ?? "",
            textWidth,
            cellWidth,
            lineCount: new Set(
              [...range.getClientRects()].map(
                (rect) => Math.round(rect.y * 2) / 2,
              ),
            ).size,
            wrapper: Boolean(wrapper),
            wrapperRect: wrapper
              ? {
                  x: wrapper.getBoundingClientRect().x,
                  y: wrapper.getBoundingClientRect().y,
                  width: wrapper.getBoundingClientRect().width,
                  height: wrapper.getBoundingClientRect().height,
                }
              : null,
            overflow,
            title:
              wrapper?.getAttribute("title") ?? anchor.getAttribute("title"),
            visible: anchor.checkVisibility(),
            textOverflow: wrapper
              ? getComputedStyle(wrapper).textOverflow
              : null,
            whiteSpace: wrapper
              ? getComputedStyle(wrapper).whiteSpace
              : getComputedStyle(anchor).whiteSpace,
            pseudoStyles,
            hostShape,
          };
        }),
      );
    try {
      await expect
        .poll(async () =>
          (await measureItems()).every((item) => {
            const source = before.find(
              (snapshot) =>
                snapshot.menuIndex === menuIndex &&
                snapshot.itemIndex === item.itemIndex,
            );
            if (!source || item.lineCount !== source.sourceLineCount)
              return false;
            // This backend fixture returns a distinct translation for every menu item.
            // Do not accept original text before a deferred visible commit has run.
            if (item.text.trim() === source.source) return false;
            if (!item.wrapper) return item.title === null;
            if (source.sourceLineCount > 1)
              return item.title === (item.overflow ? item.text : null);
            return (
              item.whiteSpace === "nowrap" &&
              item.title === (item.overflow ? item.text : null) &&
              (!item.overflow || item.textOverflow === "ellipsis")
            );
          }),
        )
        .toBe(true);
    } catch (error) {
      const items = await measureItems();
      const sources = before.filter(
        (snapshot) => snapshot.menuIndex === menuIndex,
      );
      const providerMatches = await page.evaluate(
        ({ exchanges, sourceTexts }) => {
          const entries = (html: string) => {
            const parsed = new DOMParser().parseFromString(html, "text/html");
            const anchors = [...parsed.querySelectorAll("a[i]")];
            return anchors.length
              ? anchors.map((anchor) => anchor.textContent?.trim() ?? "")
              : [parsed.querySelector("pre")?.textContent?.trim() ?? ""];
          };
          return sourceTexts.map((source) =>
            exchanges.flatMap(({ requests, results }, exchangeIndex) =>
              requests.flatMap((requestHtml, requestIndex) => {
                const sourceRecordIndex = entries(requestHtml).indexOf(source);
                if (sourceRecordIndex < 0) return [];
                return [
                  {
                    exchangeIndex,
                    requestIndex,
                    result: entries(results[requestIndex] ?? "")[
                      sourceRecordIndex
                    ],
                    sourceRecordIndex,
                  },
                ];
              }),
            ),
          );
        },
        {
          exchanges: providerExchanges,
          sourceTexts: sources.map(({ source }) => source),
        },
      );
      throw new Error(
        `Asahi dropdown policy did not stabilize: ${JSON.stringify(
          sources.map((source, index) => ({
            ...source,
            current: items.find((item) => item.itemIndex === source.itemIndex),
            providerMatches: providerMatches[index],
          })),
        )}`,
        { cause: error },
      );
    }
    const items = await measureItems();
    for (const item of items) {
      const sourceWidth =
        before.find(
          (snapshot) =>
            snapshot.menuIndex === menuIndex &&
            snapshot.itemIndex === item.itemIndex,
        )?.sourceWidth ?? 0;
      const failureContext = `Asahi dropdown item policy failed: ${JSON.stringify(
        { menuIndex, sourceWidth, ...item },
      )}`;
      expect(item.lineCount, failureContext).toBe(1);
      if (!item.wrapper) {
        expect(item.title, failureContext).toBeNull();
      } else {
        expect(item.whiteSpace, failureContext).toBe("nowrap");
        expect(item.title, failureContext).toBe(
          item.overflow ? item.text : null,
        );
        expect(item.wrapperRect, failureContext).not.toBeNull();
        if (item.wrapperRect) {
          const anchor = item.hostShape.anchor.rect;
          expect(item.wrapperRect.x, failureContext).toBeGreaterThanOrEqual(
            anchor.x - 1,
          );
          expect(
            item.wrapperRect.x + item.wrapperRect.width,
            failureContext,
          ).toBeLessThanOrEqual(anchor.x + anchor.width + 1);
        }
        if (item.overflow)
          expect(item.textOverflow, failureContext).toBe("ellipsis");
      }
      measurements.push({ menuIndex, sourceWidth, ...item });
    }
    await captureEvidence(
      page,
      `layout-ellipsis-live-asahi-menu-${menuIndex + 1}.png`,
    );
  }
  expect(measurements.length).toBe(before.length);
  expect(
    measurements.some(
      ({ textWidth, sourceWidth, cellWidth, lineCount, wrapper, overflow }) =>
        lineCount === 1 &&
        textWidth > sourceWidth + 1 &&
        textWidth <= cellWidth + 0.5 &&
        (!wrapper || !overflow),
    ),
  ).toBe(true);
  return measurements;
}

async function writeLiveEvidence(
  filename: string,
  candidate: LiveCandidate,
  retention: LiveRetentionEvidence,
  originalLength: number,
  translatedLength: number,
  vietnameseBefore: number,
  vietnameseAfter: number,
  providerRequestCounts: {
    afterInitialTopFrameTranslation: number;
    afterFirstDropdownRevealTranslation: number;
    afterCachedReflow: number;
    additionalCachedReflowRequests: number;
  },
  measurements: unknown = null,
) {
  await mkdir(evidencePath, { recursive: true });
  await writeFile(
    path.join(evidencePath, filename),
    `${JSON.stringify(
      {
        kind: candidate.kind,
        mode: candidate.mode,
        tag: candidate.tag,
        originalLength,
        translatedLength,
        candidateLength: candidate.textLength,
        retention,
        vietnameseBefore,
        vietnameseAfter,
        hasNewVietnamese: vietnameseAfter > vietnameseBefore,
        providerRequestCounts,
        measurements,
      },
      null,
      2,
    )}\n`,
  );
}

function vietnameseCharacterCount(text: string) {
  return text.match(vietnameseCharacter)?.length ?? 0;
}

async function visibleBodyText(page: Page) {
  return page.locator("body").evaluate((body) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.textContent?.trim())
          return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        return style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      nodes.push(node.textContent!.trim());
    return nodes.join(" ");
  });
}

async function installLiveRetentionProbe(page: Page) {
  await page.evaluate(() => {
    type RetentionWindow = Window & {
      __tryhandLiveRetention?: { node: Text; source: string }[];
    };
    const records: { node: Text; source: string }[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          const source = node.textContent?.trim() ?? "";
          if (
            !parent ||
            source.length < 4 ||
            source.length > 500 ||
            !/[\p{L}\p{N}]/u.test(source)
          )
            return NodeFilter.FILTER_REJECT;
          if (
            parent.closest(
              "script, style, noscript, textarea, [contenteditable]",
            )
          )
            return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom >= -window.innerHeight &&
            rect.top <= window.innerHeight * 2
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      },
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      records.push({ node: node as Text, source: node.textContent ?? "" });
    (window as RetentionWindow).__tryhandLiveRetention = records;
  });
}

async function retainedLiveRecord(
  page: Page,
  exchanges: LiveProviderExchange[],
): Promise<LiveRetentionEvidence | null> {
  return page.evaluate((providerExchanges) => {
    type RetentionWindow = Window & {
      __tryhandLiveRetention?: { node: Text; source: string }[];
    };
    const entries = (html: string) => {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const anchors = [...parsed.querySelectorAll("a[i]")];
      return anchors.length
        ? anchors.map((anchor) => anchor.textContent?.trim() ?? "")
        : [parsed.querySelector("pre")?.textContent?.trim() ?? ""];
    };
    const records = (window as RetentionWindow).__tryhandLiveRetention ?? [];
    for (const [sourceCandidateIndex, { node, source }] of records.entries()) {
      const normalizedSource = source.trim();
      if (
        !node.isConnected ||
        !node.data.trim() ||
        node.data.trim() === normalizedSource
      )
        continue;
      for (const [
        exchangeIndex,
        { requests, results },
      ] of providerExchanges.entries()) {
        for (const [requestIndex, requestHtml] of requests.entries()) {
          const sourceEntries = entries(requestHtml);
          const sourceRecordIndex = sourceEntries.indexOf(normalizedSource);
          if (sourceRecordIndex < 0) continue;
          const returned = entries(results[requestIndex] ?? "")[
            sourceRecordIndex
          ];
          if (!returned || node.data.trim() !== returned) continue;
          return {
            exchangeIndex,
            finalLength: node.data.trim().length,
            requestIndex,
            resultLength: returned.length,
            sourceCandidateIndex,
            sourceLength: normalizedSource.length,
            sourceRecordIndex,
            successfulExchangeCount: providerExchanges.length,
          };
        }
      }
    }
    return null;
  }, exchanges);
}

async function expectLiveRecordRestored(
  page: Page,
  evidence: LiveRetentionEvidence,
) {
  expect(
    await page.evaluate((sourceCandidateIndex) => {
      type RetentionWindow = Window & {
        __tryhandLiveRetention?: { node: Text; source: string }[];
      };
      const record = (window as RetentionWindow).__tryhandLiveRetention?.[
        sourceCandidateIndex
      ];
      return Boolean(
        record && record.node.isConnected && record.node.data === record.source,
      );
    }, evidence.sourceCandidateIndex),
  ).toBe(true);
}

async function expectBounded(
  page: Page,
  probe: string,
  mode: "single-line" | "multi-line",
) {
  const wrapper = page
    .locator(`[data-layout-probe="${probe}"] tryhand-ellipsis.tryhand-ellipsis`)
    .first();
  await expect(wrapper).toHaveAttribute("data-tryhand-layout", mode);
  await expect(wrapper).toContainText("Bản dịch tiếng Việt dài");
  const overflow = await wrapper.evaluate(
    (element) =>
      element.scrollWidth > element.clientWidth ||
      element.scrollHeight > element.clientHeight,
  );
  const title = await wrapper.getAttribute("title");
  expect(Boolean(title)).toBe(overflow);
  if (overflow) expect(title).toBe(await wrapper.textContent());
}

type OpenAIBenchmarkCorpus = "ui-labels" | "article" | "table-300";
type OpenAIBenchmarkTarget = "en" | "vi" | "ja";
type EffectiveServiceTier = "default" | "priority" | "flex" | "unknown";
type OpenAIBenchmarkVariant = "baseline-keyed-c2";

interface SafeRateLimitSummary {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
}

interface OpenAILatencySample {
  variant: OpenAIBenchmarkVariant;
  corpus: OpenAIBenchmarkCorpus;
  targetLanguage: OpenAIBenchmarkTarget;
  cold: boolean;
  firstCommitMs: number;
  completeMs: number;
  maxViewportCommitMs: number;
  requestCount: number;
  queueMs: number;
  requestMs: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  sourceCharacters: number;
  acceptedSourceCharacters: number;
  accepted: number;
  rejected: number;
  effectiveServiceTier: EffectiveServiceTier;
  rateLimitSummary: SafeRateLimitSummary;
  maxActiveRequests?: number;
  providerFailures?: number;
  estimatedCostUsd: number;
}

interface OpenAIResponseAggregate {
  requestedServiceTier: string;
  effectiveServiceTier: EffectiveServiceTier;
  rateLimitSummary: SafeRateLimitSummary;
  statusCode: number;
}

const OPENAI_NANO_PRICES_PER_MILLION = {
  input: 0.05,
  cachedInput: 0.005,
  output: 0.4,
} as const;
const OPENAI_MAX_INPUT_TOKENS_PER_REQUEST = 400_000;
const OPENAI_MAX_OUTPUT_TOKENS_PER_REQUEST = 128_000;
// The fixed baseline fixture packs into at most three provider requests per run.
const OPENAI_MAX_REQUESTS_PER_FIXED_RUN = 3;

function safeCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function safeDuration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function safeHeaderCount(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function rateLimitSummary(headers: Record<string, string>) {
  return {
    ...optionalCount(
      "limitRequests",
      safeHeaderCount(headers["x-ratelimit-limit-requests"]),
    ),
    ...optionalCount(
      "remainingRequests",
      safeHeaderCount(headers["x-ratelimit-remaining-requests"]),
    ),
    ...optionalCount(
      "limitTokens",
      safeHeaderCount(headers["x-ratelimit-limit-tokens"]),
    ),
    ...optionalCount(
      "remainingTokens",
      safeHeaderCount(headers["x-ratelimit-remaining-tokens"]),
    ),
  } satisfies SafeRateLimitSummary;
}

function optionalCount<Key extends keyof SafeRateLimitSummary>(
  key: Key,
  value: number | undefined,
) {
  return value === undefined
    ? {}
    : ({ [key]: value } as Pick<SafeRateLimitSummary, Key>);
}

function mergeRateLimits(exchanges: OpenAIResponseAggregate[]) {
  const values = (key: keyof SafeRateLimitSummary) =>
    exchanges.flatMap(({ rateLimitSummary: summary }) => {
      const value = summary[key];
      return value === undefined ? [] : [value];
    });
  return Object.fromEntries(
    (
      [
        "limitRequests",
        "remainingRequests",
        "limitTokens",
        "remainingTokens",
      ] as const
    ).flatMap((key) => {
      const counts = values(key);
      return counts.length ? [[key, Math.min(...counts)]] : [];
    }),
  ) as SafeRateLimitSummary;
}

function effectiveTier(exchanges: OpenAIResponseAggregate[]) {
  const tiers = new Set(
    exchanges.map((exchange) => exchange.effectiveServiceTier),
  );
  return tiers.size === 1 ? [...tiers][0]! : "unknown";
}

function estimatedOpenAICost(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
) {
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInputTokens * OPENAI_NANO_PRICES_PER_MILLION.input +
      cachedInputTokens * OPENAI_NANO_PRICES_PER_MILLION.cachedInput +
      outputTokens * OPENAI_NANO_PRICES_PER_MILLION.output) /
    1_000_000
  );
}

const OPENAI_WORST_CASE_FIXED_RUN_USD =
  OPENAI_MAX_REQUESTS_PER_FIXED_RUN *
  estimatedOpenAICost(
    OPENAI_MAX_INPUT_TOKENS_PER_REQUEST,
    0,
    OPENAI_MAX_OUTPUT_TOKENS_PER_REQUEST,
  );

function hasOpenAIBenchmarkHeadroom(spendUsd: number, budgetUsd: number) {
  return (
    Number.isFinite(spendUsd) &&
    Number.isFinite(budgetUsd) &&
    spendUsd >= 0 &&
    spendUsd + OPENAI_WORST_CASE_FIXED_RUN_USD < budgetUsd
  );
}

function parseOpenAIBenchmarkSpendLedger(ledger: string) {
  const upperBoundLines = ledger
    .split(/\r?\n/)
    .filter((line) =>
      /Conservative all-live-work upper bound after/i.test(line),
    );
  if (!upperBoundLines.length) {
    if (
      /## (?:Original authenticated baseline|Authenticated baseline screening)|- Observed estimated spend in (?:this refresh|this baseline run): US\$/i.test(
        ledger,
      )
    )
      throw new Error("insufficient evidence");
    return 0;
  }
  const amounts = upperBoundLines.map((line) => {
    const match = line.match(
      /Conservative all-live-work upper bound after[^:\r\n]*:\s*US\$([^\s]+)\s*$/i,
    );
    const raw = match?.[1]?.replace(/\.$/, "");
    if (!raw) throw new Error("insufficient evidence");
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw))
      throw new Error("insufficient evidence");
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("insufficient evidence");
    return amount;
  });
  const latest = amounts.at(-1)!;
  if (latest < Math.max(...amounts)) throw new Error("insufficient evidence");
  return latest;
}

async function readOpenAIBenchmarkSpendLedger() {
  try {
    return parseOpenAIBenchmarkSpendLedger(
      await readFile(openAiLatencyReportPath, "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new Error("insufficient evidence", { cause: error });
  }
}

function resolveOpenAIBenchmarkPriorSpend(
  persistedSpendUsd: number,
  configuredSpend: string | undefined,
) {
  if (configuredSpend === undefined) return persistedSpendUsd;
  const configuredSpendUsd = Number(configuredSpend);
  if (!Number.isFinite(configuredSpendUsd) || configuredSpendUsd < 0)
    throw new Error("insufficient evidence");
  return Math.max(persistedSpendUsd, configuredSpendUsd);
}

function openAIBenchmarkUpperBound(
  priorSpendUsd: number,
  observedSpendUsd: number,
  conservativeReserveUsd: number,
) {
  return priorSpendUsd + observedSpendUsd + conservativeReserveUsd;
}

async function dispatchOpenAIBenchmarkRequest<T>(
  blockBeforeDispatch: boolean,
  abort: () => Promise<unknown>,
  dispatch: () => Promise<T>,
) {
  if (blockBeforeDispatch) {
    await abort();
    return {
      blocked: true as const,
      conservativeReserveUsd: OPENAI_WORST_CASE_FIXED_RUN_USD,
    };
  }
  return {
    blocked: false as const,
    conservativeReserveUsd: 0,
    response: await dispatch(),
  };
}

function requiredOpenAIBillingUsage(summary: Record<string, unknown>) {
  const inputTokens = summary.inputTokens;
  const cachedInputTokens = summary.cachedInputTokens;
  const outputTokens = summary.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    Number(inputTokens) < 0 ||
    !Number.isSafeInteger(cachedInputTokens) ||
    Number(cachedInputTokens) < 0 ||
    Number(cachedInputTokens) > Number(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    Number(outputTokens) < 0
  )
    throw new Error("insufficient evidence");
  return {
    inputTokens: Number(inputTokens),
    cachedInputTokens: Number(cachedInputTokens),
    outputTokens: Number(outputTokens),
  };
}

async function readTranslationRuns(worker: Worker) {
  const stored = await readExtensionDatabase(worker, [
    "translation-diagnostics:v2",
  ]);
  const raw = stored["translation-diagnostics:v2"];
  if (typeof raw !== "string") return [];
  const parsed = JSON.parse(raw) as { runs?: unknown };
  return Array.isArray(parsed.runs)
    ? (parsed.runs as Record<string, unknown>[])
    : [];
}

async function prepareOpenAICorpus(
  page: Page,
  corpus: OpenAIBenchmarkCorpus,
  includedIds?: string[],
) {
  await page.setViewportSize({
    width: 1440,
    height:
      corpus === "table-300" ? 12_000 : corpus === "article" ? 5_000 : 1_200,
  });
  return page.evaluate(
    ({ selectedCorpus, selectedIds }) => {
      type BenchmarkWindow = Window & {
        __tryhandOpenAiBenchmarkSources?: Record<string, string>;
      };
      for (const section of document.querySelectorAll<HTMLElement>(
        "[data-openai-corpus]",
      )) {
        if (section.dataset.openaiCorpus === selectedCorpus)
          section.removeAttribute("contenteditable");
        else section.setAttribute("contenteditable", "true");
      }
      const allow = selectedIds ? new Set(selectedIds) : undefined;
      const records = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-openai-corpus='${selectedCorpus}'] [data-benchmark-record]`,
        ),
      ];
      for (const record of records)
        if (allow && !allow.has(record.id))
          record.setAttribute("contenteditable", "true");
      const active = records.filter((record) => !allow || allow.has(record.id));
      const sources = Object.fromEntries(
        active.map((record) => [record.id, record.textContent?.trim() ?? ""]),
      );
      (window as BenchmarkWindow).__tryhandOpenAiBenchmarkSources = sources;
      return {
        records: active.length,
        sourceCharacters: Object.values(sources).reduce(
          (total, source) => total + source.length,
          0,
        ),
      };
    },
    { selectedCorpus: corpus, selectedIds: includedIds },
  );
}

async function acceptedBenchmarkSummary(page: Page) {
  return page.evaluate(() => {
    type BenchmarkWindow = Window & {
      __tryhandOpenAiBenchmarkSources?: Record<string, string>;
    };
    const sources =
      (window as BenchmarkWindow).__tryhandOpenAiBenchmarkSources ?? {};
    const acceptedIds = Object.keys(sources).filter((id) => {
      const current = document.getElementById(id)?.textContent?.trim() ?? "";
      return Boolean(current && current !== sources[id]);
    });
    return {
      acceptedIds,
      acceptedSourceCharacters: acceptedIds.reduce(
        (total, id) => total + (sources[id]?.length ?? 0),
        0,
      ),
    };
  });
}

function formatRateLimits(summary: SafeRateLimitSummary) {
  const entries = Object.entries(summary);
  return entries.length
    ? entries.map(([key, value]) => `${key}=${value}`).join(", ")
    : "unavailable";
}

function replaceMarkdownSection(
  current: string,
  heading: string,
  section: string,
) {
  const start = current.indexOf(heading);
  const next =
    start < 0 ? -1 : current.indexOf("\n## ", start + heading.length);
  const retained =
    start < 0
      ? current.trimEnd()
      : `${current.slice(0, start).trimEnd()}${next < 0 ? "" : `\n${current.slice(next + 1).trimStart()}`}`;
  return `${retained}\n\n${section}`;
}

function mergeOpenAIBaselineReport(
  current: string,
  baseline: string,
  refresh: string,
) {
  return current.includes("\n## Final decision")
    ? replaceMarkdownSection(
        current,
        "## Verify Gate baseline refresh",
        refresh,
      )
    : baseline;
}

async function writeOpenAIBaselineReport(
  samples: OpenAILatencySample[],
  warm: OpenAILatencySample | undefined,
  budgetUsd: number,
  priorSpendUsd: number,
  conservativeReserveUsd: number,
  blocker?:
    "credential unavailable" | "insufficient evidence" | "provider unavailable",
) {
  let cumulative = priorSpendUsd;
  const rows = samples.map((sample, index) => {
    cumulative += sample.estimatedCostUsd;
    return `| ${index + 1} | ${sample.corpus} | ${sample.targetLanguage} | ${sample.firstCommitMs.toFixed(0)} | ${sample.completeMs.toFixed(0)} | ${sample.maxViewportCommitMs.toFixed(0)} | ${sample.queueMs.toFixed(0)} | ${sample.requestMs.toFixed(0)} | ${sample.requestCount} | ${sample.sourceCharacters} | ${sample.accepted} | ${sample.rejected} | ${sample.inputTokens} | ${sample.cachedInputTokens} | ${sample.outputTokens} | ${sample.reasoningTokens} | ${sample.effectiveServiceTier} | ${formatRateLimits(sample.rateLimitSummary)} | ${sample.estimatedCostUsd.toFixed(6)} | ${cumulative.toFixed(6)} |`;
  });
  const status =
    blocker ??
    (samples.length === 27 && warm?.requestCount === 0
      ? "BASELINE COMPLETE"
      : "insufficient evidence");
  const observedSpendUsd = cumulative - priorSpendUsd;
  cumulative = openAIBenchmarkUpperBound(
    priorSpendUsd,
    observedSpendUsd,
    conservativeReserveUsd,
  );
  const refreshHeading = "## Verify Gate baseline refresh";
  const refresh = `${refreshHeading}

**Status:** ${status}
**Variant:** \`baseline-keyed-c2\` — \`gpt-5-nano\`, reasoning \`minimal\`, requested Standard/default processing, strict keyed map, global concurrency 2, \`maxRetries: 0\`

- Prior conservative all-live-work upper bound: US$${priorSpendUsd.toFixed(7)}.
- Observed estimated spend in this refresh: US$${observedSpendUsd.toFixed(7)}.
- Unpriced provider-call reserve: US$${conservativeReserveUsd.toFixed(7)}.
- Conservative all-live-work upper bound after this refresh: US$${cumulative.toFixed(7)}.
- Hard benchmark cap: US$${budgetUsd.toFixed(2)}.
- Worst-case next fixed-fixture run: US$${OPENAI_WORST_CASE_FIXED_RUN_USD.toFixed(7)} (at most ${OPENAI_MAX_REQUESTS_PER_FIXED_RUN} requests, using the published 400,000-token context and 128,000-token maximum output limits per request).
- Each execution starts from the latest validated conservative upper bound in this ledger; OPENAI_BENCHMARK_PRIOR_SPEND_USD may only increase it. Warm replay aborts any provider attempt before dispatch and reserves the full fixed-fixture ceiling.

| # | Corpus | Target | First commit ms | Complete ms | Max viewport commit ms | Queue ms | Request ms | Requests | Source chars | Accepted | Rejected | Input | Cached input | Output | Reasoning | Effective tier | Numeric rate-limit evidence | Run cost US$ | Cumulative upper bound US$ |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
${rows.join("\n") || "| — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | unavailable | — | — |"}

Warm replay: ${warm ? `${warm.requestCount} provider calls and ${warm.completeMs.toFixed(0)} ms completion` : "not completed"}.

- The refresh contains ${samples.length}/27 cold samples. It records current provider variance and is not compared with the earlier baseline's acceptance totals.
- P95 remains unclaimed because there is no eligible finalist and no alternating 20-sample final comparison.
- Only aggregate allowlisted evidence is recorded; credential values, authorization, source text, page identity, request payloads, raw responses, and non-allowlisted headers remain excluded.
`;
  const report = `# OpenAI first-visible and viewport-completion latency — evidence ledger

**Date:** 2026-08-27
**Status:** ${status}
**Variant:** \`baseline-keyed-c2\` — \`gpt-5-nano\`, reasoning \`minimal\`, requested Standard/default processing, strict keyed map, global concurrency 2, \`maxRetries: 0\`

## Price and budget contract

Official OpenAI \`gpt-5-nano\` prices checked on 2026-08-27: US$0.05/M uncached input tokens, US$0.005/M cached input tokens, and US$0.40/M output tokens. Reasoning tokens are reported separately but are already included in output tokens, so they are not billed twice in this ledger.

- Hard benchmark cap: US$${budgetUsd.toFixed(2)} (clamped to at most US$1.00).
- Prior conservative all-live-work upper bound: US$${priorSpendUsd.toFixed(7)}.
- Observed estimated spend in this baseline run: US$${observedSpendUsd.toFixed(7)}.
- Unpriced provider-call reserve: US$${conservativeReserveUsd.toFixed(7)}.
- Conservative all-live-work upper bound after this run: US$${cumulative.toFixed(7)}.
- Before every cold run, prior actual/conservative spend plus the US$${OPENAI_WORST_CASE_FIXED_RUN_USD.toFixed(7)} worst-case fixed-fixture ceiling must remain below the cap. The harness allows at most ${OPENAI_MAX_REQUESTS_PER_FIXED_RUN} provider requests per run and fails closed when billed input/cached-input/output usage is unavailable or invalid.
- Each execution starts from the latest validated conservative upper bound in this ledger; OPENAI_BENCHMARK_PRIOR_SPEND_USD may only increase it. Warm replay aborts any provider attempt before dispatch and reserves the full fixed-fixture ceiling.

## Authenticated baseline screening

| # | Corpus | Target | First commit ms | Complete ms | Max viewport commit ms | Queue ms | Request ms | Requests | Source chars | Accepted | Rejected | Input | Cached input | Output | Reasoning | Effective tier | Numeric rate-limit evidence | Run cost US$ | Cumulative US$ |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
${rows.join("\n") || "| — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | unavailable | — | — |"}

## Warm cache proof

${warm ? `One accepted-record warm replay recorded ${warm.requestCount} provider calls and ${warm.completeMs.toFixed(0)} ms completion.` : "Not completed."}

## Evidence boundaries

- Screening requires exactly three cold repetitions for every UI-label/article/300-row-table and en/vi/ja combination. This report contains ${samples.length}/27 samples.
- P95 is not claimed from three-run screening. It belongs to the later alternating 20-sample baseline-versus-finalist gate.
- Only aggregate timings, counts, token categories, effective tier, and a numeric rate-limit allowlist are recorded. Credential values, authorization, source text, page identity, request payloads, raw responses, and non-allowlisted headers are excluded.
- The synthetic fixture is site-agnostic. Bounded local Office Sheets Man observation remains a separate final-promotion proof; no Office data was created by this baseline run.
`;
  const current = await readFile(openAiLatencyReportPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const output = mergeOpenAIBaselineReport(current, report, refresh);
  await mkdir(path.dirname(openAiLatencyReportPath), { recursive: true });
  await writeFile(openAiLatencyReportPath, output);
}

test("@openai-benchmark-harness stop gate reserves a worst-case run and requires billing usage", () => {
  expect(
    hasOpenAIBenchmarkHeadroom(1 - OPENAI_WORST_CASE_FIXED_RUN_USD, 1),
  ).toBe(false);
  expect(() =>
    requiredOpenAIBillingUsage({ inputTokens: 1, cachedInputTokens: 0 }),
  ).toThrow("insufficient evidence");
});

test("@openai-benchmark-harness successive runs start from the persisted upper bound", () => {
  const ledger = (amount: string) => `# evidence ledger

## Authenticated baseline screening

- Conservative all-live-work upper bound after this refresh: US$${amount}.`;
  const firstSpend = parseOpenAIBenchmarkSpendLedger(ledger("0.3178480"));
  const nextUpperBound = openAIBenchmarkUpperBound(firstSpend, 0.01, 0);

  expect(
    parseOpenAIBenchmarkSpendLedger(ledger(nextUpperBound.toFixed(7))),
  ).toBeCloseTo(0.327848);
});

test("@openai-benchmark-harness configured prior spend cannot lower the ledger", () => {
  expect(resolveOpenAIBenchmarkPriorSpend(0.317848, "0.1")).toBe(0.317848);
  expect(resolveOpenAIBenchmarkPriorSpend(0.317848, "0.4")).toBe(0.4);
});

test("@openai-benchmark-harness malformed authenticated ledger blocks", () => {
  expect(() =>
    parseOpenAIBenchmarkSpendLedger(`# evidence ledger

## Authenticated baseline screening

- Conservative all-live-work upper bound after this refresh: US$unknown.`),
  ).toThrow("insufficient evidence");
  expect(() =>
    parseOpenAIBenchmarkSpendLedger(`# evidence ledger

## Authenticated baseline screening

- Conservative all-live-work upper bound after this run: US$0.3178480.
- Conservative all-live-work upper bound after this refresh is unknown.`),
  ).toThrow("insufficient evidence");
  expect(parseOpenAIBenchmarkSpendLedger("")).toBe(0);
});

test("@openai-benchmark-harness warm replay blocks before dispatch and reserves fail closed", async () => {
  let aborted = false;
  let dispatched = false;
  const result = await dispatchOpenAIBenchmarkRequest(
    true,
    async () => {
      aborted = true;
    },
    async () => {
      dispatched = true;
      return "paid response";
    },
  );

  expect(aborted).toBe(true);
  expect(dispatched).toBe(false);
  expect(result.blocked).toBe(true);
  expect(
    openAIBenchmarkUpperBound(0.317848, 0, result.conservativeReserveUsd),
  ).toBeCloseTo(0.531448);
});

test("@openai-benchmark-harness baseline refresh preserves the final ledger", () => {
  const finalLedger = `# ledger

## Candidate decision

rejected

## Office observation

valid

## Final decision

NO CHANGE — NO ELIGIBLE FINALIST`;
  const first = mergeOpenAIBaselineReport(
    finalLedger,
    "initial baseline",
    "## Verify Gate baseline refresh\n\nfirst",
  );
  const second = mergeOpenAIBaselineReport(
    first,
    "initial baseline",
    "## Verify Gate baseline refresh\n\nsecond",
  );

  expect(second).toContain("## Candidate decision\n\nrejected");
  expect(second).toContain("## Office observation\n\nvalid");
  expect(second).toContain("NO CHANGE — NO ELIGIBLE FINALIST");
  expect(second).not.toContain("\n\nfirst");
  expect(second.match(/## Verify Gate baseline refresh/g)).toHaveLength(1);
  expect(
    mergeOpenAIBaselineReport(
      "# unfinished baseline",
      "# fresh baseline",
      "## Verify Gate baseline refresh\n\nunused",
    ),
  ).toBe("# fresh baseline");
});

test("@stable-auth-identity copied unpacked builds keep the pinned identity and clean state", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "tryhand-stable-identity-"),
  );
  const pinnedCopyPaths = [
    path.join(temporaryRoot, "copy-a"),
    path.join(temporaryRoot, "copy-b"),
  ];
  const siblingCopyPath = path.join(temporaryRoot, "sibling-copy");
  const sessions: ExtensionSession[] = [];
  const pinnedSessions: ExtensionSession[] = [];
  const fixture = await startFixtureServer();

  try {
    await Promise.all(
      pinnedCopyPaths.map((copyPath) =>
        cp(extensionPath, copyPath, { recursive: true }),
      ),
    );
    await cp(extensionPath, siblingCopyPath, { recursive: true });
    const siblingManifestPath = path.join(siblingCopyPath, "manifest.json");
    const siblingManifest = JSON.parse(
      await readFile(siblingManifestPath, "utf8"),
    ) as Record<string, unknown>;
    delete siblingManifest.key;
    await writeFile(
      siblingManifestPath,
      `${JSON.stringify(siblingManifest, null, 2)}\n`,
    );
    for (const copyPath of pinnedCopyPaths) {
      const session = await launchExtension(fixture.url, undefined, {
        headless: false,
        unpackedExtensionPath: copyPath,
      });
      pinnedSessions.push(session);
      sessions.push(session);
    }

    expect(pinnedSessions.map(({ extensionId }) => extensionId)).toEqual([
      stableExtensionId,
      stableExtensionId,
    ]);
    expect(
      pinnedSessions.map(({ worker }) => new URL(worker.url()).host),
    ).toEqual([stableExtensionId, stableExtensionId]);
    expect(
      await Promise.all(
        pinnedSessions.map(({ worker }) => readExtensionDatabase(worker)),
      ),
    ).toEqual([{}, {}]);
    expect(pinnedSessions[0]?.userDataDir).not.toBe(
      pinnedSessions[1]?.userDataDir,
    );

    const siblingSession = await launchExtension(fixture.url, undefined, {
      headless: false,
      unpackedExtensionPath: siblingCopyPath,
    });
    sessions.push(siblingSession);
    expect(siblingSession.extensionId).not.toBe(stableExtensionId);
    expect(new URL(siblingSession.worker.url()).host).toBe(
      siblingSession.extensionId,
    );
    const siblingExtensionPage = await siblingSession.context.newPage();
    await siblingExtensionPage.goto(
      `chrome-extension://${siblingSession.extensionId}/popup.html`,
    );
    expect(
      await siblingExtensionPage.evaluate(() =>
        (
          globalThis as unknown as {
            chrome: {
              runtime: {
                sendMessage: (message: unknown) => Promise<unknown>;
              };
            };
          }
        ).chrome.runtime.sendMessage({ type: "AUTH_STATUS" }),
      ),
    ).toMatchObject({ authenticated: true, engineSource: "on-device" });
  } finally {
    for (const session of sessions) await session.close();
    await fixture.close();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test.describe("extension layout stability", () => {
  test.describe.configure({
    timeout:
      process.env.RUN_LIVE_OPENAI_BENCHMARK === "1"
        ? 1_800_000
        : process.env.RUN_NATIVE_TRANSLATOR_PROBE === "1"
          ? 420_000
          : 30_000,
  });
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let extension: ExtensionSession;
  let pageErrors: string[];
  let authTimings: { operation: string; requestMs: number }[] = [];

  test.beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  test.beforeEach(async () => {
    authTimings = [];
    extension = await launchExtension(fixture.url);
    extension.context.on("requestfinished", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (!["/v1/me", "/v1/auth/refresh", "/v1/auth/login"].includes(pathname))
        return;
      const requestMs = request.timing().responseEnd;
      if (requestMs >= 0) authTimings.push({ operation: pathname, requestMs });
    });
    await setExtensionDatabase(extension.worker, {
      "auth:v1:refresh-token": "deterministic-refresh-token",
    });
    if (process.env.RUN_NATIVE_TRANSLATOR_PROBE !== "1")
      await extension.worker.evaluate(() => {
        // Deterministic suites must never trigger a browser-managed model download.
        (globalThis as unknown as { Translator?: unknown }).Translator =
          undefined;
      });
    pageErrors = [];
  });

  test.afterEach(async ({ browserName }, testInfo) => {
    await testInfo.attach("auth-request-timing-redacted.json", {
      body: JSON.stringify({
        browserName,
        requests: authTimings,
        totalRequestMs: authTimings.reduce(
          (sum, request) => sum + request.requestMs,
          0,
        ),
      }),
      contentType: "application/json",
    });
    await extension?.close();
  });

  test("@indexeddb-storage persists preferences and the user's provider settings, and Clear isolates settings", async () => {
    // ADR 0020: nothing but a refresh token left by older builds (ignored).
    expect(
      Object.keys(await readExtensionDatabase(extension.worker)).filter(
        (key) => key !== "auth:v1:refresh-token",
      ),
    ).toEqual([]);

    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    await page.goto(fixture.url);
    const popup = await openPopupForTab(extension, page);
    // The provider lives in Settings (ADR 0020), never as a per-run choice.
    await expect(popup.getByRole("combobox", { name: "Provider" })).toHaveCount(
      0,
    );
    await popup.getByRole("combobox", { name: "Translate to" }).click();
    await popup.getByRole("option", { name: "Vietnamese" }).click();
    await popup.getByRole("button", { name: "Translate" }).click();
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(async () => (await readTranslationRuns(extension.worker)).length)
      .toBeGreaterThan(0);

    const preferenceKey = "alwaysTranslate:127.0.0.1";
    const beforeRestart = await readExtensionDatabase(extension.worker);
    expect(beforeRestart).toMatchObject({
      [preferenceKey]: { enabled: false, targetLanguage: "vi" },
    });
    expect(beforeRestart.translationProvider).toBeUndefined();
    // ADR 0020: the user's key is the only provider credential, saved by the
    // Settings page in extension-origin IndexedDB.
    expect(beforeRestart.providerSettings).toMatchObject({
      version: 1,
      activeProvider: "openai",
      providers: { openai: { model: "gpt-5-nano" } },
    });
    expect(
      Object.keys(beforeRestart).some((key) =>
        key.startsWith("translationCache:openai:v10:"),
      ),
    ).toBe(true);
    expect(typeof beforeRestart["translation-diagnostics:v2"]).toBe("string");

    popup.once("dialog", (dialog) => dialog.accept());
    // Clear saved translations lives in the popup's header menu.
    await popup.getByRole("button", { name: "Menu" }).click();
    await popup
      .getByRole("button", { name: "Clear saved translations" })
      .click();
    await expect(popup.getByText("Saved translations cleared.")).toBeVisible();

    const afterClear = await readExtensionDatabase(extension.worker);
    expect(afterClear).toMatchObject({
      [preferenceKey]: { enabled: false, targetLanguage: "vi" },
    });
    expect(
      Object.keys(afterClear).some((key) =>
        key.startsWith("translationCache:"),
      ),
    ).toBe(false);
    expect(afterClear["translation-diagnostics:v2"]).toBeUndefined();
    // Clearing saved translations keeps the provider settings.
    expect(afterClear.providerSettings).toEqual(beforeRestart.providerSettings);
    await popup.close();

    const userDataDir = extension.userDataDir;
    await extension.close(false);
    extension = await launchExtension(fixture.url, userDataDir);
    expect(extension.extensionId).toBe(stableExtensionId);
    const restartedState = await readExtensionDatabase(extension.worker);
    expect(restartedState).toMatchObject({
      [preferenceKey]: { enabled: false, targetLanguage: "vi" },
    });
    expect(
      Object.keys(restartedState).some((key) =>
        key.startsWith("translationCache:"),
      ),
    ).toBe(false);
    expect(restartedState["translation-diagnostics:v2"]).toBeUndefined();
    expect(restartedState.providerSettings).toEqual(
      beforeRestart.providerSettings,
    );
  });

  test("@deterministic page opt-outs do not block readable text, attributes or title", async () => {
    const requests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      openAiEntries: (sources) =>
        Object.fromEntries(
          Object.keys(sources).map((id) => [id, "Translated readable text"]),
        ),
      observeRequest: (request) => requests.push(request),
    });
    const url = `${fixture.url}?opt-out-override`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="ja" translate="no"><head><title class="notranslate" translate="no">禁止された題名</title><meta name="google" content="notranslate"></head><body class="notranslate"><p translate="no">禁止された本文</p><input placeholder="禁止された説明" value="入力中の値"><div contenteditable="true">編集者の秘密</div><code>保護されたコード</code></body></html>',
      }),
    );
    const page = await extension.context.newPage();
    await page.goto(url);
    const original = await page.locator("body").innerHTML();
    await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await waitForState(extension.worker, url, "translated");
    await expect(page.locator("p")).toHaveText("Translated readable text");
    await expect(page.locator("input")).toHaveAttribute(
      "placeholder",
      "Translated readable text",
    );
    await expect(page).toHaveTitle("Translated readable text");
    await expect(page.locator("input")).toHaveValue("入力中の値");
    await expect(page.locator('[contenteditable="true"]')).toHaveText(
      "編集者の秘密",
    );
    await expect(page.locator("code")).toHaveText("保護されたコード");
    const sent = requests.flatMap((request) => request.requests).join("\n");
    for (const protectedText of [
      "入力中の値",
      "編集者の秘密",
      "保護されたコード",
    ])
      expect(sent).not.toContain(protectedText);
    await sendTopFrameMessage(extension.worker, url, { type: "SHOW_ORIGINAL" });
    await expect(page.locator("body")).toHaveJSProperty("innerHTML", original);
    await expect(page).toHaveTitle("禁止された題名");
    expect(pageErrors).toEqual([]);
  });

  test("@provider-fallback-live records a bounded redacted authenticated OpenAI to Google attempt", async ({
    browserName,
  }, testInfo) => {
    test.setTimeout(180_000);
    const testEnvPath = path.resolve(".env.test");
    const optedIn = process.env.RUN_LIVE_PROVIDER_FALLBACK === "1";
    if (
      optedIn &&
      (await access(testEnvPath)
        .then(() => true)
        .catch(() => false))
    ) {
      loadEnvFile(testEnvPath);
    }
    const backendOrigin = process.env.WXT_BACKEND_URL;
    const refreshToken = process.env.LIVE_TEST_BACKEND_REFRESH_TOKEN;
    const unavailable = !optedIn
      ? "Explicit live-provider opt-in unavailable."
      : !backendOrigin ||
          backendOrigin === "https://api.example.test" ||
          !refreshToken
        ? "Dedicated test backend origin and LIVE_TEST_BACKEND_REFRESH_TOKEN unavailable."
        : undefined;
    if (unavailable) {
      await testInfo.attach("provider-fallback-live-redacted.json", {
        body: JSON.stringify({
          status: "unavailable",
          reason: unavailable,
          providerRequests: 0,
        }),
        contentType: "application/json",
      });
      test.skip(true, unavailable);
    }
    const stageUrl = `${new URL(backendOrigin!).origin}/v1/translation-stages`;
    await setExtensionDatabase(extension.worker, {
      "auth:v1:refresh-token": refreshToken!,
    });
    await extension.worker.evaluate(async () => {
      const extensionBrowser = (
        globalThis as unknown as {
          browser: { tabs: { detectLanguage: () => Promise<string> } };
        }
      ).browser;
      extensionBrowser.tabs.detectLanguage = async () => "ja";
    });
    // The backend routes engines (ADR 0014): the client observes one stage
    // route and learns the engines only from per-record provenance and the
    // stage's engine-cost diagnostics. No source or result text is recorded.
    const evidence = {
      browserName,
      corpus: { records: 3, sourceLengths: [3, 12, 10] },
      stage: { requests: 0, statuses: [] as number[] },
      engines: {
        openAiRequests: 0,
        googleRequests: 0,
        googleBudgetExhausted: false,
        provenance: { openai: 0, google: 0, unresolved: 0 },
      },
      terminal: "unknown",
      diagnostics: {} as Record<string, unknown>,
    };
    const stageResponses: Promise<void>[] = [];
    extension.context.on("request", (request) => {
      if (request.url() === stageUrl) evidence.stage.requests += 1;
    });
    extension.context.on("response", (response) => {
      if (response.url() !== stageUrl) return;
      evidence.stage.statuses.push(response.status());
      stageResponses.push(
        response
          .json()
          .then((value: unknown) => {
            const body = value as {
              provenance?: (string | null)[][];
              diagnostics?: {
                openAiRequestCount?: number;
                googleRequestCount?: number;
                googleBudgetExhausted?: boolean;
              };
            };
            evidence.engines.openAiRequests +=
              body.diagnostics?.openAiRequestCount ?? 0;
            evidence.engines.googleRequests +=
              body.diagnostics?.googleRequestCount ?? 0;
            if (body.diagnostics?.googleBudgetExhausted)
              evidence.engines.googleBudgetExhausted = true;
            for (const engine of body.provenance?.flat() ?? [])
              if (engine === "openai" || engine === "google")
                evidence.engines.provenance[engine] += 1;
              else evidence.engines.provenance.unresolved += 1;
          })
          .catch(() => undefined),
      );
    });
    const url = `${fixture.url}?provider-fallback-live`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html lang='ja'><body><main><p>TBS</p><p>Yahoo! JAPAN</p><p>TRILL News</p></main></body></html>",
      }),
    );
    const page = await extension.context.newPage();
    try {
      await page.goto(url);
      const terminal = (await sendTopFrameMessage(extension.worker, url, {
        type: "START_TRANSLATION",
        targetLanguage: "en",
      })) as { state?: string };
      evidence.terminal = terminal.state ?? "unknown";
      const summary =
        (await readTranslationRuns(extension.worker)).at(-1) ?? {};
      evidence.diagnostics = Object.fromEntries(
        [
          "provider",
          "requestCount",
          "providerAccepted",
          "providerRejected",
          "googleFallbackAttempted",
          "googleFallbackAccepted",
          "nativeAttempted",
          "nativeAccepted",
        ].map((key) => [key, summary[key]]),
      );
      await Promise.all(stageResponses);
      expect(evidence.stage.requests).toBeGreaterThan(0);
      expect(evidence.stage.requests).toBeLessThanOrEqual(3);
      expect(evidence.engines.openAiRequests).toBeGreaterThan(0);
      expect(evidence.engines.openAiRequests).toBeLessThanOrEqual(
        3 * evidence.stage.requests,
      );
      if (!evidence.engines.googleBudgetExhausted)
        expect(evidence.engines.googleRequests).toBeGreaterThan(0);
      expect(evidence.engines.googleRequests).toBeLessThanOrEqual(
        evidence.stage.requests,
      );
    } finally {
      await testInfo.attach("provider-fallback-live-redacted.json", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      });
      await page.close();
    }
  });

  test("@openai-live-benchmark records the controlled keyed benchmark", async () => {
    test.skip(
      process.env.RUN_LIVE_OPENAI_BENCHMARK !== "1",
      "Set RUN_LIVE_OPENAI_BENCHMARK=1 to approve authenticated OpenAI benchmark usage.",
    );
    test.setTimeout(1_800_000);

    const samples: OpenAILatencySample[] = [];
    let warm: OpenAILatencySample | undefined;
    let blocker:
      | "credential unavailable"
      | "insufficient evidence"
      | "provider unavailable"
      | undefined;
    let controlPage: Page | undefined;
    let activeExchanges: OpenAIResponseAggregate[] | undefined;
    let activeProviderRequests = 0;
    let maxActiveProviderRequests = 0;
    let providerRequestsThisRun = 0;
    let requestCeilingExceeded: boolean;
    let conservativeReserveUsd = 0;
    let blockProviderDispatch = false;
    const configuredBudget = Number(
      process.env.OPENAI_BENCHMARK_BUDGET_USD ?? "1",
    );
    const priorSpendUsd = resolveOpenAIBenchmarkPriorSpend(
      await readOpenAIBenchmarkSpendLedger(),
      process.env.OPENAI_BENCHMARK_PRIOR_SPEND_USD,
    );
    const variant: OpenAIBenchmarkVariant = "baseline-keyed-c2";
    const requestedServiceTier = "default";
    const expectedEffectiveTier = "default";
    if (!Number.isFinite(configuredBudget) || configuredBudget <= 0)
      throw new Error("insufficient evidence");
    const budgetUsd = Math.min(configuredBudget, 1);
    let spendUsd = priorSpendUsd;
    let warmSeed:
      | {
          corpus: OpenAIBenchmarkCorpus;
          targetLanguage: OpenAIBenchmarkTarget;
          acceptedIds: string[];
        }
      | undefined;

    try {
      try {
        loadEnvFile(path.resolve(".env.test"));
      } catch {
        blocker = "credential unavailable";
        throw new Error("credential unavailable");
      }
      await extension.worker.evaluate(() => {
        const extensionBrowser = (
          globalThis as unknown as {
            browser: {
              tabs: { detectLanguage: () => Promise<string> };
            };
          }
        ).browser;
        extensionBrowser.tabs.detectLanguage = async () => "und";
      });

      await extension.context.route(openAiProviderUrl, async (route) => {
        const request = route.request().postDataJSON() as
          { service_tier?: unknown } | undefined;
        if (activeExchanges) {
          providerRequestsThisRun += 1;
          if (providerRequestsThisRun > OPENAI_MAX_REQUESTS_PER_FIXED_RUN) {
            requestCeilingExceeded = true;
            await route.abort("blockedbyclient");
            return;
          }
          conservativeReserveUsd = OPENAI_WORST_CASE_FIXED_RUN_USD;
        }
        const dispatched = await dispatchOpenAIBenchmarkRequest(
          blockProviderDispatch,
          () => route.abort("blockedbyclient"),
          async () => {
            activeProviderRequests += 1;
            maxActiveProviderRequests = Math.max(
              maxActiveProviderRequests,
              activeProviderRequests,
            );
            return route.fetch();
          },
        );
        if (dispatched.blocked) {
          conservativeReserveUsd = Math.max(
            conservativeReserveUsd,
            dispatched.conservativeReserveUsd,
          );
          blocker = "insufficient evidence";
          return;
        }
        try {
          const response = dispatched.response;
          let effectiveServiceTier: EffectiveServiceTier = "unknown";
          try {
            const responseBody = (await response.json()) as {
              service_tier?: unknown;
            };
            if (
              responseBody.service_tier === "default" ||
              responseBody.service_tier === "priority" ||
              responseBody.service_tier === "flex"
            )
              effectiveServiceTier = responseBody.service_tier;
          } catch {
            // The provider adapter owns response validation; the harness records no raw body.
          }
          activeExchanges?.push({
            requestedServiceTier:
              typeof request?.service_tier === "string"
                ? request.service_tier
                : "unknown",
            effectiveServiceTier,
            rateLimitSummary: rateLimitSummary(response.headers()),
            statusCode: response.status(),
          });
          await route.fulfill({ response });
        } finally {
          activeProviderRequests = Math.max(0, activeProviderRequests - 1);
        }
      });

      controlPage = await extension.context.newPage();
      await controlPage.goto(
        `chrome-extension://${extension.extensionId}/popup.html`,
      );

      const corpora: OpenAIBenchmarkCorpus[] = [
        "ui-labels",
        "article",
        "table-300",
      ];
      const targets: OpenAIBenchmarkTarget[] = ["en", "vi", "ja"];

      baseline: for (const corpus of corpora) {
        for (const targetLanguage of targets) {
          for (let repetition = 0; repetition < 3; repetition += 1) {
            await sendExtensionMessage(controlPage, {
              type: "CLEAR_SAVED_TRANSLATIONS",
            });
            const page = await extension.context.newPage();
            try {
              await page.goto(fixture.openAiLatencyUrl);
              await prepareOpenAICorpus(page, corpus);
              if (!hasOpenAIBenchmarkHeadroom(spendUsd, budgetUsd)) {
                blocker = "insufficient evidence";
                break baseline;
              }

              const previousRuns = (await readTranslationRuns(extension.worker))
                .length;
              const exchanges: OpenAIResponseAggregate[] = [];
              activeExchanges = exchanges;
              maxActiveProviderRequests = 0;
              providerRequestsThisRun = 0;
              requestCeilingExceeded = false;
              conservativeReserveUsd = 0;
              const response = (await sendTopFrameMessage(
                extension.worker,
                fixture.openAiLatencyUrl,
                {
                  type: "START_TRANSLATION",
                  targetLanguage,
                },
              )) as { state?: unknown };
              if (
                response.state !== "translated" &&
                response.state !== "partial"
              )
                throw new Error("provider unavailable");
              await expect
                .poll(
                  async () =>
                    (await readTranslationRuns(extension.worker)).length,
                )
                .toBeGreaterThan(previousRuns);
              const summary = (await readTranslationRuns(extension.worker)).at(
                -1,
              )!;
              const requestCount = safeCount(summary.requestCount);
              if (
                requestCeilingExceeded ||
                requestCount !== exchanges.length ||
                exchanges.some(
                  ({ requestedServiceTier: actualTier }) =>
                    actualTier !== requestedServiceTier,
                ) ||
                (requestCount > 0 &&
                  effectiveTier(exchanges) !== expectedEffectiveTier)
              )
                throw new Error("provider unavailable");
              const { inputTokens, cachedInputTokens, outputTokens } =
                requiredOpenAIBillingUsage(summary);
              const estimatedCostUsd = estimatedOpenAICost(
                inputTokens,
                cachedInputTokens,
                outputTokens,
              );
              spendUsd += estimatedCostUsd;
              const acceptedSummary = await acceptedBenchmarkSummary(page);
              samples.push({
                variant,
                corpus,
                targetLanguage,
                cold: true,
                firstCommitMs: safeDuration(summary.firstCommitMs),
                completeMs: safeDuration(summary.completeMs),
                maxViewportCommitMs: safeDuration(summary.maxViewportCommitMs),
                requestCount,
                queueMs: safeDuration(summary.queueMs),
                requestMs: safeDuration(summary.requestMs),
                inputTokens,
                cachedInputTokens,
                outputTokens,
                reasoningTokens: safeCount(summary.reasoningTokens),
                sourceCharacters: safeCount(summary.sourceCharacters),
                acceptedSourceCharacters:
                  acceptedSummary.acceptedSourceCharacters,
                accepted: safeCount(summary.providerAccepted),
                rejected: safeCount(summary.providerRejected),
                effectiveServiceTier: effectiveTier(exchanges),
                rateLimitSummary: mergeRateLimits(exchanges),
                maxActiveRequests: maxActiveProviderRequests,
                providerFailures: exchanges.filter(
                  ({ statusCode }) => statusCode >= 400,
                ).length,
                estimatedCostUsd,
              });
              conservativeReserveUsd = 0;
              if (spendUsd >= budgetUsd) {
                blocker = "insufficient evidence";
                break baseline;
              }
              warmSeed = {
                corpus,
                targetLanguage,
                acceptedIds: acceptedSummary.acceptedIds,
              };
            } finally {
              activeExchanges = undefined;
              await page.close();
            }
          }
        }
      }

      if (!blocker && samples.length === 27 && warmSeed?.acceptedIds.length) {
        const page = await extension.context.newPage();
        try {
          await page.goto(fixture.openAiLatencyUrl);
          await prepareOpenAICorpus(
            page,
            warmSeed.corpus,
            warmSeed.acceptedIds,
          );
          const previousRuns = (await readTranslationRuns(extension.worker))
            .length;
          const exchanges: OpenAIResponseAggregate[] = [];
          activeExchanges = exchanges;
          maxActiveProviderRequests = 0;
          providerRequestsThisRun = 0;
          requestCeilingExceeded = false;
          conservativeReserveUsd = 0;
          blockProviderDispatch = true;
          const response = (await sendTopFrameMessage(
            extension.worker,
            fixture.openAiLatencyUrl,
            {
              type: "START_TRANSLATION",
              targetLanguage: warmSeed.targetLanguage,
            },
          )) as { state?: unknown };
          if (response.state !== "translated")
            throw new Error("provider unavailable");
          await expect
            .poll(
              async () => (await readTranslationRuns(extension.worker)).length,
            )
            .toBeGreaterThan(previousRuns);
          const summary = (await readTranslationRuns(extension.worker)).at(-1)!;
          warm = {
            variant,
            corpus: warmSeed.corpus,
            targetLanguage: warmSeed.targetLanguage,
            cold: false,
            firstCommitMs: safeDuration(summary.firstCommitMs),
            completeMs: safeDuration(summary.completeMs),
            maxViewportCommitMs: safeDuration(summary.maxViewportCommitMs),
            requestCount: safeCount(summary.requestCount),
            queueMs: safeDuration(summary.queueMs),
            requestMs: safeDuration(summary.requestMs),
            inputTokens: safeCount(summary.inputTokens),
            cachedInputTokens: safeCount(summary.cachedInputTokens),
            outputTokens: safeCount(summary.outputTokens),
            reasoningTokens: safeCount(summary.reasoningTokens),
            sourceCharacters: safeCount(summary.sourceCharacters),
            acceptedSourceCharacters: safeCount(summary.sourceCharacters),
            accepted: safeCount(summary.providerAccepted),
            rejected: safeCount(summary.providerRejected),
            effectiveServiceTier: "unknown",
            rateLimitSummary: {},
            maxActiveRequests: maxActiveProviderRequests,
            providerFailures: 0,
            estimatedCostUsd: 0,
          };
          if (
            requestCeilingExceeded ||
            warm.requestCount !== 0 ||
            exchanges.length !== 0
          )
            throw new Error("insufficient evidence");
        } finally {
          blockProviderDispatch = false;
          activeExchanges = undefined;
          await page.close();
        }
      }

      if (!blocker && (!warm || samples.length !== 27))
        blocker = "insufficient evidence";
      await writeOpenAIBaselineReport(
        samples,
        warm,
        budgetUsd,
        priorSpendUsd,
        conservativeReserveUsd,
        blocker,
      );
      if (blocker) throw new Error(blocker);
    } catch {
      blocker ??= samples.length
        ? "insufficient evidence"
        : "provider unavailable";
      await writeOpenAIBaselineReport(
        samples,
        warm,
        budgetUsd,
        priorSpendUsd,
        conservativeReserveUsd,
        blocker,
      );
      throw new Error(`OpenAI live ${variant} blocked: ${blocker}`);
    } finally {
      await controlPage?.close().catch(() => undefined);
    }
  });

  test("@native-capability trusted popup click prepares ja-to-en beyond popup lifetime and survives a warm profile restart", async ({
    browserName,
  }, testInfo) => {
    test.skip(
      process.env.RUN_NATIVE_TRANSLATOR_PROBE !== "1",
      "Set RUN_NATIVE_TRANSLATOR_PROBE=1 to approve the browser-managed model probe.",
    );
    test.setTimeout(420_000);

    interface NativeStatus {
      availability:
        "available" | "downloadable" | "downloading" | "unavailable";
      ready: boolean;
      progress: {
        phase: "checking" | "downloading" | "ready";
        loaded?: number;
        total?: number;
      };
    }
    const pair = { sourceLanguage: "ja", targetLanguage: "en" } as const;
    const evidence: {
      browserName: string;
      executable: string;
      providerCalls: number;
      phases: Record<string, { elapsedMs: number; status: NativeStatus }[]>;
      translations: Record<string, unknown>;
    } = {
      browserName,
      executable: executablePath(),
      providerCalls: 0,
      phases: {},
      translations: {},
    };
    const blockProviders = async (context: BrowserContext) => {
      await routeDeterministicProvider(context, undefined, {
        observeRequest: () => {
          evidence.providerCalls += 1;
        },
      });
      for (const url of [legacyTranslatePaUrl, openAiProviderUrl])
        await context.route(url, async (route) => {
          evidence.providerCalls += 1;
          await route.abort("blockedbyclient");
        });
    };
    const runtimeMessage = <T>(popup: Page, message: Record<string, unknown>) =>
      popup.evaluate(async (payload) => {
        const extensionBrowser = (
          globalThis as unknown as {
            browser: {
              runtime: {
                sendMessage: (
                  message: Record<string, unknown>,
                ) => Promise<unknown>;
              };
            };
          }
        ).browser;
        return extensionBrowser.runtime.sendMessage(payload);
      }, message) as Promise<T>;
    const within = async <T>(
      promise: Promise<T>,
      timeoutMs: number,
      label: string,
    ) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const clickTrustedPrepare = async (popup: Page) => {
      if (await popup.getByRole("button", { name: "Sign in" }).count()) {
        await runtimeMessage(popup, { type: "AUTH_STATUS" });
        await popup.reload();
      }
      await popup.getByRole("button", { name: "Translate" }).waitFor();
      await popup.evaluate((nativePair) => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent?.trim() === "Translate",
        );
        if (!button) throw new Error("Translate button was not found.");
        button.addEventListener(
          "click",
          (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
            document.documentElement.dataset.nativeCapabilityClick =
              event.isTrusted ? "trusted" : "untrusted";
            if (!event.isTrusted) return;
            const extensionBrowser = (
              globalThis as unknown as {
                browser: {
                  runtime: {
                    sendMessage: (
                      message: Record<string, unknown>,
                    ) => Promise<unknown>;
                  };
                };
              }
            ).browser;
            void extensionBrowser.runtime.sendMessage({
              type: "PREPARE_NATIVE_TRANSLATOR",
              ...nativePair,
            });
          },
          { capture: true, once: true },
        );
      }, pair);
      await popup
        .getByRole("button", { name: "Translate", exact: true })
        .click();
      await expect
        .poll(() =>
          popup.evaluate(
            () => document.documentElement.dataset.nativeCapabilityClick,
          ),
        )
        .toBe("trusted");
    };
    const waitUntilReady = async (
      popup: Page,
      phase: string,
      timeoutMs: number,
    ) => {
      const startedAt = Date.now();
      const samples: { elapsedMs: number; status: NativeStatus }[] = [];
      evidence.phases[phase] = samples;
      while (Date.now() - startedAt < timeoutMs) {
        const status = await within(
          runtimeMessage<NativeStatus>(popup, {
            type: "QUERY_NATIVE_TRANSLATOR_PROGRESS",
            ...pair,
          }),
          5_000,
          `${phase} progress query`,
        );
        const elapsedMs = Date.now() - startedAt;
        const previous = samples.at(-1)?.status;
        if (
          !previous ||
          previous.availability !== status.availability ||
          previous.ready !== status.ready ||
          previous.progress.phase !== status.progress.phase ||
          previous.progress.loaded !== status.progress.loaded
        ) {
          samples.push({ elapsedMs, status });
          console.log(
            `[native-capability] ${phase} elapsed=${elapsedMs}ms availability=${status.availability} ready=${status.ready} phase=${status.progress.phase} loaded=${status.progress.loaded ?? "n/a"} total=${status.progress.total ?? "n/a"}`,
          );
        }
        if (status.ready) return status;
        if (status.availability === "unavailable" && elapsedMs >= 2_000)
          throw new Error(
            `${phase} native capability unavailable: ${JSON.stringify(status)}`,
          );
        await popup.waitForTimeout(250);
      }
      throw new Error(`${phase} native preparation exceeded ${timeoutMs}ms`);
    };
    const translateLabel = async (
      popup: Page,
      page: Page,
      phase: string,
      runId: number,
    ) => {
      const injections = await within(
        extension.worker.evaluate(
          async ({ url, runId, pair }) => {
            const extensionBrowser = (
              globalThis as unknown as {
                browser: typeof import("wxt/browser").browser;
              }
            ).browser;
            const tab = (await extensionBrowser.tabs.query({})).find(
              (candidate) => candidate.url === url,
            );
            if (tab?.id === undefined)
              throw new Error("Native probe content tab is unavailable.");
            return extensionBrowser.scripting.executeScript({
              target: { tabId: tab.id, frameIds: [0] },
              world: "ISOLATED",
              args: [runId, pair],
              func: async (
                runId: number,
                pair: { sourceLanguage: "ja"; targetLanguage: "en" },
              ) => {
                const runtime = (
                  globalThis as unknown as {
                    chrome: {
                      runtime: {
                        sendMessage: (
                          message: Record<string, unknown>,
                        ) => Promise<unknown>;
                      };
                    };
                  }
                ).chrome.runtime;
                const begin = await runtime.sendMessage({
                  type: "BEGIN_TRANSLATION_RUN",
                  runId,
                });
                const response = await runtime.sendMessage({
                  type: "TRANSLATE_NATIVE_TEXT",
                  runId,
                  ...pair,
                  texts: ["請求"],
                });
                return { begin, response };
              },
            });
          },
          { url: page.url(), runId, pair },
        ),
        30_000,
        `${phase} native translation`,
      );
      expect(injections).toHaveLength(1);
      expect(injections[0]?.frameId).toBe(0);
      expect(injections[0]?.documentId).toBeTruthy();
      expect(injections[0]?.result?.begin).toMatchObject({ ok: true });
      const response = injections[0]?.result?.response as {
        runId: number;
        results: { status: string; text?: string; reason?: string }[];
      };
      evidence.translations[phase] = response;
      expect(response.runId).toBe(runId);
      expect(response.results).toHaveLength(1);
      expect(response.results[0]?.status).toBe("accepted");
      expect(response.results[0]?.text?.trim()).toBeTruthy();
      expect(response.results[0]?.text?.trim()).not.toBe("請求");
      expect(
        await runtimeMessage<NativeStatus>(popup, {
          type: "QUERY_NATIVE_TRANSLATOR_PROGRESS",
          ...pair,
        }),
      ).toMatchObject({
        availability: "available",
        ready: true,
        progress: { phase: "ready" },
      });
    };

    try {
      await blockProviders(extension.context);
      const coldPage = await extension.context.newPage();
      await coldPage.goto(`${fixture.url}#native-capability-cold`);
      const coldPopup = await openPopupForTab(extension, coldPage);
      await clickTrustedPrepare(coldPopup);
      await coldPopup.close();

      const coldObserver = await openPopupForTab(extension, coldPage);
      await waitUntilReady(coldObserver, "cold", 180_000);
      await translateLabel(coldObserver, coldPage, "cold", 900_001);
      await coldObserver.close();
      expect(evidence.providerCalls).toBe(0);

      const profile = extension.userDataDir;
      await extension.close(false);
      extension = await launchExtension(fixture.url, profile);
      await blockProviders(extension.context);
      const warmPage = await extension.context.newPage();
      await warmPage.goto(`${fixture.url}#native-capability-warm`);
      const warmPopup = await openPopupForTab(extension, warmPage);
      await clickTrustedPrepare(warmPopup);
      await warmPopup.close();

      const warmObserver = await openPopupForTab(extension, warmPage);
      await waitUntilReady(warmObserver, "warm", 60_000);
      await translateLabel(warmObserver, warmPage, "warm", 900_002);
      await warmObserver.close();
      expect(evidence.providerCalls).toBe(0);
    } finally {
      await testInfo.attach("native-capability.json", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      });
    }
  });

  test("@deterministic @native-recovery records a completed backend stage leaves unresolved go once to native recovery", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    const recoverySources = new Set([
      "請求",
      "当月請求額",
      "請求月",
      "過入金",
      "切断対象",
    ]);
    // Every OpenAI attempt inside the stage misses the recovery sources, so
    // the stage leaves them unresolved for the on-device stage (ADR 0020).
    await routeDeterministicProvider(extension.context, undefined, {
      translate: (source, index, targetLanguage) =>
        recoverySources.has(source)
          ? source
          : translatedText(source, index, targetLanguage),
      googleTranslate: (source, index) =>
        recoverySources.has(source)
          ? source
          : googleFallbackText(source, index),
      observeRequest: (request) => providerRequests.push(request),
    });
    const engineRequests = (
      engine: "openai" | "google",
      source: string,
      start = 0,
    ) =>
      providerRequests
        .slice(start)
        .filter(({ provider }) => provider === engine)
        .flatMap(({ requests }) => requests)
        .filter((request) => request === source).length;
    await extension.worker.evaluate(async () => {
      interface NativeFakeState {
        calls: string[];
        releaseDetached?: () => void;
      }
      const nativeGlobal = globalThis as unknown as {
        __tryhandNativeFake?: NativeFakeState;
        Translator?: {
          availability: () => Promise<string>;
          create: (options: {
            monitor: (monitor: {
              addEventListener: (
                type: string,
                listener: (event: { loaded: number; total: number }) => void,
              ) => void;
            }) => void;
          }) => Promise<{
            translate: (text: string) => Promise<string>;
            destroy: () => void;
          }>;
        };
        browser: {
          tabs: { detectLanguage: () => Promise<string> };
        };
      };
      const state: NativeFakeState = { calls: [] };
      nativeGlobal.__tryhandNativeFake = state;
      nativeGlobal.Translator = {
        availability: async () => "available",
        async create({ monitor }) {
          monitor({
            addEventListener(_type, listener) {
              listener({ loaded: 1, total: 1 });
            },
          });
          const translations: Record<string, string> = {
            請求: "Invoice",
            当月請求額: "Invoice amount",
            請求月: "Billing month",
            過入金: "Overpayment",
            切断対象: "Detached target",
          };
          return {
            async translate(text) {
              state.calls.push(text);
              if (text === "切断対象")
                await new Promise<void>((resolve) => {
                  state.releaseDetached = resolve;
                });
              return translations[text] ?? text;
            },
            destroy: () => undefined,
          };
        },
      };
      nativeGlobal.browser.tabs.detectLanguage = async () => "ja";
    });

    const url = `${fixture.url}?native-recovery`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="ja"><head><title></title></head><body><main>
          <p data-layout-probe="native-google-basic">基本情報</p>
          <p data-layout-probe="native-google-adjustment">調整明細</p>
          <p data-layout-probe="native-invoice">請求</p>
          <p data-layout-probe="native-amount">当月請求額</p>
          <button data-layout-probe="native-filter-month">請求月</button>
          <span data-layout-probe="native-table-month">請求月</span>
          <button data-layout-probe="native-overpayment">過入金</button>
          <p data-layout-probe="native-detached">切断対象</p>
          <input data-layout-probe="native-input" value="入力値：請求月">
          <textarea data-layout-probe="native-textarea">備考：過入金</textarea>
        </main></body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    const preparingPopup = await openPopupForTab(extension, page);
    await expect(
      sendExtensionMessage(preparingPopup, {
        type: "PREPARE_NATIVE_TRANSLATOR",
        sourceLanguage: "ja",
        targetLanguage: "en",
      }),
    ).resolves.toMatchObject({
      availability: "available",
      ready: true,
      progress: { phase: "ready" },
    });
    await preparingPopup.close();
    const probes = [
      "native-google-basic",
      "native-google-adjustment",
      "native-invoice",
      "native-amount",
      "native-filter-month",
      "native-table-month",
      "native-overpayment",
    ] as const;
    const original = await page.evaluate((recordProbes) => {
      type NativeRecoveryWindow = Window & {
        __tryhandNativeRecovery?: { node: Text; source: string }[];
        __tryhandNativeDetached?: Text;
      };
      const recoveryWindow = window as NativeRecoveryWindow;
      recoveryWindow.__tryhandNativeRecovery = recordProbes.map((probe) => {
        const node = document.querySelector(
          `[data-layout-probe='${probe}']`,
        )?.firstChild;
        if (!(node instanceof Text)) throw new Error(`Missing ${probe}`);
        return { node, source: node.data };
      });
      recoveryWindow.__tryhandNativeDetached = document.querySelector(
        "[data-layout-probe='native-detached']",
      )?.firstChild as Text;
      return {
        input: (
          document.querySelector(
            "[data-layout-probe='native-input']",
          ) as HTMLInputElement
        ).value,
        textarea: (
          document.querySelector(
            "[data-layout-probe='native-textarea']",
          ) as HTMLTextAreaElement
        ).value,
      };
    }, probes);

    const run = sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await expect(
      page.locator("[data-layout-probe='native-google-basic']"),
    ).toHaveText("Basic information");
    await expect(
      page.locator("[data-layout-probe='native-google-adjustment']"),
    ).toHaveText("Adjustment details");
    await expect
      .poll(() =>
        extension.worker.evaluate(
          () =>
            (
              globalThis as unknown as {
                __tryhandNativeFake?: { calls: string[] };
              }
            ).__tryhandNativeFake?.calls.includes("切断対象") ?? false,
        ),
      )
      .toBe(true);
    await waitForState(extension.worker, url, "preparing");
    await page
      .locator("[data-layout-probe='native-detached']")
      .evaluate((element) => element.remove());
    await extension.worker.evaluate(() => {
      (
        globalThis as unknown as {
          __tryhandNativeFake?: { releaseDetached?: () => void };
        }
      ).__tryhandNativeFake?.releaseDetached?.();
    });
    expect(await run).toMatchObject({ state: "translated" });
    await waitForState(extension.worker, url, "translated");

    for (const [probe, translation] of [
      ["native-invoice", "Invoice"],
      ["native-amount", "Invoice amount"],
      ["native-filter-month", "Billing month"],
      ["native-table-month", "Billing month"],
      ["native-overpayment", "Overpayment"],
    ] as const)
      await expect(page.locator(`[data-layout-probe='${probe}']`)).toHaveText(
        translation,
      );
    await expect(
      page.locator("[data-layout-probe='native-input']"),
    ).toHaveValue(original.input);
    await expect(
      page.locator("[data-layout-probe='native-textarea']"),
    ).toHaveValue(original.textarea);

    const nativeCalls = await extension.worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            __tryhandNativeFake?: { calls: string[] };
          }
        ).__tryhandNativeFake?.calls ?? [],
    );
    expect(nativeCalls).toEqual([
      "請求",
      "当月請求額",
      "請求月",
      "請求月",
      "過入金",
      "切断対象",
    ]);
    expect(nativeCalls).not.toContain("基本情報");
    expect(nativeCalls).not.toContain("調整明細");
    for (const source of ["基本情報", "調整明細"]) {
      expect(engineRequests("openai", source)).toBe(1);
      expect(engineRequests("google", source)).toBe(0);
    }
    // One completed stage per unique record (duplicates share it): its
    // OpenAI attempts and no Google; the client never re-dispatches records
    // the stage left unresolved.
    for (const source of [
      "請求",
      "当月請求額",
      "請求月",
      "過入金",
      "切断対象",
    ]) {
      expect(engineRequests("openai", source)).toBe(OPENAI_ATTEMPTS_PER_STAGE);
      expect(engineRequests("google", source)).toBe(0);
    }
    expect(
      await page.evaluate(() => {
        const detached = (window as Window & { __tryhandNativeDetached?: Text })
          .__tryhandNativeDetached!;
        return { connected: detached.isConnected, text: detached.data };
      }),
    ).toEqual({ connected: false, text: "切断対象" });

    const popup = await openPopupForTab(extension, page);
    await expect(popup.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(
      popup.getByRole("button", { name: /install|download|set up/i }),
    ).toHaveCount(0);
    await popup.getByRole("button", { name: "Show original" }).click();
    await waitForState(extension.worker, url, "original");
    expect(
      await page.evaluate(() => {
        const records = (
          window as Window & {
            __tryhandNativeRecovery?: { node: Text; source: string }[];
          }
        ).__tryhandNativeRecovery!;
        return records.every(
          ({ node, source }) => node.isConnected && node.data === source,
        );
      }),
    ).toBe(true);
    await expect(
      page.locator("[data-layout-probe='native-input']"),
    ).toHaveValue(original.input);
    await expect(
      page.locator("[data-layout-probe='native-textarea']"),
    ).toHaveValue(original.textarea);
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    await popup.close();

    await extension.worker.evaluate(() => {
      (
        globalThis as unknown as {
          Translator?: { availability: () => Promise<string> };
        }
      ).Translator = { availability: async () => "unavailable" };
    });
    const unavailablePopup = await openPopupForTab(extension, page);
    expect(
      await sendExtensionMessage(unavailablePopup, {
        type: "PREPARE_NATIVE_TRANSLATOR",
        sourceLanguage: "ja",
        targetLanguage: "vi",
      }),
    ).toMatchObject({
      availability: "unavailable",
      ready: false,
      progress: { phase: "checking" },
    });
    await unavailablePopup.close();
    const unavailableStart = providerRequests.length;
    const terminal = await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    expect(terminal).toMatchObject({ state: "partial", hasUnresolved: true });
    await waitForState(extension.worker, url, "partial");
    await expect(
      page.locator("[data-layout-probe='native-google-basic']"),
    ).not.toHaveText("基本情報");
    await expect(
      page.locator("[data-layout-probe='native-invoice']"),
    ).toHaveText("請求");
    expect(engineRequests("openai", "請求", unavailableStart)).toBe(
      OPENAI_ATTEMPTS_PER_STAGE,
    );
    expect(engineRequests("google", "請求", unavailableStart)).toBe(0);
    const partialPopup = await openPopupForTab(extension, page);
    await expect(partialPopup.getByRole("status")).toBeEmpty();
    await expect(
      partialPopup.getByRole("button", { name: "Retry" }),
    ).toHaveCount(0);
    await expect(
      partialPopup.getByRole("button", {
        name: /install|download|set up/i,
      }),
    ).toHaveCount(0);
    await partialPopup.getByRole("button", { name: "Show original" }).click();
    await waitForState(extension.worker, url, "original");
    await expect(
      page.locator("[data-layout-probe='native-input']"),
    ).toHaveValue(original.input);
    await expect(
      page.locator("[data-layout-probe='native-textarea']"),
    ).toHaveValue(original.textarea);
    await partialPopup.close();
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @native-recovery reconstructs native pairs without popup state and infers Japanese when metadata is missing", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    const recoverySource = "請求 PDF";
    await routeDeterministicProvider(extension.context, undefined, {
      translate: (source, index, targetLanguage) =>
        source.includes(recoverySource)
          ? source
          : translatedText(source, index, targetLanguage),
      googleTranslate: (source, index) =>
        source.includes(recoverySource)
          ? source
          : googleFallbackText(source, index),
      observeRequest: (request) => providerRequests.push(request),
    });
    await extension.worker.evaluate(async () => {
      interface NativeFakeState {
        calls: { targetLanguage: string; text: string }[];
        preparations: string[];
      }
      const nativeGlobal = globalThis as unknown as {
        __tryhandNativeRestartFake?: NativeFakeState;
        Translator?: {
          availability: (pair: {
            sourceLanguage: string;
            targetLanguage: string;
          }) => Promise<string>;
          create: (options: {
            sourceLanguage: string;
            targetLanguage: string;
            monitor: (monitor: {
              addEventListener: (
                type: string,
                listener: (event: { loaded: number; total: number }) => void,
              ) => void;
            }) => void;
          }) => Promise<{
            translate: (text: string) => Promise<string>;
            destroy: () => void;
          }>;
        };
        browser: {
          tabs: { detectLanguage: () => Promise<string> };
        };
      };
      const state: NativeFakeState = { calls: [], preparations: [] };
      nativeGlobal.__tryhandNativeRestartFake = state;
      nativeGlobal.Translator = {
        availability: async () => "available",
        async create({ targetLanguage, monitor }) {
          state.preparations.push(`ja:${targetLanguage}`);
          monitor({
            addEventListener(_type, listener) {
              listener({ loaded: 1, total: 1 });
            },
          });
          return {
            async translate(text) {
              state.calls.push({ targetLanguage, text });
              return targetLanguage === "en" ? "Invoice PDF" : "Hóa đơn PDF";
            },
            destroy: () => undefined,
          };
        },
      };
      nativeGlobal.browser.tabs.detectLanguage = async () => "ja";
    });

    const runScenario = async ({
      htmlLang,
      name,
      targetLanguage,
      translation,
    }: {
      htmlLang: string;
      name: string;
      targetLanguage: "en" | "vi";
      translation: string;
    }) => {
      const url = `${fixture.url}?native-restart-${name}`;
      await extension.context.route(url, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html${htmlLang}><head><title></title></head><body><p data-layout-probe="native-restart-accepted">基本情報</p><p data-layout-probe="native-restart-mixed">${recoverySource}</p></body></html>`,
        }),
      );
      const page = await extension.context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(url);
      const terminal = await sendTopFrameMessage(extension.worker, url, {
        type: "START_TRANSLATION",
        targetLanguage,
      });
      expect(terminal).toMatchObject({ state: "translated" });
      await expect(
        page.locator("[data-layout-probe='native-restart-mixed']"),
      ).toHaveText(translation);
      await page.close();
    };

    await runScenario({
      htmlLang: ' lang="ja"',
      name: "trusted",
      targetLanguage: "en",
      translation: "Invoice PDF",
    });
    await extension.worker.evaluate(() => {
      (
        globalThis as unknown as {
          browser: { tabs: { detectLanguage: () => Promise<string> } };
        }
      ).browser.tabs.detectLanguage = async () => "und";
    });
    await runScenario({
      htmlLang: "",
      name: "inferred",
      targetLanguage: "vi",
      translation: "Hóa đơn PDF",
    });

    const nativeEvidence = await extension.worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            __tryhandNativeRestartFake?: {
              calls: { targetLanguage: string; text: string }[];
              preparations: string[];
            };
          }
        ).__tryhandNativeRestartFake,
    );
    expect(nativeEvidence).toEqual({
      calls: [
        { targetLanguage: "en", text: recoverySource },
        { targetLanguage: "vi", text: recoverySource },
      ],
      preparations: ["ja:en", "ja:vi"],
    });
    // One completed stage per scenario: its OpenAI attempts, no Google.
    const engineCount = (engine: "openai" | "google") =>
      providerRequests
        .filter(({ provider }) => provider === engine)
        .flatMap(({ requests }) => requests)
        .filter((request) => request === recoverySource).length;
    expect(engineCount("openai")).toBe(2 * OPENAI_ATTEMPTS_PER_STAGE);
    expect(engineCount("google")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @native-recovery prioritizes Japanese records over a trusted English page hint and isolates unavailable pairs", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    const japaneseSources = ["請求", "請求 PDF"];
    const englishSource = "English unresolved";
    const recoverySources = new Set([...japaneseSources, englishSource]);
    await routeDeterministicProvider(extension.context, undefined, {
      translate: (source, index, targetLanguage) =>
        recoverySources.has(source)
          ? source
          : translatedText(source, index, targetLanguage),
      googleTranslate: (source, index) =>
        recoverySources.has(source)
          ? source
          : googleFallbackText(source, index),
      observeRequest: (request) => providerRequests.push(request),
    });
    const engineRequests = (engine: "openai" | "google", source: string) =>
      providerRequests
        .filter(({ provider }) => provider === engine)
        .flatMap(({ requests }) => requests)
        .filter((request) => request === source).length;
    await extension.worker.evaluate(async () => {
      interface NativePairState {
        availability: string[];
        calls: { sourceLanguage: string; text: string }[];
        creations: string[];
      }
      const nativeGlobal = globalThis as unknown as {
        __tryhandNativePairState?: NativePairState;
        Translator?: {
          availability: (pair: {
            sourceLanguage: string;
            targetLanguage: string;
          }) => Promise<string>;
          create: (options: {
            sourceLanguage: string;
            targetLanguage: string;
            monitor: (monitor: {
              addEventListener: (
                type: string,
                listener: (event: { loaded: number; total: number }) => void,
              ) => void;
            }) => void;
          }) => Promise<{
            translate: (text: string) => Promise<string>;
            destroy: () => void;
          }>;
        };
        browser: {
          tabs: { detectLanguage: () => Promise<string> };
        };
      };
      const state: NativePairState = {
        availability: [],
        calls: [],
        creations: [],
      };
      nativeGlobal.__tryhandNativePairState = state;
      nativeGlobal.Translator = {
        async availability({ sourceLanguage, targetLanguage }) {
          state.availability.push(`${sourceLanguage}:${targetLanguage}`);
          return sourceLanguage === "ja" ? "unavailable" : "available";
        },
        async create({ sourceLanguage, targetLanguage, monitor }) {
          state.creations.push(`${sourceLanguage}:${targetLanguage}`);
          monitor({
            addEventListener(_type, listener) {
              listener({ loaded: 1, total: 1 });
            },
          });
          return {
            async translate(text) {
              state.calls.push({ sourceLanguage, text });
              return "Nhãn tiếng Anh";
            },
            destroy: () => undefined,
          };
        },
      };
      nativeGlobal.browser.tabs.detectLanguage = async () => "en";
    });
    const url = `${fixture.url}?native-source-priority`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><head><title></title></head><body><main><p data-layout-probe="native-priority-ja">${japaneseSources[0]}</p><p data-layout-probe="native-priority-mixed">${japaneseSources[1]}</p><p data-layout-probe="native-priority-en">${englishSource}</p><p data-layout-probe="native-priority-google">基本情報</p></main></body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);

    const terminal = await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    expect(terminal).toMatchObject({ state: "partial", hasUnresolved: true });
    await expect(
      page.locator("[data-layout-probe='native-priority-ja']"),
    ).toHaveText(japaneseSources[0]!);
    await expect(
      page.locator("[data-layout-probe='native-priority-mixed']"),
    ).toHaveText(japaneseSources[1]!);
    await expect(
      page.locator("[data-layout-probe='native-priority-en']"),
    ).toHaveText("Nhãn tiếng Anh");
    await expect(
      page.locator("[data-layout-probe='native-priority-google']"),
    ).not.toHaveText("基本情報");

    const nativeState = await extension.worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            __tryhandNativePairState?: {
              availability: string[];
              calls: { sourceLanguage: string; text: string }[];
              creations: string[];
            };
          }
        ).__tryhandNativePairState,
    );
    expect(new Set(nativeState?.availability)).toEqual(
      new Set(["en:vi", "ja:vi"]),
    );
    expect(nativeState?.creations).toEqual(["en:vi"]);
    expect(nativeState?.calls).toEqual([
      { sourceLanguage: "en", text: englishSource },
    ]);
    for (const source of recoverySources) {
      expect(engineRequests("openai", source)).toBe(OPENAI_ATTEMPTS_PER_STAGE);
      expect(engineRequests("google", source)).toBe(0);
    }
    expect(engineRequests("openai", "基本情報")).toBe(1);
    expect(engineRequests("google", "基本情報")).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  test("@translation-first mixed records retain provider results across local layout repair and restore exactly", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    const section = page.locator(
      "[data-layout-probe='translation-first-retention']",
    );
    await section.scrollIntoViewIfNeeded();
    const original = await section.evaluate((root) => {
      type IdentityWindow = Window & { __tryhandRetentionTexts?: Text[] };
      for (const candidate of document.querySelectorAll(
        "main > section, main > article",
      ))
        candidate.setAttribute("contenteditable", "true");
      root.removeAttribute("contenteditable");
      const fixedList = document
        .querySelector("[data-layout-probe='bounded-fixed-overflow']")!
        .closest("ul")!;
      root.append(fixedList);
      fixedList
        .querySelector("[data-layout-probe='bounded-fixed-cell']")
        ?.setAttribute("contenteditable", "true");
      for (const probe of [
        "translation-first-group-beta",
        "translation-first-success-slot",
        "translation-first-transient",
        "translation-first-nonretryable",
        "translation-first-dynamic",
      ])
        root
          .querySelector(`[data-layout-probe='${probe}']`)
          ?.setAttribute("contenteditable", "true");
      const recordProbes = [
        "translation-first-flow",
        "translation-first-fit",
        "bounded-fixed-overflow",
        "translation-first-multiline",
        "translation-first-group-alpha",
      ];
      const text = (element: Element) => {
        const walker = document.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) =>
              node.textContent?.trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT,
          },
        );
        return walker.nextNode() as Text;
      };
      (window as IdentityWindow).__tryhandRetentionTexts = recordProbes.map(
        (probe) => text(root.querySelector(`[data-layout-probe='${probe}']`)!),
      );
      return root.innerHTML;
    });
    const measured = () =>
      page.evaluate(() => {
        const rect = (probe: string) => {
          const { x, y, width, height } = document
            .querySelector(`[data-layout-probe='${probe}']`)!
            .getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          card: rect("translation-first-multiline"),
          fit: rect("translation-first-fit-row"),
          overflow: rect("bounded-fixed-overflow"),
        };
      });
    const before = await measured();
    await startFrameSampler(page, [
      "translation-first-fit-row",
      "bounded-fixed-overflow",
      "translation-first-multiline",
    ]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await section
      .locator("[data-layout-probe='translation-first-group-beta']")
      .evaluate((element) => {
        const replacement = element.cloneNode(true) as HTMLElement;
        replacement.removeAttribute("contenteditable");
        element.replaceWith(replacement);
      });
    await expect(
      section.locator("[data-layout-probe='translation-first-group-beta']"),
    ).toHaveText("Nhóm beta vẫn giữ bản dịch độc lập");
    await waitForSchedulerTicks(page);
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);

    const records = [
      [
        "translation-first-flow",
        "Translation first flow",
        "Nội dung luồng đã được dịch và vẫn còn nguyên",
      ],
      ["translation-first-fit", "Translation first fit", "Nhãn vừa vặn"],
      [
        "bounded-fixed-overflow",
        "Fixed overflow",
        "Bản dịch cố định rất dài vượt quá ô riêng",
      ],
      [
        "translation-first-multiline",
        "Translation first story headline",
        "Tiêu đề thẻ đã dịch dài hơn và được giới hạn theo số dòng ban đầu",
      ],
      [
        "translation-first-group-alpha",
        "Translation group alpha",
        "Nhóm alpha đã dịch dù hình học cần sửa cục bộ",
      ],
      [
        "translation-first-group-beta",
        "Translation group beta",
        "Nhóm beta vẫn giữ bản dịch độc lập",
      ],
    ] as const;
    for (const [probe, source, translation] of records)
      await expectRetainedProviderRecord(page, providerRequests, {
        probe,
        source,
        translation,
      });
    const alphaRequest = providerRequests.findIndex(({ requests }) =>
      requests.some((request) => request.includes("Translation group alpha")),
    );
    const betaRequest = providerRequests.findIndex(({ requests }) =>
      requests.some((request) => request.includes("Translation group beta")),
    );
    expect(alphaRequest).toBeGreaterThanOrEqual(0);
    expect(betaRequest).toBeGreaterThan(alphaRequest);

    await expect(
      section.locator(
        "[data-layout-probe='translation-first-flow'] tryhand-ellipsis",
      ),
    ).toHaveCount(0);
    await expect(
      section.locator(
        "[data-layout-probe='translation-first-fit'] tryhand-ellipsis",
      ),
    ).toHaveCount(0);
    const overflow = page.locator(
      "[data-layout-probe='bounded-fixed-overflow'] tryhand-ellipsis",
    );
    await expect(overflow).toHaveAttribute(
      "data-tryhand-layout",
      "single-line",
    );
    expect(
      await overflow.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await expect(overflow).toHaveAttribute(
      "title",
      "Bản dịch cố định rất dài vượt quá ô riêng",
    );
    const multiline = section.locator(
      "[data-layout-probe='translation-first-multiline'] tryhand-ellipsis",
    );
    await expect(multiline).toHaveAttribute(
      "data-tryhand-layout",
      "multi-line",
    );
    await expect(multiline).toHaveAttribute(
      "title",
      "Tiêu đề thẻ đã dịch dài hơn và được giới hạn theo số dòng ban đầu",
    );
    const after = await measured();
    for (const key of ["fit", "overflow", "card"] as const)
      expect(maxGeometryDelta([before[key], after[key]])).toBeLessThanOrEqual(
        1,
      );
    for (const probe of [
      "translation-first-fit-row",
      "bounded-fixed-overflow",
      "translation-first-multiline",
    ]) {
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);
      expect((samples[probe] ?? []).length).toBeGreaterThan(3);
    }

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await section
      .locator("[data-layout-probe='translation-first-group-beta']")
      .evaluate((element) => element.setAttribute("contenteditable", "true"));
    expect(
      await section.evaluate((root) => {
        type IdentityWindow = Window & { __tryhandRetentionTexts?: Text[] };
        const texts = (window as IdentityWindow).__tryhandRetentionTexts ?? [];
        const probes = [
          "translation-first-flow",
          "translation-first-fit",
          "bounded-fixed-overflow",
          "translation-first-multiline",
          "translation-first-group-alpha",
        ];
        const current = probes.map((probe) => {
          const walker = document.createTreeWalker(
            root.querySelector(`[data-layout-probe='${probe}']`)!,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode: (node) =>
                node.textContent?.trim()
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT,
            },
          );
          return walker.nextNode();
        });
        return {
          html: root.innerHTML,
          identities: current.every((node, index) => node === texts[index]),
        };
      }),
    ).toEqual({ html: original, identities: true });
    await expect(
      page.locator("[data-layout-probe='bounded-fixed-overflow']"),
    ).toHaveText("Fixed overflow");
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @openai-performance keeps same-language agreement automatic-only and lets the popup translate manually", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    await setExtensionDatabase(extension.worker, {
      "alwaysTranslate:127.0.0.1": {
        enabled: true,
        targetLanguage: "en",
      },
    });

    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await sendTopFrameMessage(extension.worker, fixture.url, {
        type: "DETECT_PAGE",
      }),
    ).toEqual({ pageLanguage: "en" });
    await waitForSchedulerTicks(page);
    expect(providerRequests).toHaveLength(0);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const section = document.querySelector(
        "[data-layout-probe='translation-first-retention']",
      )!;
      section.removeAttribute("contenteditable");
      for (const child of section.children)
        child.setAttribute("contenteditable", "true");
      const manual = section.querySelector(
        "[data-layout-probe='translation-first-success-slot']",
      )!;
      manual.removeAttribute("contenteditable");
      manual.textContent = "基本情報";
    });
    await page
      .locator("[data-layout-probe='translation-first-success-slot']")
      .scrollIntoViewIfNeeded();

    const popup = await openPopupForTab(extension, page);
    await expect(
      popup.getByText("Detected language").locator(".."),
    ).toContainText("English");
    const translate = popup.getByRole("button", {
      name: "Translate",
      exact: true,
    });
    await expect(translate).toBeEnabled();
    await page.bringToFront();
    await translate.evaluate((button: HTMLButtonElement) => button.click());
    await expect(
      popup.getByRole("status"),
      JSON.stringify(providerRequests, null, 2),
    ).toBeEmpty({ timeout: 10_000 });
    await waitForState(extension.worker, fixture.url, "translated");
    expect(providerRequests.length).toBeGreaterThan(0);
    expect(
      providerRequests.every(
        ({ provider, targetLanguage }) =>
          provider === "openai" && targetLanguage === "en",
      ),
    ).toBe(true);
    await popup.close();
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);

    for (const variant of [
      {
        name: "conflict",
        lang: ' lang="vi"',
        source: "Language conflict starts automatic translation",
      },
      {
        name: "missing",
        lang: "",
        source: "Missing language metadata starts automatic translation",
      },
      {
        name: "invalid",
        lang: ' lang="not_a_valid_tag!"',
        source: "Invalid language metadata starts automatic translation",
      },
    ]) {
      const url = `${fixture.url}?language-${variant.name}`;
      await extension.context.route(url, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html${variant.lang}><body><main>${variant.source}</main></body></html>`,
        }),
      );
      const variantPage = await extension.context.newPage();
      await variantPage.goto(url);
      await waitForState(extension.worker, url, "translated");
      expect(
        providerRequests.some(({ requests }) =>
          requests.some((request) => request.includes(variant.source)),
        ),
      ).toBe(true);
      await variantPage.close();
    }

    const undUrl = `${fixture.url}?language-und`;
    await extension.context.route(undUrl, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><body><main>1234567890</main></body></html>",
      }),
    );
    const undPage = await extension.context.newPage();
    await undPage.goto(undUrl);
    expect(
      await sendTopFrameMessage(extension.worker, undUrl, {
        type: "DETECT_PAGE",
      }),
    ).toEqual({ pageLanguage: "Unknown" });
    await waitForState(extension.worker, undUrl, "translated");
    await undPage.close();
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @openai-performance retains an early chunk while two delayed siblings stay globally bounded", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: (_target, requests) =>
        requests.some((request) =>
          request.includes("Translation first successful slot"),
        )
          ? 50
          : 650,
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    const sources = await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const section = document.querySelector(
        "[data-layout-probe='translation-first-retention']",
      )!;
      section.removeAttribute("contenteditable");
      for (const child of section.children)
        child.setAttribute("contenteditable", "true");
      const probes = [
        "translation-first-success-slot",
        "translation-first-transient",
        "translation-first-nonretryable",
      ];
      const texts = probes.map((probe, index) => {
        const element = section.querySelector(
          `[data-layout-probe='${probe}']`,
        )!;
        element.removeAttribute("contenteditable");
        element.textContent = [
          "Translation first successful slot ",
          "Translation first transient slot ",
          "Translation first nonretryable slot ",
        ]
          [index]!.repeat(35)
          .trim();
        return element.firstChild as Text;
      });
      (
        window as Window & { __tryhandOpenAiProgressiveTexts?: Text[] }
      ).__tryhandOpenAiProgressiveTexts = texts;
      return texts.map((text) => text.data);
    });
    await page
      .locator("[data-layout-probe='translation-first-success-slot']")
      .scrollIntoViewIfNeeded();

    const run = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await expect
      .poll(() => providerRequests.length, { timeout: 4_000 })
      .toBeGreaterThanOrEqual(3);
    expect(
      providerRequests
        .slice(0, 2)
        .every(({ requests }) =>
          requests.every(
            (request) => !request.includes("Layout stability fixture"),
          ),
        ),
    ).toBe(true);
    await expect(
      page.locator("[data-layout-probe='translation-first-success-slot']"),
    ).toHaveText("Vị trí thành công vẫn được giữ");
    await expect(
      page.locator("[data-layout-probe='translation-first-transient']"),
    ).toHaveText(sources[1]!);
    await expect(
      page.locator("[data-layout-probe='translation-first-nonretryable']"),
    ).toHaveText(sources[2]!);
    expect(
      Math.max(...providerRequests.map(({ activeRequests }) => activeRequests)),
    ).toBe(2);
    expect(
      providerRequests.every(({ activeRequests }) => activeRequests <= 2),
    ).toBe(true);

    await expect(
      page.locator("[data-layout-probe='translation-first-transient']"),
    ).toHaveText("Bản ghi được dịch trong lượt hiện tại");
    await expect(
      page.locator("[data-layout-probe='translation-first-nonretryable']"),
    ).toHaveText("Không được trả về cho lỗi không thử lại");
    await run;
    const readDiagnostics = async () => {
      const stored = await readExtensionDatabase(extension.worker, [
        "translation-diagnostics:v2",
      ]);
      return String(stored["translation-diagnostics:v2"] ?? "");
    };
    await expect.poll(readDiagnostics).not.toBe("");
    const diagnosticsRaw = await readDiagnostics();
    const diagnostics = JSON.parse(diagnosticsRaw) as {
      runs: Record<string, unknown>[];
    };
    const summary = diagnostics.runs.at(-1)!;
    expect(Object.keys(summary).sort()).toEqual(
      [
        "completeMs",
        "attemptedRecords",
        "cachedInputTokens",
        "chainCacheHits",
        "deterministicRecords",
        "discoveredRecords",
        "eligibleRecords",
        "firstCommitMs",
        "googleFallbackAccepted",
        "googleFallbackAttempted",
        "inputTokens",
        "localCacheHits",
        "localCacheInvalid",
        "localCacheMisses",
        "maxViewportCommitMs",
        "maxViewportDispatchMs",
        "nativeAccepted",
        "nativeAttempted",
        "outputTokens",
        "provider",
        "providerAccepted",
        "providerRejected",
        "queueMs",
        "reasoningTokens",
        "records",
        "rejectedCount",
        "rejectionReasons",
        "requestCount",
        "requestMs",
        "sourceCharacters",
        "storageReadCalls",
        "storageReadMs",
        "storageWriteCalls",
        "storageWriteMs",
      ].sort(),
    );
    const openAiRequests = providerRequests.filter(
      ({ provider }) => provider === "openai",
    );
    expect(summary).toMatchObject({
      provider: "openai",
      requestCount: openAiRequests.length,
      inputTokens: openAiRequests.length * 10,
      outputTokens: openAiRequests.length * 8,
      reasoningTokens: 0,
      rejectedCount: 0,
      rejectionReasons: {},
    });
    expect(Number(summary.firstCommitMs)).toBeGreaterThan(0);
    expect(Number(summary.completeMs)).toBeGreaterThanOrEqual(
      Number(summary.firstCommitMs),
    );
    expect(diagnosticsRaw).not.toContain("Layout stability fixture");
    for (const source of sources) expect(diagnosticsRaw).not.toContain(source);
    for (const [index, record] of [
      ["translation-first-success-slot", "Vị trí thành công vẫn được giữ"],
      ["translation-first-transient", "Bản ghi được dịch trong lượt hiện tại"],
      [
        "translation-first-nonretryable",
        "Không được trả về cho lỗi không thử lại",
      ],
    ].entries())
      await expectRetainedProviderRecord(page, providerRequests, {
        probe: record[0]!,
        source: sources[index]!,
        translation: record[1]!,
      });

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await page.evaluate((expected) => {
        const texts = (
          window as Window & { __tryhandOpenAiProgressiveTexts?: Text[] }
        ).__tryhandOpenAiProgressiveTexts!;
        const probes = [
          "translation-first-success-slot",
          "translation-first-transient",
          "translation-first-nonretryable",
        ];
        return texts.every(
          (text, index) =>
            text.isConnected &&
            text.data === expected[index] &&
            document.querySelector(`[data-layout-probe='${probes[index]}']`)
              ?.firstChild === text,
        );
      }, sources),
    ).toBe(true);
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @openai-performance isolates copied and missing entries, continues attributes, and caches only valid records", async () => {
    const copiedSource = "請求";
    const missingSource = "請求月";
    const validSource = "基本情報";
    const attributeSource = "Dynamic attribute root";
    const providerRequests: DeterministicProviderRequest[] = [];
    const qualityAttempts = new Map<string, number>();
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
      // The backend retries the copied and missing records inside the same
      // stage (ADR 0014); a wait longer than expect.poll's largest interval
      // keeps the first attempt observable on its own.
      openAiRetryDelaysMs: [1_000],
      openAiEntries: (sources) =>
        Object.fromEntries(
          Object.entries(sources).flatMap(([id, text], index) => {
            const attempt = (qualityAttempts.get(text) ?? 0) + 1;
            qualityAttempts.set(text, attempt);
            if (text.includes(copiedSource) && attempt === 1)
              return [[id, text]];
            if (text.includes(missingSource) && attempt === 1) return [];
            return [
              [
                id,
                text === validSource
                  ? "Thông tin cơ bản"
                  : text === missingSource
                    ? "Tháng thanh toán"
                    : text === copiedSource
                      ? "Hóa đơn"
                      : translatedText(text, index),
              ],
            ];
          }),
        ),
    });
    await setExtensionDatabase(extension.worker, {
      "alwaysTranslate:127.0.0.1": {
        enabled: false,
        targetLanguage: "vi",
      },
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    const original = await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const section = document.querySelector(
        "[data-layout-probe='translation-first-retention']",
      )!;
      section.removeAttribute("contenteditable");
      for (const child of section.children)
        child.setAttribute("contenteditable", "true");
      const probes = [
        "translation-first-success-slot",
        "translation-first-transient",
        "translation-first-nonretryable",
      ];
      const texts = probes.map((probe, index) => {
        const element = section.querySelector(
          `[data-layout-probe='${probe}']`,
        )!;
        element.removeAttribute("contenteditable");
        const text = element.firstChild as Text;
        text.data = ["基本情報", "請求月", "請求"][index]!;
        return text;
      });
      const input = document.createElement("input");
      input.dataset.layoutProbe = "openai-performance-attribute";
      input.title = "Dynamic attribute root";
      section.append(input);
      (
        window as Window & { __tryhandOpenAiQualityTexts?: Text[] }
      ).__tryhandOpenAiQualityTexts = texts;
      return section.innerHTML;
    });
    const legacyKey = await extension.worker.evaluate(async (source) => {
      const digest = await crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode(JSON.stringify([source])),
      );
      const hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return `translationCache:openai:v7:gpt-5-nano:en:vi:${hash}`;
    }, validSource);
    await setExtensionDatabase(extension.worker, {
      [legacyKey]: JSON.stringify([{ t: "Poisoned v7 result" }]),
    });
    const section = page.locator(
      "[data-layout-probe='translation-first-retention']",
    );
    await section.scrollIntoViewIfNeeded();

    const start = () =>
      sendTopFrameMessage(extension.worker, fixture.url, {
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      });
    const count = (source: string) =>
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes(source)),
      ).length;
    const firstRun = start();
    await expect.poll(() => count(copiedSource), { timeout: 4_000 }).toBe(1);
    await expect.poll(() => count(missingSource), { timeout: 4_000 }).toBe(1);
    const firstResponse = (await firstRun) as Record<string, unknown>;
    expect(firstResponse).toMatchObject({
      state: "translated",
      translated: true,
      appliedTarget: "vi",
      hasUnresolved: false,
    });
    await expect(
      page.locator("[data-layout-probe='translation-first-success-slot']"),
    ).toHaveText("Thông tin cơ bản");
    await expect(
      page.locator("[data-layout-probe='openai-performance-attribute']"),
    ).toHaveAttribute("title", "Thuộc tính gốc động đã được dịch");
    await expect(
      page.locator("[data-layout-probe='translation-first-nonretryable']"),
    ).toHaveText("Hóa đơn");
    await expect(
      page.locator("[data-layout-probe='translation-first-transient']"),
    ).toHaveText("Tháng thanh toán");
    expect(count(validSource)).toBe(1);
    expect(count(copiedSource)).toBe(2);
    expect(count(missingSource)).toBe(2);
    expect(count(attributeSource)).toBe(1);
    for (const source of [copiedSource, missingSource]) {
      const calls = providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes(source)),
      );
      expect(calls).toHaveLength(2);
      expect(calls.map(({ mode }) => mode)).toEqual(["primary", "primary"]);
    }
    expect(
      await sendTopFrameMessage(extension.worker, fixture.url, {
        type: "CONTENT_STATE",
      }),
    ).toMatchObject({
      state: "translated",
      translated: true,
      appliedTarget: "vi",
      hasUnresolved: false,
    });
    await expectRetainedProviderRecord(page, providerRequests, {
      probe: "translation-first-success-slot",
      source: validSource,
      translation: "Thông tin cơ bản",
    });
    expect(
      await section.evaluate(() => {
        const texts = (
          window as Window & { __tryhandOpenAiQualityTexts?: Text[] }
        ).__tryhandOpenAiQualityTexts!;
        const probes = [
          "translation-first-success-slot",
          "translation-first-transient",
          "translation-first-nonretryable",
        ];
        return texts.every(
          (text, index) =>
            text.isConnected &&
            document.querySelector(`[data-layout-probe='${probes[index]}']`)
              ?.firstChild === text,
        );
      }),
    ).toBe(true);
    const cacheKeys = Object.keys(
      await readExtensionDatabase(extension.worker),
    );
    expect(
      cacheKeys.some((key) =>
        key.startsWith("translationCache:openai:v10:record:gpt-5-nano:en:vi:"),
      ),
    ).toBe(true);

    const restore = async () => {
      await sendTopFrameMessage(extension.worker, fixture.url, {
        type: "SHOW_ORIGINAL",
      });
      await waitForState(extension.worker, fixture.url, "original");
      expect(
        await section.evaluate((root, expectedHtml) => {
          const texts = (
            window as Window & { __tryhandOpenAiQualityTexts?: Text[] }
          ).__tryhandOpenAiQualityTexts!;
          const probes = [
            "translation-first-success-slot",
            "translation-first-transient",
            "translation-first-nonretryable",
          ];
          return {
            html: root.innerHTML,
            identities: texts.every(
              (text, index) =>
                document.querySelector(`[data-layout-probe='${probes[index]}']`)
                  ?.firstChild === text,
            ),
            expectedHtml,
          };
        }, original),
      ).toEqual({ html: original, identities: true, expectedHtml: original });
      await expect(
        page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
      ).toHaveCount(0);
    };
    await restore();
    expect(pageErrors).toEqual([]);
  });

  test("@openai-coverage translates eligible Japanese records once with bounded horizontal prefetch and the existing scheduler", async () => {
    const copiedSource = "当月請求額";
    const nearSource = "累計";
    const farSource = "遠方見出し";
    const dynamicSource = "標準";
    const dynamicPlaceholder = "例：Hotel Alpenrose";
    const localValues = [
      "person@example.test",
      "https://example.test/path",
      "2026/08/25",
      "ORDER-123",
    ];
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
      openAiEntries: (sources) =>
        Object.fromEntries(
          Object.entries(sources).map(([id, text], index) => [
            id,
            translatedText(text, index),
          ]),
        ),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(
      ({ copied, far, locals, near }) => {
        type CoverageWindow = Window & {
          __tryhandCoverage?: {
            attributes: { input: HTMLInputElement; source: string }[];
            nodes: { node: Text; source: string }[];
          };
        };
        for (const element of document.querySelectorAll(
          "main > section, main > article",
        ))
          element.setAttribute("contenteditable", "true");
        document
          .querySelector("title")
          ?.setAttribute("contenteditable", "true");
        const root = document.createElement("section");
        root.dataset.layoutProbe = "openai-coverage-root";
        root.style.height = "1px";
        const nodes: { node: Text; source: string }[] = [];
        const addText = (
          probe: string,
          source: string,
          left: number,
          top: number,
        ) => {
          const element = document.createElement("div");
          element.dataset.layoutProbe = probe;
          element.style.cssText = `left:${left}px;position:fixed;top:${top}px;width:220px`;
          element.textContent = source;
          root.append(element);
          nodes.push({ node: element.firstChild as Text, source });
        };
        addText("openai-coverage-copied", copied, 20, 80);
        addText("openai-coverage-month", "請求月", 20, 110);
        addText("openai-coverage-overpayment", "過入金", 20, 140);
        addText("openai-coverage-near", near, window.innerWidth * 1.5, 80);
        addText("openai-coverage-far", far, window.innerWidth * 2.1, 80);
        locals.forEach((source, index) =>
          addText(
            `openai-coverage-local-${index}`,
            source,
            20,
            180 + index * 30,
          ),
        );
        const initialInput = document.createElement("input");
        initialInput.dataset.layoutProbe = "openai-coverage-placeholder";
        initialInput.placeholder = "例：Hotel Alpenrose";
        initialInput.style.cssText =
          "left:20px;position:fixed;top:310px;width:220px";
        root.append(initialInput);
        document.body.append(root);
        (window as CoverageWindow).__tryhandCoverage = {
          attributes: [
            { input: initialInput, source: initialInput.placeholder },
          ],
          nodes,
        };
      },
      {
        copied: copiedSource,
        far: farSource,
        locals: localValues,
        near: nearSource,
      },
    );
    const start = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    const callsFor = (source: string) =>
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes(source)),
      );
    await expect.poll(() => callsFor(copiedSource).length).toBe(1);
    expect(callsFor(copiedSource).map(({ mode }) => mode)).toEqual(["primary"]);
    await start;
    await expect(
      page.locator("[data-layout-probe='openai-coverage-copied']"),
    ).toHaveText("Invoice amount");
    await expect(
      page.locator("[data-layout-probe='openai-coverage-month']"),
    ).toHaveText("Billing month");
    await expect(
      page.locator("[data-layout-probe='openai-coverage-overpayment']"),
    ).toHaveText("Overpayment");
    await expect(
      page.locator("[data-layout-probe='openai-coverage-near']"),
    ).toHaveText("Cumulative");
    await expect(
      page.locator("[data-layout-probe='openai-coverage-placeholder']"),
    ).toHaveAttribute("placeholder", "Example: Hotel Alpenrose");
    expect(callsFor(farSource)).toHaveLength(0);
    for (const value of localValues) {
      expect(callsFor(value)).toHaveLength(0);
      await expect(page.getByText(value, { exact: true })).toBeVisible();
    }

    const addedAt = Date.now();
    await page.evaluate((placeholder) => {
      type CoverageWindow = Window & {
        __tryhandCoverage?: {
          attributes: { input: HTMLInputElement; source: string }[];
          nodes: { node: Text; source: string }[];
        };
      };
      const modal = document.createElement("section");
      modal.dataset.layoutProbe = "openai-coverage-modal";
      modal.style.cssText = "left:20px;position:fixed;top:350px;width:220px";
      const label = document.createElement("div");
      label.dataset.layoutProbe = "openai-coverage-modal-label";
      label.textContent = "標準";
      const input = document.createElement("input");
      input.dataset.layoutProbe = "openai-coverage-modal-placeholder";
      input.placeholder = placeholder;
      modal.append(label, input);
      document.body.append(modal);
      const coverage = (window as CoverageWindow).__tryhandCoverage!;
      coverage.nodes.push({
        node: label.firstChild as Text,
        source: label.textContent,
      });
      coverage.attributes.push({ input, source: input.placeholder });
    }, dynamicPlaceholder);
    await expect
      .poll(() => callsFor(dynamicSource).length, { timeout: 900 })
      .toBe(1);
    const dynamicRequest = callsFor(dynamicSource)[0]!;
    expect(dynamicRequest.at - addedAt).toBeLessThan(1_000);
    await expect(
      page.locator("[data-layout-probe='openai-coverage-modal-label']"),
    ).toHaveText("Standard");
    await expect(
      page.locator("[data-layout-probe='openai-coverage-modal-placeholder']"),
    ).toHaveAttribute("placeholder", "Example: Hotel Alpenrose");

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await page.evaluate(() => {
        type CoverageWindow = Window & {
          __tryhandCoverage?: {
            attributes: { input: HTMLInputElement; source: string }[];
            nodes: { node: Text; source: string }[];
          };
        };
        const coverage = (window as CoverageWindow).__tryhandCoverage!;
        return (
          coverage.nodes.every(
            ({ node, source }) => node.isConnected && node.data === source,
          ) &&
          coverage.attributes.every(
            ({ input, source }) =>
              input.isConnected && input.placeholder === source,
          )
        );
      }),
    ).toBe(true);
    await expect(
      page.locator(
        "[data-layout-probe^='openai-coverage'] tryhand-ellipsis, [data-layout-probe^='openai-coverage'] tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@provider-integrity retains Japanese labels and same-script copies through cold, warm, and exact restore", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    const openAiWires: Record<string, string>[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
      openAiEntries: (sources) => {
        openAiWires.push(sources);
        return Object.fromEntries(
          Object.entries(sources).map(([id, text], index) => [
            id,
            text === "Account name" ? text : translatedText(text, index),
          ]),
        );
      },
    });
    await extension.worker.evaluate(async () => {
      const extensionBrowser = (
        globalThis as unknown as {
          browser: {
            tabs: { detectLanguage: (tabId?: number) => Promise<string> };
          };
        }
      ).browser;
      extensionBrowser.tabs.detectLanguage = async () => "ja";
    });

    const url = `${fixture.url}?provider-integrity`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
          <html lang="ja"><body><main>
            <article data-layout-probe="integrity-card"><h2 data-layout-probe="integrity-basic">基本情報</h2><p data-layout-probe="integrity-amount">当月請求額</p></article>
            <section data-layout-probe="integrity-filter"><button data-layout-probe="integrity-filter-month">請求月</button><button data-layout-probe="integrity-overpayment">過入金</button></section>
            <section data-layout-probe="integrity-section"><h2 data-layout-probe="integrity-adjustment">調整明細</h2></section>
              <table><thead><tr><th data-layout-probe="integrity-invoice">請求</th><th data-layout-probe="integrity-table-month">請求月</th></tr></thead></table>
              <div data-layout-probe="integrity-near-total" style="left:150vw;position:absolute;top:20px">累計</div>
          </main></body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    const records = [
      ["integrity-invoice", "請求", "Invoice"],
      ["integrity-amount", "当月請求額", "Invoice amount"],
      ["integrity-filter-month", "請求月", "Billing month"],
      ["integrity-table-month", "請求月", "Billing month"],
      ["integrity-overpayment", "過入金", "Overpayment"],
      ["integrity-basic", "基本情報", "Basic information"],
      ["integrity-adjustment", "調整明細", "Adjustment details"],
      ["integrity-near-total", "累計", "Cumulative"],
    ] as const;
    await page.evaluate(
      (probes) => {
        type IntegrityWindow = Window & {
          __tryhandProviderIntegrity?: { node: Text; source: string }[];
        };
        (window as IntegrityWindow).__tryhandProviderIntegrity = probes.map(
          (probe) => {
            const node = document.querySelector(
              `[data-layout-probe='${probe}']`,
            )?.firstChild;
            if (!(node instanceof Text)) throw new Error(`Missing ${probe}`);
            return { node, source: node.data };
          },
        );
      },
      records.map(([probe]) => probe),
    );

    // Every engine call goes through the routed backend stage (ADR 0014).
    const stageRequests = () =>
      providerRequests.filter((request) => request.provider === "openai");
    const requestCount = (source: string) =>
      stageRequests()
        .flatMap(({ requests }) => requests)
        .filter((request) => request.includes(source)).length;
    const expectExactRestore = async () => {
      expect(
        await page.evaluate(() => {
          const records = (
            window as Window & {
              __tryhandProviderIntegrity?: { node: Text; source: string }[];
            }
          ).__tryhandProviderIntegrity!;
          return records.every(
            ({ node, source }) => node.isConnected && node.data === source,
          );
        }),
      ).toBe(true);
      await expect(
        page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
      ).toHaveCount(0);
    };

    const before = stageRequests().length;
    await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await waitForState(extension.worker, url, "translated");
    for (const [probe, source, translation] of records) {
      await expect(page.locator(`[data-layout-probe='${probe}']`)).toHaveText(
        translation,
      );
      expect(requestCount(source)).toBeGreaterThan(0);
    }
    // Both DOM records share one accepted in-flight/cache stage result.
    expect(requestCount("請求月")).toBe(1);
    expect(requestCount("累計")).toBeGreaterThan(0);
    expect(stageRequests().length).toBeGreaterThan(before);
    // OpenAI accepted every Japanese label, so the backend never needed its
    // Google fallback and every record carries `openai` provenance.
    expect(
      providerRequests.filter((request) => request.provider === "google"),
    ).toHaveLength(0);
    expect(
      stageRequests().flatMap(({ provenance }) => provenance ?? []),
    ).not.toContain(null);
    expect(openAiWires).not.toHaveLength(0);
    for (const source of openAiWires) {
      expect(Array.isArray(source)).toBe(false);
      for (const [id, text] of Object.entries(source)) {
        expect(id).toMatch(/^r\d+$/);
        expect(text).not.toBe("");
        expect(text).not.toContain("<pre>");
        expect(text).not.toContain("<a i=");
      }
    }
    for (const source of new Set(records.map(([, source]) => source)))
      expect(
        stageRequests()
          .filter(({ requests }) => requests.includes(source))
          .map(({ mode, sourceLanguages }) => ({
            mode,
            routes: [...new Set(Object.values(sourceLanguages ?? {}))],
          })),
      ).toEqual([{ mode: "primary", routes: ["ja"] }]);

    await sendTopFrameMessage(extension.worker, url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, url, "original");
    await expectExactRestore();

    const cachedRequestCount = stageRequests().length;
    await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await waitForState(extension.worker, url, "translated");
    expect(stageRequests()).toHaveLength(cachedRequestCount);
    await sendTopFrameMessage(extension.worker, url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, url, "original");
    await expectExactRestore();

    await extension.worker.evaluate(async () => {
      const extensionBrowser = (
        globalThis as unknown as {
          browser: {
            tabs: { detectLanguage: (tabId?: number) => Promise<string> };
          };
        }
      ).browser;
      extensionBrowser.tabs.detectLanguage = async () => "en";
    });
    const copiedSource = "Account name";
    const copiedUrl = `${fixture.url}?provider-integrity-copied`;
    await extension.context.route(copiedUrl, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><body><main data-layout-probe="integrity-copied">${copiedSource}</main></body></html>`,
      }),
    );
    const copiedPage = await extension.context.newPage();
    copiedPage.on("pageerror", (error) => pageErrors.push(error.message));
    await copiedPage.goto(copiedUrl);
    const copiedNode = await copiedPage
      .locator("[data-layout-probe='integrity-copied']")
      .evaluateHandle((element) => element.firstChild as Text);
    const coldStart = stageRequests().length;
    await sendTopFrameMessage(extension.worker, copiedUrl, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await waitForState(extension.worker, copiedUrl, "translated");
    await expect(
      copiedPage.locator("[data-layout-probe='integrity-copied']"),
    ).toHaveText(copiedSource);
    const cold = stageRequests().slice(coldStart);
    expect(
      cold
        .flatMap(({ requests }) => requests)
        .filter((request) => request.includes(copiedSource)),
    ).toHaveLength(1);
    expect(cold.map(({ sourceLanguage }) => sourceLanguage)).toEqual(["en"]);
    await sendTopFrameMessage(extension.worker, copiedUrl, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, copiedUrl, "original");
    expect(
      await copiedPage
        .locator("[data-layout-probe='integrity-copied']")
        .evaluate(
          (element, original) =>
            element.firstChild === original &&
            element.textContent === "Account name",
          copiedNode,
        ),
    ).toBe(true);

    const warmStart = stageRequests().length;
    await sendTopFrameMessage(extension.worker, copiedUrl, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await waitForState(extension.worker, copiedUrl, "translated");
    expect(stageRequests()).toHaveLength(warmStart);
    await sendTopFrameMessage(extension.worker, copiedUrl, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, copiedUrl, "original");
    await copiedNode.dispose();
    await copiedPage.close();
    const cacheKeys = Object.keys(
      await readExtensionDatabase(extension.worker),
    );
    expect(
      cacheKeys.some((key) =>
        key.startsWith("translationCache:openai:v10:record:gpt-5-nano:ja:en:"),
      ),
    ).toBe(true);
    expect(
      cacheKeys.some((key) =>
        key.startsWith("translationCache:openai:v10:record:gpt-5-nano:en:en:"),
      ),
    ).toBe(true);
    // No client-Google namespace is written, and OpenAI-provenance results
    // never enter the recovery chain.
    expect(
      cacheKeys.some(
        (key) =>
          key.startsWith("translationCache:google:") ||
          key.startsWith("translationCache:chain:"),
      ),
    ).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @provider-integrity CR-001 drains active batches after an early run failure and settles partial or error", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: (_targetLanguage, requests) =>
        requests.some((request) => request.includes("failure A"))
          ? 25
          : requests.some((request) => request.includes("failure B"))
            ? 160
            : 5,
      observeRequest: (request) => providerRequests.push(request),
      reply: (requests) =>
        requests.some(
          (request) =>
            request.includes("CR001 partial failure A") ||
            request.includes("CR001 error failure"),
        )
          ? { status: 400 }
          : {},
    });
    const longSource = (label: string) => Array(32).fill(label).join(" ");

    for (const scenario of [
      { accepted: true, expectedState: "partial", name: "partial" },
      { accepted: false, expectedState: "error", name: "error" },
    ] as const) {
      const sources = ["A", "B", "C"].map((suffix) =>
        longSource(`CR001 ${scenario.name} failure ${suffix}`),
      );
      expect(sources.every((source) => source.length > 600)).toBe(true);
      const title = `CR001 ${scenario.name} retained title`;
      const url = `${fixture.url}?cr001-${scenario.name}`;
      await extension.context.route(url, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html lang="en"><head><title>${scenario.accepted ? title : ""}</title><style>p{font:10px/10px sans-serif;margin:0}</style></head><body><main>${sources.map((source, index) => `<p data-layout-probe="cr001-${scenario.name}-${index}">${source}</p>`).join("")}</main></body></html>`,
        }),
      );
      const page = await extension.context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(url);
      const before = providerRequests.length;
      const terminal = (await sendTopFrameMessage(extension.worker, url, {
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      })) as Record<string, unknown>;
      expect(terminal).toMatchObject({ state: scenario.expectedState });
      await waitForState(extension.worker, url, scenario.expectedState);

      const calls = providerRequests.slice(before);
      const callsFor = (source: string) =>
        calls.filter(({ requests }) =>
          requests.some((request) => request.includes(source)),
        );
      expect(callsFor(sources[0]!)).toHaveLength(1);
      expect(callsFor(sources[1]!)).toHaveLength(1);
      expect(callsFor(sources[2]!)).toHaveLength(0);
      expect(callsFor(sources[0]!)[0]?.status).toBe(400);
      expect(callsFor(sources[1]!)[0]?.status).toBe(
        scenario.accepted ? 200 : 400,
      );
      expect(
        calls
          .filter(({ requests }) =>
            requests.some((request) => request.includes("CR001")),
          )
          .every(({ completedAt }) => completedAt !== undefined),
      ).toBe(true);
      expect(
        Math.max(...calls.map(({ activeRequests }) => activeRequests)),
      ).toBeLessThanOrEqual(2);
      const settledCallCount = providerRequests.length;
      await waitForSchedulerTicks(page, 4);
      expect(providerRequests).toHaveLength(settledCallCount);

      await expect(
        page.locator(`[data-layout-probe='cr001-${scenario.name}-0']`),
      ).toHaveText(sources[0]!);
      if (scenario.accepted)
        await expect(
          page.locator("[data-layout-probe='cr001-partial-1']"),
        ).not.toHaveText(sources[1]!);
      else
        await expect(
          page.locator("[data-layout-probe='cr001-error-1']"),
        ).toHaveText(sources[1]!);

      const popup = await openPopupForTab(extension, page);
      await expect(popup.getByRole("status")).toHaveText(
        scenario.accepted ? "" : "Couldn’t translate this page. Try again.",
      );
      await expect(popup.getByRole("status")).not.toHaveText("Translating…");
      if (scenario.accepted)
        await expect(
          popup.getByRole("button", { name: "Show original" }),
        ).toBeEnabled();
      await popup.close();
      await page.close();
    }
    expect(pageErrors).toEqual([]);
  });

  // ADR 0014: after a backend run failure the remaining records never reach
  // the backend but each still gets its one on-device attempt (lessons:
  // "one backend stage → one browser-native attempt → unresolved").
  test("@deterministic @provider-integrity CR-001 sends untouched initial records only to native after the backend fails the active batch", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    const sources = ["A", "B", "C"].map((suffix) =>
      Array(140).fill(`請求失敗${suffix}`).join(" "),
    );
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: (_targetLanguage, requests) =>
        requests.some((request) => request.includes(sources[0]!)) ? 25 : 180,
      observeRequest: (request) => providerRequests.push(request),
      reply: (requests) =>
        requests.some((request) => request.includes(sources[0]!))
          ? { status: 400 }
          : {},
    });
    await extension.worker.evaluate(async () => {
      const nativeGlobal = globalThis as unknown as {
        __tryhandCr001NativeCalls?: string[];
        Translator?: {
          availability: () => Promise<string>;
          create: (options: {
            monitor: (monitor: {
              addEventListener: (
                type: string,
                listener: (event: { loaded: number; total: number }) => void,
              ) => void;
            }) => void;
          }) => Promise<{
            translate: (text: string) => Promise<string>;
            destroy: () => void;
          }>;
        };
        browser: {
          tabs: { detectLanguage: () => Promise<string> };
        };
      };
      const calls: string[] = [];
      nativeGlobal.__tryhandCr001NativeCalls = calls;
      nativeGlobal.Translator = {
        availability: async () => "available",
        async create({ monitor }) {
          monitor({
            addEventListener(_type, listener) {
              listener({ loaded: 1, total: 1 });
            },
          });
          return {
            async translate(text) {
              calls.push(text);
              return "Recovered failed active batch";
            },
            destroy: () => undefined,
          };
        },
      };
      nativeGlobal.browser.tabs.detectLanguage = async () => "ja";
    });
    const url = `${fixture.url}?cr001-native-recovery`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="ja"><head><title></title><style>p{height:24px;overflow:hidden;white-space:nowrap}</style></head><body><main>${sources.map((source, index) => `<p data-layout-probe="cr001-native-${index}">${source}</p>`).join("")}</main></body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);

    const terminal = await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    expect(terminal).toMatchObject({
      state: "translated",
      hasUnresolved: false,
    });
    await expect(
      page.locator("[data-layout-probe='cr001-native-0']"),
    ).toHaveText("Recovered failed active batch");
    await expect(
      page.locator("[data-layout-probe='cr001-native-1']"),
    ).not.toHaveText(sources[1]!);
    await expect(
      page.locator("[data-layout-probe='cr001-native-1']"),
    ).not.toHaveText("Recovered failed active batch");
    await expect(
      page.locator("[data-layout-probe='cr001-native-2']"),
    ).toHaveText("Recovered failed active batch");
    const callsFor = (source: string) =>
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes(source)),
      );
    expect(callsFor(sources[0]!)).toHaveLength(1);
    expect(callsFor(sources[1]!)).toHaveLength(1);
    expect(callsFor(sources[2]!)).toHaveLength(0);
    const nativeCalls = await extension.worker.evaluate(
      () =>
        (globalThis as unknown as { __tryhandCr001NativeCalls?: string[] })
          .__tryhandCr001NativeCalls ?? [],
    );
    // One on-device attempt each for the failed record and the untouched one;
    // the backend-accepted record never reaches native.
    expect([...nativeCalls].sort()).toEqual([sources[0]!, sources[2]!].sort());
    const settledCalls = providerRequests.length;
    await waitForSchedulerTicks(page, 4);
    expect(providerRequests).toHaveLength(settledCalls);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic initial viewport cohort dispatches once after scrolling away while two batches are active", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    const sources = ["A", "B", "C"].map((suffix) =>
      Array(32).fill(`Scroll active batch ${suffix}`).join(" "),
    );
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: (_targetLanguage, requests) =>
        requests.some(
          (request) =>
            request.includes(sources[0]!) || request.includes(sources[1]!),
        )
          ? 180
          : 5,
      observeRequest: (request) => providerRequests.push(request),
    });
    const url = `${fixture.url}?initial-scroll-cohort`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><head><title></title><style>body{min-height:5000px}p{height:24px;overflow:hidden;white-space:nowrap}</style></head><body><main>${sources.map((source, index) => `<p data-layout-probe="scroll-cohort-${index}">${source}</p>`).join("")}</main></body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    const before = providerRequests.length;
    const run = sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await expect
      .poll(
        () =>
          providerRequests
            .slice(before)
            .filter(({ requests }) =>
              requests.some(
                (request) =>
                  request.includes(sources[0]!) ||
                  request.includes(sources[1]!),
              ),
            ).length,
      )
      .toBe(2);
    await page.evaluate(() => window.scrollTo(0, 4000));

    expect(await run).toMatchObject({ state: "translated" });
    await waitForState(extension.worker, url, "translated");
    const callsFor = (source: string) =>
      providerRequests
        .slice(before)
        .filter(({ requests }) =>
          requests.some((request) => request.includes(source)),
        );
    for (const source of sources) expect(callsFor(source)).toHaveLength(1);
    await page.evaluate(() => window.scrollTo(0, 0));
    for (const [index, source] of sources.entries())
      await expect(
        page.locator(`[data-layout-probe='scroll-cohort-${index}']`),
      ).not.toHaveText(source);
    const settledCalls = providerRequests.length;
    await waitForSchedulerTicks(page, 4);
    expect(providerRequests).toHaveLength(settledCalls);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @provider-integrity CR-003 keeps a successful title on body failure and restores title and body exactly", async () => {
    const titleSource = "CR003 retained title";
    const bodySource = "CR003 body total failure";
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
      reply: (requests) =>
        requests.some((request) => request.includes(bodySource))
          ? { status: 400 }
          : {},
    });
    const url = `${fixture.url}?cr003-title-retention`;
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="en"><head><title>${titleSource}</title></head><body><main><p data-layout-probe="cr003-body">${bodySource}</p></main></body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    await page
      .locator("[data-layout-probe='cr003-body']")
      .evaluate((element) => {
        (window as Window & { __tryhandCr003Body?: Text }).__tryhandCr003Body =
          element.firstChild as Text;
      });

    const terminal = (await sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    })) as Record<string, unknown>;
    expect(terminal).toMatchObject({
      appliedTarget: "vi",
      hasUnresolved: true,
      state: "partial",
      translated: true,
    });
    await waitForState(extension.worker, url, "partial");
    await expect(page).not.toHaveTitle(titleSource);
    await expect(page.locator("[data-layout-probe='cr003-body']")).toHaveText(
      bodySource,
    );
    expect(
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes(titleSource)),
      ),
    ).toHaveLength(1);
    expect(
      providerRequests
        .filter(({ requests }) =>
          requests.some((request) => request.includes(bodySource)),
        )
        .map(({ status }) => status),
    ).toEqual([400]);

    const popup = await openPopupForTab(extension, page);
    await expect(popup.getByRole("status")).toBeEmpty();
    const showOriginal = popup.getByRole("button", { name: "Show original" });
    await expect(showOriginal).toBeEnabled();
    await showOriginal.click();
    await expect(popup.getByRole("status")).toHaveText("Original restored.");
    await waitForState(extension.worker, url, "original");
    await expect(page).toHaveTitle(titleSource);
    expect(
      await page
        .locator("[data-layout-probe='cr003-body']")
        .evaluate(
          (element, source) =>
            element.firstChild ===
              (window as Window & { __tryhandCr003Body?: Text })
                .__tryhandCr003Body && element.textContent === source,
          bodySource,
        ),
    ).toBe(true);
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    await popup.close();
    expect(pageErrors).toEqual([]);
  });

  test("@record-cache-performance @provider-latency prioritizes named UI, bounds 300-row cold/warm/partial/scroll work, and restores exactly", async () => {
    const namedRecords = [
      ["latency-basic", "基本情報", "Basic information"],
      ["latency-english", "Customer summary", "Translated Customer summary"],
      [
        "latency-duplicate-a",
        "Repeated English label",
        "Translated Repeated English label",
      ],
      [
        "latency-duplicate-b",
        "Repeated English label",
        "Translated Repeated English label",
      ],
      ["latency-amount", "当月請求額", "Invoice amount"],
      ["latency-filter-month", "請求月", "Billing month"],
      ["latency-overpayment", "過入金", "Overpayment"],
      ["latency-adjustment", "調整明細", "Adjustment details"],
      ["latency-invoice", "請求", "Invoice"],
      ["latency-total", "累計", "Cumulative"],
      ["latency-standard", "標準", "Standard"],
    ] as const;
    const titleSource = "請求管理";
    const partialAcceptedSource = "Accepted stable record cache label";
    const partialUnresolvedSource = "Record cache unresolved label";
    const fullViewportCompletionCeilingMs = 1_500;
    const providerRequests: DeterministicProviderRequest[] = [];
    let partialOpenAiAttempts = 0;
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: (_targetLanguage, requests) =>
        requests.some((request) => request.includes("明細行")) ? 260 : 40,
      // The backend's official Google fallback recovers the record OpenAI
      // missed inside the same stage.
      googleTranslate: (source, index, targetLanguage) =>
        translatedText(source, index, targetLanguage),
      observeRequest: (request) => providerRequests.push(request),
      openAiEntries: (sources, _requestNumber, targetLanguage) =>
        Object.fromEntries(
          Object.entries(sources).map(([id, text], index) => [
            id,
            text === partialUnresolvedSource && partialOpenAiAttempts++ === 0
              ? text
              : translatedText(text, index, targetLanguage),
          ]),
        ),
    });
    await extension.worker.evaluate(async () => {
      const extensionBrowser = (
        globalThis as unknown as {
          browser: {
            tabs: { detectLanguage: (tabId?: number) => Promise<string> };
          };
        }
      ).browser;
      extensionBrowser.tabs.detectLanguage = async () => "en";
    });

    const url = `${fixture.url}?provider-latency`;
    const rows = Array.from(
      { length: 300 },
      (_, index) =>
        `<tr><td data-layout-probe="latency-row-${index}">明細行 ${String(index).padStart(3, "0")} 顧客請求情報</td><td>¥${index + 1},000</td></tr>`,
    ).join("");
    await extension.context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>
              <html lang="en"><head><title>${titleSource}</title><style>
              body{font:14px system-ui;margin:0} header{padding:12px 20px} .labels{display:flex;gap:12px;flex-wrap:wrap}
              .labels>*{min-width:120px;padding:8px} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ddd;height:32px;padding:0 12px;text-align:left}
              thead{background:#f4f5f6;position:sticky;top:0}
            </style></head><body>
              <header><div class="labels">
                  <h1 data-layout-probe="latency-basic">基本情報</h1>
                  <button data-layout-probe="latency-english">Customer summary</button>
                  <button data-layout-probe="latency-duplicate-a">Repeated English label</button>
                  <button data-layout-probe="latency-duplicate-b">Repeated English label</button>
                <h2 data-layout-probe="latency-amount">当月請求額</h2>
                <button data-layout-probe="latency-filter-month">請求月</button>
                <button data-layout-probe="latency-overpayment">過入金</button>
                <h2 data-layout-probe="latency-adjustment">調整明細</h2>
                <button data-layout-probe="latency-standard">標準</button>
              </div></header>
              <table><thead><tr><th data-layout-probe="latency-invoice">請求</th><th data-layout-probe="latency-total">累計</th></tr></thead><tbody>${rows}</tbody></table>
            </body></html>`,
      }),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url);
    await page.evaluate(
      (probes) => {
        type LatencyWindow = Window & {
          __tryhandLatencyOriginal?: {
            nodes: { node: Text; source: string }[];
            title: string;
          };
        };
        const nodes = probes.map((probe) => {
          const node = document.querySelector(
            `[data-layout-probe='${probe}']`,
          )?.firstChild;
          if (!(node instanceof Text)) throw new Error(`Missing ${probe}`);
          return { node, source: node.data };
        });
        for (const probe of ["latency-row-0", "latency-row-299"]) {
          const node = document.querySelector(
            `[data-layout-probe='${probe}']`,
          )?.firstChild;
          if (!(node instanceof Text)) throw new Error(`Missing ${probe}`);
          nodes.push({ node, source: node.data });
        }
        (window as LatencyWindow).__tryhandLatencyOriginal = {
          nodes,
          title: document.title,
        };
      },
      namedRecords.map(([probe]) => probe),
    );

    // Stage evidence; Google evidence entries describe work inside a stage.
    const requestsFor = (provider: "google" | "openai") =>
      providerRequests.filter((request) => request.provider === provider);
    interface RecordCacheSummary {
      attemptedRecords: number;
      completeMs: number;
      discoveredRecords: number;
      localCacheHits: number;
      localCacheInvalid: number;
      localCacheMisses: number;
      maxViewportCommitMs: number;
      maxViewportDispatchMs: number;
      provider: "openai";
      googleFallbackAccepted: number;
      providerAccepted: number;
      providerRejected: number;
      requestCount: number;
      storageReadCalls: number;
      storageWriteCalls: number;
    }
    const readDiagnostics = () =>
      readTranslationRuns(extension.worker) as unknown as Promise<
        RecordCacheSummary[]
      >;
    const waitForDiagnostic = async (previousCount: number) => {
      await expect
        .poll(async () => (await readDiagnostics()).length)
        .toBeGreaterThan(previousCount);
      return (await readDiagnostics()).at(-1)!;
    };
    await extension.worker.evaluate(() => {
      interface CacheWriteEvidence {
        calls: number;
        entries: number;
      }
      const extensionGlobal = globalThis as unknown as {
        __tryhandRecordCacheWrites?: CacheWriteEvidence;
      };
      const evidence = { calls: 0, entries: 0 };
      extensionGlobal.__tryhandRecordCacheWrites = evidence;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        if (typeof key === "string" && key.startsWith("translationCache:")) {
          evidence.calls += 1;
          evidence.entries += 1;
        }
        return key === undefined
          ? put.call(this, value)
          : put.call(this, value, key);
      };
    });
    const readCacheWrites = () =>
      extension.worker.evaluate(
        () =>
          (
            globalThis as unknown as {
              __tryhandRecordCacheWrites?: {
                calls: number;
                entries: number;
              };
            }
          ).__tryhandRecordCacheWrites ?? { calls: 0, entries: 0 },
      );
    const resetTimeline = () =>
      page.evaluate(() => {
        interface LongTaskEvidence {
          attribution: {
            containerId?: string;
            containerName?: string;
            containerSrc?: string;
            containerType?: string;
            duration: number;
            entryType: string;
            name: string;
            startMs: number;
          }[];
          duration: number;
          entryType: string;
          name: string;
          startMs: number;
        }
        interface LatencyTimeline {
          bulkAt?: number;
          disconnect: () => void;
          firstAcceptedAt?: number;
          longTaskSupported: boolean;
          longTasks: LongTaskEvidence[];
          priorityAt?: number;
          startedAt: number;
        }
        type LatencyWindow = Window & {
          __tryhandLatencyTimeline?: LatencyTimeline;
        };
        const startedAt = performance.now();
        const longTasks: LongTaskEvidence[] = [];
        const longTaskSupported =
          PerformanceObserver.supportedEntryTypes.includes("longtask");
        const performanceObserver = longTaskSupported
          ? new PerformanceObserver((list) =>
              list.getEntries().forEach((entry) => {
                const attributed = entry as PerformanceEntry & {
                  attribution?: (PerformanceEntry & {
                    containerId?: string;
                    containerName?: string;
                    containerSrc?: string;
                    containerType?: string;
                  })[];
                };
                longTasks.push({
                  attribution: (attributed.attribution ?? []).map((item) => ({
                    ...(item.containerId
                      ? { containerId: item.containerId }
                      : {}),
                    ...(item.containerName
                      ? { containerName: item.containerName }
                      : {}),
                    ...(item.containerSrc
                      ? { containerSrc: item.containerSrc }
                      : {}),
                    ...(item.containerType
                      ? { containerType: item.containerType }
                      : {}),
                    duration: item.duration,
                    entryType: item.entryType,
                    name: item.name,
                    startMs: item.startTime - startedAt,
                  })),
                  duration: entry.duration,
                  entryType: entry.entryType,
                  name: entry.name,
                  startMs: entry.startTime - startedAt,
                });
              }),
            )
          : undefined;
        performanceObserver?.observe({ entryTypes: ["longtask"] });
        const timeline: LatencyTimeline = {
          longTaskSupported,
          longTasks,
          startedAt,
          disconnect: () => undefined,
        };
        const mark = () => {
          const now = performance.now() - startedAt;
          if (
            timeline.priorityAt === undefined &&
            document.querySelector("[data-layout-probe='latency-basic']")
              ?.textContent === "Basic information"
          )
            timeline.priorityAt = now;
          if (
            timeline.bulkAt === undefined &&
            document.querySelector("[data-layout-probe='latency-row-0']")
              ?.textContent === "Translated row 000"
          )
            timeline.bulkAt = now;
          timeline.firstAcceptedAt ??= timeline.priorityAt ?? timeline.bulkAt;
        };
        const mutationObserver = new MutationObserver(mark);
        mutationObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ["placeholder"],
          characterData: true,
          childList: true,
          subtree: true,
        });
        timeline.disconnect = () => {
          mutationObserver.disconnect();
          performanceObserver?.disconnect();
        };
        (window as LatencyWindow).__tryhandLatencyTimeline = timeline;
      });
    const finishTimeline = () =>
      page.evaluate(() => {
        interface LongTaskEvidence {
          attribution: {
            containerId?: string;
            containerName?: string;
            containerSrc?: string;
            containerType?: string;
            duration: number;
            entryType: string;
            name: string;
            startMs: number;
          }[];
          duration: number;
          entryType: string;
          name: string;
          startMs: number;
        }
        type LatencyWindow = Window & {
          __tryhandLatencyTimeline?: {
            bulkAt?: number;
            disconnect: () => void;
            firstAcceptedAt?: number;
            longTaskSupported: boolean;
            longTasks: LongTaskEvidence[];
            priorityAt?: number;
            startedAt: number;
          };
        };
        const timeline = (window as LatencyWindow).__tryhandLatencyTimeline;
        if (!timeline) throw new Error("Missing latency timeline");
        timeline.disconnect();
        return {
          bulkAt: timeline.bulkAt,
          completionMs: performance.now() - timeline.startedAt,
          firstAcceptedAt: timeline.firstAcceptedAt,
          longTaskSupported: timeline.longTaskSupported,
          longTasks: timeline.longTasks,
          priorityAt: timeline.priorityAt,
          startedAtEpoch: performance.timeOrigin + timeline.startedAt,
        };
      });
    const expectExactRestore = async () => {
      expect(
        await page.evaluate(() => {
          type LatencyWindow = Window & {
            __tryhandLatencyOriginal?: {
              nodes: { node: Text; source: string }[];
              title: string;
            };
          };
          const original = (window as LatencyWindow).__tryhandLatencyOriginal!;
          return {
            nodes: original.nodes.every(
              ({ node, source }) => node.isConnected && node.data === source,
            ),
            title: document.title === original.title,
          };
        }),
      ).toEqual({ nodes: true, title: true });
      await expect(
        page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
      ).toHaveCount(0);
    };

    {
      // The backend routes engines (ADR 0014); every run reports `openai`.
      const provider = "openai" as const;
      await page.evaluate(() => window.scrollTo(0, 0));
      const diagnosticsBeforeCold = (await readDiagnostics()).length;
      const writesBeforeCold = await readCacheWrites();
      const coldStart = requestsFor(provider).length;
      await resetTimeline();
      const coldRun = sendTopFrameMessage(extension.worker, url, {
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      await expect(
        page.locator("[data-layout-probe='latency-basic']"),
      ).toHaveText("Basic information");
      await coldRun;
      await waitForState(extension.worker, url, "translated");
      await expect(
        page.locator("[data-layout-probe='latency-row-0']"),
      ).toHaveText("Translated row 000");
      const timeline = await finishTimeline();
      const coldRequests = requestsFor(provider).slice(coldStart);
      const diagnosedColdRequests = coldRequests;
      const coldSummary = await waitForDiagnostic(diagnosticsBeforeCold);
      const writesAfterCold = await readCacheWrites();
      const longTaskDiagnostics = timeline.longTasks.map((task) => ({
        ...task,
        phase:
          timeline.priorityAt === undefined ||
          task.startMs < timeline.priorityAt
            ? "before-priority"
            : timeline.bulkAt === undefined || task.startMs < timeline.bulkAt
              ? "priority-to-bulk"
              : task.startMs < timeline.completionMs
                ? "bulk-to-completion"
                : "after-completion",
        overlappingRequests: coldRequests.flatMap((request, index) => {
          const startMs = request.at - timeline.startedAtEpoch;
          const endMs =
            (request.responseReadyAt ?? request.completedAt ?? request.at) -
            timeline.startedAtEpoch;
          const overlaps =
            startMs <= task.startMs + task.duration && endMs >= task.startMs;
          return overlaps
            ? [
                {
                  endMs,
                  index,
                  mode: request.mode,
                  provider: request.provider,
                  records: request.recordCount,
                  startMs,
                },
              ]
            : [];
        }),
      }));
      const maxLongTaskMs = Math.max(
        0,
        ...timeline.longTasks.map(({ duration }) => duration),
      );
      const totalBlockingMs = timeline.longTasks.reduce(
        (total, { duration }) => total + Math.max(0, duration - 50),
        0,
      );
      expect(timeline.longTaskSupported).toBe(true);
      const longTaskMessage = JSON.stringify(
        {
          bulkAt: timeline.bulkAt,
          completionMs: timeline.completionMs,
          longTasks: longTaskDiagnostics,
          maxLongTaskMs,
          priorityAt: timeline.priorityAt,
          provider,
          totalBlockingMs,
        },
        null,
        2,
      );
      expect(timeline.longTasks.length, longTaskMessage).toBeLessThanOrEqual(1);
      expect(timeline.completionMs, longTaskMessage).toBeLessThanOrEqual(
        fullViewportCompletionCeilingMs,
      );
      expect(maxLongTaskMs, longTaskMessage).toBeLessThanOrEqual(60);
      expect(totalBlockingMs, longTaskMessage).toBeLessThanOrEqual(10);
      expect(
        timeline.longTasks.some(({ duration }) => duration > 100),
        longTaskMessage,
      ).toBe(false);
      expect(timeline.firstAcceptedAt).toBeDefined();
      expect(timeline.priorityAt).toBeDefined();
      expect(timeline.bulkAt).toBeDefined();
      expect(timeline.priorityAt!).toBeLessThan(timeline.bulkAt!);
      expect(coldSummary).toMatchObject({
        localCacheHits: 0,
        localCacheInvalid: 0,
        provider,
        providerRejected: 0,
        requestCount: diagnosedColdRequests.length,
      });
      expect(coldSummary.localCacheMisses).toBe(
        diagnosedColdRequests.reduce(
          (total, request) => total + request.recordCount,
          0,
        ),
      );
      expect(coldSummary.providerAccepted).toBe(coldSummary.localCacheMisses);
      expect(coldSummary.storageReadCalls).toBeGreaterThan(0);
      expect(coldSummary.storageWriteCalls).toBeGreaterThan(0);
      expect(writesAfterCold.calls).toBeGreaterThan(writesBeforeCold.calls);

      for (const [probe, , translation] of namedRecords)
        await expect(page.locator(`[data-layout-probe='${probe}']`)).toHaveText(
          translation,
        );
      await expect(page).toHaveTitle("Invoice management");
      await expect(
        page.locator("[data-layout-probe='latency-row-299']"),
      ).toHaveText("明細行 299 顧客請求情報");

      expect(coldRequests.length).toBeGreaterThan(0);
      expect(coldRequests.some(({ recordCount }) => recordCount > 1)).toBe(
        true,
      );
      expect(
        coldRequests
          .flatMap(({ requests }) => requests)
          .filter((request) => request.includes("Repeated English label")),
      ).toHaveLength(1);
      const maxActiveRequests = Math.max(
        ...coldRequests.map(({ activeRequests }) => activeRequests),
      );
      expect(
        maxActiveRequests,
        JSON.stringify(
          {
            maxActiveRequests,
            provider,
            requests: coldRequests.map(
              ({ activeRequests, mode, recordCount, sourceLanguage }) => ({
                activeRequests,
                mode,
                recordCount,
                sourceLanguage,
              }),
            ),
          },
          null,
          2,
        ),
      ).toBeLessThanOrEqual(4);
      expect(
        coldRequests.some(({ requests }) =>
          requests.some((request) => request.includes("明細行 299")),
        ),
      ).toBe(false);
      expect(requestsFor("google").slice(coldStart)).toHaveLength(0);
      {
        const primary = coldRequests.filter(({ status }) => status === 200);
        const content = primary.filter(
          ({ requests }) => !requests.includes(titleSource),
        );
        const openAiDispatchOrder = coldRequests.map((request, position) => ({
          characters: request.characters,
          kind: request.requests.includes(titleSource)
            ? "title"
            : request.requests.some((source) => source.includes("明細行"))
              ? "bulk"
              : "priority",
          labels: request.requests.slice(0, 6),
          mode: request.mode,
          position,
          records: request.recordCount,
          relativeDispatchMs: request.at - timeline.startedAtEpoch,
        }));
        expect(
          coldRequests.length,
          JSON.stringify({ openAiDispatchOrder }, null, 2),
        ).toBeLessThanOrEqual(3);
        expect(content.length).toBeLessThanOrEqual(2);
        expect(coldRequests.every(({ mode }) => mode === "primary")).toBe(true);
        expect(
          new Set(
            coldRequests.flatMap(({ sourceLanguages = {} }) =>
              Object.values(sourceLanguages),
            ),
          ),
        ).toEqual(new Set(["en", "ja"]));
        for (const request of coldRequests) {
          const routes = request.sourceLanguages ?? {};
          expect(Object.keys(routes)).toHaveLength(request.recordCount);
          expect(Object.keys(routes)).toEqual(
            request.requests.map((_, index) => `r${index}`),
          );
        }
        for (const request of primary) {
          const bulk = request.requests.some((source) =>
            source.includes("明細行"),
          );
          expect(request.recordCount).toBeLessThanOrEqual(bulk ? 128 : 24);
          expect(request.characters).toBeLessThanOrEqual(bulk ? 8_000 : 600);
          expect(request.encodedCharacters).toBeLessThanOrEqual(8_000);
        }
      }

      const durations = coldRequests
        .map(({ durationMs }) => durationMs)
        .filter((duration): duration is number => duration !== undefined)
        .sort((left, right) => left - right);
      const percentile = (ratio: number) =>
        durations[Math.max(0, Math.ceil(durations.length * ratio) - 1)] ?? 0;
      await test.info().attach(`${provider}-provider-latency`, {
        body: Buffer.from(
          JSON.stringify(
            {
              activeMax: Math.max(
                ...coldRequests.map(({ activeRequests }) => activeRequests),
              ),
              characters: coldRequests.reduce(
                (total, request) => total + request.characters,
                0,
              ),
              completionMs: timeline.completionMs,
              firstAcceptedMs: timeline.firstAcceptedAt,
              longTasks: longTaskDiagnostics,
              longTaskTotalBlockingMs: totalBlockingMs,
              maxLongTaskMs,
              maxMs: durations.at(-1) ?? 0,
              p50Ms: percentile(0.5),
              p95Ms: percentile(0.95),
              records: coldRequests.reduce(
                (total, request) => total + request.recordCount,
                0,
              ),
              requests: coldRequests.length,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });

      await sendTopFrameMessage(extension.worker, url, {
        type: "SHOW_ORIGINAL",
      });
      await waitForState(extension.worker, url, "original");
      await expectExactRestore();

      const diagnosticsBeforeWarm = (await readDiagnostics()).length;
      const warmStart = requestsFor(provider).length;
      const writesBeforeWarm = await readCacheWrites();
      await resetTimeline();
      await sendTopFrameMessage(extension.worker, url, {
        type: "START_TRANSLATION",
        targetLanguage: "en",
      });
      await waitForState(extension.worker, url, "translated");
      const warmTimeline = await finishTimeline();
      const warmSummary = await waitForDiagnostic(diagnosticsBeforeWarm);
      const writesAfterWarm = await readCacheWrites();
      expect(requestsFor(provider)).toHaveLength(warmStart);
      expect(warmTimeline.completionMs).toBeLessThanOrEqual(500);
      expect(warmTimeline.completionMs).toBeLessThanOrEqual(
        timeline.completionMs * 0.5,
      );
      expect(warmSummary).toMatchObject({
        localCacheInvalid: 0,
        localCacheMisses: 0,
        provider,
        providerAccepted: 0,
        providerRejected: 0,
        requestCount: 0,
        storageWriteCalls: 0,
      });
      expect(warmSummary.localCacheHits).toBeGreaterThan(0);
      expect(warmSummary.storageReadCalls).toBeGreaterThan(0);
      expect(writesAfterWarm).toEqual(writesBeforeWarm);
      for (const [probe, , translation] of namedRecords)
        await expect(page.locator(`[data-layout-probe='${probe}']`)).toHaveText(
          translation,
        );
      const translatedPopup = await openPopupForTab(extension, page);
      await expect(
        translatedPopup.getByRole("button", {
          name: "Translated",
          exact: true,
        }),
      ).toBeDisabled();
      await translatedPopup.close();

      const beforeLazyScroll = requestsFor(provider).length;
      const writesBeforeLazyScroll = await readCacheWrites();
      const scrollStartedAt = Date.now();
      await page
        .locator("[data-layout-probe='latency-row-299']")
        .scrollIntoViewIfNeeded();
      await expect
        .poll(
          () =>
            requestsFor(provider)
              .slice(beforeLazyScroll)
              .find(({ requests }) =>
                requests.some((request) => request.includes("明細行 299")),
              )?.at,
          { timeout: 1_500 },
        )
        .toBeDefined();
      const scrollDispatchAt = requestsFor(provider)
        .slice(beforeLazyScroll)
        .find(({ requests }) =>
          requests.some((request) => request.includes("明細行 299")),
        )!.at;
      expect(scrollDispatchAt - scrollStartedAt).toBeLessThanOrEqual(600);
      await expect(
        page.locator("[data-layout-probe='latency-row-299']"),
      ).toHaveText("Translated row 299", { timeout: 1_500 });
      const scrollCommitMs = Date.now() - scrollStartedAt;
      expect(scrollCommitMs).toBeLessThanOrEqual(1_500);
      await waitForState(extension.worker, url, "translated");
      expect(requestsFor(provider).length).toBeGreaterThan(beforeLazyScroll);
      expect(
        requestsFor(provider)
          .slice(beforeLazyScroll)
          .some(({ requests }) =>
            requests.some((request) => request.includes("明細行 299")),
          ),
      ).toBe(true);
      const writesAfterLazyScroll = await readCacheWrites();
      expect(writesAfterLazyScroll.calls).toBeGreaterThan(
        writesBeforeLazyScroll.calls,
      );
      expect(
        await page.evaluate(() => {
          const original = (
            window as Window & {
              __tryhandLatencyOriginal?: {
                nodes: { node: Text; source: string }[];
              };
            }
          ).__tryhandLatencyOriginal!;
          const node = document.querySelector(
            "[data-layout-probe='latency-row-299']",
          )?.firstChild;
          return (
            node ===
            original.nodes.find(({ source }) => source.includes("明細行 299"))
              ?.node
          );
        }),
      ).toBe(true);

      await page.evaluate(() => {
        type ScrollBackWindow = Window & {
          __tryhandScrollBackLongTasks?: {
            durations: number[];
            observer?: PerformanceObserver;
          };
        };
        const evidence: NonNullable<
          ScrollBackWindow["__tryhandScrollBackLongTasks"]
        > = { durations: [] };
        if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
          evidence.observer = new PerformanceObserver((list) =>
            list
              .getEntries()
              .forEach((entry) => evidence.durations.push(entry.duration)),
          );
          evidence.observer.observe({ entryTypes: ["longtask"] });
        }
        (window as ScrollBackWindow).__tryhandScrollBackLongTasks = evidence;
      });
      const beforeScrollBack = requestsFor(provider).length;
      const writesBeforeScrollBack = await readCacheWrites();
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitForSchedulerTicks(page, 2);
      expect(requestsFor(provider)).toHaveLength(beforeScrollBack);
      expect(await readCacheWrites()).toEqual(writesBeforeScrollBack);
      const scrollBackLongTasks = await page.evaluate(() => {
        const evidence = (
          window as Window & {
            __tryhandScrollBackLongTasks?: {
              durations: number[];
              observer?: PerformanceObserver;
            };
          }
        ).__tryhandScrollBackLongTasks;
        evidence?.observer?.disconnect();
        return evidence?.durations ?? [];
      });
      expect(Math.max(0, ...scrollBackLongTasks)).toBeLessThanOrEqual(50);
      expect(
        await page.evaluate(() => {
          const original = (
            window as Window & {
              __tryhandLatencyOriginal?: {
                nodes: { node: Text; source: string }[];
              };
            }
          ).__tryhandLatencyOriginal!;
          return original.nodes.every(({ node }) => node.isConnected);
        }),
      ).toBe(true);

      await test.info().attach(`${provider}-record-cache-performance`, {
        body: Buffer.from(
          JSON.stringify(
            {
              cold: { summary: coldSummary, timeline },
              coldRequests,
              scroll: {
                commitMs: scrollCommitMs,
                dispatchMs: scrollDispatchAt - scrollStartedAt,
                scrollBackLongTasks,
              },
              warm: { summary: warmSummary, timeline: warmTimeline },
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      await sendTopFrameMessage(extension.worker, url, {
        type: "SHOW_ORIGINAL",
      });
      await waitForState(extension.worker, url, "original");
      await expectExactRestore();

      const partialUrl = `${fixture.url}?record-cache-partial`;
      await extension.context.route(partialUrl, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html lang="en"><head><title></title><style>body{font:14px system-ui;margin:0}header{padding:12px}.tail{margin-top:3000px}</style></head><body><header><button data-layout-probe="partial-accepted">${partialAcceptedSource}</button><button data-layout-probe="partial-unresolved">${partialUnresolvedSource}</button></header><table class="tail" contenteditable="true"><tbody>${rows}</tbody></table></body></html>`,
        }),
      );
      const partialPage = await extension.context.newPage();
      partialPage.on("pageerror", (error) => pageErrors.push(error.message));
      await partialPage.goto(partialUrl);
      await partialPage.evaluate(() => {
        const accepted = document.querySelector(
          "[data-layout-probe='partial-accepted']",
        )?.firstChild;
        const unresolved = document.querySelector(
          "[data-layout-probe='partial-unresolved']",
        )?.firstChild;
        if (!(accepted instanceof Text) || !(unresolved instanceof Text))
          throw new Error("Missing partial Text records");
        (
          window as Window & {
            __tryhandPartialRecords?: {
              accepted: Text;
              acceptedSource: string;
              acceptedWrites: number;
              unresolved: Text;
              unresolvedSource: string;
            };
          }
        ).__tryhandPartialRecords = {
          accepted,
          acceptedSource: accepted.data,
          acceptedWrites: 0,
          unresolved,
          unresolvedSource: unresolved.data,
        };
      });

      const diagnosticsBeforePartial = (await readDiagnostics()).length;
      const partialRequestStart = requestsFor(provider).length;
      const partialRun = sendTopFrameMessage(extension.worker, partialUrl, {
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      });
      await expect(
        partialPage.locator("[data-layout-probe='partial-accepted']"),
      ).not.toHaveText(partialAcceptedSource);
      await partialPage.evaluate(() => {
        const records = (
          window as Window & {
            __tryhandPartialRecords?: {
              accepted: Text;
              acceptedWrites: number;
            };
          }
        ).__tryhandPartialRecords!;
        new MutationObserver((mutations) => {
          records.acceptedWrites += mutations.filter(
            ({ type, target }) =>
              type === "characterData" && target === records.accepted,
          ).length;
        }).observe(records.accepted, { characterData: true });
      });
      await partialRun;
      await waitForState(extension.worker, partialUrl, "translated");
      const partialSummary = await waitForDiagnostic(diagnosticsBeforePartial);
      const partialRequests = requestsFor(provider).slice(partialRequestStart);
      // One stage: OpenAI accepts one record, the in-stage Google fallback
      // accepts the other, and no record is dispatched twice.
      expect(partialSummary).toMatchObject({
        attemptedRecords: 2,
        discoveredRecords: 2,
        localCacheHits: 0,
        localCacheInvalid: 0,
        localCacheMisses: 2,
        provider,
        googleFallbackAccepted: 1,
        providerAccepted: 2,
        providerRejected: 0,
        requestCount: 1,
      });
      expect(partialSummary.storageReadCalls).toBeGreaterThan(0);
      expect(partialSummary.storageWriteCalls).toBeGreaterThan(0);
      expect(
        partialRequests.reduce(
          (total, request) => total + request.recordCount,
          0,
        ),
      ).toBe(2);
      expect(
        partialRequests.filter(({ requests }) =>
          requests.some((request) => request.includes(partialAcceptedSource)),
        ),
      ).toHaveLength(1);
      expect(
        partialRequests.filter(({ requests }) =>
          requests.some((request) => request.includes(partialUnresolvedSource)),
        ),
      ).toHaveLength(1);
      expect(
        partialRequests.flatMap(({ provenance }) => provenance ?? []).sort(),
      ).toEqual(["google", "openai"]);
      expect(
        await partialPage.evaluate(() => {
          const records = (
            window as Window & {
              __tryhandPartialRecords?: {
                accepted: Text;
                acceptedWrites: number;
              };
            }
          ).__tryhandPartialRecords!;
          return {
            acceptedWrites: records.acceptedWrites,
            retained:
              records.accepted.isConnected &&
              document
                .querySelector("[data-layout-probe='partial-accepted']")
                ?.contains(records.accepted) === true,
          };
        }),
      ).toEqual({ acceptedWrites: 0, retained: true });
      await sendTopFrameMessage(extension.worker, partialUrl, {
        type: "SHOW_ORIGINAL",
      });
      await waitForState(extension.worker, partialUrl, "original");
      expect(
        await partialPage.evaluate(() => {
          const records = (
            window as Window & {
              __tryhandPartialRecords?: {
                accepted: Text;
                acceptedSource: string;
                unresolved: Text;
                unresolvedSource: string;
              };
            }
          ).__tryhandPartialRecords!;
          return (
            records.accepted.isConnected &&
            records.accepted.data === records.acceptedSource &&
            document.querySelector("[data-layout-probe='partial-accepted']")
              ?.firstChild === records.accepted &&
            records.unresolved.isConnected &&
            records.unresolved.data === records.unresolvedSource &&
            document.querySelector("[data-layout-probe='partial-unresolved']")
              ?.firstChild === records.unresolved
          );
        }),
      ).toBe(true);
      await expect(
        partialPage.locator("tryhand-ellipsis, tryhand-baseline-marker"),
      ).toHaveCount(0);
      await partialPage.close();
    }

    const cacheKeys = Object.keys(
      await readExtensionDatabase(extension.worker),
    );
    expect(
      cacheKeys.some((key) =>
        key.startsWith("translationCache:openai:v10:record:gpt-5-nano:ja:en:"),
      ),
    ).toBe(true);
    expect(
      cacheKeys.some((key) =>
        key.startsWith("translationCache:chain:v1:openai-google-native:en:vi:"),
      ),
    ).toBe(true);
    expect(
      cacheKeys.some((key) => key.startsWith("translationCache:google:")),
    ).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @provider-integrity @translation-first total provider failure stops once in error and restores without residue", async () => {
    const titleSource = "Layout stability fixture";
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
      reply: (requests) =>
        requests.some(
          (request) =>
            request.includes("Translation first nonretryable slot") ||
            request.includes(titleSource),
        )
          ? { status: 400 }
          : {},
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const section = document.querySelector(
        "[data-layout-probe='translation-first-retention']",
      )!;
      section.removeAttribute("contenteditable");
      for (const child of section.children)
        child.setAttribute("contenteditable", "true");
      section
        .querySelector("[data-layout-probe='translation-first-nonretryable']")
        ?.removeAttribute("contenteditable");
    });
    const target = page.locator(
      "[data-layout-probe='translation-first-nonretryable']",
    );
    await target.scrollIntoViewIfNeeded();
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "error");
    await waitForSchedulerTicks(page);
    expect(
      providerRequests
        .filter(({ requests }) =>
          requests.some((request) =>
            request.includes("Translation first nonretryable slot"),
          ),
        )
        .map(({ status }) => status),
    ).toEqual([400]);
    expect(
      providerRequests
        .filter(({ requests }) =>
          requests.some((request) => request.includes(titleSource)),
        )
        .map(({ status }) => status),
    ).toEqual([400]);
    await expect(page).toHaveTitle(titleSource);
    await expect(target).toHaveText("Translation first nonretryable slot");
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(page).toHaveTitle(titleSource);
    await expect(target).toHaveText("Translation first nonretryable slot");
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @translation-first delayed provider scroll sends and applies each visible record once", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: 425,
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='delayed-provider-scroll']")
        ?.removeAttribute("contenteditable");
      type AppliedTextWindow = Window & {
        __tryhandAppliedTexts?: string[];
      };
      const appliedWindow = window as AppliedTextWindow;
      appliedWindow.__tryhandAppliedTexts = [];
      const record = (node: Node) => {
        if (node instanceof Text) {
          appliedWindow.__tryhandAppliedTexts?.push(node.textContent ?? "");
          return;
        }
        node.childNodes.forEach(record);
      };
      new MutationObserver((records) => {
        for (const recordEntry of records) {
          if (recordEntry.type === "characterData") record(recordEntry.target);
          for (const node of recordEntry.addedNodes) record(node);
        }
      }).observe(document.body, {
        characterData: true,
        childList: true,
        subtree: true,
      });
    });

    const firstSource = "Delayed provider first record";
    const secondSource = "Delayed provider second record";
    await page
      .locator("[data-layout-probe='delayed-provider-first']")
      .scrollIntoViewIfNeeded();
    const start = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await expect
      .poll(
        () =>
          providerRequests.filter(({ requests }) =>
            requests.some((request) => request.includes(firstSource)),
          ).length,
      )
      .toBe(1);
    const second = page.locator(
      "[data-layout-probe='delayed-provider-second']",
    );
    const scrollAt = Date.now();
    await second.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          providerRequests.filter(({ requests }) =>
            requests.some((request) => request.includes(secondSource)),
          ).length,
      )
      .toBe(1);
    const secondRequest = providerRequests.find(({ requests }) =>
      requests.some((request) => request.includes(secondSource)),
    );
    expect(secondRequest).toBeDefined();
    expect(secondRequest!.at - scrollAt).toBeGreaterThanOrEqual(0);
    expect(secondRequest!.at - scrollAt).toBeLessThanOrEqual(500);

    await start;
    await expect(
      page.locator("[data-layout-probe='delayed-provider-first']"),
    ).toHaveText("Bản ghi đầu tiên từ nhà cung cấp chậm");
    await expect(second).toHaveText(
      "Bản ghi thứ hai vừa hiện trong khung nhìn",
    );
    await waitForSchedulerTicks(page);
    await expectRetainedProviderRecord(page, providerRequests, {
      probe: "delayed-provider-first",
      source: firstSource,
      translation: "Bản ghi đầu tiên từ nhà cung cấp chậm",
    });
    await expectRetainedProviderRecord(page, providerRequests, {
      probe: "delayed-provider-second",
      source: secondSource,
      translation: "Bản ghi thứ hai vừa hiện trong khung nhìn",
    });
    expect(
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes(firstSource)),
      ),
    ).toHaveLength(1);
    const appliedCounts = () =>
      page.evaluate(() => {
        type AppliedTextWindow = Window & {
          __tryhandAppliedTexts?: string[];
        };
        const applied =
          (window as AppliedTextWindow).__tryhandAppliedTexts ?? [];
        return [
          applied.filter(
            (text) => text === "Bản ghi đầu tiên từ nhà cung cấp chậm",
          ).length,
          applied.filter(
            (text) => text === "Bản ghi thứ hai vừa hiện trong khung nhìn",
          ).length,
        ];
      });
    const settled = await appliedCounts();
    expect(settled[0]).toBeGreaterThanOrEqual(1);
    expect(settled[1]).toBeGreaterThanOrEqual(1);
    await waitForSchedulerTicks(page);
    await waitForSchedulerTicks(page);
    expect(
      await appliedCounts(),
      "records must settle with no ongoing rewrites",
    ).toEqual(settled);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @openai-performance delayed multi-Text response retains the connected sibling once after its peer detaches", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: 425,
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const section = document.querySelector(
        "[data-layout-probe='stale-multi-text']",
      )!;
      section.removeAttribute("contenteditable");
      const kept = section.querySelector(
        "[data-layout-probe='stale-multi-kept']",
      )!.firstChild as Text;
      const detached = section.querySelector(
        "[data-layout-probe='stale-multi-detached']",
      )!.firstChild as Text;
      type StaleWindow = Window & {
        __tryhandStaleMulti?: {
          kept: Text;
          detached: Text;
          keptSource: string;
          detachedSource: string;
          keptWrites: number;
        };
      };
      const state = {
        kept,
        detached,
        keptSource: kept.data,
        detachedSource: detached.data,
        keptWrites: 0,
      };
      (window as StaleWindow).__tryhandStaleMulti = state;
      new MutationObserver((records) => {
        state.keptWrites += records.filter(
          (record) => record.type === "characterData" && record.target === kept,
        ).length;
      }).observe(kept, { characterData: true });
    });
    await page
      .locator("[data-layout-probe='stale-multi-text']")
      .scrollIntoViewIfNeeded();

    const run = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await expect
      .poll(
        () =>
          providerRequests.filter(({ requests }) =>
            requests.some((request) =>
              request.includes("Stale multi node kept"),
            ),
          ).length,
      )
      .toBe(1);
    await page
      .locator("[data-layout-probe='stale-multi-detached']")
      .evaluate((element) => element.remove());
    const kept = page.locator("[data-layout-probe='stale-multi-kept']");
    await expect(kept).toHaveText("Nút cùng nhóm vẫn được dịch một lần");
    await run;
    await waitForSchedulerTicks(page);
    expect(
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes("Stale multi node kept")),
      ),
    ).toHaveLength(1);
    expect(
      await kept.evaluate(() => {
        type StaleWindow = Window & {
          __tryhandStaleMulti?: {
            kept: Text;
            detached: Text;
            keptSource: string;
            detachedSource: string;
            keptWrites: number;
          };
        };
        const state = (window as StaleWindow).__tryhandStaleMulti!;
        return {
          identity:
            state.kept ===
            document.querySelector("[data-layout-probe='stale-multi-kept']")
              ?.firstChild,
          keptWrites: state.keptWrites,
          detachedConnected: state.detached.isConnected,
          detachedText: state.detached.data,
        };
      }),
    ).toEqual({
      identity: true,
      keptWrites: 1,
      detachedConnected: false,
      detachedText: "Stale multi node detached",
    });

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await kept.evaluate((element) => {
        type StaleWindow = Window & {
          __tryhandStaleMulti?: { kept: Text; keptSource: string };
        };
        const state = (window as StaleWindow).__tryhandStaleMulti!;
        return {
          identity: element.firstChild === state.kept,
          source: state.kept.data === state.keptSource,
        };
      }),
    ).toEqual({ identity: true, source: true });
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic scroll-invariant refresh avoids rewrites but recaptures real geometry", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='bounded-fixed-overflow']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
      document
        .querySelector("[data-layout-probe='bounded-fixed-cell']")
        ?.setAttribute("contenteditable", "true");
      const target = document.querySelector(
        "[data-layout-probe='bounded-fixed-overflow'] a",
      );
      (
        window as Window & { __tryhandRecaptureText?: Text }
      ).__tryhandRecaptureText = target?.firstChild as Text;
    });
    const cell = page.locator("[data-layout-probe='bounded-fixed-overflow']");
    await cell.scrollIntoViewIfNeeded();
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(cell).toHaveText("Bản dịch cố định rất dài vượt quá ô riêng");
    const requestsBeforeRefresh = providerBatches.length;
    const wrapper = cell.locator("tryhand-ellipsis.tryhand-ellipsis");
    const initialWrapperWidth = await wrapper.evaluate(
      (element) => element.getBoundingClientRect().width,
    );
    await cell.evaluate((element) => {
      type RefreshWindow = Window & { __tryhandRefreshWrites?: number };
      const refreshWindow = window as RefreshWindow;
      refreshWindow.__tryhandRefreshWrites = 0;
      new MutationObserver((records) => {
        refreshWindow.__tryhandRefreshWrites! += records.length;
      }).observe(element, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      window.scrollBy(0, Math.max(200, window.innerHeight));
    });
    await page.waitForTimeout(650);
    expect(
      await cell.evaluate(
        () =>
          (window as Window & { __tryhandRefreshWrites?: number })
            .__tryhandRefreshWrites,
      ),
    ).toBe(0);
    expect(providerBatches).toHaveLength(requestsBeforeRefresh);

    await cell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    expect(
      await cell.evaluate(
        () =>
          (window as Window & { __tryhandRefreshWrites?: number })
            .__tryhandRefreshWrites,
      ),
    ).toBe(0);

    await cell.evaluate((element) => {
      (element as HTMLElement).style.width = "100px";
    });
    await expect(wrapper).toHaveCount(1);
    await expect
      .poll(() =>
        wrapper.evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThan(initialWrapperWidth - 1);
    await expect(wrapper).toHaveAttribute(
      "title",
      "Bản dịch cố định rất dài vượt quá ô riêng",
    );
    expect(
      await cell.evaluate(
        () =>
          (window as Window & { __tryhandRefreshWrites?: number })
            .__tryhandRefreshWrites,
      ),
    ).toBeGreaterThan(0);
    expect(
      await cell.evaluate(() => {
        const wrapper = document.querySelector(
          "[data-layout-probe='bounded-fixed-overflow'] tryhand-ellipsis",
        );
        return (
          wrapper?.firstChild ===
          (window as Window & { __tryhandRecaptureText?: Text })
            .__tryhandRecaptureText
        );
      }),
    ).toBe(true);
    expect(providerBatches).toHaveLength(requestsBeforeRefresh);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(cell).toHaveText("Fixed overflow");
    expect(
      await cell.evaluate(
        (element) =>
          element.querySelector("a")?.firstChild ===
          (window as Window & { __tryhandRecaptureText?: Text })
            .__tryhandRecaptureText,
      ),
    ).toBe(true);
    await expect(wrapper).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @translation-first dynamic added nodes translate once and restore cleanly", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page
      .locator("[data-layout-probe='dynamic-added-nodes']")
      .scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
    });
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    const original = await page.evaluate(() => {
      type DynamicWindow = Window & { __tryhandDynamicTexts?: Text[] };
      const root = document.querySelector<HTMLElement>(
        "[data-layout-probe='dynamic-added-nodes']",
      )!;
      root.removeAttribute("contenteditable");
      const element = document.createElement("span");
      element.dataset.layoutProbe = "dynamic-element";
      element.textContent = "Dynamic Element";
      const textHost = document.createElement("span");
      textHost.dataset.layoutProbe = "dynamic-text";
      textHost.append("Dynamic Text");
      const fragment = document.createDocumentFragment();
      const fragmentHost = document.createElement("span");
      fragmentHost.dataset.layoutProbe = "dynamic-fragment";
      fragmentHost.textContent = "Dynamic Fragment";
      fragment.append(fragmentHost);
      root.append(element, textHost, fragment);
      (window as DynamicWindow).__tryhandDynamicTexts = [
        element.firstChild as Text,
        textHost.firstChild as Text,
        fragmentHost.firstChild as Text,
      ];
      return root.innerHTML;
    });
    const translated = [
      "Phần tử động đã được dịch",
      "Nút văn bản động đã được dịch",
      "Mảnh động đã được dịch",
    ];
    for (const [index, probe] of [
      "dynamic-element",
      "dynamic-text",
      "dynamic-fragment",
    ].entries())
      await expect(page.locator(`[data-layout-probe='${probe}']`)).toHaveText(
        translated[index]!,
      );
    await waitForState(extension.worker, fixture.url, "translated");
    for (const source of [
      "Dynamic Element",
      "Dynamic Text",
      "Dynamic Fragment",
    ])
      expect(
        providerRequests
          .flatMap(({ requests }) => requests)
          .filter((request) => request.includes(source)),
      ).toHaveLength(1);
    await waitForSchedulerTicks(page);
    for (const [index, source] of [
      "Dynamic Element",
      "Dynamic Text",
      "Dynamic Fragment",
    ].entries())
      await expectRetainedProviderRecord(page, providerRequests, {
        probe: ["dynamic-element", "dynamic-text", "dynamic-fragment"][index]!,
        source,
        translation: translated[index]!,
      });

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await page.evaluate(() => {
        type DynamicWindow = Window & { __tryhandDynamicTexts?: Text[] };
        const root = document.querySelector(
          "[data-layout-probe='dynamic-added-nodes']",
        )!;
        const texts = (window as DynamicWindow).__tryhandDynamicTexts ?? [];
        return {
          identities: [
            "dynamic-element",
            "dynamic-text",
            "dynamic-fragment",
          ].every(
            (probe, index) =>
              document.querySelector(`[data-layout-probe='${probe}']`)
                ?.firstChild === texts[index],
          ),
          html: root.innerHTML,
        };
      }),
    ).toEqual({ identities: true, html: original });
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic in-place Text.data and an added attribute-bearing root translate once and restore exactly", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
    });
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await page
      .locator("[data-layout-probe='dynamic-character-data']")
      .scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      type DynamicRootWindow = Window & {
        __tryhandDynamicCharacter?: Text;
        __tryhandDynamicAttribute?: HTMLInputElement;
      };
      const section = document.querySelector(
        "[data-layout-probe='dynamic-character-data']",
      )!;
      section.removeAttribute("contenteditable");
      const text = section.querySelector(
        "[data-layout-probe='dynamic-character-target']",
      )!.firstChild as Text;
      text.data = "Dynamic in-place source";
      const input = document.createElement("input");
      input.dataset.layoutProbe = "dynamic-attribute-root";
      input.title = "Dynamic attribute root";
      input.style.cssText = "position:fixed;inset:4px auto auto 4px";
      document.body.append(input);
      const dynamicWindow = window as DynamicRootWindow;
      dynamicWindow.__tryhandDynamicCharacter = text;
      dynamicWindow.__tryhandDynamicAttribute = input;
    });

    const text = page.locator("[data-layout-probe='dynamic-character-target']");
    const attribute = page.locator(
      "[data-layout-probe='dynamic-attribute-root']",
    );
    await expect(text).toHaveText("Văn bản cập nhật tại chỗ đã được dịch");
    await expect(attribute).toHaveAttribute(
      "title",
      "Thuộc tính gốc động đã được dịch",
    );
    await waitForState(extension.worker, fixture.url, "translated");
    for (const source of ["Dynamic in-place source", "Dynamic attribute root"])
      expect(
        providerRequests
          .flatMap(({ requests }) => requests)
          .filter((request) => request.includes(source)),
      ).toHaveLength(1);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await page.evaluate(() => {
        type DynamicRootWindow = Window & {
          __tryhandDynamicCharacter?: Text;
          __tryhandDynamicAttribute?: HTMLInputElement;
        };
        const dynamicWindow = window as DynamicRootWindow;
        return {
          textIdentity:
            document.querySelector(
              "[data-layout-probe='dynamic-character-target']",
            )?.firstChild === dynamicWindow.__tryhandDynamicCharacter,
          text: dynamicWindow.__tryhandDynamicCharacter?.data,
          attributeIdentity:
            document.querySelector(
              "[data-layout-probe='dynamic-attribute-root']",
            ) === dynamicWindow.__tryhandDynamicAttribute,
          title: dynamicWindow.__tryhandDynamicAttribute?.title,
        };
      }),
    ).toEqual({
      textIdentity: true,
      text: "Dynamic in-place source",
      attributeIdentity: true,
      title: "Dynamic attribute root",
    });
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @openai-performance overlapping delayed starts leave one active lazy pipeline and restore cleanly", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      delayMs: (targetLanguage) => (targetLanguage === "vi" ? 700 : 100),
      observeRequest: (request) => providerRequests.push(request),
      reply: (_requests, _requestNumber, targetLanguage) =>
        targetLanguage === "vi" ? { status: 500 } : {},
      translate: (source, index, targetLanguage) =>
        targetLanguage === "ja" && source.includes("Overlap scheduler source")
          ? "最新の日本語実行が保持されました"
          : targetLanguage === "ja" && source.includes("Overlap dynamic source")
            ? "動的レコードも最新の実行で翻訳されました"
            : translatedText(source, index, targetLanguage),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const section = document.querySelector(
        "[data-layout-probe='overlap-starts']",
      )!;
      section.removeAttribute("contenteditable");
      (
        window as Window & { __tryhandOverlapText?: Text }
      ).__tryhandOverlapText = section.querySelector(
        "[data-layout-probe='overlap-source']",
      )!.firstChild as Text;
    });
    await page
      .locator("[data-layout-probe='overlap-source']")
      .scrollIntoViewIfNeeded();

    const first = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await expect
      .poll(
        () =>
          providerRequests.filter(({ requests }) =>
            requests.some((request) =>
              request.includes("Overlap scheduler source"),
            ),
          ).length,
      )
      .toBe(1);
    const second = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "ja",
    });
    await Promise.all([first, second]);
    const target = page.locator("[data-layout-probe='overlap-source']");
    await expect(target).toHaveText("最新の日本語実行が保持されました");
    await expect
      .poll(
        () =>
          providerRequests.filter(
            ({ requests, targetLanguage }) =>
              targetLanguage === "vi" &&
              requests.some((request) =>
                request.includes("Overlap scheduler source"),
              ),
          ).length,
      )
      .toBe(1);
    const overlappingRequests = providerRequests.filter(({ requests }) =>
      requests.some((request) => request.includes("Overlap scheduler source")),
    );
    expect(overlappingRequests).toHaveLength(2);
    expect(
      overlappingRequests.filter(
        ({ targetLanguage, status }) =>
          targetLanguage === "ja" && status === 200,
      ),
    ).toHaveLength(1);
    expect(
      overlappingRequests.filter(
        ({ targetLanguage, status }) =>
          targetLanguage === "vi" && status === 500,
      ),
    ).toHaveLength(1);
    expect(
      Math.max(
        ...overlappingRequests.map(({ activeRequests }) => activeRequests),
      ),
    ).toBeLessThanOrEqual(2);
    expect(
      overlappingRequests.every(
        (request, index) =>
          index === 0 || request.at > overlappingRequests[index - 1]!.at,
      ),
    ).toBe(true);
    await page.waitForTimeout(1_250);
    expect(
      providerRequests.filter(
        ({ requests, targetLanguage }) =>
          targetLanguage === "vi" &&
          requests.some((request) =>
            request.includes("Overlap scheduler source"),
          ),
      ),
    ).toHaveLength(1);
    await expect(target).toHaveText("最新の日本語実行が保持されました");

    await page
      .locator("[data-layout-probe='overlap-starts']")
      .evaluate((section) => {
        const dynamic = document.createElement("span");
        dynamic.dataset.layoutProbe = "overlap-dynamic";
        dynamic.textContent = "Overlap dynamic source";
        section.append(dynamic);
      });
    await expect(
      page.locator("[data-layout-probe='overlap-dynamic']"),
    ).toHaveText("動的レコードも最新の実行で翻訳されました");
    await waitForSchedulerTicks(page);
    await expect(target).toHaveText("最新の日本語実行が保持されました");
    expect(
      providerRequests.filter(({ requests }) =>
        requests.some((request) => request.includes("Overlap dynamic source")),
      ),
    ).toHaveLength(1);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await target.evaluate(
        (element) =>
          element.firstChild ===
            (window as Window & { __tryhandOverlapText?: Text })
              .__tryhandOverlapText && element.textContent,
      ),
    ).toBe("Overlap scheduler source");
    const requestCountAfterRestore = providerRequests.length;
    await page
      .locator("[data-layout-probe='overlap-starts']")
      .evaluate((section) => section.append("Overlap dynamic source"));
    await page.waitForTimeout(2_100);
    expect(providerRequests).toHaveLength(requestCountAfterRestore);
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic cached recapture tracks protected peer geometry inside a fixed host", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const row = document.querySelector(
        "[data-layout-probe='gap-capacity-row']",
      )!;
      row.closest("section")!.removeAttribute("contenteditable");
      (
        window as Window & { __tryhandPeerGeometryText?: Text }
      ).__tryhandPeerGeometryText = row.querySelector(
        "[data-layout-probe='gap-capacity-text']",
      )!.firstChild as Text;
    });
    const row = page.locator("[data-layout-probe='gap-capacity-row']");
    await row.scrollIntoViewIfNeeded();
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    const wrapper = row.locator("tryhand-ellipsis");
    await expect(wrapper).toHaveAttribute(
      "title",
      "Nhãn khoảng cách rất dài phải nằm trong phần riêng",
    );
    const before = await row.evaluate((element) => {
      const icon = element.querySelector(".gap-capacity-icon")!;
      const suffix = element.querySelector(".gap-capacity-suffix")!;
      const wrapper = element.querySelector<HTMLElement>("tryhand-ellipsis")!;
      const rect = (target: Element): Rect => {
        const { x, y, width, height } = target.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        row: rect(element),
        icon: rect(icon),
        suffix: rect(suffix),
        gap: Number.parseFloat(getComputedStyle(element).columnGap),
        selectedWidth: Number.parseFloat(
          wrapper.style.getPropertyValue("--tryhand-inline-size"),
        ),
      };
    });
    const providerCountBeforeRecapture = providerRequests.length;

    await row.evaluate((element) => {
      const icon = element.querySelector<HTMLElement>(".gap-capacity-icon")!;
      const suffix = element.querySelector<HTMLElement>(
        ".gap-capacity-suffix",
      )!;
      icon.style.flexBasis = "32px";
      icon.style.width = "32px";
      suffix.style.transform = "translateX(-4px)";
    });
    await expect
      .poll(() =>
        wrapper.evaluate((element) =>
          Number.parseFloat(
            (element as HTMLElement).style.getPropertyValue(
              "--tryhand-inline-size",
            ),
          ),
        ),
      )
      .toBeLessThan(before.selectedWidth - 1);
    const after = await row.evaluate((element) => {
      const icon = element.querySelector(".gap-capacity-icon")!;
      const suffix = element.querySelector(".gap-capacity-suffix")!;
      const wrapper = element.querySelector<HTMLElement>("tryhand-ellipsis")!;
      const rect = (target: Element): Rect => {
        const { x, y, width, height } = target.getBoundingClientRect();
        return { x, y, width, height };
      };
      const wrapperRect = rect(wrapper);
      const suffixRect = rect(suffix);
      return {
        row: rect(element),
        icon: rect(icon),
        suffix: suffixRect,
        wrapperEnd: wrapperRect.x + wrapperRect.width,
        selectedWidth: Number.parseFloat(
          wrapper.style.getPropertyValue("--tryhand-inline-size"),
        ),
        identity:
          wrapper.firstChild ===
          (window as Window & { __tryhandPeerGeometryText?: Text })
            .__tryhandPeerGeometryText,
      };
    });
    expect(maxGeometryDelta([before.row, after.row])).toBeLessThanOrEqual(1);
    expect(after.icon.width - before.icon.width).toBeGreaterThan(1);
    expect(Math.abs(after.suffix.x - before.suffix.x)).toBeGreaterThan(1);
    expect(after.wrapperEnd).toBeLessThanOrEqual(
      after.suffix.x - before.gap + 1,
    );
    expect(after.selectedWidth).toBeLessThan(before.selectedWidth - 1);
    expect(after.identity).toBe(true);
    expect(providerRequests).toHaveLength(providerCountBeforeRecapture);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    const restored = await row.evaluate((element) => {
      const text = (window as Window & { __tryhandPeerGeometryText?: Text })
        .__tryhandPeerGeometryText;
      const icon = element.querySelector(".gap-capacity-icon")!;
      const suffix = element.querySelector(".gap-capacity-suffix")!;
      const rect = (target: Element): Rect => {
        const { x, y, width, height } = target.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        identity:
          element.querySelector("[data-layout-probe='gap-capacity-text']")
            ?.firstChild === text,
        source: text?.data,
        icon: rect(icon),
        suffix: rect(suffix),
      };
    });
    expect(restored.identity).toBe(true);
    expect(restored.source).toBe("Gap capacity source");
    expect(maxGeometryDelta([after.icon, restored.icon])).toBeLessThanOrEqual(
      1,
    );
    expect(
      maxGeometryDelta([after.suffix, restored.suffix]),
    ).toBeLessThanOrEqual(1);
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic gap capacity and unbreakable multi-line overflow stay bounded", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page
      .locator("[data-layout-probe='gap-capacity-row']")
      .scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      const row = document.querySelector<HTMLElement>(
        "[data-layout-probe='gap-capacity-row']",
      )!;
      const section = row.closest("section")!;
      section.removeAttribute("contenteditable");
      const card = document.querySelector<HTMLElement>(
        "[data-layout-probe='unbreakable-multi-card']",
      )!;
      const text = card.querySelector(
        "[data-layout-probe='unbreakable-multi-text']",
      )!.firstChild!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const style = getComputedStyle(row);
      const icon = row.querySelector(".gap-capacity-icon")!;
      const suffix = row.querySelector(".gap-capacity-suffix")!;
      const gap = Number.parseFloat(style.columnGap);
      const rowRect = row.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      return {
        row: {
          x: rowRect.x,
          y: rowRect.y,
          width: rowRect.width,
          height: rowRect.height,
        },
        card: {
          x: cardRect.x,
          y: cardRect.y,
          width: cardRect.width,
          height: cardRect.height,
        },
        gap,
        gapCapacity:
          row.clientWidth -
          Number.parseFloat(style.paddingInlineStart) -
          Number.parseFloat(style.paddingInlineEnd) -
          icon.getBoundingClientRect().width -
          suffix.getBoundingClientRect().width -
          gap * 2,
        sourceLines: new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.y * 2) / 2),
        ).size,
      };
    });
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");

    const gapWrapper = page.locator(
      "[data-layout-probe='gap-capacity-text'] tryhand-ellipsis",
    );
    await expect(gapWrapper).toHaveAttribute(
      "data-tryhand-layout",
      "single-line",
    );
    await expect(gapWrapper).toHaveAttribute(
      "title",
      "Nhãn khoảng cách rất dài phải nằm trong phần riêng",
    );
    const gapAfter = await page.evaluate(() => {
      const row = document.querySelector(
        "[data-layout-probe='gap-capacity-row']",
      )!;
      const wrapper = row.querySelector("tryhand-ellipsis")!;
      const suffix = row.querySelector(".gap-capacity-suffix")!;
      const rowRect = row.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      const suffixRect = suffix.getBoundingClientRect();
      return {
        row: {
          x: rowRect.x,
          y: rowRect.y,
          width: rowRect.width,
          height: rowRect.height,
        },
        wrapperWidth: wrapperRect.width,
        wrapperEnd: wrapperRect.right,
        suffixStart: suffixRect.left,
        overflow:
          wrapper.scrollWidth > wrapper.clientWidth ||
          wrapper.scrollHeight > wrapper.clientHeight,
      };
    });
    expect(gapAfter.overflow).toBe(true);
    expect(gapAfter.wrapperWidth).toBeLessThanOrEqual(before.gapCapacity + 1);
    expect(gapAfter.wrapperEnd).toBeLessThanOrEqual(
      gapAfter.suffixStart - before.gap + 1,
    );
    expect(maxGeometryDelta([before.row, gapAfter.row])).toBeLessThanOrEqual(1);

    const multiWrapper = page.locator(
      "[data-layout-probe='unbreakable-multi-card'] tryhand-ellipsis",
    );
    await expect(multiWrapper).toHaveAttribute(
      "data-tryhand-layout",
      "multi-line",
    );
    await expect(multiWrapper).toHaveAttribute(
      "title",
      "ChuỗiDịchKhôngThểNgắtRấtDàiPhảiBịGiớiHạnTrongThẻ",
    );
    const multiAfter = await page.evaluate(() => {
      const card = document.querySelector(
        "[data-layout-probe='unbreakable-multi-card']",
      )!;
      const wrapper = card.querySelector("tryhand-ellipsis")!;
      const range = document.createRange();
      range.selectNodeContents(wrapper.firstChild!);
      const cardRect = card.getBoundingClientRect();
      return {
        card: {
          x: cardRect.x,
          y: cardRect.y,
          width: cardRect.width,
          height: cardRect.height,
        },
        lines: new Set(
          [...range.getClientRects()].map((rect) => Math.round(rect.y * 2) / 2),
        ).size,
        overflow:
          wrapper.scrollWidth > wrapper.clientWidth ||
          wrapper.scrollHeight > wrapper.clientHeight,
      };
    });
    expect(multiAfter.overflow).toBe(true);
    expect(multiAfter.lines).toBeLessThanOrEqual(before.sourceLines);
    expect(
      maxGeometryDelta([before.card, multiAfter.card]),
    ).toBeLessThanOrEqual(1);
    for (const source of ["Gap capacity source", "Unbreakable multi source"])
      expect(
        providerRequests
          .flatMap(({ requests }) => requests)
          .filter((request) => request.includes(source)),
      ).toHaveLength(1);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(
      page.locator("tryhand-ellipsis, tryhand-baseline-marker"),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic preserves bounded controls and cards while article flow stays readable", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 900, height: 1400 });
    await page.goto(fixture.url);
    await expect(
      page.locator("[data-layout-probe='incompatible'] p"),
    ).toBeInViewport();

    const bounded = [
      "flex-single",
      "grid-single",
      "float-single",
      "rtl-single",
      "responsive-single",
      "block-anchor-nav",
      "hostile-icon-nav",
      "card-teaser",
      "block-link",
    ];
    const blockAnchorMetrics = await page
      .locator("[data-layout-probe='block-anchor-nav']")
      .evaluate((anchor) => {
        const text = anchor.firstChild;
        if (!(text instanceof Text)) return null;
        const range = document.createRange();
        range.selectNodeContents(text);
        return {
          glyphHeight: range.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(anchor).lineHeight),
        };
      });
    expect(blockAnchorMetrics).not.toBeNull();
    expect(blockAnchorMetrics!.lineHeight).toBeGreaterThan(
      blockAnchorMetrics!.glyphHeight,
    );
    await startFrameSampler(page, bounded);
    const hostileIconBefore = await page
      .locator("[data-layout-probe='hostile-icon-nav'] .host-icon")
      .evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const host = element.parentElement!.getBoundingClientRect();
        return {
          host: {
            x: host.x,
            y: host.y,
            width: host.width,
            height: host.height,
          },
          icon: { x, y, width, height },
        };
      });
    const originals = await page
      .locator(
        "[data-layout-probe='flex-single'], [data-layout-probe='card-teaser'], [data-layout-probe='article-body']",
      )
      .allTextContents();
    const flowRects = () =>
      page.evaluate(() =>
        [
          "[data-layout-probe='article-body'] > p:first-child",
          "[data-layout-probe='article-grid-body']",
          "[data-layout-probe='incompatible'] p",
        ].map((selector) => {
          const { x, y, width, height } = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    const flowBefore = await flowRects();
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);

    for (const probe of [
      "flex-single",
      "grid-single",
      "float-single",
      "responsive-single",
      "block-anchor-nav",
    ])
      await expectBounded(page, probe, "single-line");
    for (const probe of ["card-teaser", "block-link"]) {
      const probeSamples = samples[probe] ?? [];
      const wrapper = page.locator(
        `[data-layout-probe='${probe}'] tryhand-ellipsis.tryhand-ellipsis`,
      );
      if (await wrapper.count()) {
        await expectBounded(page, probe, "multi-line");
      } else {
        const host = page.locator(`[data-layout-probe='${probe}']`);
        await expect(host).toContainText("Bản dịch tiếng Việt dài");
        await expect(host).not.toHaveAttribute("title");
        expect(probeSamples.length).toBeGreaterThan(1);
        const after = probeSamples[probeSamples.length - 1]!;
        expect(after.wrapper).toBe(false);
        expect(after.overflow).toBe(false);
        expect(after.title).toBeNull();
        expect(after.blockLineCount).toBeLessThanOrEqual(
          probeSamples[0]!.blockLineCount,
        );
      }
    }
    const blockSource = "Read the full report from the regional care team";
    const blockRequest = providerRequests.find(({ requests }) =>
      requests.some((request) => request.includes(blockSource)),
    );
    expect(blockRequest).toBeDefined();
    const blockRequestIndex = blockRequest!.requests.findIndex((request) =>
      request.includes(blockSource),
    );
    await expectRetainedProviderRecord(page, providerRequests, {
      probe: "block-link",
      source: blockSource,
      translation: `Bản dịch tiếng Việt dài để kiểm tra việc giữ nguyên bố cục cho mục số ${blockRequestIndex}`,
    });
    const rtlHost = page.locator("[data-layout-probe='rtl-single']");
    const rtlSource = "Settings and notifications";
    const rtlRequest = providerRequests.find(({ requests }) =>
      requests.some((request) => request.includes(rtlSource)),
    );
    expect(rtlRequest).toBeDefined();
    const rtlRequestIndex = rtlRequest!.requests.findIndex((request) =>
      request.includes(rtlSource),
    );
    await expectRetainedProviderRecord(page, providerRequests, {
      probe: "rtl-single",
      source: rtlSource,
      translation: `Bản dịch tiếng Việt dài để kiểm tra việc giữ nguyên bố cục cho mục số ${rtlRequestIndex}`,
    });
    const rtlWrapper = rtlHost.locator("tryhand-ellipsis.tryhand-ellipsis");
    const hasRtlWrapper = (await rtlWrapper.count()) > 0;
    if (hasRtlWrapper) {
      await expectBounded(page, "rtl-single", "single-line");
    } else {
      await expect(rtlHost).not.toHaveAttribute("title");
    }
    const rtlSamples = samples["rtl-single"] ?? [];
    expect(rtlSamples.length).toBeGreaterThan(0);
    const translatedRtlSamples = rtlSamples.filter((sample) =>
      sample.text.includes("Bản dịch tiếng Việt dài"),
    );
    expect(translatedRtlSamples.length).toBeGreaterThan(0);
    for (const sample of translatedRtlSamples)
      if (hasRtlWrapper) {
        expect(sample.lineCount).toBe(1);
        expect(sample.blockLineCount).toBe(1);
      } else {
        expect(sample.overflow).toBe(false);
        expect(sample.title).toBeNull();
      }
    const rtlAfter = rtlSamples[rtlSamples.length - 1]!;
    if (!rtlAfter.wrapper) {
      expect(rtlAfter.overflow).toBe(false);
      expect(rtlAfter.title).toBeNull();
    }
    if (hasRtlWrapper)
      expect(maxGeometryDelta(rtlSamples)).toBeLessThanOrEqual(1);
    const rtlIndex = bounded.indexOf("rtl-single");
    for (const [index, probe] of bounded.entries()) {
      const probeSamples = samples[probe] ?? [];
      if (!hasRtlWrapper && index > rtlIndex) {
        expect(probeSamples.length, probe).toBeGreaterThan(0);
        const baseline = probeSamples[0]!;
        expect(
          Math.max(
            ...probeSamples.map((sample) =>
              Math.max(
                Math.abs(sample.width - baseline.width),
                Math.abs(sample.height - baseline.height),
              ),
            ),
          ),
          probe,
        ).toBeLessThanOrEqual(1);
      } else if (probe !== "rtl-single" || hasRtlWrapper) {
        expect(maxGeometryDelta(probeSamples), probe).toBeLessThanOrEqual(1);
      }
    }
    const hostileHost = page.locator("[data-layout-probe='hostile-icon-nav']");
    await expect(
      hostileHost.locator("tryhand-ellipsis.tryhand-ellipsis"),
    ).toHaveCount(0);
    await expect(hostileHost).not.toHaveAttribute("title");
    await expect(hostileHost).toContainText("Bản dịch tiếng Việt dài");
    expect(
      await hostileHost.evaluate((element) => ({
        noOverlap: (() => {
          const text = element.firstChild;
          const icon = element.querySelector(".host-icon");
          if (!(text instanceof Text) || !icon) return false;
          const range = document.createRange();
          range.selectNodeContents(text);
          return (
            range.getBoundingClientRect().right <=
            icon.getBoundingClientRect().x + 1
          );
        })(),
        rawText: element.firstChild instanceof Text,
        overflow:
          element.scrollWidth > element.clientWidth ||
          element.scrollHeight > element.clientHeight,
      })),
    ).toEqual({ noOverlap: true, rawText: true, overflow: false });
    const hostileIconAfter = await page
      .locator("[data-layout-probe='hostile-icon-nav'] .host-icon")
      .evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        const host = element.parentElement!.getBoundingClientRect();
        return {
          host: {
            x: host.x,
            y: host.y,
            width: host.width,
            height: host.height,
          },
          icon: { x, y, width, height },
        };
      });
    expect(
      await page
        .locator("[data-layout-probe='hostile-icon-nav'] .host-icon")
        .evaluate((element) => getComputedStyle(element, "::before").content),
    ).toBe('"◆"');
    expect(
      maxGeometryDelta([
        relativeRect(hostileIconBefore.icon, hostileIconBefore.host),
        relativeRect(hostileIconAfter.icon, hostileIconAfter.host),
      ]),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(
        Math.abs(hostileIconAfter.host.width - hostileIconBefore.host.width),
        Math.abs(hostileIconAfter.host.height - hostileIconBefore.host.height),
      ),
    ).toBeLessThanOrEqual(1);
    const hostileCenterOffset = ({ host, icon }: typeof hostileIconBefore) =>
      icon.y + icon.height / 2 - (host.y + host.height / 2);
    expect(
      Math.abs(
        hostileCenterOffset(hostileIconAfter) -
          hostileCenterOffset(hostileIconBefore),
      ),
    ).toBeLessThanOrEqual(1);
    const constrainedWrapper = page.locator(
      "[data-layout-probe='flex-single'] tryhand-ellipsis.tryhand-ellipsis",
    );
    expect(
      await constrainedWrapper.evaluate(
        (element) =>
          element.scrollWidth > element.clientWidth ||
          element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    const constrainedText = await constrainedWrapper.textContent();
    expect(constrainedText).not.toBeNull();
    await expect(constrainedWrapper).toHaveAttribute("title", constrainedText!);

    // Sole-text flow preserves its captured footprint (clamping when the
    // translation overflows); mixed-inline flow stays raw and readable.
    await expect(
      page.locator(
        "[data-layout-probe='inline-link'] tryhand-ellipsis.tryhand-ellipsis",
      ),
    ).toHaveCount(0);
    await expect(
      page.locator("[data-layout-probe='article-body']"),
    ).toContainText("Bản dịch tiếng Việt dài");
    await expect(
      page.locator("[data-layout-probe='article-grid-body']"),
    ).toContainText("Bản dịch tiếng Việt dài");
    await expect(
      page.locator("[data-layout-probe='incompatible']"),
    ).toContainText("Bản dịch tiếng Việt dài");
    for (const probe of ["article-body", "article-grid-body", "incompatible"]) {
      const wrapper = page.locator(
        `[data-layout-probe='${probe}'] tryhand-ellipsis.tryhand-ellipsis`,
      );
      if (await wrapper.count()) {
        expect(
          await wrapper.first().evaluate((element) => {
            const overflows =
              element.scrollWidth > element.clientWidth ||
              element.scrollHeight > element.clientHeight;
            const title = element.getAttribute("title");
            return overflows ? title === element.textContent : title === null;
          }),
          `${probe} tooltip must match its measured overflow`,
        ).toBe(true);
      }
    }
    const flowAfter = await flowRects();
    for (const [index, after] of flowAfter.entries()) {
      // Sole-text flow keeps its own footprint; its absolute position may
      // still shift when mixed-inline flow above it reflows.
      expect(
        Math.abs(after.width - flowBefore[index]!.width),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(after.height - flowBefore[index]!.height),
      ).toBeLessThanOrEqual(1);
    }
    await captureEvidence(page, "layout-ellipsis-deterministic.png");

    await page.setViewportSize({ width: 480, height: 900 });
    await expect(
      page.locator("[data-layout-probe='responsive-single']"),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(page.locator("tryhand-ellipsis.tryhand-ellipsis")).toHaveCount(
      0,
    );
    await expect(
      page.locator(
        "[data-layout-probe='flex-single'], [data-layout-probe='card-teaser'], [data-layout-probe='article-body']",
      ),
    ).toHaveText(originals);
  });

  test("@deterministic bounded-navigation-no-wrap keeps an auto-width row on its captured line", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='bounded-navigation-no-wrap']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });

    const row = page.locator(
      "[data-layout-probe='bounded-navigation-no-wrap']",
    );
    await row.scrollIntoViewIfNeeded();
    const measure = () =>
      row.evaluate((element) => {
        const rect = (target: Element) => {
          const { x, y, width, height } = target.getBoundingClientRect();
          return { x, y, width, height, right: x + width };
        };
        const items = [...element.querySelectorAll("a")].map((anchor) => {
          const wrapper = anchor.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          const range = document.createRange();
          range.selectNodeContents(wrapper?.firstChild ?? anchor.firstChild!);
          return {
            anchor: rect(anchor),
            lineCount: new Set(
              [...range.getClientRects()].map(
                (box) => Math.round(box.y * 2) / 2,
              ),
            ).size,
            overflow: Boolean(
              wrapper &&
              (wrapper.scrollWidth > wrapper.clientWidth ||
                wrapper.scrollHeight > wrapper.clientHeight),
            ),
            text: anchor.textContent?.trim() ?? "",
            title: wrapper?.getAttribute("title") ?? null,
            whiteSpace: getComputedStyle(wrapper ?? anchor).whiteSpace,
            wrapper: Boolean(wrapper),
            wrapperRect: wrapper ? rect(wrapper) : null,
          };
        });
        return {
          items,
          row: rect(element),
          rowLineCount: new Set(
            [...element.children].map(
              (item) => Math.round(item.getBoundingClientRect().y * 2) / 2,
            ),
          ).size,
        };
      });
    const before = await measure();
    expect(before.rowLineCount).toBe(1);
    expect(before.items.every(({ lineCount }) => lineCount === 1)).toBe(true);
    const probes = [
      "bounded-navigation-no-wrap",
      "bounded-nav-item-news",
      "bounded-nav-item-world",
      "bounded-nav-item-sports",
    ];
    await startFrameSampler(page, probes);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(
      page.locator("[data-layout-probe='bounded-nav-item-news']"),
    ).toHaveText("Tin tức tự động mở rộng");
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    const after = await measure();

    expect(
      providerBatches.some((requests) => {
        const batch = requests.join(" ");
        return (
          batch.includes("Auto news") &&
          batch.includes("Auto world") &&
          batch.includes("Auto sports")
        );
      }),
    ).toBe(true);
    expect(after.items.map(({ text }) => text)).toEqual([
      "Tin tức tự động mở rộng",
      "Thế giới tự động mở rộng",
      "Thể thao tự động mở rộng",
    ]);
    expect(after.rowLineCount).toBe(1);
    expect(maxGeometryDelta([before.row, after.row])).toBeLessThanOrEqual(1);
    for (const [index, item] of after.items.entries()) {
      expect(item.lineCount).toBe(1);
      expect(item.wrapper).toBe(true);
      expect(item.overflow).toBe(true);
      expect(item.title).toBe(item.text);
      expect(item.whiteSpace).toBe("nowrap");
      expect(item.wrapperRect!.right).toBeLessThanOrEqual(
        item.anchor.right + 1,
      );
      expect(
        maxGeometryDelta([before.items[index]!.anchor, item.anchor]),
      ).toBeLessThanOrEqual(1);
      const next = after.items[index + 1];
      if (next)
        expect(item.anchor.right).toBeLessThanOrEqual(next.anchor.x + 1);
    }
    for (const probe of probes) {
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);
      for (const sample of samples[probe] ?? []) {
        expect(sample.markerCount).toBe(0);
        expect(sample.blockLineCount).toBe(1);
        if (sample.wrapper) expect(sample.whiteSpace).toBe("nowrap");
      }
    }

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    const restored = await measure();
    expect(restored.items.map(({ text }) => text)).toEqual([
      "Auto news",
      "Auto world",
      "Auto sports",
    ]);
    expect(restored.rowLineCount).toBe(1);
    expect(maxGeometryDelta([before.row, restored.row])).toBeLessThanOrEqual(1);
    for (const [index, item] of restored.items.entries())
      expect(
        maxGeometryDelta([before.items[index]!.anchor, item.anchor]),
      ).toBeLessThanOrEqual(1);
    await expect(row.locator("tryhand-ellipsis")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic selected capacity uses its 61px source and 123px owned cell without a false title", async () => {
    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='bounded-fixed-cell']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });
    const cells = page.locator(
      "[data-layout-probe='bounded-fixed-cell'], [data-layout-probe='bounded-fixed-overflow']",
    );
    const measure = () =>
      cells.evaluateAll((elements) =>
        elements.map((cell) => {
          const anchor = cell.querySelector("a")!;
          const wrapper = anchor.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          const text = wrapper?.firstChild ?? anchor.firstChild!;
          const range = document.createRange();
          range.selectNodeContents(text);
          const { x, y, width, height } = cell.getBoundingClientRect();
          return {
            cell: { x, y, width, height },
            hostWhiteSpace: getComputedStyle(anchor).whiteSpace,
            lineCount: new Set(
              [...range.getClientRects()].map(
                (rect) => Math.round(rect.y * 2) / 2,
              ),
            ).size,
            overflow: Boolean(
              wrapper &&
              (wrapper.scrollWidth > wrapper.clientWidth ||
                wrapper.scrollHeight > wrapper.clientHeight),
            ),
            text: text.textContent ?? "",
            textWidth: range.getBoundingClientRect().width,
            title: wrapper?.getAttribute("title") ?? null,
            whiteSpace: getComputedStyle(wrapper ?? anchor).whiteSpace,
            wrapper: Boolean(wrapper),
          };
        }),
      );
    const before = await measure();
    expect(before[0]!.cell.width).toBe(123);
    expect(before[0]!.textWidth).toBeGreaterThan(50);
    expect(before[0]!.textWidth).toBeLessThan(70);
    expect(
      before.every(({ hostWhiteSpace }) => hostWhiteSpace === "normal"),
    ).toBe(true);
    await startFrameSampler(page, [
      "bounded-fixed-cell",
      "bounded-fixed-overflow",
    ]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(cells.nth(0)).toHaveText("Tiếng nói nhân dân");
    await expect(cells.nth(1)).toHaveText(
      "Bản dịch cố định rất dài vượt quá ô riêng",
    );
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    const after = await measure();

    expect(after[0]!.text).toBe("Tiếng nói nhân dân");
    expect(after[0]!.textWidth).toBeGreaterThan(before[0]!.textWidth + 1);
    expect(after[0]!.textWidth).toBeLessThanOrEqual(123);
    expect(after[0]!.lineCount).toBe(1);
    expect(after[0]!.wrapper).toBe(false);
    expect(after[0]!.title).toBeNull();
    expect(after[1]!.text).toBe("Bản dịch cố định rất dài vượt quá ô riêng");
    expect(after[1]!.lineCount).toBe(1);
    expect(after[1]!.wrapper).toBe(true);
    expect(after[1]!.overflow).toBe(true);
    expect(after[1]!.title).toBe(after[1]!.text);
    expect(after[1]!.whiteSpace).toBe("nowrap");
    for (const [index, item] of after.entries())
      expect(
        maxGeometryDelta([before[index]!.cell, item.cell]),
      ).toBeLessThanOrEqual(1);
    for (const probe of ["bounded-fixed-cell", "bounded-fixed-overflow"])
      for (const sample of samples[probe] ?? []) {
        expect(sample.markerCount).toBe(0);
        expect(sample.blockLineCount).toBe(1);
      }

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    const restored = await measure();
    expect(restored.map(({ text }) => text)).toEqual([
      "Fixed menu",
      "Fixed overflow",
    ]);
    for (const [index, item] of restored.entries())
      expect(
        maxGeometryDelta([before[index]!.cell, item.cell]),
      ).toBeLessThanOrEqual(1);
    await expect(cells.locator("tryhand-ellipsis")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic clipping boundary prevents selected capacity from crossing hidden overflow", async () => {
    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='clipped-capacity-cell']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });
    const cell = page.locator("[data-layout-probe='clipped-capacity-cell']");
    await cell.scrollIntoViewIfNeeded();
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    const wrapper = cell.locator("tryhand-ellipsis.tryhand-ellipsis");
    await expect(wrapper).toHaveCount(1);
    await expect(wrapper).toHaveText("Bản dịch dài bị giới hạn trong ô riêng");
    await expect(wrapper).toHaveAttribute(
      "title",
      "Bản dịch dài bị giới hạn trong ô riêng",
    );
    const capacity = await wrapper.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        maximum: Number.parseFloat(getComputedStyle(element).maxInlineSize),
        used: rect.width,
      };
    });
    expect(capacity.used).toBeLessThanOrEqual(62);
    expect(capacity.maximum).toBeLessThanOrEqual(62);
    expect(Math.abs(capacity.used - capacity.maximum)).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @translation-first unsupported source-capacity repair retains raw translation", async () => {
    const providerRequests: DeterministicProviderRequest[] = [];
    await routeDeterministicProvider(extension.context, undefined, {
      observeRequest: (request) => providerRequests.push(request),
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      document
        .querySelector("[data-layout-probe='bounded-source-fallback']")
        ?.closest(".compatibility-row")
        ?.removeAttribute("contenteditable");
      for (const element of document.querySelectorAll(
        "button, .cards, article, .article-sidebar-grid, .incompatible, #spa-root",
      )) {
        if (!element.closest("[data-layout-probe='bounded-source-fallback']"))
          element.setAttribute("contenteditable", "true");
      }
    });
    const target = page.locator(
      "[data-layout-probe='bounded-source-fallback']",
    );
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((element) => {
      (window as Window & { __tryhandSourceText?: Text }).__tryhandSourceText =
        element.firstChild as Text;
    });
    await startFrameSampler(page, ["bounded-source-fallback"]);
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() =>
        providerRequests
          .flatMap(({ requests }) => requests)
          .join(" ")
          .includes("Incompatible bounded"),
      )
      .toBe(true);
    await waitForSchedulerTicks(page);
    const samples = await stopFrameSampler(page);

    await expectRetainedProviderRecord(page, providerRequests, {
      probe: "bounded-source-fallback",
      source: "Incompatible bounded",
      translation: "Bản dịch không tương thích với hình học gốc",
    });
    expect(
      await target.evaluate(
        (element) =>
          element.firstChild ===
          (window as Window & { __tryhandSourceText?: Text })
            .__tryhandSourceText,
      ),
    ).toBe(true);
    await expect(target).not.toHaveAttribute("title");
    await expect(
      target.locator("tryhand-ellipsis.tryhand-ellipsis"),
    ).toHaveCount(0);
    for (const sample of samples["bounded-source-fallback"] ?? []) {
      expect(sample.markerCount).toBe(0);
      expect(sample.wrapper).toBe(false);
    }
    expect(pageErrors).toEqual([]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(target).toHaveText("Incompatible bounded");
    await expect(page.locator("tryhand-baseline-marker")).toHaveCount(0);
  });

  test("@deterministic uses a stable dropdown cell but preserves unsafe nav geometry", async () => {
    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      for (const probe of ["dropdown-capacity", "unsafe-capacity-nav"])
        document
          .querySelector(`[data-layout-probe='${probe}']`)
          ?.closest("section")
          ?.removeAttribute("contenteditable");
    });
    await page
      .locator("[data-layout-probe='dropdown-item-en']")
      .scrollIntoViewIfNeeded();

    const dropdownBefore = await page
      .locator("[data-layout-probe^='dropdown-item-']")
      .evaluateAll((cells) =>
        cells.map((cell) => {
          const text = cell.querySelector("a")?.firstChild;
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          return {
            text: text?.textContent ?? "",
            textWidth: text ? range.getBoundingClientRect().width : 0,
            cellWidth: cell.getBoundingClientRect().width,
          };
        }),
      );
    expect(dropdownBefore).toHaveLength(4);
    expect(dropdownBefore[0]!.cellWidth).toBe(123);
    expect(dropdownBefore[0]!.textWidth).toBeLessThan(
      dropdownBefore[0]!.cellWidth,
    );
    const unsafeBefore = await page
      .locator(
        "[data-layout-probe='unsafe-nav-icon'], [data-layout-probe='unsafe-nav-sibling']",
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(
      page.locator("[data-layout-probe='dropdown-item-en']"),
    ).toHaveText("Mục phù hợp");
    await waitForFrames(page);

    const dropdownItems = await page
      .locator("[data-layout-probe^='dropdown-item-']")
      .evaluateAll((cells) =>
        cells.map((cell) => {
          const anchor = cell.querySelector("a");
          const wrapper = anchor?.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          const text = wrapper?.firstChild ?? anchor?.firstChild;
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          const lineCount = new Set(
            [...range.getClientRects()].map(
              (rect) => Math.round(rect.y * 2) / 2,
            ),
          ).size;
          const style = wrapper ? getComputedStyle(wrapper) : null;
          return {
            text: text?.textContent ?? "",
            textWidth: text ? range.getBoundingClientRect().width : 0,
            cellWidth: cell.clientWidth,
            lineCount,
            wrapper: Boolean(wrapper),
            overflow: wrapper
              ? wrapper.scrollWidth > wrapper.clientWidth ||
                wrapper.scrollHeight > wrapper.clientHeight
              : false,
            title:
              wrapper?.getAttribute("title") ??
              anchor?.getAttribute("title") ??
              null,
            textOverflow: style?.textOverflow ?? null,
            whiteSpace:
              style?.whiteSpace ?? getComputedStyle(anchor!).whiteSpace,
          };
        }),
      );
    expect(dropdownItems.map(({ text }) => text)).toEqual([
      "Mục phù hợp",
      "Mục phù hợp",
      "Mục menu tiếng Nhật",
      "Bản dịch tiếng Việt rất dài vượt quá ô menu này",
    ]);
    expect(dropdownItems[0]!.textWidth).toBeGreaterThan(
      dropdownBefore[0]!.textWidth + 1,
    );
    for (const item of dropdownItems.slice(0, 3)) {
      expect(item.textWidth).toBeLessThanOrEqual(item.cellWidth + 0.5);
      expect(item.lineCount).toBe(1);
      expect(item.wrapper).toBe(false);
      expect(item.title).toBeNull();
    }
    const dropdownOverflow = dropdownItems[3]!;
    expect(dropdownOverflow.wrapper).toBe(true);
    expect(dropdownOverflow.overflow).toBe(true);
    expect(dropdownOverflow.title).toBe(dropdownOverflow.text);
    expect(dropdownOverflow.textOverflow).toBe("ellipsis");
    expect(dropdownOverflow.whiteSpace).toBe("nowrap");
    expect(dropdownOverflow.lineCount).toBe(1);

    const unsafeWrapper = page.locator(
      "[data-layout-probe='unsafe-capacity-nav'] tryhand-ellipsis.tryhand-ellipsis",
    );
    await expect(unsafeWrapper).toHaveText("Mục phù hợp");
    const unsafeAfter = await page
      .locator(
        "[data-layout-probe='unsafe-nav-icon'], [data-layout-probe='unsafe-nav-sibling']",
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    for (const [index, before] of unsafeBefore.entries())
      expect(
        maxGeometryDelta([before!, unsafeAfter[index]!]),
      ).toBeLessThanOrEqual(1);
    const unsafeBudget = await unsafeWrapper.evaluate((element) =>
      Number.parseFloat(
        element.style.getPropertyValue("--tryhand-inline-size"),
      ),
    );
    expect(unsafeBudget).toBeLessThan(dropdownBefore[0]!.cellWidth);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic keeps a flex row icon cell contained", async () => {
    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='flex-icon-cell']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });
    await page
      .locator("[data-layout-probe='flex-icon-cell']")
      .scrollIntoViewIfNeeded();

    const before = await page
      .locator("[data-layout-probe='flex-icon-cell']")
      .evaluate((cell) => {
        const icon = cell.querySelector("[data-layout-probe='flex-icon']");
        const text = cell.querySelector("[data-layout-probe='flex-icon-text']");
        const adjacent = cell.parentElement?.querySelector(
          ".flex-icon-adjacent",
        );
        if (!icon || !text || !adjacent) return null;
        const rect = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        const attributes = (element: Element) =>
          [...element.attributes]
            .map(({ name, value }): [string, string] => [name, value])
            .sort(([left], [right]) => left.localeCompare(right));
        return {
          cell: rect(cell),
          icon: rect(icon),
          adjacent: rect(adjacent),
          paddingInline:
            Number.parseFloat(getComputedStyle(cell).paddingInlineStart) +
            Number.parseFloat(getComputedStyle(cell).paddingInlineEnd),
          cellAttributes: attributes(cell),
          textAttributes: attributes(text),
        };
      });
    expect(before).not.toBeNull();

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(
      page.locator(
        "[data-layout-probe='flex-icon-cell'] tryhand-ellipsis.tryhand-ellipsis",
      ),
    ).toHaveCount(1);

    const after = await page
      .locator("[data-layout-probe='flex-icon-cell']")
      .evaluate((cell) => {
        const icon = cell.querySelector("[data-layout-probe='flex-icon']");
        const text = cell.querySelector("[data-layout-probe='flex-icon-text']");
        const adjacent = cell.parentElement?.querySelector(
          ".flex-icon-adjacent",
        );
        const wrapper = text?.querySelector<HTMLElement>(
          "tryhand-ellipsis.tryhand-ellipsis[data-tryhand-layout='single-line']",
        );
        if (!icon || !text || !adjacent || !wrapper) return null;
        const rect = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height, right: x + width };
        };
        const attributes = (element: Element) =>
          [...element.attributes]
            .map(({ name, value }): [string, string] => [name, value])
            .sort(([left], [right]) => left.localeCompare(right));
        return {
          cell: rect(cell),
          icon: rect(icon),
          adjacent: rect(adjacent),
          wrapper: rect(wrapper),
          overflow: wrapper.scrollWidth > wrapper.clientWidth,
          title: wrapper.getAttribute("title"),
          text: wrapper.textContent,
          cellAttributes: attributes(cell),
          textAttributes: attributes(text),
        };
      });
    expect(after).not.toBeNull();
    if (!before || !after) return;

    expect(before.paddingInline).toBeGreaterThan(0);
    expect(after.overflow).toBe(true);
    expect(after.title).toBe(after.text);
    expect(after.wrapper.x).toBeGreaterThanOrEqual(
      after.icon.x + after.icon.width - 1,
    );
    expect(after.wrapper.right).toBeLessThanOrEqual(after.cell.right + 1);
    expect(after.wrapper.right).toBeLessThanOrEqual(after.adjacent.x + 1);
    expect(maxGeometryDelta([before.cell, after.cell])).toBeLessThanOrEqual(1);
    expect(maxGeometryDelta([before.icon, after.icon])).toBeLessThanOrEqual(1);
    expect(after.cellAttributes).toEqual(before.cellAttributes);
    expect(after.textAttributes).toEqual(before.textAttributes);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic batch isolation keeps a fitting label raw after an earlier geometry repair", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='batch-isolation']")
        ?.removeAttribute("contenteditable");
    });
    const sampledProbes = [
      "batch-isolation-cell",
      "batch-repair-trigger",
      "batch-isolation-icon",
      "batch-fit-text",
    ];
    await page
      .locator("[data-layout-probe='batch-isolation-cell']")
      .scrollIntoViewIfNeeded();
    await startFrameSampler(page, sampledProbes);

    const before = await page
      .locator("[data-layout-probe='batch-isolation-cell']")
      .evaluate((cell) => {
        const first = cell.querySelector(
          "[data-layout-probe='batch-repair-trigger']",
        )!;
        const icon = cell.querySelector(
          "[data-layout-probe='batch-isolation-icon']",
        )!;
        const later = cell.querySelector(
          "[data-layout-probe='batch-fit-text']",
        )!;
        const rect = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        const text = later.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(text);
        return {
          cell: rect(cell),
          first: rect(first),
          icon: rect(icon),
          laterTextWidth: range.getBoundingClientRect().width,
        };
      });

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() =>
        providerBatches.some((requests) => {
          const responseBatch = requests.join(" ");
          return (
            responseBatch.includes("Repair trigger") &&
            responseBatch.includes("FAQ")
          );
        }),
      )
      .toBe(true);
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);

    expect(
      providerBatches.some((requests) => {
        const responseBatch = requests.join(" ");
        return (
          responseBatch.includes("Repair trigger") &&
          responseBatch.includes("FAQ")
        );
      }),
    ).toBe(true);
    const after = await page
      .locator("[data-layout-probe='batch-isolation-cell']")
      .evaluate((cell) => {
        const first = cell.querySelector<HTMLElement>(
          "[data-layout-probe='batch-repair-trigger']",
        )!;
        const icon = cell.querySelector(
          "[data-layout-probe='batch-isolation-icon']",
        )!;
        const later = cell.querySelector<HTMLElement>(
          "[data-layout-probe='batch-fit-text']",
        )!;
        const firstWrapper = first.querySelector<HTMLElement>(
          "tryhand-ellipsis.tryhand-ellipsis",
        );
        const laterWrapper = later.querySelector(
          "tryhand-ellipsis.tryhand-ellipsis",
        );
        const laterRange = document.createRange();
        laterRange.selectNodeContents(later.firstChild!);
        const firstRange = document.createRange();
        firstRange.selectNodeContents(first.firstChild!);
        const laterTextRect = laterRange.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        const rect = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          cell: rect(cell),
          first: rect(first),
          icon: rect(icon),
          firstText: first.textContent,
          firstSource: !firstWrapper && first.firstChild instanceof Text,
          firstTitle: first.getAttribute("title"),
          firstLineCount: new Set(
            [...firstRange.getClientRects()].map(
              (box) => Math.round(box.y * 2) / 2,
            ),
          ).size,
          laterText: later.textContent,
          laterRawText: later.firstChild instanceof Text,
          laterWrapper: Boolean(laterWrapper),
          laterTitle: later.getAttribute("title"),
          laterTextWidth: laterTextRect.width,
          laterFitsCell: laterTextRect.right <= cellRect.right + 0.5,
          laterLineCount: new Set(
            [...laterRange.getClientRects()].map(
              (rect) => Math.round(rect.y * 2) / 2,
            ),
          ).size,
        };
      });

    expect(after.firstText).toBe("Nhãn đầu tiên cần được sửa hình học");
    expect(after.firstSource).toBe(true);
    expect(after.firstTitle).toBeNull();
    expect(after.firstLineCount).toBe(1);
    expect(after.laterText).toBe("Hỏi và Đáp");
    expect(after.laterTextWidth).toBeGreaterThan(before.laterTextWidth + 1);
    expect(after.laterFitsCell).toBe(true);
    expect(after.laterLineCount).toBe(1);
    expect(after.laterRawText).toBe(true);
    expect(after.laterWrapper).toBe(false);
    expect(after.laterTitle).toBeNull();
    for (const probe of ["cell", "first", "icon"] as const)
      expect(
        maxGeometryDelta([before[probe], after[probe]]),
      ).toBeLessThanOrEqual(1);
    for (const probe of sampledProbes)
      for (const sample of samples[probe] ?? []) {
        expect(sample.markerCount).toBe(0);
        expect(sample.wrapper).toBe(false);
        expect(sample.blockLineCount).toBe(1);
      }
    for (const probe of [
      "batch-isolation-cell",
      "batch-repair-trigger",
      "batch-isolation-icon",
    ])
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);
    for (const sample of samples["batch-fit-text"] ?? []) {
      expect(["FAQ", "Hỏi và Đáp"]).toContain(sample.text);
      expect(sample.lineCount).toBe(1);
    }
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic inline sibling anchors keep source capacity without a list owner", async () => {
    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='inline-sibling-owner-row']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });

    const row = page.locator("[data-layout-probe='inline-sibling-owner-row']");
    const measure = () =>
      row.evaluate((element) => {
        const rect = (target: Element) => {
          const { x, y, width, height } = target.getBoundingClientRect();
          return { x, y, width, height, right: x + width };
        };
        const anchors = [...element.querySelectorAll("a")].map((anchor) => {
          const wrapper = anchor.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          const text = wrapper?.firstChild ?? anchor.firstChild!;
          const range = document.createRange();
          range.selectNodeContents(text);
          return {
            anchor: rect(anchor),
            lineCount: new Set(
              [...range.getClientRects()].map(
                (box) => Math.round(box.y * 2) / 2,
              ),
            ).size,
            text: text.textContent ?? "",
            textWidth: range.getBoundingClientRect().width,
            wrapper: wrapper ? rect(wrapper) : null,
          };
        });
        return { anchors, row: rect(element) };
      });
    await row.scrollIntoViewIfNeeded();
    const before = await measure();
    await startFrameSampler(page, [
      "inline-sibling-owner-row",
      "inline-sibling-owner",
      "inline-sibling-peer",
    ]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() => measure().then(({ anchors }) => anchors[0]?.text))
      .toBe("Nhãn điều hướng nội tuyến rất dài");
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    const after = await measure();

    expect(after.anchors[0]!.text).toBe("Nhãn điều hướng nội tuyến rất dài");
    expect(after.anchors[1]!.text).toBe("Inline beta");
    expect(after.anchors[0]!.lineCount).toBe(1);
    expect(after.anchors[0]!.wrapper).not.toBeNull();
    expect(after.anchors[0]!.wrapper!.width).toBeLessThanOrEqual(
      before.anchors[0]!.textWidth + 1,
    );
    expect(after.anchors[0]!.wrapper!.right).toBeLessThanOrEqual(
      after.anchors[1]!.anchor.x + 1,
    );
    expect(maxGeometryDelta([before.row, after.row])).toBeLessThanOrEqual(1);
    for (const [index, anchor] of after.anchors.entries())
      expect(
        maxGeometryDelta([before.anchors[index]!.anchor, anchor.anchor]),
      ).toBeLessThanOrEqual(1);
    for (const probe of [
      "inline-sibling-owner-row",
      "inline-sibling-owner",
      "inline-sibling-peer",
    ]) {
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);
      for (const sample of samples[probe] ?? [])
        expect(sample.blockLineCount).toBe(1);
    }
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic nested label excludes visible icon and Text siblings from capacity but retains raw translation when a safe wrapper is unsupported", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='nested-sibling-row']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });

    const row = page.locator("[data-layout-probe='nested-sibling-row']");
    const measure = () =>
      row.evaluate((element) => {
        const label = element.querySelector<HTMLElement>(
          "[data-layout-probe='nested-sibling-label']",
        )!;
        const icon = element.querySelector(
          "[data-layout-probe='nested-sibling-icon']",
        )!;
        const wrapper = label.querySelector<HTMLElement>(
          "tryhand-ellipsis.tryhand-ellipsis",
        );
        const text = wrapper?.firstChild ?? label.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(text);
        const snapshot = ({ x, y, width, height }: DOMRect) => {
          return { x, y, width, height, right: x + width };
        };
        const rect = (target: Element) =>
          snapshot(target.getBoundingClientRect());
        const directTextNodes = [...label.parentElement!.childNodes].filter(
          (node): node is Text =>
            node instanceof Text && Boolean(node.textContent?.trim()),
        );
        const textSiblings = directTextNodes.map((node) => {
          const siblingRange = document.createRange();
          siblingRange.selectNodeContents(node);
          return snapshot(siblingRange.getBoundingClientRect());
        });
        const visibleText = wrapper
          ? rect(wrapper)
          : snapshot(range.getBoundingClientRect());
        return {
          directVisibleTextNodes: directTextNodes.length,
          icon: rect(icon),
          label: rect(label),
          lineCount: new Set(
            [...range.getClientRects()].map((box) => Math.round(box.y * 2) / 2),
          ).size,
          ownerWidth: label.parentElement!.clientWidth,
          overflow:
            label.parentElement!.scrollWidth > label.parentElement!.clientWidth,
          row: rect(element),
          text: text.textContent ?? "",
          textSiblings,
          textSiblingValues: directTextNodes.map((node) => node.data),
          textWidth: range.getBoundingClientRect().width,
          title: wrapper?.getAttribute("title") ?? label.getAttribute("title"),
          wrapper: wrapper ? rect(wrapper) : null,
          wrapperMode: wrapper?.dataset.tryhandLayout ?? null,
          wrapperOverflow: Boolean(
            wrapper &&
            (wrapper.scrollWidth > wrapper.clientWidth ||
              wrapper.scrollHeight > wrapper.clientHeight),
          ),
          visibleText,
        };
      });
    await row.scrollIntoViewIfNeeded();
    const before = await measure();
    await startFrameSampler(page, [
      "nested-sibling-row",
      "nested-sibling-label",
      "nested-sibling-icon",
    ]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() => providerBatches.flat().join(" ").includes("Nested label"))
      .toBe(true);
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    const after = await measure();

    expect(before.directVisibleTextNodes).toBe(2);
    expect(after.directVisibleTextNodes).toBe(2);
    expect(after.textSiblingValues).toEqual(before.textSiblingValues);
    expect(providerBatches.flat().join(" ")).toContain("Nested label");
    expect(before.ownerWidth).toBeGreaterThan(before.textWidth + 1);
    expect(after.text).toBe("Nhãn lồng dài vượt phần văn bản gốc");
    expect(after.lineCount).toBe(1);
    expect(after.overflow).toBe(false);
    const occupiedStart = Math.min(
      after.icon.x,
      ...after.textSiblings.map(({ x }) => x),
    );
    expect(after.visibleText.x).toBeGreaterThanOrEqual(after.row.x - 1);
    expect(after.visibleText.right).toBeLessThanOrEqual(occupiedStart + 1);
    if (after.wrapper) {
      expect(after.wrapperMode).toBe("single-line");
      expect(after.wrapper.width).toBeLessThanOrEqual(before.textWidth + 1);
      expect(after.wrapper.right).toBeLessThanOrEqual(occupiedStart + 1);
      expect(Boolean(after.title)).toBe(after.wrapperOverflow);
      if (after.wrapperOverflow) expect(after.title).toBe(after.text);
    } else {
      expect(after.title).toBeNull();
      expect(after.wrapperOverflow).toBe(false);
    }
    expect(maxGeometryDelta([before.row, after.row])).toBeLessThanOrEqual(1);
    expect(maxGeometryDelta([before.icon, after.icon])).toBeLessThanOrEqual(1);
    expect(maxGeometryDelta([before.label, after.label])).toBeLessThanOrEqual(
      1,
    );
    for (const [index, beforeText] of before.textSiblings.entries())
      expect(
        maxGeometryDelta([beforeText, after.textSiblings[index]!]),
      ).toBeLessThanOrEqual(1);
    for (const probe of [
      "nested-sibling-row",
      "nested-sibling-label",
      "nested-sibling-icon",
    ])
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);
    for (const sample of samples["nested-sibling-label"] ?? [])
      expect(sample.lineCount).toBe(1);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic @translation-first prior line-count protection preserves batch one while repairing batch two", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='batch-isolation']")
        ?.removeAttribute("contenteditable");
      document
        .querySelector("[data-layout-probe='batch-repair-trigger']")
        ?.setAttribute("contenteditable", "true");
    });

    const row = page.locator("[data-layout-probe='batch-isolation-cell']");
    const measure = () =>
      row.evaluate((element) => {
        const valid = element.querySelector<HTMLElement>(
          "[data-layout-probe='batch-fit-text']",
        )!;
        const repair = element.querySelector<HTMLElement>(
          "[data-layout-probe='batch-repair-trigger']",
        )!;
        const icon = element.querySelector(
          "[data-layout-probe='batch-isolation-icon']",
        )!;
        const rect = (target: Element) => {
          const { x, y, width, height } = target.getBoundingClientRect();
          return { x, y, width, height, right: x + width };
        };
        const lineCount = (target: Element) => {
          const range = document.createRange();
          range.selectNodeContents(target);
          return new Set(
            [...range.getClientRects()].map((box) => Math.round(box.y * 2) / 2),
          ).size;
        };
        return {
          icon: rect(icon),
          repair: rect(repair),
          repairLineCount: lineCount(repair),
          repairText: repair.textContent?.trim() ?? "",
          repairWrapper: Boolean(repair.querySelector("tryhand-ellipsis")),
          row: rect(element),
          valid: rect(valid),
          validLineCount: lineCount(valid),
          validText: valid.textContent?.trim() ?? "",
          validWrapper: Boolean(valid.querySelector("tryhand-ellipsis")),
        };
      });
    await row.scrollIntoViewIfNeeded();
    const before = await measure();
    await startFrameSampler(page, [
      "batch-isolation-cell",
      "batch-repair-trigger",
      "batch-isolation-icon",
      "batch-fit-text",
    ]);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() => measure().then(({ validText }) => validText))
      .toBe("Hỏi và Đáp");
    const afterBatchOne = await measure();
    const batchOneIndex = providerBatches.findIndex((requests) =>
      requests.join(" ").includes("FAQ"),
    );
    expect(batchOneIndex).toBeGreaterThanOrEqual(0);
    expect(providerBatches[batchOneIndex]!.join(" ")).not.toContain(
      "Repair trigger",
    );

    await page
      .locator("[data-layout-probe='batch-repair-trigger']")
      .evaluate((element) => {
        const replacement = element.cloneNode(true) as HTMLElement;
        replacement.removeAttribute("contenteditable");
        element.replaceWith(replacement);
      });
    await expect
      .poll(() =>
        providerBatches.findIndex(
          (requests, index) =>
            index > batchOneIndex &&
            requests.join(" ").includes("Repair trigger"),
        ),
      )
      .toBeGreaterThan(batchOneIndex);
    await expect
      .poll(() => measure().then(({ repairText }) => repairText))
      .toBe("Nhãn đầu tiên cần được sửa hình học");
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    const afterBatchTwo = await measure();
    const batchTwoIndex = providerBatches.findIndex(
      (requests, index) =>
        index > batchOneIndex && requests.join(" ").includes("Repair trigger"),
    );

    expect(batchTwoIndex).toBeGreaterThan(batchOneIndex);
    expect(providerBatches[batchTwoIndex]!.join(" ")).not.toContain("FAQ");
    expect(afterBatchOne.validText).toBe("Hỏi và Đáp");
    expect(afterBatchTwo.validText).toBe("Hỏi và Đáp");
    expect(afterBatchTwo.validWrapper).toBe(afterBatchOne.validWrapper);
    expect(afterBatchTwo.repairText).toBe(
      "Nhãn đầu tiên cần được sửa hình học",
    );
    expect(afterBatchTwo.repairWrapper).toBe(false);
    expect(afterBatchTwo.validLineCount).toBe(1);
    expect(afterBatchTwo.repairLineCount).toBe(1);
    expect(
      maxGeometryDelta([before.row, afterBatchOne.row, afterBatchTwo.row]),
    ).toBeLessThanOrEqual(1);
    for (const key of ["valid", "repair", "icon"] as const)
      expect(
        maxGeometryDelta([before[key], afterBatchOne[key], afterBatchTwo[key]]),
      ).toBeLessThanOrEqual(1);
    expect(afterBatchTwo.repair.right).toBeLessThanOrEqual(
      afterBatchTwo.icon.x + 1,
    );
    expect(afterBatchTwo.icon.right).toBeLessThanOrEqual(
      afterBatchTwo.valid.x + 1,
    );
    for (const probe of [
      "batch-isolation-cell",
      "batch-repair-trigger",
      "batch-isolation-icon",
      "batch-fit-text",
    ]) {
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);
      for (const sample of samples[probe] ?? []) {
        expect(sample.blockLineCount).toBe(1);
        expect(sample.markerCount).toBe(0);
      }
    }
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic keeps hover-menu icons aligned and gives each stable cell its full capacity", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='hover-menu']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });

    const session = await page.context().newCDPSession(page);
    const menu = page.locator("[data-layout-probe='hover-menu']");
    const trigger = page.locator("[data-layout-probe='hover-menu-trigger']");
    await trigger.scrollIntoViewIfNeeded();
    await menu.evaluate((element) =>
      element.setAttribute("data-layout-open", ""),
    );
    await trigger.hover();
    await expect(menu.locator(".hover-menu-items")).toBeVisible();
    const pseudoBefore = await pseudoBox(
      session,
      "[data-layout-probe='hover-menu-trigger']",
      "after",
    );
    expect(pseudoBefore).not.toBeNull();
    const iconBefore = await page
      .locator("[data-layout-probe='hover-menu-icon']")
      .evaluate((icon) => {
        const { x, y, width, height } = icon.getBoundingClientRect();
        const host = icon.parentElement?.getBoundingClientRect();
        return { icon: { x, y, width, height }, host };
      });
    expect(iconBefore.host).not.toBeUndefined();
    const itemSources = await page
      .locator("[data-layout-probe^='hover-menu-item-']")
      .evaluateAll((cells) =>
        cells.map((cell) => {
          const text = cell.querySelector("a")?.firstChild;
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          return {
            text: text?.textContent ?? "",
            textWidth: text ? range.getBoundingClientRect().width : 0,
          };
        }),
      );
    expect(itemSources.map(({ text }) => text)).toEqual([
      "English hover item",
      "Mục menu tiếng Việt",
      "日本語メニュー",
      "Long hover menu label",
    ]);

    await startFrameSampler(page, ["hover-menu-trigger"]);
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() =>
        providerBatches.some((requests) =>
          requests.some((request) => request.includes("English hover item")),
        ),
      )
      .toBe(true);
    await expect(
      page.locator("[data-layout-probe='hover-menu-item-en']"),
    ).toHaveText("Mục menu tiếng Việt");
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    await trigger.hover();
    await expect(menu.locator(".hover-menu-items")).toBeVisible();

    const items = await page
      .locator("[data-layout-probe^='hover-menu-item']")
      .evaluateAll((cells) =>
        cells.map((cell) => {
          const anchor = cell.querySelector("a");
          const wrapper = anchor?.querySelector(
            "tryhand-ellipsis.tryhand-ellipsis[data-tryhand-layout='single-line']",
          );
          if (!(anchor instanceof HTMLElement))
            return {
              valid: false,
              visible: false,
              cellWidth: 0,
              textWidth: 0,
              wrapperWidth: 0,
              overflow: false,
              title: null,
              text: null,
              lineCount: 0,
              wrapper: false,
              textOverflow: null,
              whiteSpace: null,
            };
          const text = wrapper?.firstChild ?? anchor.firstChild;
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          const lineCount = new Set(
            [...range.getClientRects()].map(
              (rect) => Math.round(rect.y * 2) / 2,
            ),
          ).size;
          const style = getComputedStyle(cell);
          const rect = cell.getBoundingClientRect();
          const overflow =
            wrapper instanceof HTMLElement &&
            (wrapper.scrollWidth > wrapper.clientWidth ||
              wrapper.scrollHeight > wrapper.clientHeight);
          const wrapperStyle =
            wrapper instanceof HTMLElement ? getComputedStyle(wrapper) : null;
          return {
            valid: true,
            visible:
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0,
            cellWidth: cell.clientWidth,
            textWidth: text ? range.getBoundingClientRect().width : 0,
            wrapperWidth:
              wrapper instanceof HTMLElement ? wrapper.clientWidth : 0,
            overflow,
            title:
              wrapper?.getAttribute("title") ?? anchor.getAttribute("title"),
            text: text?.textContent ?? "",
            lineCount,
            wrapper: wrapper instanceof HTMLElement,
            textOverflow: wrapperStyle?.textOverflow ?? null,
            whiteSpace:
              wrapperStyle?.whiteSpace ?? getComputedStyle(anchor).whiteSpace,
          };
        }),
      );
    expect(items).toHaveLength(4);
    expect(items.map(({ text }) => text)).toEqual([
      "Mục menu tiếng Việt",
      "Mục phù hợp",
      "Mục menu tiếng Nhật",
      "Bản dịch tiếng Việt rất dài vượt quá ô menu này",
    ]);
    expect(items[0]!.textWidth).toBeGreaterThan(itemSources[0]!.textWidth + 1);
    for (const item of items.slice(0, 3)) {
      expect(item.valid).toBe(true);
      if (!item.valid) continue;
      expect(item.visible).toBe(true);
      expect(item.textWidth).toBeLessThanOrEqual(item.cellWidth + 0.5);
      expect(item.lineCount).toBe(1);
      expect(item.wrapper).toBe(false);
      expect(item.overflow).toBe(false);
      expect(item.title).toBeNull();
    }
    const overflowing = items[3]!;
    expect(overflowing.valid).toBe(true);
    expect(overflowing.visible).toBe(true);
    expect(overflowing.wrapper).toBe(true);
    expect(overflowing.overflow).toBe(true);
    expect(overflowing.title).toBe(overflowing.text);
    expect(overflowing.textOverflow).toBe("ellipsis");
    expect(overflowing.whiteSpace).toBe("nowrap");
    expect(overflowing.lineCount).toBe(1);

    const iconAfter = await page
      .locator("[data-layout-probe='hover-menu-icon']")
      .evaluate((icon) => {
        const { x, y, width, height } = icon.getBoundingClientRect();
        const host = icon.parentElement?.getBoundingClientRect();
        return { icon: { x, y, width, height }, host };
      });
    expect(iconAfter.host).not.toBeUndefined();
    const beforeOffset =
      iconBefore.icon.y +
      iconBefore.icon.height / 2 -
      (iconBefore.host!.y + iconBefore.host!.height / 2);
    const afterOffset =
      iconAfter.icon.y +
      iconAfter.icon.height / 2 -
      (iconAfter.host!.y + iconAfter.host!.height / 2);
    const iconDelta = maxGeometryDelta([iconBefore.icon, iconAfter.icon]);
    const centerDelta = Math.abs(afterOffset - beforeOffset);
    const geometry = JSON.stringify({
      before: iconBefore,
      after: iconAfter,
      iconDelta,
      centerDelta,
    });
    expect(
      iconDelta,
      `Hover-menu icon geometry changed: ${geometry}`,
    ).toBeLessThanOrEqual(1);
    expect(
      centerDelta,
      `Hover-menu icon center changed: ${geometry}`,
    ).toBeLessThanOrEqual(1);
    const pseudoAfter = await pseudoBox(
      session,
      "[data-layout-probe='hover-menu-trigger']",
      "after",
    );
    expect(pseudoAfter).not.toBeNull();
    expect(maxGeometryDelta([pseudoBefore!, pseudoAfter!])).toBeLessThanOrEqual(
      1,
    );
    expectNoTransientLayout(samples["hover-menu-trigger"] ?? []);
    expect(
      maxGeometryDelta(samples["hover-menu-trigger"] ?? []),
    ).toBeLessThanOrEqual(1);
    await expect(
      page.locator("tryhand-baseline-marker.tryhand-baseline-marker"),
    ).toHaveCount(0);
    await session.detach();
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic restores and retranslates a newly inserted SPA menu without residue", async () => {
    await routeDeterministicProvider(extension.context);
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");

    const insertedHtml = await page.evaluate(() => {
      const root = document.querySelector("#spa-root");
      const replacement = document.createElement("button");
      replacement.dataset.layoutProbe = "spa-replaced";
      replacement.textContent = "Client rendered replacement";
      const menu = document.createElement("ul");
      menu.className = "dropdown-capacity";
      menu.innerHTML =
        '<li data-layout-probe="spa-menu-new"><a href="#spa-menu">Menu item</a></li>';
      root?.replaceChildren(replacement, menu);
      return root?.innerHTML ?? "";
    });
    const spaMenu = page.locator("[data-layout-probe='spa-menu-new']");
    await spaMenu.scrollIntoViewIfNeeded();
    await expect(spaMenu).toHaveText("Mục phù hợp");
    await expect(
      page.locator(
        "[data-layout-probe='spa-menu-new'] tryhand-ellipsis.tryhand-ellipsis",
      ),
    ).toHaveCount(0);
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");

    await expect(page.locator("[data-layout-probe='spa-replaced']")).toHaveText(
      "Client rendered replacement",
    );
    await expect(page.locator("#spa-root")).toHaveJSProperty(
      "innerHTML",
      insertedHtml,
    );
    await expect(page.locator("tryhand-ellipsis.tryhand-ellipsis")).toHaveCount(
      0,
    );
    await expect(
      page.locator("tryhand-baseline-marker.tryhand-baseline-marker"),
    ).toHaveCount(0);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(page.locator("[data-layout-probe='spa-menu-new']")).toHaveText(
      "Mục phù hợp",
    );
    const secondTranslationWrapper = page.locator(
      "[data-layout-probe='spa-menu-new'] tryhand-ellipsis.tryhand-ellipsis",
    );
    const secondTranslationDiagnostics = await spaMenu.evaluate((menu) => {
      const describe = (element: Element | null) => {
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tagName: element.tagName,
          rect: { x, y, width, height },
          style: {
            display: style.display,
            position: style.position,
            inlineSize: style.inlineSize,
            minInlineSize: style.minInlineSize,
            maxInlineSize: style.maxInlineSize,
            overflow: style.overflow,
            whiteSpace: style.whiteSpace,
            textOverflow: style.textOverflow,
          },
        };
      };
      const anchor = menu.querySelector("a");
      const wrapper = menu.querySelector("tryhand-ellipsis.tryhand-ellipsis");
      const walker = document.createTreeWalker(
        anchor ?? menu,
        NodeFilter.SHOW_TEXT,
      );
      let textNode = walker.nextNode();
      while (textNode && !textNode.textContent?.trim()) {
        textNode = walker.nextNode();
      }
      const textRange = textNode ? document.createRange() : null;
      textRange?.selectNodeContents(textNode!);
      const textRect = textRange?.getBoundingClientRect();

      return {
        wrapper: wrapper
          ? {
              ...describe(wrapper),
              title: wrapper.getAttribute("title"),
              inlineStyle: wrapper.getAttribute("style"),
            }
          : null,
        menu: describe(menu),
        anchor: describe(anchor),
        text: {
          value: textNode?.textContent ?? null,
          rect: textRect
            ? {
                x: textRect.x,
                y: textRect.y,
                width: textRect.width,
                height: textRect.height,
              }
            : null,
        },
        scroll: { x: window.scrollX, y: window.scrollY },
        ancestors: [
          describe(menu.parentElement),
          describe(menu.parentElement?.parentElement ?? null),
        ],
      };
    });
    await expect(
      secondTranslationWrapper,
      `Second SPA translation unexpectedly wrapped: ${JSON.stringify(secondTranslationDiagnostics)}`,
    ).toHaveCount(0);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expect(page.locator("#spa-root")).toHaveJSProperty(
      "innerHTML",
      insertedHtml,
    );
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic restores a host-moved translated Text in its current host", async () => {
    const providerBatches: string[][] = [];
    await routeDeterministicProvider(extension.context, (requests) =>
      providerBatches.push(requests),
    );
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect(
      page.locator(
        "[data-layout-probe='flex-single'] tryhand-ellipsis.tryhand-ellipsis",
      ),
    ).toHaveCount(1);

    const moved = await page.evaluate(() => {
      const wrapper = document.querySelector(
        "[data-layout-probe='flex-single'] tryhand-ellipsis.tryhand-ellipsis",
      );
      const destination = document.querySelector("#moved-text-host");
      const node = wrapper?.firstChild;
      if (!(node instanceof Text) || !destination) return false;
      const marker = document.createComment("tryhand-moved-text");
      destination.append(marker, node);
      (
        window as Window & {
          __tryhandMovedText?: { node: Text; source: string };
        }
      ).__tryhandMovedText = { node, source: "Open account" };
      return node.isConnected ? node.textContent : false;
    });
    expect(moved).not.toBe(false);
    const movedText = String(moved);
    expect(movedText).toContain("Bản dịch tiếng Việt dài");

    const batchesBeforeLaterElement = providerBatches.length;
    await page.evaluate(() => {
      const laterContainer = document.createElement("div");
      laterContainer.style.cssText =
        "position: fixed; inset: 4px auto auto 4px; z-index: 1";
      const laterElement = document.createElement("span");
      laterElement.dataset.layoutProbe = "moved-text-later-batch";
      laterElement.textContent = "Moved host later batch";
      laterContainer.append(laterElement);
      document.body.append(laterContainer);
    });
    const laterElement = page.locator(
      "[data-layout-probe='moved-text-later-batch']",
    );
    await expect(laterElement).toHaveText("Batch sau riêng biệt");
    expect(
      providerBatches
        .slice(batchesBeforeLaterElement)
        .some((batch) =>
          batch.some((request) => request.includes("Moved host later batch")),
        ),
    ).toBe(true);
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis:empty, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const marker = [
          ...document.querySelector("#moved-text-host")!.childNodes,
        ].find(
          (node) =>
            node.nodeType === Node.COMMENT_NODE &&
            node.textContent === "tryhand-moved-text",
        );
        const moved = (
          window as Window & {
            __tryhandMovedText?: { node: Text; source: string };
          }
        ).__tryhandMovedText;
        return {
          identity: marker?.nextSibling === moved?.node,
          text: moved?.node.data,
        };
      }),
    ).toEqual({ identity: true, text: movedText });

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    expect(
      await page.evaluate(() => {
        const marker = [
          ...document.querySelector("#moved-text-host")!.childNodes,
        ].find(
          (node) =>
            node.nodeType === Node.COMMENT_NODE &&
            node.textContent === "tryhand-moved-text",
        );
        const moved = (
          window as Window & {
            __tryhandMovedText?: { node: Text; source: string };
          }
        ).__tryhandMovedText;
        return {
          identity: marker?.nextSibling === moved?.node,
          source: moved?.source,
          text: moved?.node.data,
        };
      }),
    ).toEqual({ identity: true, source: "Open account", text: "Open account" });
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis:empty, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic stretched dedicated rows keep fitting English raw and constrain shrink-to-fit overflow", async () => {
    const fitEnglish = "List of invoices";
    const overflowEnglish =
      "List of invoices and complete payment history for every related billing period and customer account";
    const actionEnglish = "Create a new invoice for this customer";
    // Each Text record is one plain-text stage source (no markup markers).
    await routeDeterministicProvider(extension.context, undefined, {
      translate: (text) => {
        if (text.includes("請求書")) return fitEnglish;
        if (text.includes("支払履歴")) return overflowEnglish;
        if (text.includes("新規")) return actionEnglish;
        return text;
      },
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='dedicated-shrink-fit-capacity']")
        ?.removeAttribute("contenteditable");
    });

    const sampledProbes = [
      "stretched-icon-text-fit",
      "stretched-icon-text-fit-icon",
      "stretched-icon-text-overflow",
      "stretched-icon-text-overflow-icon",
      "shrink-fit-action-group",
      "shrink-fit-action-host",
      "shrink-fit-action-peer",
    ];
    const measure = () =>
      page.evaluate(() => {
        const rect = (target: Element) => {
          const { x, y, width, height } = target.getBoundingClientRect();
          return { x, y, width, height };
        };
        const snapshot = (probe: string, host: Element, icon?: Element) => {
          const wrapper = host.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          const textWalker = document.createTreeWalker(
            wrapper ?? host,
            NodeFilter.SHOW_TEXT,
          );
          let text: Text | null =
            wrapper?.firstChild instanceof Text ? wrapper.firstChild : null;
          if (!text) {
            for (
              let node = textWalker.nextNode();
              node;
              node = textWalker.nextNode()
            ) {
              if (
                !node.textContent?.trim() ||
                (node.parentElement &&
                  node.parentElement.closest('[contenteditable="true"]'))
              )
                continue;
              text = node as Text;
              break;
            }
          }
          const range = document.createRange();
          if (text) range.selectNodeContents(text);
          const textBox = text ? range.getBoundingClientRect() : rect(host);
          const style = getComputedStyle(host);
          const remainingInterval =
            host.getBoundingClientRect().right -
            Number.parseFloat(style.paddingRight) -
            Number.parseFloat(style.borderRightWidth) -
            textBox.x;
          const innerInterval =
            host.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight);
          return {
            clipped: Boolean(
              wrapper && wrapper.scrollWidth > wrapper.clientWidth + 0.5,
            ),
            host: rect(host),
            icon: icon ? rect(icon) : null,
            innerInterval,
            remainingInterval,
            row: rect(
              document.querySelector(`[data-layout-probe='${probe}']`)!,
            ),
            scrollWidth: wrapper?.scrollWidth ?? textBox.width,
            text: text?.textContent?.trim() ?? "",
            textWidth: textBox.width,
            title: wrapper?.getAttribute("title") ?? host.getAttribute("title"),
            wrapper: wrapper ? rect(wrapper) : null,
            wrapperCount: host.querySelectorAll(
              "tryhand-ellipsis.tryhand-ellipsis",
            ).length,
          };
        };
        const fitRow = document.querySelector(
          "[data-layout-probe='stretched-icon-text-fit']",
        )!;
        const overflowRow = document.querySelector(
          "[data-layout-probe='stretched-icon-text-overflow']",
        )!;
        const group = document.querySelector(
          "[data-layout-probe='shrink-fit-action-group']",
        )!;
        return {
          action: {
            ...snapshot(
              "shrink-fit-action-host",
              document.querySelector(
                "[data-layout-probe='shrink-fit-action-host']",
              )!,
            ),
            group: rect(group),
            peer: rect(
              document.querySelector(
                "[data-layout-probe='shrink-fit-action-peer']",
              )!,
            ),
          },
          fit: snapshot(
            "stretched-icon-text-fit",
            fitRow.querySelector("button")!,
            document.querySelector(
              "[data-layout-probe='stretched-icon-text-fit-icon']",
            ) ?? undefined,
          ),
          overflow: snapshot(
            "stretched-icon-text-overflow",
            overflowRow.querySelector("button")!,
            document.querySelector(
              "[data-layout-probe='stretched-icon-text-overflow-icon']",
            ) ?? undefined,
          ),
        };
      });

    await page
      .locator("[data-layout-probe='dedicated-shrink-fit-capacity']")
      .scrollIntoViewIfNeeded();
    const before = await measure();
    await startFrameSampler(page, sampledProbes);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(async () => {
        const current = await measure();
        return [
          current.fit.text,
          current.overflow.text,
          current.action.text,
        ].join("|");
      })
      .toBe(`${fitEnglish}|${overflowEnglish}|${actionEnglish}`);
    await waitForSchedulerTicks(page);
    await waitForFrames(page);
    const samples = await stopFrameSampler(page);
    const after = await measure();

    expect(before.fit.remainingInterval).toBeGreaterThan(
      before.fit.textWidth + 1,
    );
    expect(after.fit.text).toBe(fitEnglish);
    expect(after.fit.wrapper).toBeNull();
    expect(after.fit.wrapperCount).toBe(0);
    expect(after.fit.title).toBeNull();
    expect(after.fit.clipped).toBe(false);
    expect(after.fit.textWidth).toBeGreaterThan(before.fit.textWidth);
    expect(after.fit.textWidth).toBeLessThanOrEqual(
      before.fit.remainingInterval + 1,
    );
    expect(
      maxGeometryDelta([before.fit.row, after.fit.row]),
    ).toBeLessThanOrEqual(1);

    expect(before.overflow.remainingInterval).toBeGreaterThan(
      before.overflow.textWidth + 1,
    );
    expect(after.overflow.text).toBe(overflowEnglish);
    expect(
      after.overflow.wrapperCount,
      "overflow row must install one wrapper",
    ).toBe(1);
    expect(after.overflow.wrapper).not.toBeNull();
    expect(after.overflow.title).toBe(overflowEnglish);
    expect(after.overflow.clipped).toBe(true);
    expect(after.overflow.scrollWidth).toBeGreaterThan(
      before.overflow.remainingInterval + 1,
    );
    expect(
      maxGeometryDelta([before.overflow.row, after.overflow.row]),
    ).toBeLessThanOrEqual(1);
    expect(
      maxGeometryDelta([before.overflow.icon!, after.overflow.icon!]),
    ).toBeLessThanOrEqual(1);

    expect(after.action.text).toBe(actionEnglish);
    expect(
      after.action.wrapper,
      "shrink-to-fit overflow must install a wrapper; unsupported install must not pass",
    ).not.toBeNull();
    expect(after.action.wrapperCount).toBe(1);
    expect(after.action.title).toBe(actionEnglish);
    expect(after.action.clipped).toBe(true);
    expect(after.action.scrollWidth).toBeGreaterThan(
      before.action.innerInterval + 1,
    );
    expect(
      maxGeometryDelta([before.action.host, after.action.host]),
    ).toBeLessThanOrEqual(1);
    expect(
      maxGeometryDelta([before.action.group, after.action.group]),
    ).toBeLessThanOrEqual(1);
    expect(
      maxGeometryDelta([before.action.peer, after.action.peer]),
    ).toBeLessThanOrEqual(1);

    for (const probe of sampledProbes)
      expect(maxGeometryDelta(samples[probe] ?? [])).toBeLessThanOrEqual(1);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    const restored = await measure();
    expect(restored.fit.text).toBe("請求書");
    expect(restored.overflow.text).toBe("支払履歴");
    expect(restored.action.text).toBe("新規");
    expect(restored.fit.wrapperCount).toBe(0);
    expect(restored.overflow.wrapperCount).toBe(0);
    expect(restored.action.wrapperCount).toBe(0);
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  test("@deterministic hugging truncate labels use anchor capacity and clamp overflow with a tooltip", async () => {
    const fitEnglish = "List of delivery slips";
    const overflowEnglish =
      "Contact memo with an extremely long translated label that cannot possibly fit";
    // Each Text record is one plain-text stage source (no markup markers).
    await routeDeterministicProvider(extension.context, undefined, {
      translate: (text) => {
        if (text.includes("納品書一覧")) return fitEnglish;
        if (text.includes("連絡メモ")) return overflowEnglish;
        return text;
      },
    });
    const page = await extension.context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(fixture.url);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll(
        "main > section, main > article",
      ))
        element.setAttribute("contenteditable", "true");
      document
        .querySelector("[data-layout-probe='hug-truncate-fit']")
        ?.closest("section")
        ?.removeAttribute("contenteditable");
    });

    const measure = () =>
      page.evaluate(() => {
        const rect = (target: Element) => {
          const { x, y, width, height } = target.getBoundingClientRect();
          return { x, y, width, height };
        };
        const snapshot = (probe: string) => {
          const anchor = document.querySelector(
            `[data-layout-probe='${probe}']`,
          )!;
          const label = anchor.querySelector(".hug-label")!;
          const wrapper = anchor.querySelector<HTMLElement>(
            "tryhand-ellipsis.tryhand-ellipsis",
          );
          return {
            anchor: rect(anchor),
            clipped: Boolean(
              wrapper && wrapper.scrollWidth > wrapper.clientWidth + 0.5,
            ),
            label: rect(label),
            text: anchor.textContent?.trim() ?? "",
            title: wrapper?.getAttribute("title") ?? null,
            wrapperCount: anchor.querySelectorAll(
              "tryhand-ellipsis.tryhand-ellipsis",
            ).length,
          };
        };
        return {
          fit: snapshot("hug-truncate-fit"),
          overflow: snapshot("hug-truncate-overflow"),
        };
      });
    await page
      .locator("[data-layout-probe='hug-truncate-fit']")
      .scrollIntoViewIfNeeded();
    const before = await measure();

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(async () => {
        const current = await measure();
        return [current.fit.text, current.overflow.text].join("|");
      })
      .toBe(`${fitEnglish}|${overflowEnglish}`);
    await waitForSchedulerTicks(page);
    await waitForFrames(page);
    const after = await measure();

    expect(after.fit.wrapperCount).toBe(0);
    expect(after.fit.title).toBeNull();
    expect(after.fit.label.width).toBeGreaterThan(before.fit.label.width);
    expect(
      maxGeometryDelta([before.fit.anchor, after.fit.anchor]),
    ).toBeLessThanOrEqual(1);

    expect(after.overflow.wrapperCount).toBe(1);
    expect(after.overflow.clipped).toBe(true);
    expect(after.overflow.title).toBe(overflowEnglish);
    expect(after.overflow.label.width).toBeGreaterThan(
      before.overflow.label.width,
    );
    expect(
      after.overflow.label.x + after.overflow.label.width,
    ).toBeLessThanOrEqual(
      after.overflow.anchor.x + after.overflow.anchor.width - 12 + 1,
    );
    expect(
      maxGeometryDelta([before.overflow.anchor, after.overflow.anchor]),
    ).toBeLessThanOrEqual(1);

    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    const restored = await measure();
    expect(restored.fit.text).toBe("納品書一覧");
    expect(restored.overflow.text).toBe("連絡メモ");
    expect(restored.fit.wrapperCount).toBe(0);
    expect(restored.overflow.wrapperCount).toBe(0);
    await expect(
      page.locator(
        "tryhand-ellipsis.tryhand-ellipsis, tryhand-baseline-marker.tryhand-baseline-marker",
      ),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });

  for (const liveCase of [
    [
      "Asahi AJW",
      "https://www.asahi.com/ajw/",
      "layout-ellipsis-live-asahi.png",
      "layout-ellipsis-live-asahi.json",
      false,
    ],
    [
      "Wikipedia scroll",
      "https://en.wikipedia.org/wiki/Main_Page",
      "layout-ellipsis-live-wikipedia.png",
      "layout-ellipsis-live-wikipedia.json",
      true,
    ],
    [
      "Yahoo! JAPAN",
      "https://www.yahoo.co.jp/",
      "layout-ellipsis-live-yahoo.png",
      "layout-ellipsis-live-yahoo.json",
      false,
    ],
  ] as const) {
    test(`@live translates and restores ${liveCase[0]} through the top frame`, async () => {
      test.skip(
        process.env.RUN_LIVE_LAYOUT_SMOKE !== "1",
        "Set RUN_LIVE_LAYOUT_SMOKE=1 to run live-site DOM checks with the deterministic backend.",
      );
      const providerExchanges: LiveProviderExchange[] = [];
      let providerRequestCount = 0;
      await routeDeterministicProvider(extension.context, undefined, {
        // The live oracle needs both fitting and truly overflowing translations.
        // Each Text record is one plain-text stage source.
        translate: (text, index) => {
          // Use plausible short labels for navigation while dropdown/body fixtures
          // still exercise long overflow. Geometry tolerances remain unchanged.
          const navigation: Record<string, string> = {
            HOME: "Trang chủ",
            "What’s New": "Tin mới",
            "National Report": "Tin trong nước",
            Politics: "Chính trị",
            Business: "Kinh tế",
            "Asia & World": "Châu Á & thế giới",
            "Sci & Tech": "Khoa học và công nghệ",
            Culture: "Văn hóa",
            Travel: "Du lịch",
            Sports: "Thể thao",
            Opinion: "Ý kiến",
            Special: "Đặc biệt",
          };
          if (
            process.env.RUN_LIVE_NAV_REALISTIC_LABELS === "1" &&
            liveCase[0] === "Asahi AJW" &&
            navigation[text]
          )
            return navigation[text];
          return text === "Style" ? "Phong cách" : translatedText(text, index);
        },
        observeRequest: ({ requests, results, status }) => {
          providerRequestCount += 1;
          if (status >= 200 && status < 300)
            providerExchanges.push({ requests, results });
        },
      });
      const page = await extension.context.newPage();
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(liveCase[1], { waitUntil: "domcontentloaded" });
      const liveScrollOrigin = await page.evaluate(() => window.scrollY);
      await installLiveRetentionProbe(page);
      const beforeTranslation = await visibleBodyText(page);
      const vietnameseBefore = vietnameseCharacterCount(beforeTranslation);
      expect(beforeTranslation).not.toBe("");
      const asahiDropdownBefore =
        liveCase[0] === "Asahi AJW" ? await asahiDropdownSnapshot(page) : null;
      if (liveCase[0] === "Asahi AJW" && !asahiDropdownBefore) {
        test.skip(
          true,
          "Asahi dropdowns were not reachable after hover before translation; external markup/interaction availability is not product evidence.",
        );
        return;
      }
      const asahiSession =
        liveCase[0] === "Asahi AJW"
          ? await page.context().newCDPSession(page)
          : null;
      const asahiPseudoTargets =
        liveCase[0] === "Asahi AJW"
          ? await asahiPrimaryPseudoTargets(page)
          : [];
      const asahiPseudoBefore = [];
      if (asahiSession)
        for (const target of asahiPseudoTargets)
          asahiPseudoBefore.push({
            ...target,
            rect: await pseudoBox(
              asahiSession,
              target.selector,
              target.pseudoType,
            ),
          });
      if (asahiSession) {
        expect(asahiPseudoBefore.length).toBeGreaterThan(0);
        expect(asahiPseudoBefore.every(({ rect }) => rect !== null)).toBe(true);
      }
      const asahiIconRects =
        liveCase[0] === "Asahi AJW"
          ? await asahiPrimaryNavIconRects(page)
          : null;
      const asahiNavRectsBefore =
        liveCase[0] === "Asahi AJW" ? await asahiPrimaryNavRects(page) : null;
      const asahiViewportBefore =
        liveCase[0] === "Asahi AJW" ? await asahiViewportMetrics(page) : null;
      const yahooSidebarBefore =
        liveCase[0] === "Yahoo! JAPAN"
          ? await yahooSidebarMeasurements(page)
          : null;
      if (liveCase[0] === "Yahoo! JAPAN" && !yahooSidebarBefore?.length) {
        test.skip(
          true,
          "Yahoo sidebar rows were not present; external markup availability is not product evidence.",
        );
        return;
      }
      await sendTopFrameMessage(extension.worker, liveCase[1], {
        type: "START_TRANSLATION",
        targetLanguage: "vi",
      });
      const terminal = await sendTopFrameMessage(
        extension.worker,
        liveCase[1],
        {
          type: "WAIT_FOR_CONTENT_TERMINAL_STATE",
        },
      );
      expect(["translated", "partial"]).toContain(
        (terminal as { state?: unknown }).state,
      );
      if (liveCase[4]) {
        await page.evaluate(() =>
          window.scrollBy(0, Math.max(window.innerHeight, 600)),
        );
        await waitForSchedulerTicks(page);
        await page.evaluate(
          (scrollY) => window.scrollTo(0, scrollY),
          liveScrollOrigin,
        );
        await waitForSchedulerTicks(page);
      }
      await expect.poll(() => providerExchanges.length).toBeGreaterThan(0);
      const providerRequestCountAfterInitialTranslation = providerRequestCount;
      expect(providerRequestCountAfterInitialTranslation).toBeGreaterThan(0);
      await waitForFrames(page);
      await waitForSchedulerTicks(page);
      await expect(page.locator("body")).not.toBeEmpty();
      await expect
        .poll(() => visibleBodyText(page))
        .not.toBe(beforeTranslation);
      await expect
        .poll(async () => vietnameseCharacterCount(await visibleBodyText(page)))
        .toBeGreaterThan(vietnameseBefore);
      const afterTranslation = await visibleBodyText(page);
      const vietnameseAfter = vietnameseCharacterCount(afterTranslation);
      expect(vietnameseAfter).toBeGreaterThan(vietnameseBefore);
      const candidate =
        liveCase[0] === "Asahi AJW"
          ? await asahiPrimaryNavCandidate(page)
          : await runtimeCandidate(page);
      expect(candidate).not.toBeNull();
      if (asahiDropdownBefore)
        expect(
          await asahiDropdownSnapshot(page),
          "Asahi dropdowns were not reachable after translation.",
        ).not.toBeNull();
      await waitForSchedulerTicks(page);
      const retention = await retainedLiveRecord(page, providerExchanges);
      expect(
        retention,
        `${liveCase[0]} had no source -> provider request/result -> retained connected DOM Text record across ${providerExchanges.length} successful exchange(s).`,
      ).not.toBeNull();
      const initialAsahiDropdownMeasurements = asahiDropdownBefore
        ? await measureAsahiDropdowns(
            page,
            asahiDropdownBefore,
            providerExchanges,
          )
        : null;
      const providerRequestCountAfterFirstDropdownRevealTranslation =
        providerRequestCount;
      const cachedAsahiDropdownMeasurements = asahiDropdownBefore
        ? await measureAsahiDropdowns(
            page,
            asahiDropdownBefore,
            providerExchanges,
          )
        : null;
      const providerRequestCountAfterCachedReflow = providerRequestCount;
      expect(
        providerRequestCountAfterCachedReflow,
        `${liveCase[0]} cached dropdown reflow issued another provider request.`,
      ).toBe(providerRequestCountAfterFirstDropdownRevealTranslation);
      const asahiDropdownMeasurements =
        cachedAsahiDropdownMeasurements ?? initialAsahiDropdownMeasurements;
      const asahiIconRectsAfter = asahiIconRects
        ? await asahiPrimaryNavIconRects(page)
        : null;
      const asahiNavRectsAfter = asahiNavRectsBefore
        ? await asahiPrimaryNavRects(page)
        : null;
      const asahiViewportAfter = asahiViewportBefore
        ? await asahiViewportMetrics(page)
        : null;
      const yahooSidebarAfter = yahooSidebarBefore
        ? await yahooSidebarMeasurements(page)
        : null;
      if (yahooSidebarBefore)
        expect(yahooSidebarAfter?.length).toBeGreaterThan(0);
      const yahooRawFitAfter = yahooSidebarAfter?.find(
        ({ wrapper, visibleText, row, icon }) =>
          !wrapper &&
          visibleText.x >= icon.x + icon.width - 1 &&
          visibleText.x + visibleText.width <= row.x + row.width + 1,
      );
      const yahooOverflowAfter = yahooSidebarAfter?.find(
        ({ wrapper, overflow }) => wrapper && overflow,
      );
      if (yahooRawFitAfter) {
        expect(yahooRawFitAfter.wrapper).toBe(false);
        expect(yahooRawFitAfter.visibleText.x).toBeGreaterThanOrEqual(
          yahooRawFitAfter.icon.x + yahooRawFitAfter.icon.width - 1,
        );
        expect(
          yahooRawFitAfter.visibleText.x + yahooRawFitAfter.visibleText.width,
        ).toBeLessThanOrEqual(
          yahooRawFitAfter.row.x + yahooRawFitAfter.row.width + 1,
        );
      }
      if (yahooOverflowAfter) {
        expect(yahooOverflowAfter.titleLength).toBe(
          yahooOverflowAfter.textLength,
        );
        expect(yahooOverflowAfter.visibleText.x).toBeGreaterThanOrEqual(
          yahooOverflowAfter.icon.x + yahooOverflowAfter.icon.width - 1,
        );
        expect(
          yahooOverflowAfter.visibleText.x +
            yahooOverflowAfter.visibleText.width,
        ).toBeLessThanOrEqual(
          yahooOverflowAfter.row.x + yahooOverflowAfter.row.width + 1,
        );
      }
      if (asahiIconRects && asahiIconRectsAfter) {
        expect(asahiIconRectsAfter).toHaveLength(asahiIconRects.length);
        for (const [index, before] of asahiIconRects.entries()) {
          const after = asahiIconRectsAfter[index]!;
          expect(after.selector).toBe(before.selector);
          const beforeOwner =
            before.layoutContext.anchor ?? before.layoutContext.primaryItem;
          const afterOwner =
            after.layoutContext.anchor ?? after.layoutContext.primaryItem;
          expect(beforeOwner).not.toBeNull();
          expect(afterOwner).not.toBeNull();
          const beforeRelative = relativeRect(before, beforeOwner!);
          const afterRelative = relativeRect(after, afterOwner!);
          const viewportShift = {
            x: after.x - before.x,
            y: after.y - before.y,
            width: after.width - before.width,
            height: after.height - before.height,
          };
          expect(
            maxGeometryDelta([beforeRelative, afterRelative]),
            `Asahi primary-nav icon alignment changed relative to its anchor: ${JSON.stringify({ before, after, beforeRelative, afterRelative, viewportShift, navRectsBefore: asahiNavRectsBefore, navRectsAfter: asahiNavRectsAfter })}`,
          ).toBeLessThanOrEqual(1);
        }
      }
      const asahiPseudoTargetsAfter = asahiSession
        ? await asahiPrimaryPseudoTargets(page)
        : [];
      const asahiPseudoAfter: {
        selector: string;
        pseudoType: "before" | "after";
        ownerRect: Rect;
        rect: Rect | null;
      }[] = [];
      if (asahiSession)
        for (const target of asahiPseudoTargetsAfter)
          asahiPseudoAfter.push({
            ...target,
            rect: await pseudoBox(
              asahiSession,
              target.selector,
              target.pseudoType,
            ),
          });
      for (const [index, before] of asahiPseudoBefore.entries()) {
        const after = asahiPseudoAfter[index];
        expect(after?.selector).toBe(before.selector);
        expect(after?.pseudoType).toBe(before.pseudoType);
        expect(before.rect).not.toBeNull();
        expect(after?.rect).not.toBeNull();
        const beforeRelative = relativeRect(before.rect!, before.ownerRect);
        const afterRelative = relativeRect(after!.rect!, after!.ownerRect);
        expect(
          maxGeometryDelta([beforeRelative, afterRelative]),
          `Asahi primary-nav pseudo-element alignment changed relative to its owner anchor: ${JSON.stringify({ before, after, beforeRelative, afterRelative })}`,
        ).toBeLessThanOrEqual(1);
      }
      if (asahiNavRectsBefore && asahiNavRectsAfter) {
        expect(asahiViewportBefore).not.toBeNull();
        expect(asahiViewportAfter).not.toBeNull();
        const viewportDeltas = {
          innerWidth:
            asahiViewportAfter!.innerWidth - asahiViewportBefore!.innerWidth,
          clientWidth:
            asahiViewportAfter!.clientWidth - asahiViewportBefore!.clientWidth,
          scrollbarWidth:
            asahiViewportAfter!.scrollbarWidth -
            asahiViewportBefore!.scrollbarWidth,
        };
        const containerDeltas = {
          x: asahiNavRectsAfter.container.x - asahiNavRectsBefore.container.x,
          y: asahiNavRectsAfter.container.y - asahiNavRectsBefore.container.y,
          width:
            asahiNavRectsAfter.container.width -
            asahiNavRectsBefore.container.width,
          height:
            asahiNavRectsAfter.container.height -
            asahiNavRectsBefore.container.height,
        };
        const expectedCenteredXShift = viewportDeltas.clientWidth / 2;
        const unexplainedCenteredXShift =
          containerDeltas.x - expectedCenteredXShift;
        const viewportFailureContext = `Asahi navigation viewport shift was not explained by centered layout and scrollbar change: ${JSON.stringify({ viewportBefore: asahiViewportBefore, viewportAfter: asahiViewportAfter, viewportDeltas, containerBefore: asahiNavRectsBefore.container, containerAfter: asahiNavRectsAfter.container, containerDeltas, expectedCenteredXShift, unexplainedCenteredXShift })}`;
        expect(
          Math.abs(viewportDeltas.innerWidth),
          viewportFailureContext,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(unexplainedCenteredXShift),
          viewportFailureContext,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.max(
            Math.abs(containerDeltas.y),
            Math.abs(containerDeltas.width),
            Math.abs(containerDeltas.height),
          ),
          viewportFailureContext,
        ).toBeLessThanOrEqual(1);
        expect(asahiNavRectsAfter.items).toHaveLength(
          asahiNavRectsBefore.items.length,
        );
        for (const [index, before] of asahiNavRectsBefore.items.entries()) {
          const after = asahiNavRectsAfter.items[index]!;
          const beforeRelative = relativeRect(
            before,
            asahiNavRectsBefore.container,
          );
          const afterRelative = relativeRect(
            after,
            asahiNavRectsAfter.container,
          );
          expect(
            maxGeometryDelta([beforeRelative, afterRelative]),
            `Asahi primary-nav item alignment changed relative to its navigation container: ${JSON.stringify({ index, before, after, beforeRelative, afterRelative, containerBefore: asahiNavRectsBefore.container, containerAfter: asahiNavRectsAfter.container })}`,
          ).toBeLessThanOrEqual(1);
        }
      }
      await writeLiveEvidence(
        liveCase[3],
        candidate!,
        retention!,
        beforeTranslation.length,
        afterTranslation.length,
        vietnameseBefore,
        vietnameseAfter,
        {
          afterInitialTopFrameTranslation:
            providerRequestCountAfterInitialTranslation,
          afterFirstDropdownRevealTranslation:
            providerRequestCountAfterFirstDropdownRevealTranslation,
          afterCachedReflow: providerRequestCountAfterCachedReflow,
          additionalCachedReflowRequests:
            providerRequestCountAfterCachedReflow -
            providerRequestCountAfterFirstDropdownRevealTranslation,
        },
        liveCase[0] === "Asahi AJW"
          ? {
              dropdowns: asahiDropdownMeasurements,
              icons: asahiIconRects?.map((before, index) => ({
                before,
                after: asahiIconRectsAfter?.[index],
                viewportShift: asahiIconRectsAfter?.[index]
                  ? {
                      x: asahiIconRectsAfter[index]!.x - before.x,
                      y: asahiIconRectsAfter[index]!.y - before.y,
                    }
                  : null,
                relativeMaxDelta: asahiIconRectsAfter?.[index]
                  ? maxGeometryDelta([
                      relativeRect(
                        before,
                        before.layoutContext.anchor ??
                          before.layoutContext.primaryItem!,
                      ),
                      relativeRect(
                        asahiIconRectsAfter[index]!,
                        asahiIconRectsAfter[index]!.layoutContext.anchor ??
                          asahiIconRectsAfter[index]!.layoutContext
                            .primaryItem!,
                      ),
                    ])
                  : null,
              })),
              navigation:
                asahiNavRectsBefore &&
                asahiNavRectsAfter &&
                asahiViewportBefore &&
                asahiViewportAfter
                  ? {
                      viewportBefore: asahiViewportBefore,
                      viewportAfter: asahiViewportAfter,
                      viewportDeltas: {
                        innerWidth:
                          asahiViewportAfter.innerWidth -
                          asahiViewportBefore.innerWidth,
                        clientWidth:
                          asahiViewportAfter.clientWidth -
                          asahiViewportBefore.clientWidth,
                        scrollbarWidth:
                          asahiViewportAfter.scrollbarWidth -
                          asahiViewportBefore.scrollbarWidth,
                      },
                      containerBefore: asahiNavRectsBefore.container,
                      containerAfter: asahiNavRectsAfter.container,
                      containerViewportShift: {
                        x:
                          asahiNavRectsAfter.container.x -
                          asahiNavRectsBefore.container.x,
                        y:
                          asahiNavRectsAfter.container.y -
                          asahiNavRectsBefore.container.y,
                        width:
                          asahiNavRectsAfter.container.width -
                          asahiNavRectsBefore.container.width,
                        height:
                          asahiNavRectsAfter.container.height -
                          asahiNavRectsBefore.container.height,
                      },
                      expectedCenteredXShift:
                        (asahiViewportAfter.clientWidth -
                          asahiViewportBefore.clientWidth) /
                        2,
                      unexplainedCenteredXShift:
                        asahiNavRectsAfter.container.x -
                        asahiNavRectsBefore.container.x -
                        (asahiViewportAfter.clientWidth -
                          asahiViewportBefore.clientWidth) /
                          2,
                      items: asahiNavRectsBefore.items.map((before, index) => ({
                        before,
                        after: asahiNavRectsAfter.items[index],
                        relativeMaxDelta: maxGeometryDelta([
                          relativeRect(before, asahiNavRectsBefore.container),
                          relativeRect(
                            asahiNavRectsAfter.items[index]!,
                            asahiNavRectsAfter.container,
                          ),
                        ]),
                      })),
                    }
                  : null,
              pseudoElements: asahiPseudoBefore.map((before, index) => ({
                ...before,
                after: asahiPseudoAfter[index]?.rect,
                afterOwnerRect: asahiPseudoAfter[index]?.ownerRect,
                relativeMaxDelta: maxGeometryDelta([
                  relativeRect(before.rect!, before.ownerRect),
                  relativeRect(
                    asahiPseudoAfter[index]!.rect!,
                    asahiPseudoAfter[index]!.ownerRect,
                  ),
                ]),
              })),
            }
          : yahooSidebarBefore && yahooSidebarAfter
            ? {
                sidebar: {
                  candidateCountBefore: yahooSidebarBefore.length,
                  candidateCountAfter: yahooSidebarAfter.length,
                  rawFit: yahooRawFitAfter ?? null,
                  trueOverflow: yahooOverflowAfter ?? null,
                },
              }
            : null,
      );
      await captureEvidence(page, liveCase[2]);
      await asahiSession?.detach();

      await sendTopFrameMessage(extension.worker, liveCase[1], {
        type: "SHOW_ORIGINAL",
      });
      await waitForState(extension.worker, liveCase[1], "original");
      await expectLiveRecordRestored(page, retention!);
      await expect(
        page.locator(
          "tryhand-ellipsis.tryhand-ellipsis, tryhand-baseline-marker.tryhand-baseline-marker",
        ),
      ).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    });
  }
});
