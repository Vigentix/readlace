import { expect, test } from "@playwright/test";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
  type Route,
  type Worker,
} from "@playwright/test";
import { routeE2EProvider } from "@/e2e/provider-stage";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const extensionPath = path.resolve(
  process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const fixturePath = path.resolve("tests/fixtures/selection-translation.html");
const screenshotPath = path.resolve(
  "output/selection-translation-deterministic.png",
);
const stableExtensionId = "imlhpiikjakgljngkdalbfgdpkniejdb";

interface ExtensionSession {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  worker: Worker;
  close: () => Promise<void>;
}

interface ProviderRequest {
  active: number;
  sources: string[];
  target: string;
}

function executablePath() {
  const executable =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    chromium.executablePath();
  if (!executable) throw new Error("Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.");
  return executable;
}

async function launchExtension(wakeUrl: string): Promise<ExtensionSession> {
  const executable = executablePath();
  await Promise.all([access(executable), access(extensionPath)]);
  const userDataDir = await mkdtemp(path.join(tmpdir(), "readlace-selection-"));
  const installedExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const context = await chromium.launchPersistentContext(
    userDataDir,
    installedExecutable
      ? {
          executablePath: executable,
          headless: false,
          ignoreDefaultArgs: ["--disable-extensions"],
          args: ["--enable-unsafe-extension-debugging"],
        }
      : {
          executablePath: executable,
          headless: false,
          ignoreDefaultArgs: ["--disable-extensions"],
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
          ],
        },
  );
  let extensionId = "";
  if (installedExecutable) {
    const browser = context.browser();
    if (!browser) throw new Error("Installed Chrome browser is unavailable.");
    const session = await browser.newBrowserCDPSession();
    try {
      const loaded = (await session.send("Extensions.loadUnpacked", {
        path: extensionPath,
      })) as { id: string };
      extensionId = loaded.id;
    } finally {
      await session.detach();
    }
  }
  const isExtensionWorker = (candidate: Worker) =>
    !extensionId ||
    candidate.url().startsWith(`chrome-extension://${extensionId}/`);
  let worker = context.serviceWorkers().find(isExtensionWorker);
  try {
    if (!worker) {
      const ready = context.waitForEvent("serviceworker", {
        predicate: isExtensionWorker,
        timeout: 30_000,
      });
      const wakePage = await context.newPage();
      try {
        await wakePage.goto(wakeUrl);
        worker = await ready;
      } finally {
        await wakePage.close();
      }
    }
  } catch (error) {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
    throw error;
  }
  extensionId ||= new URL(worker.url()).host;
  return {
    context,
    extensionId,
    userDataDir,
    worker,
    close: async () => {
      await context.close();
      await rm(userDataDir, { force: true, recursive: true });
    },
  };
}

async function startFixtureServer() {
  const fixture = await readFile(fixturePath);
  let server: Server;
  await new Promise<void>((resolve) => {
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/frame") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end(
          '<!doctype html><html lang="ja"><body><p id="frame-source">Injected frame readable text.</p><input value="Injected editable text"></body></html>',
        );
        return;
      }
      if (pathname === "/away") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
        });
        response.end("<!doctype html><title>Away</title><p>Away page</p>");
        return;
      }
      if (pathname !== "/fixture") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixture);
    }).listen(0, "127.0.0.1", resolve);
  });
  const address = server!.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server failed.");
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function routeBackend(
  context: BrowserContext,
  requests: ProviderRequest[],
) {
  let authenticated = true;
  let unavailable = false;
  let active = 0;
  let maxActive = 0;
  let fail = false;
  const handleBackend = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.pathname === "/v1/auth/refresh" ||
      url.pathname === "/v1/auth/login"
    ) {
      await route.fulfill({
        status: unavailable ? 503 : authenticated ? 200 : 401,
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
        status: unavailable ? 503 : authenticated ? 200 : 401,
        contentType: "application/json",
        body: JSON.stringify(
          authenticated
            ? {
                authenticated: true,
                user: { id: "selection-user", email: "member@example.com" },
              }
            : { authenticated: false },
        ),
      });
      return;
    }
    // One routed backend stage; the extension never names an engine.
    if (url.pathname !== "/v1/translation-stages") {
      await route.fulfill({ status: 404, body: "{}" });
      return;
    }
    const body = request.postDataJSON() as {
      sources: string[][];
      targetLanguage: string;
    };
    const sources = body.sources.flat();
    active += 1;
    maxActive = Math.max(maxActive, active);
    requests.push({
      active,
      sources,
      target: body.targetLanguage,
    });
    const persistedDelay = sources.some((source) =>
      source.includes("Persisted pending selection"),
    );
    const isDelayed =
      persistedDelay ||
      sources.some((source) => source.includes("Delayed selection"));
    if (isDelayed)
      await new Promise((resolve) =>
        setTimeout(resolve, persistedDelay ? 1_500 : 700),
      );
    active -= 1;
    if (fail) {
      await route.fulfill({
        status: 400,
        body: '{"error":{"message":"rejected"}}',
      });
      return;
    }
    const results = body.sources.map((row) =>
      row.map((text) =>
        text.includes("Viewport edge")
          ? `<img src=x onerror=alert(1)> ${"Long plain-text result ".repeat(80)}`
          : `Selection ${body.targetLanguage}: ${text}`,
      ),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results,
        provenance: body.sources.map((row) => row.map(() => "openai")),
        failures: [],
        diagnostics: {
          records: sources.length,
          sourceCharacters: sources.join("").length,
          requestCount: 1,
          requestMs: 1,
        },
      }),
    });
  };
  await context.route(/^https:\/\/api\.example\.test\/.*/, handleBackend);
  // ADR 0020: translation goes to OpenAI with the user's key; this stub
  // answers it through the stage adapter.
  await routeE2EProvider(context, handleBackend);
  return {
    setAuthenticated: (value: boolean) => (authenticated = value),
    setUnavailable: (value: boolean) => (unavailable = value),
    setFail: (value: boolean) => (fail = value),
    maxActive: () => maxActive,
  };
}

async function seedAuthentication(worker: Worker) {
  await worker.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("web-page-translation", 1);
      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains("kv"))
          request.result.createObjectStore("kv");
      });
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    try {
      const transaction = database.transaction("kv", "readwrite");
      transaction
        .objectStore("kv")
        .put("deterministic-refresh-token", "auth:v1:refresh-token");
      await new Promise<void>((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve(), {
          once: true,
        });
        transaction.addEventListener("error", () => reject(transaction.error), {
          once: true,
        });
        transaction.addEventListener("abort", () => reject(transaction.error), {
          once: true,
        });
      });
    } finally {
      database.close();
    }
  });
}

async function setStoredProvider(
  worker: Worker,
  provider: "google" | "openai",
) {
  await worker.evaluate(async (provider) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("web-page-translation", 1);
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    try {
      const transaction = database.transaction("kv", "readwrite");
      transaction.objectStore("kv").put(provider, "translationProvider");
      await new Promise<void>((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve(), {
          once: true,
        });
        transaction.addEventListener("error", () => reject(transaction.error), {
          once: true,
        });
        transaction.addEventListener("abort", () => reject(transaction.error), {
          once: true,
        });
      });
    } finally {
      database.close();
    }
  }, provider);
}

async function storedProvider(worker: Worker) {
  return worker.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("web-page-translation", 1);
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      });
      request.addEventListener("error", () => reject(request.error), {
        once: true,
      });
    });
    try {
      const transaction = database.transaction("kv", "readonly");
      const request = transaction.objectStore("kv").get("translationProvider");
      return await new Promise<unknown>((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), {
          once: true,
        });
        request.addEventListener("error", () => reject(request.error), {
          once: true,
        });
      });
    } finally {
      database.close();
    }
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

async function waitForState(worker: Worker, url: string, state: string) {
  await expect
    .poll(async () => {
      const response = (await sendTopFrameMessage(worker, url, {
        type: "CONTENT_STATE",
      })) as { state?: string };
      return response.state;
    })
    .toBe(state);
}

