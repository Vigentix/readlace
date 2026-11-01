import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ADR 0011: the Local Spreadsheet Reader is trial/Pro. The popup quick-open is
// prominent for trial and Pro; Free sees it marked Pro, with the upgrade path
// instead of a Reader tab.
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

const PERIOD = {
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
};
const TRIAL = {
  startedAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-10-15T00:00:00.000Z",
  charCap: 1_000_000,
  daysLeft: 9,
  active: true,
  capReached: false,
};
const PLANS = {
  trial: {
    plan: "trial",
    source: "trial",
    trial: TRIAL,
    period: PERIOD,
    limits: {
      notifyAt: 800_000,
      throttleAt: null,
      hardCap: 1_000_000,
      window: "trial",
    },
  },
  pro: {
    plan: "pro",
    source: "managed",
    period: PERIOD,
    limits: {
      notifyAt: 4_000_000,
      throttleAt: 5_000_000,
      hardCap: 10_000_000,
      window: "period",
    },
  },
  free: {
    plan: "free",
    source: "trial-expired",
    trial: { ...TRIAL, daysLeft: 0, active: false },
    period: PERIOD,
    limits: null,
  },
} as const;

function mockPopup(entitlement: unknown) {
  vi.spyOn(browser.tabs, "query").mockImplementation(
    async () =>
      [
        {
          id: 1,
          windowId: 10,
          url: "https://news.yahoo.co.jp/a",
          active: true,
        },
      ] as never,
  );
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      ((message as { type?: string }).type === "AUTH_STATUS"
        ? {
            authenticated: true,
            backendConfigured: true,
            user: { id: "user-1", email: "reader@example.com" },
            entitlement,
          }
        : { pageLanguage: "Japanese", sourceLanguage: "ja" }) as never,
  );
}

async function waitForPopupReady() {
  await waitFor(() => {
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BROWSER", "chrome");
  vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "");
  vi.spyOn(window, "close").mockImplementation(() => undefined);
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
});

test.each(["trial", "pro"] as const)(
  "%s gets a prominent Open local spreadsheet that opens the Reader tab",
  async (plan) => {
    const user = userEvent.setup();
    mockPopup(PLANS[plan]);
    const create = vi
      .spyOn(browser.tabs, "create")
      .mockResolvedValue({} as never);
    render(<App />);
    await waitForPopupReady();

    const tools = screen.getByRole("region", { name: "Spreadsheet tools" });
    const open = within(tools).getByRole("button", {
      name: "Open local spreadsheet",
    });
    expect(open).toHaveTextContent("CSV, XLSX or XLSM");
    expect(open).not.toHaveTextContent("Pro");
    expect(open).not.toHaveAttribute("aria-expanded");

    await user.click(open);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      url: browser.runtime.getURL("/reader.html?local=1" as never),
    });
    expect(window.close).toHaveBeenCalledOnce();
  },
);

test("Free opens the local Reader too: every feature is open (ADR 0020)", async () => {
  const user = userEvent.setup();
  mockPopup(PLANS.free);
  const create = vi
    .spyOn(browser.tabs, "create")
    .mockResolvedValue({} as never);
  render(<App />);
  await waitForPopupReady();

  const open = screen.getByRole("button", { name: "Open local spreadsheet" });
  expect(open).not.toHaveTextContent("Pro");
  await user.click(open);
  expect(create).toHaveBeenCalledExactlyOnceWith({
    url: browser.runtime.getURL("/reader.html?local=1" as never),
  });
});
