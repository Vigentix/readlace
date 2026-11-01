import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// UI locale (CONTEXT.md): the popup follows the background's locale, its
// switch saves through `UI_LOCALE_SET`, and broadcasts re-render it.

vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: vi.fn(async () => undefined),
    getMany: vi.fn(async () => ({})),
    getByPrefix: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
    setMany: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/workspace-features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace-features")>()),
  readSheetsReaderFlag: vi.fn(async () => false),
}));

import App from "./App";

const RESETS_AT = "2026-10-15T00:00:00.000Z";
const TRIAL_AUTH = {
  authenticated: true,
  backendConfigured: true,
  user: { id: "user-1", email: "locale@example.com" },
  entitlement: {
    plan: "trial",
    source: "trial",
    trial: {
      startedAt: "2026-10-01T00:00:00.000Z",
      endsAt: RESETS_AT,
      charCap: 1_000_000,
      daysLeft: 3,
      active: true,
      capReached: false,
    },
    period: {
      start: "2026-10-01T00:00:00.000Z",
      end: "2026-11-01T00:00:00.000Z",
    },
    limits: {
      notifyAt: 800_000,
      throttleAt: null,
      hardCap: 1_000_000,
      window: "trial",
    },
  },
  usage: {
    used: 120_000,
    limit: 1_000_000,
    notifyAt: 800_000,
    throttleAt: null,
    hardCap: 1_000_000,
    window: "trial",
    resetsAt: RESETS_AT,
  },
};

let stored: "en" | "vi" | null;
let auth: Record<string, unknown>;

function sent(type: string) {
  return vi
    .mocked(browser.runtime.sendMessage)
    .mock.calls.map(([message]) => message as { type?: string })
    .filter((message) => message.type === type);
}

async function waitForPopupReady() {
  await waitFor(() =>
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = "vi";
  auth = TRIAL_AUTH;
  vi.stubEnv("BROWSER", "chrome");
  vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "");
  const url = "https://news.example.test/a";
  vi.spyOn(browser.tabs, "query").mockImplementation(
    async () => [{ id: 1, windowId: 10, url, active: true }] as never,
  );
  vi.spyOn(browser.tabs, "get").mockImplementation(
    async () => ({ id: 1, windowId: 10, url, active: true }) as never,
  );
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(async (raw) => {
    const message = raw as { type?: string; locale?: "en" | "vi" };
    if (message.type === "AUTH_STATUS") return auth as never;
    if (message.type === "UI_LOCALE_GET")
      return { locale: stored ?? "en", stored } as never;
    if (message.type === "UI_LOCALE_SET") {
      stored = message.locale!;
      return { locale: stored, stored } as never;
    }
    return { pageLanguage: "Japanese", sourceLanguage: "ja" } as never;
  });
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.documentElement.lang = "en";
});

test("renders the popup in Vietnamese", async () => {
  render(<App />);
  await waitForPopupReady();

  expect(document.documentElement.lang).toBe("vi");
  expect(screen.getByRole("button", { name: "Dịch trang" })).toBeEnabled();
  // The detected-language label is for assistive technology only.
  const detectedLabel = screen.getByText("Ngôn ngữ trang:");
  expect(detectedLabel).toHaveClass("sr-only");
  expect(detectedLabel.parentElement).toHaveTextContent(
    "Ngôn ngữ trang: Tiếng Nhật",
  );
  expect(screen.getByRole("combobox", { name: "Dịch sang" })).toHaveTextContent(
    "Tiếng Anh",
  );
  expect(
    screen.getByRole("switch", { name: "Luôn dịch trang này" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Mở file bảng tính" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Cài đặt" })).toBeInTheDocument();
});

test("switching language in the account menu saves it and re-renders at once", async () => {
  render(<App />);
  await waitForPopupReady();

  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  const group = screen.getByRole("radiogroup", { name: "Ngôn ngữ" });
  expect(screen.getByRole("radio", { name: "Tiếng Việt" })).toBeChecked();
  expect(group).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "English" }));

  expect(
    await screen.findByRole("button", { name: "Translate" }),
  ).toBeInTheDocument();
  expect(sent("UI_LOCALE_SET")).toEqual([
    { type: "UI_LOCALE_SET", locale: "en" },
  ]);
  expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
  expect(screen.getByText("Always translate this site")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeInTheDocument();
  expect(document.documentElement.lang).toBe("en");
});

test("follows a UI_LOCALE_CHANGED broadcast from the background", async () => {
  stored = null;
  render(<App />);
  await waitForPopupReady();
  expect(screen.getByRole("button", { name: "Translate" })).toBeInTheDocument();

  await act(() =>
    fakeBrowser.runtime.onMessage.trigger(
      { type: "UI_LOCALE_CHANGED", locale: "vi" },
      { id: browser.runtime.id } as never,
      vi.fn(),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Dịch trang" }),
  ).toBeInTheDocument();

  // Another extension cannot switch it.
  await act(() =>
    fakeBrowser.runtime.onMessage.trigger(
      { type: "UI_LOCALE_CHANGED", locale: "en" },
      { id: "other-extension" } as never,
      vi.fn(),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Dịch trang" }),
  ).toBeInTheDocument();
});

test("keeps the current language when saving fails", async () => {
  stored = null;
  render(<App />);
  await waitForPopupReady();
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (raw) =>
    (raw as { type?: string }).type === "UI_LOCALE_SET"
      ? (undefined as never)
      : ({} as never),
  );

  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  fireEvent.click(screen.getByRole("radio", { name: "Tiếng Việt" }));
  await waitFor(() =>
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked(),
  );
  expect(screen.getByRole("button", { name: "Translate" })).toBeInTheDocument();
});