async function setTabZoom(worker: Worker, url: string, zoomFactor: number) {
  return worker.evaluate(
    async ({ targetUrl, zoomFactor }) => {
      const extensionBrowser = (
        globalThis as unknown as {
          browser: {
            tabs: {
              getZoom: (tabId: number) => Promise<number>;
              query: (
                query: object,
              ) => Promise<{ id?: number; url?: string }[]>;
              setZoom: (tabId: number, zoomFactor: number) => Promise<void>;
            };
          };
        }
      ).browser;
      const tab = (await extensionBrowser.tabs.query({})).find(
        (candidate) => candidate.url === targetUrl,
      );
      if (tab?.id === undefined)
        throw new Error(`No extension tab matched ${targetUrl}`);
      await extensionBrowser.tabs.setZoom(tab.id, zoomFactor);
      return extensionBrowser.tabs.getZoom(tab.id);
    },
    { targetUrl: url, zoomFactor },
  );
}

async function selectText(
  page: Page | Frame,
  selector: string,
  start: number,
  end: number,
  backward = false,
  dispatchFromTarget = false,
  markColdStart = false,
) {
  return page.evaluate(
    ({ selector, start, end, backward, dispatchFromTarget, markColdStart }) => {
      const root = document.querySelector(selector);
      if (!root) throw new Error(`Missing ${selector}`);
      const locate = (offset: number) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let consumed = 0;
        while ((node = walker.nextNode())) {
          const length = node.textContent?.length ?? 0;
          if (consumed + length >= offset)
            return [node, offset - consumed] as const;
          consumed += length;
        }
        throw new Error(`Offset ${offset} is outside ${selector}`);
      };
      const [startNode, startOffset] = locate(start);
      const [endNode, endOffset] = locate(end);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.setBaseAndExtent(
        backward ? endNode : startNode,
        backward ? endOffset : startOffset,
        backward ? startNode : endNode,
        backward ? startOffset : endOffset,
      );
      if (markColdStart)
        (
          window as unknown as { __selectionColdStart?: number }
        ).__selectionColdStart = performance.now();
      (dispatchFromTarget ? root : document).dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return selection.toString();
    },
    { selector, start, end, backward, dispatchFromTarget, markColdStart },
  );
}

async function documentFootprint(page: Page) {
  return page.evaluate(() => ({
    bodyDisplay: getComputedStyle(document.body).display,
    documentHeight: document.documentElement.scrollHeight,
    documentWidth: document.documentElement.scrollWidth,
    siblings: [...document.body.children]
      .filter(
        (element) =>
          element.tagName !== "SCRIPT" &&
          element.tagName !== "READLACE-SELECTION-TRANSLATOR",
      )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.id,
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        };
      }),
  }));
}

async function selectionFragmentRects(page: Page) {
  return page.evaluate(() =>
    Array.from(window.getSelection()!.getRangeAt(0).getClientRects()).map(
      (rect) => ({
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        top: rect.top,
      }),
    ),
  );
}

function attributes(node: { attributes?: string[] }) {
  return Object.fromEntries(
    Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, index) => [
      node.attributes![index * 2],
      node.attributes![index * 2 + 1],
    ]),
  );
}

async function findShadowNode(session: CDPSession, className: string) {
  const { nodes } = await session.send("DOM.getFlattenedDocument", {
    depth: -1,
    pierce: true,
  });
  const node = nodes.find((candidate) => {
    const attrs = attributes(candidate);
    return (
      candidate.nodeName === className ||
      attrs.id === className ||
      attrs.class?.split(/\s+/).includes(className)
    );
  });
  return node;
}

async function shadowNode(session: CDPSession, className: string) {
  await session.send("DOM.enable");
  let node: Awaited<ReturnType<typeof findShadowNode>>;
  await expect
    .poll(async () =>
      Boolean((node = await findShadowNode(session, className))),
    )
    .toBe(true);
  if (!node) throw new Error(`Missing closed-shadow node ${className}`);
  return node;
}

async function findShadowNodeByAttributes(
  session: CDPSession,
  expected: Record<string, string>,
) {
  const { nodes } = await session.send("DOM.getFlattenedDocument", {
    depth: -1,
    pierce: true,
  });
  return nodes.find((node) => {
    const attrs = attributes(node);
    return Object.entries(expected).every(
      ([name, value]) => attrs[name] === value,
    );
  });
}

