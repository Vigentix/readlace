import {
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
} from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { expect, test } from "./fixtures";
import { routeOpenAIThroughStage, saveE2EProviderKey } from "./provider-stage";

const backendUrl = "https://api.example.test";
const stageUrl = `${backendUrl}/v1/translation-stages`;
const extensionPath = path.resolve(
  process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const refreshTokenKey = "auth:v1:refresh-token";
const longEmail =
  "translation.agent.with.an.intentionally.long.email.address@example.com";
let server: Server;
let fixtureUrl: string;
let proofControlId = 0;

interface ProtocolResponse<T> {
  id: number;
  result?: T;
  error?: unknown;
}

class ActionPopup {
  private commandId = 0;

  constructor(
    readonly action: CDPSession,
    readonly control: CDPSession,
    readonly sessionId: string,
    readonly targetIds: string[],
  ) {}

  async send<T>(method: string, params: Record<string, unknown> = {}) {
    const id = (this.commandId += 1);
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
        .catch((error) => {
          this.control.off("Target.receivedMessageFromTarget", listener);
          reject(error);
        });
    });
  }

  async evaluate<T>(expression: string) {
    const result = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(result.result.description ?? "Popup evaluation failed.");
    return result.result.value as T;
  }

  async screenshot(outputPath: string) {
    const { data } = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "png",
        fromSurface: true,
      },
    );
    await writeFile(outputPath, Buffer.from(data, "base64"));
  }
}

test.beforeEach(async ({ context }, testInfo) => {
  if (testInfo.title.includes("@popup-ui")) {
    testInfo.setTimeout(60_000);
    await context.tracing.start({ screenshots: true, snapshots: true });
  }
});

test.afterEach(async ({ context }, testInfo) => {
  if (testInfo.title.includes("@popup-ui"))
    await context.tracing.stop({ path: testInfo.outputPath("trace.zip") });
});

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="ja">
        <head><title translate="no">Self-heal fixture</title></head>
          <body>
            <p id="probe">基本情報</p>
            <p>${"これは日本語の言語検出を安定させるための文章です。".repeat(24)}</p>
            <script>
            const navigationCount = Number(sessionStorage.getItem("navigationCount") || 0) + 1;
            sessionStorage.setItem("navigationCount", String(navigationCount));
            window.__selfHeal = { navigationCount, sentinel: crypto.randomUUID() };
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Self-heal fixture did not bind a TCP port.");
  fixtureUrl = `http://127.0.0.1:${address.port}/`;
});

test.afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

async function browserSession(context: BrowserContext) {
  const browser = context.browser();
  if (!browser) throw new Error("Installed Chrome browser is unavailable.");
  return browser.newBrowserCDPSession();
}

async function tabTargetId(session: CDPSession, page: Page) {
  await page.bringToFront();
  const { targetInfos } = (await session.send("Target.getTargets", {
    filter: [{}],
  })) as {
    targetInfos: { targetId: string; type: string; url: string }[];
  };
  const tab = targetInfos.find(
    (target) => target.type === "tab" && target.url === page.url(),
  );
  if (!tab) throw new Error(`No Chrome tab target matched ${page.url()}`);
  return tab.targetId;
}

