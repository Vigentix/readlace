import { beforeEach, expect, test, vi } from "vitest";
import {
  readReaderIntent,
  readerIntentForCurrentSource,
  readerIntentIsCurrent,
  readerIntentKey,
  takeReaderIntent,
  type WorkspaceReaderIntent,
} from "./workspace-reader-intent";

const intent = (): WorkspaceReaderIntent => ({
  id: "click-1",
  createdAt: Date.now(),
  context: {
    kind: "sheets",
    sourceTabId: 7,
    fileId: "sheet-1",
    activeId: "42",
  },
  targetLanguage: "vi",
  account: "reader@example.com",
});

beforeEach(() => {
  let queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_key: string, callback: () => Promise<unknown>) => {
        const result = queue.then(callback);
        queue = result.then(() => undefined);
        return result;
      },
    },
  });
  vi.spyOn(browser.tabs, "get").mockResolvedValue({
    id: 7,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
  } as never);
  vi.spyOn(browser.runtime, "sendMessage").mockResolvedValue({
    authenticated: true,
    user: { email: "reader@example.com" },
  } as never);
});

test("rejects expired, malformed and other-tab intents", () => {
  const value = intent();
  expect(readReaderIntent(value, 7)).toEqual(value);
  for (const invalid of [
    null,
    {},
    { ...value, createdAt: Date.now() - 300_001 },
    { ...value, targetLanguage: "invalid" },
    { ...value, context: { ...value.context, sourceTabId: 8 } },
    { ...value, context: { ...value.context, activeId: "2147483648" } },
  ])
    expect(readReaderIntent(invalid, 7)).toBeUndefined();
});

test("consumes one click once across simultaneous Reader surfaces", async () => {
  const value = intent();
  await browser.storage.session.set({ [readerIntentKey(7)]: value });
  expect(await Promise.all([takeReaderIntent(7), takeReaderIntent(7)])).toEqual(
    [value, undefined],
  );
});

test("claims a same-file sheet change and rebinds only to its authoritative context", async () => {
  const value = intent();
  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 7,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit?gid=41#gid=43",
  } as never);
  await browser.storage.session.set({ [readerIntentKey(7)]: value });

  expect(await takeReaderIntent(7)).toEqual(value);
  expect(
    await readerIntentForCurrentSource(value, {
      ...value.context,
      activeId: "43",
    }),
  ).toEqual({
    ...value,
    context: { ...value.context, activeId: "43" },
  });
  expect(
    await readerIntentForCurrentSource(value, {
      ...value.context,
      activeId: "41",
    }),
  ).toBeUndefined();
});

test("keeps a no-gid click file-bound and accepts only the authoritative resolved sheet", async () => {
  const value = {
    ...intent(),
    context: { ...intent().context, activeId: null },
  };
  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 7,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
  } as never);

  expect(await readerIntentIsCurrent(value)).toBe(true);
  expect(
    await readerIntentForCurrentSource(value, {
      ...value.context,
      activeId: "42",
    }),
  ).toEqual({
    ...value,
    context: { ...value.context, activeId: "42" },
  });
  expect(
    await readerIntentForCurrentSource(value, value.context),
  ).toBeUndefined();

  vi.mocked(browser.tabs.get).mockResolvedValue({
    id: 7,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=43",
  } as never);
  expect(await readerIntentIsCurrent(value)).toBe(true);
  expect(
    await readerIntentForCurrentSource(value, {
      ...value.context,
      activeId: "42",
    }),
  ).toBeUndefined();
  expect(
    await readerIntentForCurrentSource(value, {
      ...value.context,
      activeId: "43",
    }),
  ).toEqual({ ...value, context: { ...value.context, activeId: "43" } });
});

test.each(["navigation", "account", "unavailable", "expired"])(
  "discards a click after %s changes",
  async (change) => {
    const value = intent();
    if (change === "expired") value.createdAt = Date.now() - 300_001;
    await browser.storage.session.set({ [readerIntentKey(7)]: value });
    if (change === "navigation")
      vi.mocked(browser.tabs.get).mockResolvedValue({
        id: 7,
        url: "https://docs.google.com/spreadsheets/d/sheet-2/edit#gid=43",
      } as never);
    else if (change !== "expired")
      vi.mocked(browser.runtime.sendMessage).mockResolvedValue({
        authenticated: true,
        unavailable: change === "unavailable",
        user: { email: "someone-else@example.com" },
      } as never);
    expect(await takeReaderIntent(7)).toBeUndefined();
    expect(await browser.storage.session.get(readerIntentKey(7))).toEqual({});
    expect(
      await readerIntentForCurrentSource(value, value.context),
    ).toBeUndefined();
  },
);

test.each([
  "https://docs.google.com/spreadsheets/d/sheet-1/edit?gid=42&gid=43",
  "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=-1",
])("rejects a malformed current source %s", async (url) => {
  vi.mocked(browser.tabs.get).mockResolvedValue({ id: 7, url } as never);
  expect(await readerIntentIsCurrent(intent())).toBe(false);
  expect(
    await readerIntentForCurrentSource(intent(), intent().context),
  ).toBeUndefined();
});