interface ShadowBox {
  bottom: number;
  centerX: number;
  centerY: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

const shadowNodeVisibility =
  "function(){const rect=this.getBoundingClientRect();const style=getComputedStyle(this);return this.isConnected&&rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&Number(style.opacity)>0&&style.pointerEvents!=='none'}";

async function stableShadowBox(
  session: CDPSession,
  description: string,
  find: () => Promise<{ backendNodeId: number } | undefined>,
): Promise<ShadowBox> {
  await session.send("DOM.enable");
  let box: ShadowBox | undefined;
  let lastIssue = "node not found";
  try {
    await expect
      .poll(
        async () => {
          box = undefined;
          const node = await find();
          if (!node) {
            lastIssue = "node not found";
            return false;
          }
          try {
            const resolved = await session.send("DOM.resolveNode", {
              backendNodeId: node.backendNodeId,
            });
            const objectId = resolved.object.objectId;
            if (!objectId) {
              lastIssue = "node could not be resolved";
              return false;
            }
            const visible = await session.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: shadowNodeVisibility,
              returnByValue: true,
            });
            if (visible.exceptionDetails || visible.result.value !== true) {
              lastIssue = "node is detached or not visible";
              return false;
            }
            const { model } = await session.send("DOM.getBoxModel", {
              backendNodeId: node.backendNodeId,
            });
            const quad = model.border;
            const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
            const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
            if ([...xs, ...ys].some((value) => !Number.isFinite(value))) {
              lastIssue = "node has an invalid border box";
              return false;
            }
            const left = Math.min(...xs);
            const right = Math.max(...xs);
            const top = Math.min(...ys);
            const bottom = Math.max(...ys);
            if (right <= left || bottom <= top) {
              lastIssue = "node has a zero-sized border box";
              return false;
            }
            const stillVisible = await session.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: shadowNodeVisibility,
              returnByValue: true,
            });
            if (
              stillVisible.exceptionDetails ||
              stillVisible.result.value !== true
            ) {
              lastIssue = "node detached while its box was measured";
              return false;
            }
            box = {
              bottom,
              centerX: (left + right) / 2,
              centerY: (top + bottom) / 2,
              height: bottom - top,
              left,
              right,
              top,
              width: right - left,
            };
            return true;
          } catch (error) {
            lastIssue = error instanceof Error ? error.message : String(error);
            return false;
          }
        },
        {
          message: `Wait for a stable visible closed-shadow node: ${description}`,
          timeout: 5_000,
        },
      )
      .toBe(true);
  } catch (error) {
    const pollFailure = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Closed-shadow node never stabilized (${description}); last state: ${lastIssue}. ${pollFailure}`,
      { cause: error },
    );
  }
  if (!box)
    throw new Error(`Missing stable closed-shadow box for ${description}`);
  return box;
}

async function shadowValue<T>(
  session: CDPSession,
  className: string,
  functionDeclaration: string,
): Promise<T> {
  const node = await shadowNode(session, className);
  const resolved = await session.send("DOM.resolveNode", {
    backendNodeId: node.backendNodeId,
  });
  const result = await session.send("Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration,
    returnByValue: true,
  });
  return result.result.value as T;
}

async function clickShadow(page: Page, session: CDPSession, className: string) {
  const box = await stableShadowBox(session, className, () =>
    findShadowNode(session, className),
  );
  await page.mouse.click(box.centerX, box.centerY);
}

async function clickShadowByAttributes(
  page: Page,
  session: CDPSession,
  expected: Record<string, string>,
) {
  const description = JSON.stringify(expected);
  const box = await stableShadowBox(session, description, () =>
    findShadowNodeByAttributes(session, expected),
  );
  await page.mouse.click(box.centerX, box.centerY);
}

async function chooseShadowSelect(
  page: Page,
  session: CDPSession,
  label: "Translate to",
  optionText: string,
) {
  await clickShadowByAttributes(page, session, {
    "aria-label": label,
    role: "combobox",
  });
  await expect
    .poll(() =>
      shadowValue<number>(
        session,
        "readlace-selection__panel",
        "function(){return this.getRootNode().querySelectorAll('[role=listbox]').length}",
      ),
    )
    .toBeGreaterThan(0);
  expect(await page.locator('[role="listbox"]').count()).toBe(0);
  expect(
    await shadowValue<boolean>(
      session,
      "readlace-selection__panel",
      "function(){const root=this.getRootNode();const lists=[...root.querySelectorAll('[role=listbox]')];return lists.length>0&&lists.every(list=>list.getRootNode()===root)}",
    ),
  ).toBe(true);
  const option = await shadowValue<{
    fontFamily: string;
    fontSize: string;
    hit: boolean;
    left: number;
    pointerEvents: string;
    top: number;
    width: number;
    height: number;
    triggerFontFamily: string;
    triggerFontSize: string;
    zIndex: string;
  }>(
    session,
    "readlace-selection__panel",
    `function(){const root=this.getRootNode();const option=[...root.querySelectorAll('[role=option]')].find(node=>node.textContent.trim()===${JSON.stringify(optionText)}&&node.getBoundingClientRect().height>0);if(!option)throw new Error('Missing visible option');const trigger=this.querySelector('[role=combobox][aria-label=${JSON.stringify(label)}]');const rect=option.getBoundingClientRect();const hit=root.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);const positioner=option.closest('[data-role=select-positioner]');return {fontFamily:getComputedStyle(option).fontFamily,fontSize:getComputedStyle(option).fontSize,hit:hit===option||option.contains(hit),left:rect.left,top:rect.top,width:rect.width,height:rect.height,pointerEvents:getComputedStyle(positioner).pointerEvents,triggerFontFamily:getComputedStyle(trigger).fontFamily,triggerFontSize:getComputedStyle(trigger).fontSize,zIndex:getComputedStyle(positioner).zIndex}}`,
  );
  expect(option.hit).toBe(true);
  expect(option.pointerEvents).toBe("auto");
  expect(option.fontFamily).toBe(option.triggerFontFamily);
  expect(option.fontSize).toBe(option.triggerFontSize);
  expect(option.fontSize).toBe("14px");
  expect(option.zIndex).toBe("1");
  await page.mouse.click(
    option.left + option.width / 2,
    option.top + option.height / 2,
  );
  await expect
    .poll(() =>
      shadowValue<string>(
        session,
        "readlace-selection__panel",
        `function(){return this.querySelector('[role=combobox][aria-label=${JSON.stringify(label)}]').textContent.trim()}`,
      ),
    )
    .toBe(optionText);
}

/** Geometry reads wait for the panel's 160ms pop-in (scale .98) to finish. */
async function settledPanel(session: CDPSession) {
  await expect
    .poll(() =>
      shadowValue<number>(
        session,
        "readlace-selection__panel",
        "function(){return this.getAnimations().filter(animation=>animation.playState==='running').length}",
      ),
    )
    .toBe(0);
}

async function selectionControls(session: CDPSession) {
  await settledPanel(session);
  return shadowValue<{
    fields: { bottom: number; left: number; right: number; top: number }[];
    icons: string[];
    panel: {
      bottom: number;
      left: number;
      right: number;
      top: number;
      width: number;
    };
    providerControls: number;
    target: { disabled: boolean; text: string };
    triggers: { fontSize: string; height: number; iconHeight: number }[];
  }>(
    session,
    "readlace-selection__panel",
    "function(){const read=(label)=>{const node=this.querySelector(`[role=combobox][aria-label=\"${label}\"]`);return {disabled:node.disabled,text:node.textContent.trim()}};const rect=this.getBoundingClientRect();return {fields:[...this.querySelectorAll('[data-role=provider-field],[data-role=target-field]')].map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}),icons:[...this.querySelectorAll('svg')].map(node=>node.getAttribute('class')||''),panel:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width},providerControls:this.querySelectorAll('[role=combobox][aria-label=\"Provider\"]').length,target:read('Translate to'),triggers:[...this.querySelectorAll('[role=combobox]')].map(node=>({fontSize:getComputedStyle(node).fontSize,height:node.getBoundingClientRect().height,iconHeight:node.querySelector('svg').getBoundingClientRect().height}))}}",
  );
}

async function shadowDescendantCount(session: CDPSession, selector: string) {
  return shadowValue<number>(
    session,
    "readlace-selection__panel",
    `function(){return this.querySelectorAll(${JSON.stringify(selector)}).length}`,
  );
}

async function selectionResultState(session: CDPSession) {
  return shadowValue<{
    ariaAtomic: string | null;
    ariaLive: string | null;
    height: number;
    marginTop: string;
    role: string | null;
    text: string;
  }>(
    session,
    "readlace-selection__result",
    "function(){const style=getComputedStyle(this);return {ariaAtomic:this.getAttribute('aria-atomic'),ariaLive:this.getAttribute('aria-live'),height:this.getBoundingClientRect().height,marginTop:style.marginTop,role:this.getAttribute('role'),text:this.textContent}}",
  );
}

async function expectEmptySelectionResult(session: CDPSession) {
  expect(await selectionResultState(session)).toEqual({
    ariaAtomic: "true",
    ariaLive: "polite",
    height: 0,
    marginTop: "0px",
    role: "status",
    text: "",
  });
}

test("@selection-deterministic bootstrap rejects ineligible selections before loading the runtime", async () => {
  test.setTimeout(45_000);
  const fixture = await startFixtureServer();
  let extension: ExtensionSession | undefined;
  try {
    extension = await launchExtension(fixture.url);
    const page = await extension.context.newPage();
    await page.addInitScript(() => {
      const state = {
        durations: [] as number[],
        supported:
          typeof PerformanceObserver !== "undefined" &&
          PerformanceObserver.supportedEntryTypes.includes("longtask"),
      };
      const runtime = window as unknown as {
        __selectionLongTasks?: typeof state;
        __selectionLongTaskObserver?: PerformanceObserver;
      };
      runtime.__selectionLongTasks = state;
      if (state.supported) {
        const observer = new PerformanceObserver((list) =>
          state.durations.push(
            ...list.getEntries().map((entry) => entry.duration),
          ),
        );
        observer.observe({ type: "longtask", buffered: true });
        runtime.__selectionLongTaskObserver = observer;
      }
    });
    await page.goto(`${fixture.url}?eligibility=before-runtime`);
    const expectNoRuntimeHost = async () => {
      await page.waitForTimeout(100);
      await expect(page.locator("readlace-selection-translator")).toHaveCount(
        0,
      );
    };

    await page.evaluate(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expectNoRuntimeHost();
    for (const selector of ["#input", "#textarea"]) {
      await page.locator(selector).focus();
      await page.keyboard.press("ControlOrMeta+A");
      await expectNoRuntimeHost();
    }
    const editableText = (await page.locator("#editor").textContent())!;
    await selectText(page, "#editor", 0, editableText.length);
    await expectNoRuntimeHost();
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#editable-ancestor")!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    await expectNoRuntimeHost();
    await page.evaluate(() => {
      const root = document.querySelector(
        "#shadow-selection-host",
      )!.shadowRoot!;
      const text = root.querySelector("#shadow-selection-text")!.firstChild!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      (text.parentElement as HTMLElement).dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, composed: true }),
      );
    });
    await expectNoRuntimeHost();
    const multiRangeCount = await page.evaluate(() => {
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      const first = document.createRange();
      first.selectNodeContents(document.querySelector("#source")!);
      const second = document.createRange();
      second.selectNodeContents(document.querySelector("#keyboard")!);
      selection.addRange(first);
      selection.addRange(second);
      const count = selection.rangeCount;
      if (count > 1)
        document.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true }),
        );
      else selection.removeAllRanges();
      return count;
    });
    console.info(`[selection-multi-range-count] ${multiRangeCount}`);
    await expectNoRuntimeHost();

    await page.evaluate(() => {
      (
        window as unknown as { __selectionColdStart?: number }
      ).__selectionColdStart = performance.now();
    });
    await page.locator("#dblclick-initial-word").dblclick();
    expect(
      await page.evaluate(() => window.getSelection()?.toString().trim()),
    ).toBe("Bootstrapword");
    await expect(page.locator("readlace-selection-translator")).toHaveCount(1);
    const cdp = await page.context().newCDPSession(page);
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__icon",
          "function(){return this.hidden}",
        ),
      )
      .toBe(false);
    const performanceEvidence = await page.evaluate(() => {
      const runtime = window as unknown as {
        __selectionColdStart?: number;
        __selectionLongTasks?: { durations: number[]; supported: boolean };
      };
      return {
        iconLatencyMs: performance.now() - runtime.__selectionColdStart!,
        longTaskDurationsMs: runtime.__selectionLongTasks?.durations ?? [],
        longTaskSupported: runtime.__selectionLongTasks?.supported ?? false,
      };
    });
    expect(Number.isFinite(performanceEvidence.iconLatencyMs)).toBe(true);
    expect(performanceEvidence.iconLatencyMs).toBeGreaterThan(0);
    expect(
      performanceEvidence.longTaskDurationsMs.every(
        (duration) => duration >= 0,
      ),
    ).toBe(true);
    console.info(
      `[selection-cold-observation] ${JSON.stringify(performanceEvidence)}`,
    );
    await page.evaluate(() => {
      (
        window as unknown as { __firstSelectionHost?: Element | null }
      ).__firstSelectionHost = document.querySelector(
        "readlace-selection-translator",
      );
    });
    await page.keyboard.press("Escape");
    await page.locator("#dblclick-mounted-word").dblclick();
    expect(
      await page.evaluate(() => window.getSelection()?.toString().trim()),
    ).toBe("Mountedword");
    await expect(page.locator("readlace-selection-translator")).toHaveCount(1);
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__icon",
          "function(){return this.hidden}",
        ),
      )
      .toBe(false);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __firstSelectionHost?: Element | null })
            .__firstSelectionHost ===
          document.querySelector("readlace-selection-translator"),
      ),
    ).toBe(true);
  } finally {
    await extension?.close();
    await fixture.close();
  }
});