async function triggerAction(
  session: CDPSession,
  extensionId: string,
  page: Page,
) {
  const control = await browserSession(page.context());
  const before = (await control.send("Target.getTargets", {
    filter: [{}],
  })) as { targetInfos: { targetId: string }[] };
  const existingTargets = new Set(
    before.targetInfos.map((target) => target.targetId),
  );
  const action = await browserSession(page.context());
  void action
    .send("Extensions.triggerAction", {
      id: extensionId,
      targetId: await tabTargetId(session, page),
    })
    .catch(() => undefined);
  let actionTargets: { targetId: string; type: string; url: string }[] = [];
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  await expect
    .poll(async () => {
      const { targetInfos } = (await control.send("Target.getTargets", {
        filter: [{}],
      })) as {
        targetInfos: { targetId: string; type: string; url: string }[];
      };
      actionTargets = targetInfos.filter(
        (target) =>
          (target.type === "page" || target.type === "tab") &&
          target.url === popupUrl &&
          !existingTargets.has(target.targetId),
      );
      return actionTargets.map((target) => target.type).sort();
    })
    .toEqual(["page", "tab"]);
  const popupTarget = actionTargets.find((target) => target.type === "page")!;
  const { sessionId } = (await control.send("Target.attachToTarget", {
    targetId: popupTarget.targetId,
  })) as { sessionId: string };
  return new ActionPopup(
    action,
    control,
    sessionId,
    actionTargets.map((target) => target.targetId),
  );
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

async function mockAuthenticated(
  context: BrowserContext,
  email = "agent@example.com",
) {
  await context.route(`${backendUrl}/v1/auth/refresh`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        accessToken: "mock-access",
        accessExpiresAt: "2099-01-01T00:00:00.000Z",
        refreshToken: "mock-refresh-next",
        refreshExpiresAt: "2099-02-01T00:00:00.000Z",
      }),
    }),
  );
  await context.route(`${backendUrl}/v1/me`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        user: { id: "mock-user", email },
      }),
    }),
  );
}

async function seedPopupAuthentication(
  context: BrowserContext,
  extensionId: string,
) {
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(setup.locator('main[aria-busy="false"]')).toBeVisible();
  await setExtensionStorage(setup, refreshTokenKey, "mock-refresh");
  await setup.close();
  // ADR 0020: a saved provider key puts translation on the provider path.
  await saveE2EProviderKey(context, extensionId);
}

/** The stage stub, reached by OpenAI requests through the adapter. */
async function routeStage(
  context: BrowserContext,
  handler: (route: Route) => Promise<unknown> | unknown,
) {
  await context.route(stageUrl, handler);
  await routeOpenAIThroughStage(context, handler);
}

async function openActionPopup(
  context: BrowserContext,
  extensionId: string,
  activePage: Page,
) {
  await activePage.bringToFront();
  const browser = await browserSession(context);
  const popup = await triggerAction(browser, extensionId, activePage);
  await expect
    .poll(() =>
      popup
        .evaluate<boolean>(
          "document.querySelector('main[aria-busy=\"false\"]') !== null",
        )
        .catch(() => false),
    )
    .toBe(true);
  return { browser, popup };
}

interface ControlStyle {
  backgroundColor: string;
  color: string;
  cursor: string;
  transform: string;
  translate: string;
  boxShadow: string;
  focusVisible: boolean;
}

async function expectActionGeometry(popup: ActionPopup) {
  const geometry = await popup.evaluate<{
    width: number;
    height: number;
    rootClientWidth: number;
    rootScrollWidth: number;
    rootClientHeight: number;
    rootScrollHeight: number;
    bodyClientWidth: number;
    bodyScrollWidth: number;
  }>(`(() => {
    const main = document.querySelector("main");
    const root = document.documentElement;
    const body = document.body;
    return {
      width: main.getBoundingClientRect().width,
      height: main.getBoundingClientRect().height,
      rootClientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      rootClientHeight: root.clientHeight,
      rootScrollHeight: root.scrollHeight,
      bodyClientWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
    };
  })()`);
  expect(geometry.width).toBe(360);
  expect(geometry.bodyClientWidth).toBe(360);
  expect(geometry.height).toBeLessThanOrEqual(520);
  expect(geometry.rootScrollWidth).toBeLessThanOrEqual(
    geometry.rootClientWidth,
  );
  expect(geometry.rootScrollHeight).toBeLessThanOrEqual(
    geometry.rootClientHeight,
  );
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(
    geometry.bodyClientWidth,
  );
}

