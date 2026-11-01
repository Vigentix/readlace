import { test as base, chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";

const pathToExtension = path.resolve(
  process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3",
);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const loadedExtensionIds = new WeakMap<BrowserContext, string>();

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    // Always load through CDP as an unpacked extension so specs can uninstall
    // and reload it (`@popup-self-heal`); `--load-extension` cannot be
    // uninstalled ("not an unpacked extension").
    const context = await chromium.launchPersistentContext("", {
      headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      args: ["--enable-unsafe-extension-debugging"],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    try {
      const browser = context.browser();
      if (!browser) throw new Error("Chromium browser is unavailable.");
      const session = await browser.newBrowserCDPSession();
      const { id } = (await session.send("Extensions.loadUnpacked", {
        path: pathToExtension,
      })) as { id: string };
      loadedExtensionIds.set(context, id);
      await session.detach();
      await use(context);
    } finally {
      await context.close();
    }
  },
  extensionId: async ({ context }, use) => {
    const loadedExtensionId = loadedExtensionIds.get(context);
    if (loadedExtensionId) {
      await use(loadedExtensionId);
      return;
    }
    const matchesExtension = (worker: { url(): string }) =>
      worker.url().startsWith("chrome-extension://");
    let serviceWorker = context.serviceWorkers().find(matchesExtension);
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", {
        predicate: matchesExtension,
      });
    }

    const extensionId = serviceWorker.url().split("/")[2];
    if (!extensionId) {
      throw new Error("Could not determine extension ID from service worker");
    }

    await use(extensionId);
  },
});

export const expect = test.expect;