async function capturePage(page: Page) {
  await page.evaluate(() => {
    const ids = [
      "source",
      "multiline",
      "editable-intersection",
      "clipped",
      "delayed",
      "near-edge",
    ];
    const elements = ids.map((id) => document.getElementById(id)!);
    (
      window as unknown as { __selectionBaseline: unknown }
    ).__selectionBaseline = {
      elements,
      texts: elements.map((element) => [...element.childNodes]),
      values: elements.map((element) => ({
        id: element.id,
        text: element.textContent,
        className: element.className,
        style: element.getAttribute("style"),
        rect: element.getBoundingClientRect().toJSON(),
      })),
    };
  });
}

async function expectPagePreserved(page: Page, geometry = true) {
  const result = await page.evaluate((geometry) => {
    const baseline = (
      window as unknown as {
        __selectionBaseline: {
          elements: Element[];
          texts: Node[][];
          values: {
            id: string;
            text: string | null;
            className: string;
            style: string | null;
            rect: DOMRect;
          }[];
        };
      }
    ).__selectionBaseline;
    return baseline.values.map((before, index) => {
      const element = document.getElementById(before.id)!;
      const after = element.getBoundingClientRect();
      return {
        id: before.id,
        sameElement: element === baseline.elements[index],
        sameNodes:
          element.childNodes.length === baseline.texts[index]?.length &&
          [...element.childNodes].every(
            (node, nodeIndex) => node === baseline.texts[index]?.[nodeIndex],
          ),
        sameText: element.textContent === before.text,
        sameClass: element.className === before.className,
        sameStyle: element.getAttribute("style") === before.style,
        geometryDelta: geometry
          ? Math.max(
              Math.abs(after.x - before.rect.x),
              Math.abs(after.y - before.rect.y),
              Math.abs(after.width - before.rect.width),
              Math.abs(after.height - before.rect.height),
            )
          : 0,
      };
    });
  }, geometry);
  for (const item of result) {
    expect(item, item.id).toMatchObject({
      sameElement: true,
      sameNodes: true,
      sameText: true,
      sameClass: true,
      sameStyle: true,
    });
    expect(item.geometryDelta, item.id).toBeLessThanOrEqual(1);
  }
}

