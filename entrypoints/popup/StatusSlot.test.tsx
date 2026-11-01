import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Decision 6: one status slot shows only the top notice; the quota meter
// stays in its footer. The primary control becomes Translation | Original.

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

const PAGE_URL = "https://news.yahoo.co.jp/a";
const PERIOD = {
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
};
const TRIAL = {
  startedAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-10-15T00:00:00.000Z",
  charCap: 1_000_000,
  daysLeft: 3,
  active: true,
  capReached: false,
};
const PRO_LIMITS = {
  notifyAt: 8_000_000,
  throttleAt: 9_000_000,
  hardCap: 10_000_000,
  window: "period",
};
const PRO = {
  plan: "pro",
  source: "managed",
  period: PERIOD,
  limits: PRO_LIMITS,
};

function mockPopup(url: string, auth: Record<string, unknown>) {
  vi.spyOn(browser.tabs, "query").mockImplementation(
    async () => [{ id: 1, windowId: 10, url, active: true }] as never,
  );
  vi.spyOn(browser.tabs, "get").mockImplementation(
    async () => ({ id: 1, windowId: 10, url, active: true }) as never,
  );
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      ((message as { type?: string }).type === "AUTH_STATUS"
        ? {
            authenticated: true,
            backendConfigured: true,
            user: { id: "user-1", email: "slot@example.com" },
            ...auth,
          }
        : { pageLanguage: "Japanese", sourceLanguage: "ja" }) as never,
  );
}

async function waitForPopupReady() {
  await waitFor(() =>
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false"),
  );
}

function messageTypes() {
  return vi
    .mocked(browser.tabs.sendMessage)
    .mock.calls.map((call) => (call[1] as { type?: string }).type);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BROWSER", "chrome");
  vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "");
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
  // No Workspace client in this build: Sheets show the coming-soon notice.
  vi.spyOn(browser.runtime, "getManifest").mockReturnValue({
    manifest_version: 3,
    name: "Readlace",
    version: "0.0.1",
  } as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("on-device unsupported shows its notice and why Translate is disabled", async () => {
  mockPopup(PAGE_URL, {
    entitlement: {
      plan: "free",
      source: "trial-expired",
      trial: { ...TRIAL, daysLeft: 0, active: false },
      period: PERIOD,
      limits: null,
    },
    onDeviceTranslation: "unsupported",
    // ADR 0020: no provider key, so translation starts on-device.
    engineSource: "on-device",
  });
  render(<App />);
  await waitForPopupReady();
  expect(screen.getByLabelText("On-device translation")).toBeInTheDocument();
  // Disabled Translate says why, next to the control.
  const translate = screen.getByRole("button", { name: "Translate" });
  expect(translate).toBeDisabled();
  expect(translate).toHaveAccessibleDescription(
    "Needs an API key to translate in this browser.",
  );
});

test("Translation | Original switches with Show original and re-translates", async () => {
  const user = userEvent.setup();
  mockPopup(PAGE_URL, { entitlement: PRO });
  vi.mocked(browser.tabs.sendMessage).mockImplementation((async (
    _tab: number,
    message: { type?: string },
  ) =>
    message.type === "SHOW_ORIGINAL"
      ? { ok: true }
      : {
          state: "translated",
          targetLanguage: "en",
          translated: true,
          appliedTarget: "en",
          hasUnresolved: false,
        }) as never);
  render(<App />);
  await waitForPopupReady();

  const view = screen.getByRole("group", { name: "Page view" });
  const translation = screen.getByRole("button", { name: "Show translation" });
  const original = screen.getByRole("button", { name: "Show original" });
  expect(view).toContainElement(translation);
  expect(translation).toHaveTextContent("Translation");
  expect(translation).toHaveAttribute("aria-pressed", "true");
  expect(original).toHaveAttribute("aria-pressed", "false");
  expect(original).toHaveTextContent("Original");
  expect(
    document.querySelector('[data-page-status="translated"]'),
  ).toHaveTextContent("Translated to English");

  // The pressed side is a no-op: nothing is sent.
  const before = messageTypes().length;
  await user.click(translation);
  expect(messageTypes()).toHaveLength(before);

  await user.click(original);
  await waitFor(() =>
    expect(
      document.querySelector('[data-page-status="original"]'),
    ).toHaveTextContent("Showing the original"),
  );
  expect(messageTypes()).toContain("SHOW_ORIGINAL");
  // Signed in, the card's status line says it; the footer does not repeat it.
  expect(screen.getByRole("status")).not.toHaveTextContent(
    "Original restored.",
  );
  const again = screen.getByRole("button", { name: "Show translation" });
  expect(again).toHaveAttribute("aria-pressed", "false");
  expect(again).toBeEnabled();
  expect(screen.getByRole("button", { name: "Show original" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Show original" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await user.click(again);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Show translation" }),
    ).toHaveAttribute("aria-pressed", "true"),
  );
  expect(messageTypes()).toContain("START_TRANSLATION");
});

test("the menu closes on an outside click", async () => {
  mockPopup(PAGE_URL, { entitlement: PRO });
  render(<App />);
  await waitForPopupReady();
  const account = screen.getByRole("button", { name: "Menu" });
  fireEvent.click(account);
  expect(
    screen.getByRole("button", { name: "Clear saved translations" }),
  ).toBeVisible();
  fireEvent.pointerDown(screen.getByRole("main"));
  expect(account).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("button", { name: "Clear saved translations" }),
  ).not.toBeInTheDocument();
});
