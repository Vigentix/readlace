import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

const extensionPath = path.resolve(
  process.env.PLAYWRIGHT_EXTENSION_PATH ?? ".output/chrome-mv3",
);

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

async function launchExtension() {
  await access(extensionPath);
  const userDataDir = await mkdtemp(
    path.join(tmpdir(), "readlace-local-reader-"),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: await executablePath(),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  const browser = context.browser();
  if (!browser) throw new Error("Installed Chromium browser is unavailable.");
  const session = await browser.newBrowserCDPSession();
  try {
    const { id } = (await session.send("Extensions.loadUnpacked", {
      path: extensionPath,
    })) as { id: string };
    return { context, extensionId: id, userDataDir };
  } catch (error) {
    await context.close();
    await rm(userDataDir, { force: true, recursive: true });
    throw error;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function closeExtension(session: {
  context: BrowserContext;
  userDataDir: string;
}) {
  await session.context.close();
  await rm(session.userDataDir, { force: true, recursive: true });
}

test("reader loading states keep local controls centered and settings persistent", async () => {
  const session = await launchExtension();
  try {
    const page = await session.context.newPage();
    const readerUrl = `chrome-extension://${session.extensionId}/reader.html?local=1`;
    await page.addInitScript(() => {
      const runtime = globalThis as unknown as {
        __localSpreadsheetTranslationRequests?: unknown[];
        __holdLocalSpreadsheetTranslation?: boolean;
        __releaseLocalSpreadsheetTranslation?: () => void;
        chrome: {
          runtime: {
            sendMessage(...args: unknown[]): Promise<unknown>;
          };
        };
      };
      const requests: unknown[] = [];
      const sendMessage = runtime.chrome.runtime.sendMessage.bind(
        runtime.chrome.runtime,
      );
      runtime.__localSpreadsheetTranslationRequests = requests;
      runtime.chrome.runtime.sendMessage = async (...args: unknown[]) => {
        const request = args[0] as {
          type?: string;
          readerInstanceId?: string;
          requestId?: number;
          generation?: number;
          records?: { id: string; sourceHash: string; text: string }[];
        };
        if (request?.type !== "LOCAL_SPREADSHEET_TRANSLATE")
          return sendMessage(...args);
        requests.push(request);
        if (runtime.__holdLocalSpreadsheetTranslation)
          await new Promise<void>((resolve) => {
            runtime.__releaseLocalSpreadsheetTranslation = () => resolve();
          });
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          generation: request.generation,
          ok: true,
          results: request.records?.map(({ id, sourceHash, text }) => ({
            id,
            sourceHash,
            text: `Translated: ${text}`,
          })),
        };
      };
    });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(readerUrl);

    const externalRequests: string[] = [];
    const downloads: string[] = [];
    session.context.on("request", (request) => {
      const entry = `${request.method()} ${request.url()}`;
      // ADR 0015: the worker reads the content-free remote Reader flag at
      // startup, which can land after this listener attaches. Nothing else
      // may leave the device.
      if (
        /^https?:/i.test(request.url()) &&
        entry !== "GET https://api.example.test/v1/features"
      )
        externalRequests.push(entry);
    });
    page.on("download", (download) =>
      downloads.push(download.suggestedFilename()),
    );

    await page.locator('input[type="file"]').setInputFiles({
      name: "quoted-fields.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        'Name,Note\r\n"Alpha","Line 1\nLine 2"\r\n"001","a,b"',
        "utf8",
      ),
    });

    await expect(
      page.getByText("quoted-fields.csv", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Worksheet" })).toHaveText(
      "Sheet1",
    );
    await expect(
      page.locator('[role="gridcell"][data-cell-address="A2"]'),
    ).toHaveText("Alpha");
    const multiline = page.locator('[role="gridcell"][data-cell-address="B2"]');
    await expect(multiline).toHaveText(/Line 1\s+Line 2/);
    await expect(multiline).toHaveAttribute("aria-label", "B2: Line 1\nLine 2");
    await expect(
      page.locator('[role="gridcell"][data-cell-address="B3"]'),
    ).toHaveText("a,b");

    await page.getByRole("button", { name: "Clear view" }).click();
    await expect(page.locator('input[type="file"]')).toBeVisible();

    const first = XLSX.utils.aoa_to_sheet([
      ["First sheet", { t: "s", f: '"Cached text"', v: "Cached text" }],
      [],
      ["Merged absolute cell"],
    ]);
    first["!merges"] = [XLSX.utils.decode_range("A3:B3")];
    const second = XLSX.utils.aoa_to_sheet([["Second sheet", "Visible value"]]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, first, "First");
    XLSX.utils.book_append_sheet(workbook, second, "Second");
    const workbookBytes = XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      compression: true,
      cellStyles: true,
    }) as ArrayBuffer;

    await page.locator('input[type="file"]').setInputFiles({
      name: "two-sheets.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(workbookBytes),
    });

    await expect(
      page.getByText("two-sheets.xlsx", { exact: true }),
    ).toBeVisible();
    const worksheet = page.getByRole("combobox", { name: "Worksheet" });
    await expect(worksheet).toHaveText("First");
    await expect(
      page.locator('[role="gridcell"][data-cell-address="B1"]'),
    ).toHaveText("Cached text");
    await expect(
      page.locator('[role="gridcell"][data-cell-address="A3"]'),
    ).toHaveText("Merged absolute cell");

    await worksheet.click();
    await page.getByRole("option", { name: "Second" }).click();
    await expect(worksheet).toHaveText("Second");
    const secondSheetCell = page.locator(
      '[role="gridcell"][data-cell-address="A1"]',
    );
    await expect(secondSheetCell).toHaveText("Second sheet");
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as unknown as {
          __localSpreadsheetTranslationRequests?: unknown[];
        };
        return runtime.__localSpreadsheetTranslationRequests?.length ?? 0;
      }),
    ).toBe(0);

    const fieldLayout = async () =>
      page.evaluate(() => {
        const fields = [
          ...document.querySelectorAll<HTMLElement>(
            ".spreadsheet-fields .spreadsheet-field",
          ),
        ];
        return {
          tops: fields.map((field) =>
            Math.round(field.getBoundingClientRect().top),
          ),
          widths: fields.map((field) => field.getBoundingClientRect().width),
          viewportWidth: window.innerWidth,
          pageWidth: document.documentElement.scrollWidth,
        };
      });
    const narrowFields = await fieldLayout();
    expect(narrowFields.tops).toHaveLength(2);
    expect(new Set(narrowFields.tops).size).toBe(1);
    expect(narrowFields.widths.every((width) => width > 70)).toBe(true);
    expect(narrowFields.pageWidth).toBeLessThanOrEqual(
      narrowFields.viewportWidth,
    );

    const translate = page.getByRole("button", { name: "Translate" });
    const stop = page.getByRole("button", { name: "Stop" });
    const translation = page.getByRole("button", {
      name: "Translation",
      exact: true,
    });
    const original = page.getByRole("button", { name: "Original" });
    await expect(translate).toBeEnabled();
    await expect(stop).toBeDisabled();
    await expect(translation).toBeDisabled();
    await expect(original).toBeDisabled();
    const actionGeometry = async () =>
      page.evaluate(() => {
        const primary = document.querySelector<HTMLElement>(
          ".spreadsheet-primary-actions .primary-button",
        )!;
        const stop = document.querySelector<HTMLElement>(
          ".spreadsheet-primary-actions .stop-button",
        )!;
        const primaryRect = primary.getBoundingClientRect();
        const stopRect = stop.getBoundingClientRect();
        return {
          primary: { x: primaryRect.x, width: primaryRect.width },
          stop: { x: stopRect.x, width: stopRect.width },
        };
      });
    const idleActions = await actionGeometry();
    await page.evaluate(() => {
      const runtime = globalThis as unknown as {
        __holdLocalSpreadsheetTranslation?: boolean;
      };
      runtime.__holdLocalSpreadsheetTranslation = true;
    });

    await translate.click();
    const translating = page.getByRole("button", { name: "Translating…" });
    await expect(translating).toBeDisabled();
    await expect(translating.getByTestId("reader-spinner")).toBeVisible();
    await expect(stop).toBeEnabled();
    expect(await actionGeometry()).toEqual(idleActions);
    await page.evaluate(() => {
      const runtime = globalThis as unknown as {
        __holdLocalSpreadsheetTranslation?: boolean;
        __releaseLocalSpreadsheetTranslation?: () => void;
      };
      runtime.__holdLocalSpreadsheetTranslation = false;
      runtime.__releaseLocalSpreadsheetTranslation?.();
    });
    await expect(secondSheetCell).toHaveText("Translated: Second sheet");
    await expect(
      page.getByRole("button", { name: "Translation on" }),
    ).toBeDisabled();
    await expect(stop).toBeEnabled();
    await expect(translation).toBeEnabled();
    await expect(original).toBeEnabled();
    expect(await actionGeometry()).toEqual(idleActions);
    expect(
      await page.locator(".reader-sr-only").evaluate((element) => {
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
    await expect(page.locator(".reader-status:visible")).toHaveCount(0);

    for (const width of [320, 480, 1_000]) {
      await page.setViewportSize({ width, height: 720 });
      const geometry = await page.locator(".stop-button").evaluate((button) => {
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        const label = button.querySelector("span")!.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return {
          iconWidth: icon.width,
          iconHeight: icon.height,
          center: (icon.left + label.right) / 2,
          buttonCenter: rect.left + rect.width / 2,
          vertical: Math.abs(
            icon.top + icon.height / 2 - label.top - label.height / 2,
          ),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry.iconWidth).toBe(16);
      expect(geometry.iconHeight).toBe(16);
      expect(
        Math.abs(geometry.center - geometry.buttonCenter),
      ).toBeLessThanOrEqual(1);
      expect(geometry.vertical).toBeLessThanOrEqual(1);
      expect(geometry.overflow).toBe(false);
      await page.screenshot({
        path: test.info().outputPath(`local-controls-${width}.png`),
      });
    }
    await expect(
      page.getByRole("combobox", { name: "Translate to" }),
    ).toHaveText("Vietnamese");
    await page.setViewportSize({ width: 1_000, height: 720 });
    const expandedFields = await fieldLayout();
    expect(new Set(expandedFields.tops).size).toBe(1);
    expect(expandedFields.pageWidth).toBeLessThanOrEqual(
      expandedFields.viewportWidth,
    );

    await worksheet.click();
    await page.getByRole("option", { name: "First" }).click();
    await expect(worksheet).toHaveText("First");
    await expect(
      page.locator('[role="gridcell"][data-cell-address="A1"]'),
    ).toHaveText("Translated: First sheet");
    const translationRequests = await page.evaluate(() => {
      const runtime = globalThis as unknown as {
        __localSpreadsheetTranslationRequests?: unknown[];
      };
      return runtime.__localSpreadsheetTranslationRequests ?? [];
    });
    expect(translationRequests).toHaveLength(2);
    expect(
      translationRequests.every(
        (request) =>
          (request as { targetLanguage?: string }).targetLanguage === "vi",
      ),
    ).toBe(true);
    const translationRequest = translationRequests[0] as {
      records: Record<string, unknown>[];
      [key: string]: unknown;
    };
    // ADR 0014: the backend routes engines; no provider is sent.
    expect(Object.keys(translationRequest).sort()).toEqual([
      "generation",
      "readerInstanceId",
      "records",
      "requestId",
      "targetLanguage",
      "type",
    ]);
    expect(
      translationRequest.records.map((record) => Object.keys(record).sort()),
    ).toEqual(
      translationRequest.records.map(() => ["id", "sourceHash", "text"]),
    );
    expect(translationRequest.records.map((record) => record.text)).toContain(
      "Second sheet",
    );
    expect(JSON.stringify(translationRequest)).not.toMatch(
      /arraybuffer|bytes|filename|sheetname|workbook|vba/i,
    );
    await expect(page).toHaveURL(readerUrl);
    expect(externalRequests).toEqual([]);
    expect(downloads).toEqual([]);
    await expect(
      page.getByRole("button", { name: /save|download|export/i }),
    ).toHaveCount(0);
  } finally {
    await closeExtension(session);
  }
});