test("@selection-deterministic packaged selection UI coexists with page translation", async () => {
  test.setTimeout(90_000);
  const fixture = await startFixtureServer();
  let extension: ExtensionSession | undefined;
  try {
    extension = await launchExtension(fixture.url);
    expect(extension.extensionId).toBe(stableExtensionId);
    const providerRequests: ProviderRequest[] = [];
    const backend = await routeBackend(extension.context, providerRequests);
    await seedAuthentication(extension.worker);
    // A provider saved by an earlier build is ignored.
    await setStoredProvider(extension.worker, "google");
    const page = await extension.context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const cdp = await page.context().newCDPSession(page);
    const parsedScripts = new Set<string>();
    cdp.on("event", ({ method, params }) => {
      if (method === "Runtime.scriptParsed")
        parsedScripts.add(
          String((params as { url?: string } | undefined)?.url ?? ""),
        );
    });
    await cdp.send("Runtime.enable");
    await page.goto(fixture.url);
    await expect(page.locator("iframe")).toHaveCount(1);
    await expect(page.locator("readlace-selection-translator")).toHaveCount(0);
    expect(
      [...parsedScripts].some((url) => url.endsWith("/selection-ui.js")),
    ).toBe(false);
    const footprintBeforeMount = await documentFootprint(page);
    expect(footprintBeforeMount.bodyDisplay).toBe("grid");
    await capturePage(page);
    const stoppedSelections = [
      {
        selector: "#stopped-propagation-first",
        text: "First readable selection survives a page pointerup bubble stop.",
      },
      {
        selector: "#stopped-propagation-next",
        text: "Subsequent readable selection survives the same page handler.",
      },
    ] as const;
    for (const [index, stopped] of stoppedSelections.entries()) {
      const content = (await page.locator(stopped.selector).textContent())!;
      const start = content.indexOf(stopped.text);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(
        await selectText(
          page,
          stopped.selector,
          start,
          start + stopped.text.length,
          false,
          true,
        ),
      ).toBe(stopped.text);
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                stoppedPropagationEvidence: {
                  cancelBubbleBeforeStop: boolean;
                  count: number;
                  defaultPrevented: boolean;
                };
              }
            ).stoppedPropagationEvidence,
        ),
      ).toEqual({
        cancelBubbleBeforeStop: false,
        count: index + 1,
        defaultPrevented: false,
      });
      await expect(page.locator("readlace-selection-translator")).toHaveCount(
        1,
      );
      if (index === 0) {
        console.info(
          `[selection-runtime-script-parsed] ${[...parsedScripts].some((url) => url.endsWith("/selection-ui.js"))}`,
        );
      }
      expect(providerRequests).toHaveLength(index);
      await clickShadow(page, cdp, "readlace-selection__icon");
      if (index === 0) {
        expect(
          await page
            .locator("readlace-selection-translator")
            .evaluate((host) => {
              const rect = host.getBoundingClientRect();
              return {
                height: rect.height,
                position: getComputedStyle(host).position,
                width: rect.width,
              };
            }),
        ).toEqual({ height: 0, position: "fixed", width: 0 });
        expect(await documentFootprint(page)).toEqual(footprintBeforeMount);
        expect(
          await shadowValue(
            cdp,
            "readlace-selection-title",
            "function(){return this.textContent}",
          ),
        ).toBe("Readlace");
      }
      const controls = await selectionControls(cdp);
      expect(controls.providerControls).toBe(0);
      expect(controls.target.text).toBe("English");
      await clickShadow(page, cdp, "readlace-selection__translate");
      await expect.poll(() => providerRequests.length).toBe(index + 1);
      expect(providerRequests.at(-1)).toEqual({
        active: 1,
        sources: [stopped.text],
        target: "en",
      });
      await expect
        .poll(() =>
          shadowValue<string>(
            cdp,
            "readlace-selection__result",
            "function(){return this.textContent}",
          ),
        )
        .toBe(`Selection en: ${stopped.text}`);
      expect(
        await shadowDescendantCount(cdp, "[data-role=selection-status]"),
      ).toBe(0);
      await clickShadow(page, cdp, "readlace-selection__close");
    }
    providerRequests.length = 0;

    const expectedSelection =
      "When updating or accessing data, be aware of any data that has restricted access.";
    const sourceText = (await page.locator("#source").textContent())!;
    const selectionStart = sourceText.indexOf(expectedSelection);
    expect(selectionStart).toBeGreaterThanOrEqual(0);
    const selected = await selectText(
      page,
      "#source",
      selectionStart,
      selectionStart + expectedSelection.length,
    );
    expect(selected).toBe(expectedSelection);
    await expect(page.locator("readlace-selection-translator")).toHaveCount(1);
    expect(
      await shadowValue(
        cdp,
        "IMG",
        "function(){return {complete:this.complete,naturalWidth:this.naturalWidth,src:this.src}}",
      ),
    ).toMatchObject({ complete: true, naturalWidth: 32 });
    expect(providerRequests).toHaveLength(0);
    await clickShadow(page, cdp, "readlace-selection__icon");
    expect(providerRequests).toHaveLength(0);
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-status]"),
    ).toBe(0);
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-result]"),
    ).toBe(1);
    await expectEmptySelectionResult(cdp);
    const initialControls = await selectionControls(cdp);
    expect(initialControls.providerControls).toBe(0);
    expect(initialControls.target.text).toBe("English");
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).fontSize,
      ),
    ).toBe("10px");
    expect(initialControls.triggers).toEqual([
      { fontSize: "14px", height: 32, iconHeight: 16 },
    ]);
    expect(initialControls.panel.width).toBeLessThanOrEqual(360);
    const initialViewport = await page.evaluate(() => ({
      height: innerHeight,
      width: innerWidth,
    }));
    expect(initialControls.panel.left).toBeGreaterThanOrEqual(7);
    expect(initialControls.panel.top).toBeGreaterThanOrEqual(7);
    expect(initialControls.panel.right).toBeLessThanOrEqual(
      initialViewport.width - 7,
    );
    expect(initialControls.panel.bottom).toBeLessThanOrEqual(
      initialViewport.height - 7,
    );
    expect(initialControls.icons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lucide-x"),
        expect.stringContaining("lucide-languages"),
      ]),
    );
    // The brand is the inline laced-R mark (recolored for dark mode).
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__brand-icon",
        "function(){const r=this.getBoundingClientRect();return {mark:this.hasAttribute('data-mark'),tag:this.tagName.toLowerCase(),width:Math.round(r.width)}}",
      ),
    ).toEqual({ mark: true, tag: "svg", width: 24 });
    await chooseShadowSelect(page, cdp, "Translate to", "Vietnamese");
    expect(await storedProvider(extension.worker)).toBe("google");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { outsideSelectionPopupInsertions: number })
            .outsideSelectionPopupInsertions,
      ),
    ).toBe(0);
    expect(await selectionControls(cdp)).toMatchObject({
      providerControls: 0,
      target: { disabled: false, text: "Vietnamese" },
    });
    expect(providerRequests).toHaveLength(0);
    await clickShadow(page, cdp, "readlace-selection__translate");
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__result",
          "function(){return this.textContent}",
        ),
      )
      .toBe(`Selection vi: ${selected}`);
    expect(
      providerRequests.filter((request) => request.sources.includes(selected)),
    ).toEqual([
      {
        active: 1,
        sources: [selected],
        target: "vi",
      },
    ]);
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-status]"),
    ).toBe(0);
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__result",
        "function(){return this.textContent}",
      ),
    ).toBe(`Selection vi: ${selected}`);
    await expectPagePreserved(page);

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const islandSelection = await page.evaluate(() => {
      const ancestor =
        document.querySelector<HTMLElement>("#editable-ancestor")!;
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(ancestor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return selection.toString();
    });
    expect(islandSelection).toContain("editable bridge");
    expect(
      await shadowValue(
        cdp,
        "readlace-selection",
        "function(){return this.hidden}",
      ),
    ).toBe(true);
    expect(providerRequests).toHaveLength(1);
    for (const selector of ["#input", "#textarea"]) {
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      const control = page.locator(selector);
      await control.focus();
      await page.keyboard.press("ControlOrMeta+A");
      const controlValue = await control.inputValue();
      expect(
        await control.evaluate(
          (element: HTMLInputElement | HTMLTextAreaElement) => ({
            end: element.selectionEnd,
            length: element.value.length,
            start: element.selectionStart,
            windowSelection: window.getSelection()?.toString() ?? "",
          }),
        ),
      ).toEqual({
        end: controlValue.length,
        length: controlValue.length,
        start: 0,
        windowSelection: controlValue,
      });
      expect(
        await shadowValue(
          cdp,
          "readlace-selection",
          "function(){return this.hidden}",
        ),
      ).toBe(true);
      expect(providerRequests).toHaveLength(1);
    }
    const editableText = await page
      .locator("#editable-intersection")
      .textContent();
    await selectText(page, "#editable-intersection", 0, editableText!.length);
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection",
          "function(){return this.hidden}",
        ),
      )
      .toBe(true);
    expect(providerRequests).toHaveLength(1);

    const multiline = (await page.locator("#multiline").textContent())!;
    const forwardSelection = await selectText(
      page,
      "#multiline",
      0,
      multiline.length,
    );
    const forwardRects = await selectionFragmentRects(page);
    const forwardIcon = await stableShadowBox(
      cdp,
      "readlace-selection__icon",
      () => findShadowNode(cdp, "readlace-selection__icon"),
    );
    expect(forwardSelection).toBe(multiline.replace(/\s+/g, " ").trim());
    expect(forwardRects.length).toBeGreaterThan(1);
    expect(forwardIcon.left).toBeCloseTo(forwardRects.at(-1)!.right + 8, 0);
    expect(forwardIcon.top).toBeCloseTo(forwardRects.at(-1)!.bottom + 8, 0);
    await page.keyboard.press("Escape");
    await page.mouse.click(10, 10);
    const backwardSelection = await selectText(
      page,
      "#multiline",
      0,
      multiline.length,
      true,
    );
    const backwardRects = await selectionFragmentRects(page);
    const backwardIcon = await stableShadowBox(
      cdp,
      "readlace-selection__icon",
      () => findShadowNode(cdp, "readlace-selection__icon"),
    );
    expect(backwardSelection).toBe(multiline.replace(/\s+/g, " ").trim());
    expect(backwardIcon.left).toBeCloseTo(backwardRects[0]!.right + 8, 0);
    expect(backwardIcon.top).toBeCloseTo(backwardRects[0]!.bottom + 8, 0);
    await clickShadow(page, cdp, "readlace-selection__icon");
    expect((await selectionControls(cdp)).target.text).toBe("Vietnamese");
    await page.keyboard.press("Escape");

    // ADR 0020: no session, so no unavailable or signed-out selection state.
    await page.bringToFront();
    await selectText(page, "#multiline", 0, multiline.length, true);
    await clickShadow(page, cdp, "readlace-selection__icon");
    // Use a cold target for provider failure.
    await chooseShadowSelect(page, cdp, "Translate to", "Japanese");
    backend.setFail(true);
    await clickShadow(page, cdp, "readlace-selection__translate");
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__status",
          "function(){return this.textContent}",
        ),
      )
      .toContain("failed");
    expect((await selectionControls(cdp)).icons).toEqual(
      expect.arrayContaining([expect.stringContaining("lucide-circle-alert")]),
    );
    backend.setFail(false);
    await chooseShadowSelect(page, cdp, "Translate to", "Vietnamese");

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const delayed = (await page.locator("#delayed").textContent())!;
    await selectText(page, "#delayed", 0, delayed.length);
    await clickShadow(page, cdp, "readlace-selection__icon");
    await clickShadow(page, cdp, "readlace-selection__translate");
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__translate",
          "function(){return this.textContent}",
        ),
      )
      .toBe("Translating…");
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-status]"),
    ).toBe(0);
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-result]"),
    ).toBe(1);
    await expectEmptySelectionResult(cdp);
    const busyControls = await selectionControls(cdp);
    expect(busyControls.providerControls).toBe(0);
    expect(busyControls.target.disabled).toBe(true);
    expect(busyControls.icons).toEqual(
      expect.arrayContaining([expect.stringContaining("lucide-loader-circle")]),
    );
    await clickShadow(page, cdp, "readlace-selection__close");
    const edge = (await page.locator("#near-edge").textContent())!;
    await page.locator("#near-edge").scrollIntoViewIfNeeded();
    expect(await setTabZoom(extension.worker, fixture.url, 2)).toBe(2);
    await selectText(page, "#near-edge", 0, edge.length);
    await clickShadow(page, cdp, "readlace-selection__icon");
    // Reopening may already be ready; busy controls are asserted above while work is held.
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__translate",
          "function(){return this.disabled}",
        ),
      )
      .toBe(false);
    const zoomControls = await selectionControls(cdp);
    expect(zoomControls.fields).toHaveLength(1);
    expect(zoomControls.triggers).toEqual([
      { fontSize: "14px", height: 32, iconHeight: 16 },
    ]);
    expect(zoomControls.panel.width).toBeLessThanOrEqual(360);
    expect(zoomControls.fields[0]!.left).toBeGreaterThanOrEqual(
      zoomControls.panel.left,
    );
    expect(zoomControls.fields[0]!.right).toBeLessThanOrEqual(
      zoomControls.panel.right,
    );
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-result]"),
    ).toBe(1);
    await expectEmptySelectionResult(cdp);
    await clickShadow(page, cdp, "readlace-selection__translate");
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__result",
          "function(){return this.textContent}",
        ),
      )
      .toContain("Long plain-text result");
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-status]"),
    ).toBe(0);
    const resultMotion = await shadowValue<{
      duration: string;
      property: string;
    }>(
      cdp,
      "readlace-selection__result-group",
      "function(){const style=getComputedStyle(this);return {duration:style.transitionDuration,property:style.transitionProperty}}",
    );
    expect(resultMotion.property).toContain("grid-template-rows");
    expect(resultMotion.property).toContain("opacity");
    expect(resultMotion.duration).toContain("0.18s");
    await page.waitForTimeout(220);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__result-group",
        "function(){return getComputedStyle(this).transitionDuration}",
      ),
    ).toBe("0s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const panelRect = await shadowValue<{
      bottom: number;
      left: number;
      right: number;
      top: number;
    }>(
      cdp,
      "readlace-selection__panel",
      "function(){const r=this.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}",
    );
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    expect(panelRect.left).toBeGreaterThanOrEqual(7);
    expect(panelRect.top).toBeGreaterThanOrEqual(7);
    expect(panelRect.right).toBeLessThanOrEqual(viewport.width - 7);
    expect(panelRect.bottom).toBeLessThanOrEqual(viewport.height - 7);
    const longResult = await shadowValue<{
      backgroundColor: string;
      borderRadius: string;
      clientHeight: number;
      images: number;
      maxHeight: string;
      overflow: string;
      paddingRight: string;
      paddingTop: string;
      scrollable: boolean;
      scrollHeight: number;
      text: string;
    }>(
      cdp,
      "readlace-selection__result",
      "function(){const style=getComputedStyle(this);const value={backgroundColor:style.backgroundColor,borderRadius:style.borderRadius,clientHeight:this.clientHeight,images:this.querySelectorAll('img').length,maxHeight:style.maxHeight,overflow:style.overflow,paddingRight:style.paddingRight,paddingTop:style.paddingTop,scrollable:this.scrollHeight>this.clientHeight,scrollHeight:this.scrollHeight,text:this.textContent};this.scrollTop=40;return value}",
    );
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__result-label",
        "function(){return this.textContent}",
      ),
    ).toBe("Result");
    expect(longResult.images).toBe(0);
    // The result is plain text: markup stays literal and never renders.
    expect(longResult.text).toContain("<img src=x onerror=alert(1)>");
    expect(longResult.text.length).toBeGreaterThan(1_000);
    expect(longResult.scrollable, JSON.stringify(longResult)).toBe(true);
    expect(longResult.maxHeight).toBe("220px");
    expect(longResult.overflow).toBe("auto");
    // Paper tone (`--rl-paper-2`, light scheme).
    expect(longResult.backgroundColor).toBe("rgb(243, 236, 223)");
    expect(longResult.borderRadius).toBe("8px");
    expect(longResult.paddingTop).toBe("10px");
    expect(longResult.paddingRight).toBe("12px");
    const scrollbarStyle = await shadowValue<{
      overscroll: string;
      scrollbarColor: string;
      scrollbarWidth: string;
      thumb: string;
      track: string;
      webkitWidth: string;
    }>(
      cdp,
      "readlace-selection__result",
      "function(){const scrollbar=getComputedStyle(this,'::-webkit-scrollbar');const track=getComputedStyle(this,'::-webkit-scrollbar-track');const thumb=getComputedStyle(this,'::-webkit-scrollbar-thumb');return {overscroll:getComputedStyle(this).overscrollBehaviorY,scrollbarColor:getComputedStyle(this).scrollbarColor,scrollbarWidth:getComputedStyle(this).scrollbarWidth,webkitWidth:scrollbar.width,track:track.backgroundColor,thumb:thumb.backgroundColor}}",
    );
    expect(scrollbarStyle).toMatchObject({
      overscroll: "contain",
      scrollbarColor: "rgb(215, 205, 184) rgba(0, 0, 0, 0)",
      scrollbarWidth: "thin",
      webkitWidth: "6px",
      track: "rgba(0, 0, 0, 0)",
    });
    expect(["rgb(215, 205, 184)", "rgb(102, 98, 125)"]).toContain(
      scrollbarStyle.thumb,
    );
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__panel",
        "function(){return this.hidden}",
      ),
    ).toBe(false);
    await page.evaluate(() => window.scrollBy(0, -40));
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__panel",
          "function(){return this.hidden}",
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__icon",
          "function(){return this.hidden}",
        ),
      )
      .toBe(false);
    await clickShadow(page, cdp, "readlace-selection__icon");
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__result",
        "function(){this.scrollTop=this.scrollHeight;const rect=this.getBoundingClientRect();return {bottom:rect.bottom,left:rect.left,right:rect.right,top:rect.top,text:this.textContent}}",
      ),
    ).toMatchObject({
      text: expect.stringContaining("Long plain-text result"),
    });
    const resultRect = await shadowValue<{
      bottom: number;
      left: number;
      right: number;
      top: number;
    }>(
      cdp,
      "readlace-selection__result",
      "function(){const rect=this.getBoundingClientRect();return {bottom:rect.bottom,left:rect.left,right:rect.right,top:rect.top}}",
    );
    const pageScrollBeforeBoundaryWheel = await page.evaluate(() => scrollY);
    await page.mouse.move(
      (resultRect.left + resultRect.right) / 2,
      (resultRect.top + resultRect.bottom) / 2,
    );
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => scrollY)).toBe(
      pageScrollBeforeBoundaryWheel,
    );
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__panel",
        "function(){return this.hidden}",
      ),
    ).toBe(false);

    await clickShadow(page, cdp, "readlace-selection__close");
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__icon",
        "function(){return this.hidden}",
      ),
    ).toBe(false);
    await clickShadow(page, cdp, "readlace-selection__icon");
    expect(
      await shadowValue(
        cdp,
        "readlace-selection__result",
        "function(){return this.textContent}",
      ),
    ).toContain("Long plain-text result");

    const delayedPageText = (await page.locator("#delayed").textContent())!;
    const concurrentText = "Delayed selection response";
    const concurrentStart = delayedPageText.indexOf(concurrentText);
    expect(concurrentStart).toBeGreaterThanOrEqual(0);
    await selectText(
      page,
      "#delayed",
      concurrentStart,
      concurrentStart + concurrentText.length,
    );
    await clickShadow(page, cdp, "readlace-selection__icon");
    const concurrentRequestCount = providerRequests.length;
    await clickShadow(page, cdp, "readlace-selection__translate");
    const pageRun = sendTopFrameMessage(extension.worker, fixture.url, {
      type: "START_TRANSLATION",
      targetLanguage: "en",
    });
    await pageRun;
    await waitForState(extension.worker, fixture.url, "translated");
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__result",
          "function(){return this.textContent}",
        ),
      )
      .toContain(concurrentText);
    expect(
      await shadowDescendantCount(cdp, "[data-role=selection-status]"),
    ).toBe(0);
    expect(
      providerRequests
        .slice(concurrentRequestCount)
        .find((request) => request.sources.includes(concurrentText)),
    ).toMatchObject({ target: "vi" });
    expect(
      providerRequests
        .slice(concurrentRequestCount)
        .some(
          (request) =>
            request.target === "en" &&
            !request.sources.includes(concurrentText),
        ),
    ).toBe(true);
    expect(await storedProvider(extension.worker)).toBe("google");
    expect(
      providerRequests
        .flatMap((request) => request.sources)
        .some((source) =>
          [
            "Translate selection",
            "Target language",
            "Translation complete",
          ].some((label) => source.includes(label)),
        ),
    ).toBe(false);
    expect(backend.maxActive()).toBeLessThanOrEqual(2);
    await sendTopFrameMessage(extension.worker, fixture.url, {
      type: "SHOW_ORIGINAL",
    });
    await waitForState(extension.worker, fixture.url, "original");
    await expectPagePreserved(page, false);
    expect(await setTabZoom(extension.worker, fixture.url, 1)).toBe(1);
    await page.waitForTimeout(150);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    await expectPagePreserved(page);
    await selectText(
      page,
      "#source",
      selectionStart,
      selectionStart + expectedSelection.length,
    );
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__icon",
          "function(){return this.hidden}",
        ),
      )
      .toBe(false);
    await clickShadow(page, cdp, "readlace-selection__icon");
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    await clickShadow(page, cdp, "readlace-selection__close");

    const keyboardExpected = "Keyboard proof";
    await page.locator("#keyboard").click();
    await page.evaluate((prefixLength) => {
      const text = document.querySelector("#keyboard")!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, prefixLength);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, keyboardExpected.length - 1);
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(
      keyboardExpected,
    );
    await expect
      .poll(() =>
        shadowValue<boolean>(
          cdp,
          "readlace-selection__icon",
          "function(){return this.hidden}",
        ),
      )
      .toBe(false);
    await clickShadow(page, cdp, "readlace-selection__icon");
    const keyboardRequestCount = providerRequests.length;
    await clickShadow(page, cdp, "readlace-selection__translate");
    await expect
      .poll(() => providerRequests.length)
      .toBe(keyboardRequestCount + 1);
    expect(providerRequests.at(-1)).toEqual({
      active: 1,
      sources: [keyboardExpected],
      target: "vi",
    });
    const injectedFrame = page
      .frames()
      .find((frame) => frame.url().endsWith("/frame"));
    expect(injectedFrame).toBeDefined();
    const frameText = (await injectedFrame!
      .locator("#frame-source")
      .textContent())!;
    expect(
      await selectText(injectedFrame!, "#frame-source", 0, frameText.length),
    ).toBe(frameText);
    await expect(
      injectedFrame!.locator("readlace-selection-translator"),
    ).toHaveCount(1);

    await page.evaluate(() => {
      const state = { pagehidePersisted: null, pageshowPersisted: null } as {
        pagehidePersisted: boolean | null;
        pageshowPersisted: boolean | null;
      };
      (
        window as unknown as { __selectionNavigation?: typeof state }
      ).__selectionNavigation = state;
      window.addEventListener(
        "pagehide",
        (event) => (state.pagehidePersisted = event.persisted),
        { once: true },
      );
      window.addEventListener(
        "pageshow",
        (event) => (state.pageshowPersisted = event.persisted),
        { once: true },
      );
    });
    const awayUrl = new URL("/away", fixture.url).href;
    await page.goto(awayUrl);
    await expect(page.locator("readlace-selection-translator")).toHaveCount(0);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load");
    await expect(page).toHaveURL(fixture.url);
    await expect(page.locator("readlace-selection-translator")).toHaveCount(0);
    const navigationEvidence = await page.evaluate(
      () =>
        (
          window as unknown as {
            __selectionNavigation?: {
              pagehidePersisted: boolean | null;
              pageshowPersisted: boolean | null;
            };
          }
        ).__selectionNavigation ?? {
          pagehidePersisted: null,
          pageshowPersisted: null,
        },
    );
    console.info(
      `[selection-navigation] ${JSON.stringify(navigationEvidence)}`,
    );
    const bfcacheText = (await page.locator("#bfcache-text").textContent())!;
    expect(await selectText(page, "#bfcache-text", 0, bfcacheText.length)).toBe(
      bfcacheText,
    );
    await expect(page.locator("readlace-selection-translator")).toHaveCount(1);
    await clickShadow(page, cdp, "readlace-selection__icon");
    const restoredRequestCount = providerRequests.length;
    await clickShadow(page, cdp, "readlace-selection__translate");
    await expect
      .poll(() => providerRequests.length)
      .toBe(restoredRequestCount + 1);
    expect(providerRequests.at(-1)).toEqual({
      active: 1,
      sources: [bfcacheText],
      target: "en",
    });
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__result",
          "function(){return this.textContent}",
        ),
      )
      .toContain(bfcacheText);
    if (navigationEvidence.pageshowPersisted !== true) {
      const persistedTexts = await page.evaluate(() => {
        const pending = document.createElement("p");
        pending.id = "persisted-pending";
        pending.textContent = "Persisted pending selection unique.";
        const next = document.createElement("p");
        next.id = "persisted-next";
        next.textContent = "Persisted next selection unique.";
        document.querySelector("main")!.append(pending, next);
        return { pending: pending.textContent, next: next.textContent };
      });
      await clickShadow(page, cdp, "readlace-selection__close");
      expect(
        await selectText(
          page,
          "#persisted-pending",
          0,
          persistedTexts.pending.length,
        ),
      ).toBe(persistedTexts.pending);
      await expect
        .poll(async () => (await selectionResultState(cdp)).text)
        .toBe("");
      await clickShadow(page, cdp, "readlace-selection__icon");
      const persistedRequestCount = providerRequests.length;
      await clickShadow(page, cdp, "readlace-selection__translate");
      await expect
        .poll(() => providerRequests.length)
        .toBe(persistedRequestCount + 1);
      expect(providerRequests.at(-1)?.sources).toEqual([
        persistedTexts.pending,
      ]);
      await page.evaluate(() => {
        window.dispatchEvent(
          new PageTransitionEvent("pagehide", { persisted: true }),
        );
      });
      await expect(
        page.locator("readlace-selection-translator"),
      ).toHaveAttribute("data-readlace-suspended", "");
      expect(
        await page
          .locator("readlace-selection-translator")
          .evaluate((host) => getComputedStyle(host).display),
      ).toBe("none");
      await page.evaluate(() =>
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        ),
      );
      await expect(
        page.locator("readlace-selection-translator"),
      ).not.toHaveAttribute("data-readlace-suspended", "");
      await selectText(page, "#persisted-next", 0, persistedTexts.next.length);
      await expect(page.locator("readlace-selection-translator")).toHaveCount(
        1,
      );
      await clickShadow(page, cdp, "readlace-selection__icon");
      expect(
        await shadowValue(
          cdp,
          "readlace-selection-title",
          "function(){return this.textContent}",
        ),
      ).toBe("Readlace");
      expect(
        await shadowValue(
          cdp,
          "readlace-selection__translate",
          "function(){return this.disabled}",
        ),
      ).toBe(true);
      await clickShadow(page, cdp, "readlace-selection__translate");
      expect(providerRequests).toHaveLength(persistedRequestCount + 1);
      await expect
        .poll(() =>
          shadowValue<boolean>(
            cdp,
            "readlace-selection__translate",
            "function(){return this.disabled}",
          ),
        )
        .toBe(false);
      expect(providerRequests).toHaveLength(persistedRequestCount + 1);
      expect(
        await shadowDescendantCount(cdp, "[data-role=selection-result]"),
      ).toBe(1);
      await expectEmptySelectionResult(cdp);
      expect(
        await shadowDescendantCount(cdp, "[data-role=selection-status]"),
      ).toBe(0);
      await clickShadow(page, cdp, "readlace-selection__translate");
      await expect
        .poll(() => providerRequests.length)
        .toBe(persistedRequestCount + 2);
      expect(providerRequests.at(-1)?.sources).toEqual([persistedTexts.next]);
    }
    expect(pageErrors).toEqual([]);
    await cdp.detach();
  } finally {
    await extension?.close();
    await fixture.close();
  }
});