async function controlStyle(popup: ActionPopup, selector: string) {
  return popup.evaluate<ControlStyle>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      cursor: style.cursor,
      transform: style.transform,
      translate: style.translate,
      boxShadow: style.boxShadow,
      focusVisible: element.matches(":focus-visible"),
    };
  })()`);
}

async function controlNode(popup: ActionPopup, selector: string) {
  await popup.send("DOM.enable");
  await popup.send("CSS.enable");
  const { root } = await popup.send<{ root: { nodeId: number } }>(
    "DOM.getDocument",
  );
  return popup.send<{ nodeId: number }>("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
}

function boxCenter(content: number[]) {
  const [left, top, , , right, bottom] = content;
  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined
  )
    throw new Error("Chrome returned an incomplete control box model.");
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

async function hoverControl(popup: ActionPopup, selector: string) {
  const { nodeId } = await controlNode(popup, selector);
  const { model } = await popup.send<{ model: { content: number[] } }>(
    "DOM.getBoxModel",
    { nodeId },
  );
  const { x, y } = boxCenter(model.content);
  await popup.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  return nodeId;
}

async function clickControl(popup: ActionPopup, selector: string) {
  const { nodeId } = await controlNode(popup, selector);
  const { model } = await popup.send<{ model: { content: number[] } }>(
    "DOM.getBoxModel",
    { nodeId },
  );
  const { x, y } = boxCenter(model.content);
  await popup.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await popup.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await popup.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function forcedActiveStyle(popup: ActionPopup, selector: string) {
  const { nodeId } = await controlNode(popup, selector);
  await popup.send("CSS.forcePseudoState", {
    nodeId,
    forcedPseudoClasses: ["active"],
  });
  const style = await controlStyle(popup, selector);
  await popup.send("CSS.forcePseudoState", {
    nodeId,
    forcedPseudoClasses: [],
  });
  return style;
}

async function expectPopupInteractions(popup: ActionPopup) {
  const controls = await popup.evaluate<
    { selector: string; disabled: boolean }[]
  >(`(() => [...document.querySelectorAll("button")].map((element, index) => {
    const id = "${(proofControlId += 1)}-" + index;
    element.setAttribute("data-popup-proof", id);
    return { selector: '[data-popup-proof="' + id + '"]', disabled: element.disabled };
  }))()`);

  for (const control of controls) {
    await popup.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 1,
      y: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = await controlStyle(popup, control.selector);
    expect(before.cursor).toBe(control.disabled ? "not-allowed" : "pointer");
    await hoverControl(popup, control.selector);
    if (control.disabled) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const hovered = await controlStyle(popup, control.selector);
      expect(`${hovered.backgroundColor}|${hovered.color}`).toBe(
        `${before.backgroundColor}|${before.color}`,
      );
      const active = await forcedActiveStyle(popup, control.selector);
      expect(active.transform).toBe("none");
      expect(active.translate).toBe("none");
      continue;
    }

    await expect
      .poll(async () => {
        const hovered = await controlStyle(popup, control.selector);
        return `${hovered.backgroundColor}|${hovered.color}`;
      })
      .not.toBe(`${before.backgroundColor}|${before.color}`);
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await popup.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await popup.evaluate(
      `document.querySelector(${JSON.stringify(control.selector)}).focus()`,
    );
    const focused = await controlStyle(popup, control.selector);
    expect(focused.focusVisible).toBe(true);
    expect(focused.boxShadow).not.toBe("none");
    expect(
      (await forcedActiveStyle(popup, control.selector)).translate,
    ).not.toBe("none");
  }
}

async function popupButton(popup: ActionPopup, name: string) {
  const proofId = `named-${(proofControlId += 1)}`;
  const found = await popup.evaluate<boolean>(`(() => {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) =>
        (candidate.getAttribute("aria-label") ?? candidate.textContent.trim()) === ${JSON.stringify(name)},
    );
    if (button) button.setAttribute("data-popup-proof", ${JSON.stringify(proofId)});
    return Boolean(button);
  })()`);
  expect(found).toBe(true);
  return `[data-popup-proof="${proofId}"]`;
}

async function popupElement(popup: ActionPopup, selector: string, index = 0) {
  const proofId = `element-${(proofControlId += 1)}`;
  const found = await popup.evaluate<boolean>(`(() => {
    const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (element) element.setAttribute("data-popup-proof", ${JSON.stringify(proofId)});
    return Boolean(element);
  })()`);
  expect(found).toBe(true);
  return `[data-popup-proof="${proofId}"]`;
}

async function expectFooterStatus(popup: ActionPopup, text?: string) {
  const status = await popup.evaluate<{
    count: number;
    live: string | null;
    borderTop: number;
    text: string;
    footerOnly: boolean;
  }>(`(() => {
    const statuses = [...document.querySelectorAll('[role="status"]')];
    const element = statuses[0];
    return {
      count: statuses.length,
      live: element?.getAttribute("aria-live") ?? null,
      borderTop: element ? parseFloat(getComputedStyle(element).borderTopWidth) : -1,
      text: element?.textContent?.trim() ?? "",
      footerOnly: element === document.querySelector("main")?.lastElementChild,
    };
  })()`);
  expect(status).toMatchObject({ count: 1, live: "polite", footerOnly: true });
  // No divider above the footer; when empty it collapses instead of
  // reserving a row.
  expect(status.borderTop).toBe(0);
  if (text !== undefined)
    await expect
      .poll(() =>
        popup.evaluate<string>(
          'document.querySelector(\'[role="status"]\')?.textContent?.trim() ?? ""',
        ),
      )
      .toBe(text);
}

const authenticatedStates = [
  {
    name: "configured",
    email: longEmail,
  },
] as const;

for (const state of authenticatedStates) {
  test(`@popup-ui authenticated ${state.name} popup contract`, async ({
    context,
    extensionId,
    page,
  }, testInfo) => {
    let releaseTranslation: (() => void) | undefined;
    let translationRequested: Promise<void> | undefined;
    if (state.name === "configured") {
      const translationGate = new Promise<void>((resolve) => {
        releaseTranslation = resolve;
      });
      let markTranslationRequested!: () => void;
      translationRequested = new Promise<void>((resolve) => {
        markTranslationRequested = resolve;
      });
      await routeStage(context, async (route) => {
        markTranslationRequested();
        await translationGate;
        const body = route.request().postDataJSON() as {
          sources: string[][];
        };
        let resultIndex = 0;
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            results: body.sources.map((row) =>
              row.map(
                (source) =>
                  `Translated mock content ${(resultIndex += 1)}: ${source}`,
              ),
            ),
            provenance: body.sources.map((row) => row.map(() => "openai")),
            failures: [],
            diagnostics: {
              records: body.sources.flat().length,
              sourceCharacters: body.sources
                .flat()
                .reduce((total, source) => total + source.length, 0),
              requestCount: 1,
              requestMs: 1,
            },
          }),
        });
      });
    }
    await mockAuthenticated(context, state.email);
    await page.goto(fixtureUrl);
    await seedPopupAuthentication(context, extensionId);
    const { browser, popup } = await openActionPopup(
      context,
      extensionId,
      page,
    );
    try {
      const actual = await popup.evaluate<{
        bodyText: string;
        buttons: { text: string; disabled: boolean }[];
        headerButtons: string[];
        clearButtonsOutsideHeader: number;
        detectedLanguage: string;
        srOnlyLabels: string[];
        alwaysInPageCard: boolean;
        account: { text: string; title: string; truncated: boolean } | null;
      }>(`(() => {
          const detectedLabel = [...document.querySelectorAll("span")].find(
            (element) => element.textContent.trim() === "Detected language:",
          );
            // The email is in the account menu only, not in the header.
            const account = document.querySelector(${JSON.stringify(
              `[title="${state.email}"]`,
            )});
          return {
            bodyText: document.body.innerText,
              buttons: [...document.querySelectorAll("button")].map((button) => ({
                text: button.getAttribute("aria-label") ?? button.textContent.trim(),
                disabled: button.disabled,
              })),
              headerButtons: [...document.querySelectorAll("header button")].map(
                (button) => button.getAttribute("aria-label") ?? button.textContent.trim(),
              ),
              clearButtonsOutsideHeader: [...document.querySelectorAll('button[aria-label="Clear saved translations"]')].filter(
                (button) => !button.closest("header"),
              ).length,
              detectedLanguage: detectedLabel.parentElement.textContent.replace(detectedLabel.textContent, "").trim(),
              srOnlyLabels: [...document.querySelectorAll(".sr-only")].map((element) => element.textContent.trim()),
              alwaysInPageCard: Boolean(
                [...document.querySelectorAll("label")]
                  .find((label) => label.textContent.trim() === "Always translate this site")
                  ?.closest('section[aria-label="This page"]'),
              ),
              account: account ? {
              text: account.textContent.trim(),
              title: account.getAttribute("title"),
              truncated: account.scrollWidth > account.clientWidth,
            } : null,
          };
        })()`);
      const lines = actual.bodyText.split("\n");
      for (const label of ["Readlace", "Always translate this site"])
        expect(lines).toContain(label);
      // One-line language row: both labels stay for screen readers only.
      expect(actual.srOnlyLabels).toEqual(
        expect.arrayContaining(["Detected language:", "Translate to"]),
      );
      expect(actual.alwaysInPageCard).toBe(true);
      expect(lines).not.toContain("Provider");
      for (const button of ["Menu", "Translate"])
        expect(actual.buttons.map((candidate) => candidate.text)).toContain(
          button,
        );
      // Show original joins the Translation | Original toggle after a
      // translation; account actions sit behind the header account button.
      expect(actual.buttons.map((candidate) => candidate.text)).not.toContain(
        "Show original",
      );
      // ADR 0020: Settings (provider and API key) sits next to the menu.
      expect(actual.headerButtons).toEqual(["Settings", "Menu"]);
      expect(actual.clearButtonsOutsideHeader).toBe(0);
      await expectFooterStatus(popup);
      expect(actual.detectedLanguage).toMatch(
        /^(English|Vietnamese|Japanese|Unknown)$/,
      );
      expect(lines.some((line) => /^(en|vi|ja)$/.test(line))).toBe(false);
      expect(actual.bodyText).not.toContain("—");

      if (state.name === "configured") {
        expect(actual.account).toBeNull();
        // The header menu overlays the page card: opening it moves nothing.
        const cardTop = await popup.evaluate<number>(
          "document.querySelector('[aria-label=\"This page\"]').getBoundingClientRect().top",
        );
        await clickControl(popup, await popupButton(popup, "Menu"));
        // ADR 0020: no accounts, so no email or Sign out in the menu.
        for (const name of ["Clear saved translations"]) {
          const button = await popupButton(popup, name);
          expect(
            await popup.evaluate<boolean>(
              `Boolean(document.querySelector(${JSON.stringify(button)}).closest("header"))`,
            ),
          ).toBe(true);
          const before = await controlStyle(popup, button);
          await hoverControl(popup, button);
          await expect
            .poll(async () => {
              const hovered = await controlStyle(popup, button);
              return hovered.backgroundColor;
            })
            .not.toBe(before.backgroundColor);
        }
        expect(
          await popup.evaluate<number>(
            "document.querySelector('[aria-label=\"This page\"]').getBoundingClientRect().top",
          ),
        ).toBe(cardTop);
        await popup.screenshot(
          testInfo.outputPath("account-menu-action-popup.png"),
        );
        await popup.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await popup.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
        });
        await expect
          .poll(() =>
            popup.evaluate<number>(
              `[...document.querySelectorAll("button")].filter((button) => button.textContent.trim() === "Sign out").length`,
            ),
          )
          .toBe(0);
        const manifest = await popup.evaluate<{
          icons: Record<string, string>;
          action: { default_popup: string };
        }>('fetch("/manifest.json").then((response) => response.json())');
        expect(manifest.icons["16"]).toBe("icon/16.png");
        expect(manifest.action.default_popup).toBe("popup.html");
      }

      await expectActionGeometry(popup);
      await expectPopupInteractions(popup);
      await popup.screenshot(
        testInfo.outputPath(`${state.name}-action-popup.png`),
      );
      if (state.name === "configured") {
        const translate = await popupButton(popup, "Translate");
        await clickControl(popup, translate);
        await translationRequested;
        await expectFooterStatus(popup, "");
        expect(
          await popup.evaluate<number>(
            `document.body.innerText.split("Translating…").length - 1`,
          ),
        ).toBe(1);
        expect(
          await popup.evaluate<string>(`(() => {
              const button = [...document.querySelectorAll("button")].find(
                (candidate) => candidate.textContent.trim() === "Translating…",
              );
              return button?.textContent?.trim() ?? "";
            })()`),
        ).toBe("Translating…");
        // Busy: the disabled label button plus a separate, enabled Stop.
        expect(
          await popup.evaluate<{
            busy: string | null;
            thread: boolean;
            stop: { text: string; disabled: boolean } | null;
          }>(`(() => {
              const busy = document.querySelector('button[data-state="busy"]');
              const stop = document.querySelector(
                'button[aria-label="Stop translating and show the original"]',
              );
              return {
                busy: busy?.getAttribute("aria-busy") ?? null,
                thread: Boolean(busy?.querySelector("[data-thread]")),
                stop: stop ? { text: stop.textContent.trim(), disabled: stop.disabled } : null,
              };
            })()`),
        ).toEqual({
          busy: "true",
          thread: true,
          stop: { text: "Stop", disabled: false },
        });
        await popup.screenshot(
          testInfo.outputPath("translating-button-only-action-popup.png"),
        );
        releaseTranslation?.();
        await expect
          .poll(() =>
            popup.evaluate<string>(
              'document.querySelector(\'[role="status"]\')?.textContent?.trim() ?? ""',
            ),
          )
          .toBe("");

        // Translated: the primary control becomes Translation | Original,
        // with the card's status line above it.
        await expect
          .poll(() =>
            popup.evaluate<string>(`(() => {
              const button = document.querySelector('button[aria-label="Show original"]');
              return button ? String(button.disabled) : "missing";
            })()`),
          )
          .toBe("false");
        expect(
          await popup.evaluate<{
            translation: string | null;
            status: string;
          }>(`(() => ({
              translation: document
                .querySelector('button[aria-label="Show translation"]')
                ?.getAttribute("aria-pressed") ?? null,
              status: document.querySelector("[data-page-status]")?.textContent?.trim() ?? "",
            }))()`),
        ).toEqual({ translation: "true", status: "Translated to English" });
        await popup.screenshot(
          testInfo.outputPath("translated-toggle-action-popup.png"),
        );
        const showOriginal = await popupButton(popup, "Show original");
        await clickControl(popup, showOriginal);
        // Signed in, the card's status line says it; the footer stays empty.
        await expect
          .poll(() =>
            popup.evaluate<string>(
              'document.querySelector(\'[data-page-status="original"]\')?.textContent?.trim() ?? ""',
            ),
          )
          .toBe("Showing the original");
        await expectFooterStatus(popup, "");
        await expect(page.locator("#probe")).toHaveText("基本情報");

        const cacheKey = "translationCache:google:v6:popup-proof";
        await popup.evaluate(`new Promise((resolve, reject) => {
            const request = indexedDB.open("web-page-translation", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const transaction = request.result.transaction("kv", "readwrite");
              transaction.objectStore("kv").put("proof", ${JSON.stringify(cacheKey)});
              transaction.oncomplete = () => resolve();
              transaction.onerror = () => reject(transaction.error);
            };
          })`);
        await popup.evaluate(`(() => {
            globalThis.__popupProofConfirmation = "";
            window.confirm = (message) => {
              globalThis.__popupProofConfirmation = message;
              return true;
            };
          })()`);
        await clickControl(popup, await popupButton(popup, "Menu"));
        const clearSaved = await popupButton(popup, "Clear saved translations");
        await clickControl(popup, clearSaved);
        await expect
          .poll(() =>
            popup.evaluate<string>(
              'document.querySelector(\'[role="status"]\')?.textContent?.trim() ?? ""',
            ),
          )
          .toBe("Saved translations cleared.");
        await expectFooterStatus(popup, "Saved translations cleared.");
        expect(
          await popup.evaluate<string>(
            "String(globalThis.__popupProofConfirmation)",
          ),
        ).toBe(
          "Clear saved translations? Your site preferences will stay saved.",
        );
        expect(
          await popup.evaluate<unknown>(`new Promise((resolve, reject) => {
              const request = indexedDB.open("web-page-translation", 1);
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const transaction = request.result.transaction("kv", "readonly");
                const read = transaction.objectStore("kv").get(${JSON.stringify(cacheKey)});
                read.onsuccess = () => resolve(read.result ?? null);
                read.onerror = () => reject(read.error);
              };
            })`),
        ).toBeNull();

        // ADR 0014 removed the Provider select: "Translate to" is the only
        // combobox.
        expect(
          await popup.evaluate<number>(
            "document.querySelectorAll('[role=\"combobox\"]').length",
          ),
        ).toBe(1);
        const target = await popupElement(popup, '[role="combobox"]', 0);
        await clickControl(popup, target);
        await expect
          .poll(() =>
            popup.evaluate<string[]>(
              "[...document.querySelectorAll('[role=\"option\"]')].map((option) => option.textContent.trim())",
            ),
          )
          .toEqual(
            expect.arrayContaining(["English", "Vietnamese", "Japanese"]),
          );
        await popup.screenshot(
          testInfo.outputPath("configured-language-options-action-popup.png"),
        );
      }
    } finally {
      await closeActionPopup(popup);
      await browser.detach();
    }
  });
}

async function closeActionPopup(popup: {
  action: CDPSession;
  control: CDPSession;
  targetIds: string[];
}) {
  await Promise.allSettled(
    popup.targetIds.map((targetId) =>
      popup.control.send("Target.closeTarget", { targetId }),
    ),
  );
  await popup.action.detach();
  await popup.control.detach();
}

test("@popup-self-heal action popup repairs an already-open document", async ({
  context,
  extensionId,
  page,
}) => {
  // Stage requests that carry the probe record: the repair oracle.
  let providerRequests = 0;
  await mockAuthenticated(context);
  await routeStage(context, async (route) => {
    const body = route.request().postDataJSON() as { sources: string[][] };
    if (body.sources.flat().includes("基本情報")) providerRequests += 1;
    await route.fulfill({
      json: {
        results: body.sources.map((row) => row.map(() => "Basic information")),
        provenance: body.sources.map((row) => row.map(() => "openai")),
        failures: [],
        diagnostics: {
          records: body.sources.flat().length,
          sourceCharacters: 1,
          requestCount: 1,
          requestMs: 1,
        },
      },
    });
  });

  await page.goto(fixtureUrl);
  // User-authorized translation bypasses `translate="no"` (lessons,
  // 2026-10-03), so the context paragraph and title are translated too; the
  // oracle counts only stage requests that carry the probe.
  const initialDocument = await page.evaluate(
    () =>
      (
        window as unknown as {
          __selfHeal: { navigationCount: number; sentinel: string };
        }
      ).__selfHeal,
  );
  const session = await browserSession(context);
  const startupPopup = await triggerAction(session, extensionId, page);
  await closeActionPopup(startupPopup);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __selfHeal: { navigationCount: number; sentinel: string };
          }
        ).__selfHeal,
    ),
  ).toEqual(initialDocument);

  await session.send("Extensions.uninstall", { id: extensionId });
  const reloaded = (await session.send("Extensions.loadUnpacked", {
    path: extensionPath,
  })) as { id: string };
  expect(reloaded.id).toBe(extensionId);
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${reloaded.id}/popup.html`);
  await expect(setup.locator('main[aria-busy="false"]')).toBeVisible();
  await setExtensionStorage(setup, refreshTokenKey, "mock-refresh");
  await setExtensionStorage(
    setup,
    `alwaysTranslate:${new URL(fixtureUrl).hostname}`,
    { enabled: true, targetLanguage: "en" },
  );
  await setup.close();

  const recoveredPopup = await triggerAction(session, reloaded.id, page);
  await expect(page.locator("#probe")).toHaveText("Basic information");
  expect(providerRequests).toBe(1);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __selfHeal: { navigationCount: number; sentinel: string };
          }
        ).__selfHeal,
    ),
  ).toEqual(initialDocument);
  await closeActionPopup(recoveredPopup);
  await session.detach();
});

test("@popup-self-heal protected page ends after one popup attempt", async ({
  context,
  extensionId,
  page,
}) => {
  let providerRequests = 0;
  await routeStage(context, async (route) => {
    providerRequests += 1;
    await route.abort();
  });
  await page.goto("chrome://version/");
  const initialPage = { title: await page.title(), url: page.url() };
  const session = await browserSession(context);

  const popup = await triggerAction(session, extensionId, page);
  expect({ title: await page.title(), url: page.url() }).toEqual(initialPage);
  expect(providerRequests).toBe(0);
  await closeActionPopup(popup);
  await session.detach();
});