test("@selection-deterministic selection target stays local and pinned during a page run", async () => {
  test.setTimeout(90_000);
  const fixture = await startFixtureServer();
  let extension: ExtensionSession | undefined;
  try {
    extension = await launchExtension(fixture.url);
    const providerRequests: ProviderRequest[] = [];
    const backend = await routeBackend(extension.context, providerRequests);
    await seedAuthentication(extension.worker);
    // A provider saved by an earlier build is ignored and never rewritten.
    await setStoredProvider(extension.worker, "openai");
    const url = `${fixture.url}?page-run=vi`;
    const page = await extension.context.newPage();
    await page.goto(url);
    const cdp = await page.context().newCDPSession(page);
    const fullText = (await page.locator("#delayed").textContent())!;
    const selectedText = "Delayed selection response";
    const start = fullText.indexOf(selectedText);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(
      await selectText(page, "#delayed", start, start + selectedText.length),
    ).toBe(selectedText);
    await expect(page.locator("readlace-selection-translator")).toHaveCount(1);
    await clickShadow(page, cdp, "readlace-selection__icon");
    expect(await selectionControls(cdp)).toMatchObject({
      providerControls: 0,
      target: { disabled: false, text: "English" },
    });
    expect(providerRequests).toHaveLength(0);
    await chooseShadowSelect(page, cdp, "Translate to", "Japanese");
    expect(await storedProvider(extension.worker)).toBe("openai");

    await clickShadow(page, cdp, "readlace-selection__translate");
    const pageRun = sendTopFrameMessage(extension.worker, url, {
      type: "START_TRANSLATION",
      targetLanguage: "vi",
    });
    await expect
      .poll(() =>
        providerRequests.some(
          (request) =>
            request.target === "ja" &&
            request.sources.length === 1 &&
            request.sources[0] === selectedText,
        ),
      )
      .toBe(true);
    await expect
      .poll(() => providerRequests.some((request) => request.target === "vi"))
      .toBe(true);
    expect(await selectionControls(cdp)).toMatchObject({
      providerControls: 0,
      target: { disabled: true, text: "Japanese" },
    });
    await pageRun;
    await waitForState(extension.worker, url, "translated");
    await expect
      .poll(() =>
        shadowValue<string>(
          cdp,
          "readlace-selection__result",
          "function(){return this.textContent}",
        ),
      )
      .toBe(`Selection ja: ${selectedText}`);
    const selectionRequests = providerRequests.filter(
      (request) =>
        request.sources.length === 1 && request.sources[0] === selectedText,
    );
    expect(selectionRequests).toHaveLength(1);
    expect(selectionRequests[0]).toMatchObject({
      sources: [selectedText],
      target: "ja",
    });
    expect(
      providerRequests.some(
        (request) =>
          request.target === "vi" && !request.sources.includes(selectedText),
      ),
    ).toBe(true);
    expect(await storedProvider(extension.worker)).toBe("openai");
    expect(backend.maxActive()).toBeLessThanOrEqual(2);
  } finally {
    await extension?.close();
    await fixture.close();
  }
});

test("@selection-deterministic package exposes only the selection icon and keeps manifest policy", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
  ) as {
    content_scripts?: { js?: string[]; matches?: string[] }[];
    host_permissions?: string[];
    incognito?: string;
    oauth2?: unknown;
    optional_host_permissions?: string[];
    optional_permissions?: string[];
    permissions?: string[];
    side_panel?: { default_path?: string };
    web_accessible_resources?: {
      resources?: string[];
      matches?: string[];
    }[];
  };
  expect(manifest.incognito).toBe("not_allowed");
  const background = await readFile(
    path.join(extensionPath, "background.js"),
    "utf8",
  );
  // ADR 0015: Google access is never a required permission. A Reader-enabled
  // build lists `identity` and the Sheets API host only as optional
  // permissions, requested inside the Connect Google Workspace click.
  const workspaceReaderConfigured = Boolean(
    Object.hasOwn(manifest, "side_panel") ||
    Object.hasOwn(manifest, "optional_permissions") ||
    Object.hasOwn(manifest, "optional_host_permissions") ||
    manifest.permissions?.includes("sidePanel"),
  );
  expect(manifest.oauth2).toBeUndefined();
  expect(manifest.permissions).not.toContain("identity");
  expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  if (workspaceReaderConfigured) {
    expect(manifest.permissions).toEqual([
      "tabs",
      "scripting",
      "sidePanel",
      "storage",
    ]);
    expect(manifest.optional_permissions).toEqual(["identity"]);
    expect(manifest.optional_host_permissions).toEqual([
      "https://sheets.googleapis.com/*",
    ]);
    expect(manifest.side_panel).toEqual({ default_path: "/reader.html" });
    expect(background).toContain("launchWebAuthFlow");
    expect(background).not.toContain("getAuthToken");
  } else {
    expect(manifest.permissions).toEqual(["tabs", "scripting"]);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.side_panel).toBeUndefined();
  }
  const manifestScripts = (manifest.content_scripts ?? []).flatMap(
    (entry) => entry.js ?? [],
  );
  expect(manifestScripts).toEqual([
    "content-scripts/content.js",
    "content-scripts/selection.js",
  ]);
  expect(manifestScripts).not.toContain("content-scripts/selection-ui.js");
  expect(manifest.web_accessible_resources).toEqual(
    expect.arrayContaining([
      { resources: ["icon/32.png"], matches: ["<all_urls>"] },
      expect.objectContaining({
        resources: ["content-scripts/selection-ui.css"],
        matches: ["<all_urls>"],
      }),
    ]),
  );
  expect(manifest.web_accessible_resources).toHaveLength(2);
  await access(path.join(extensionPath, "icon/32.png"));
  const distributable = await Promise.all(
    manifestScripts.map((file) =>
      readFile(path.join(extensionPath, file), "utf8"),
    ),
  );
  expect(distributable.join("\n")).not.toContain("__selectionBaseline");
  const bootstrapPath = path.join(
    extensionPath,
    "content-scripts/selection.js",
  );
  const runtimePath = path.join(
    extensionPath,
    "content-scripts/selection-ui.js",
  );
  const [bootstrap, runtime, bootstrapStats, runtimeStats] = await Promise.all([
    readFile(bootstrapPath, "utf8"),
    readFile(runtimePath, "utf8"),
    stat(bootstrapPath),
    stat(runtimePath),
  ]);
  expect(bootstrap).not.toContain("__readlaceSelectionTranslationUi");
  expect(runtime).toContain("__readlaceSelectionTranslationUi");
  expect(bootstrapStats.size).toBeLessThan(10_000);
  expect(runtimeStats.size).toBeGreaterThan(bootstrapStats.size * 20);
  expect(
    manifest.web_accessible_resources?.some((entry) =>
      entry.resources?.some((resource) => resource.endsWith(".js")),
    ),
  ).toBe(false);
});
