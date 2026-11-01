import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// ADR 0020: without a provider key the popup translates on-device. Without
// the on-device Translator it says so and points to Settings; first-use
// language-pack preparation shows download progress.
const { store } = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock("@/lib/indexeddb-storage", () => ({
  extensionStorage: {
    get: vi.fn(async (key: string) => store[key]),
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
  startedAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-09-15T00:00:00.000Z",
  charCap: 1_000_000,
  daysLeft: 0,
  active: false,
  capReached: false,
};
const FREE_NO_TRIAL = {
  plan: "free",
  source: "none",
  period: PERIOD,
  limits: null,
};

function mockPopup(
  entitlement: unknown,
  onDeviceTranslation?: string,
  engineSource = "on-device",
) {
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
            user: { id: "user-1", email: "free@example.com" },
            entitlement,
            ...(onDeviceTranslation ? { onDeviceTranslation } : {}),
            // ADR 0020: without a provider key translation starts on-device.
            engineSource,
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
  for (const key of Object.keys(store)) delete store[key];
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
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("no key and no on-device support explains Chrome 138+ desktop, points to Settings and disables Translate", async () => {
  mockPopup(FREE_NO_TRIAL, "unsupported");
  render(<App />);
  await waitForPopupReady();

  const notice = screen.getByLabelText("On-device translation");
  expect(notice).toHaveTextContent(
    "On-device translation requires Chrome 138+ desktop.",
  );
  expect(notice).toHaveTextContent(
    "Add your OpenAI API key in Settings to translate in this browser.",
  );
  expect(
    within(notice).getByRole("button", { name: "Settings" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();
});

test.each([
  ["Free with on-device support", FREE_NO_TRIAL, "supported", undefined],
  [
    "a saved provider key without on-device support",
    {
      plan: "trial",
      source: "trial",
      trial: { ...TRIAL, daysLeft: 5, active: true },
      period: PERIOD,
      limits: {
        notifyAt: 800_000,
        throttleAt: null,
        hardCap: 1_000_000,
        window: "trial",
      },
    },
    "unsupported",
    "byok-openai",
  ],
  [
    "Free from a background without detection",
    FREE_NO_TRIAL,
    undefined,
    undefined,
  ],
])(
  "%s keeps Translate available",
  async (_name, entitlement, support, source) => {
    mockPopup(entitlement, support, source);
    render(<App />);
    await waitForPopupReady();

    expect(
      screen.queryByLabelText("On-device translation"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  },
);

test("shows first-use language-pack download progress while preparing", async () => {
  mockPopup(FREE_NO_TRIAL, "supported");
  let finish!: (value: unknown) => void;
  vi.mocked(browser.tabs.sendMessage).mockImplementation((async (
    _tabId: number,
    message: { type?: string },
  ) =>
    message.type === "START_TRANSLATION"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : {
          state: "original",
          targetLanguage: "en",
          translated: false,
          hasUnresolved: false,
        }) as never);
  const user = userEvent.setup();
  render(<App />);
  await waitForPopupReady();

  await user.click(screen.getByRole("button", { name: "Translate" }));
  // The popup starts preparation from the trusted click.
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
    type: "PREPARE_NATIVE_TRANSLATOR",
    sourceLanguage: "ja",
    targetLanguage: "en",
  });
  // Progress for another pair or from another extension is ignored.
  await act(async () => {
    await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "vi",
        progress: { phase: "downloading", loaded: 0.9, total: 1 },
      },
      { id: browser.runtime.id },
      vi.fn(),
    );
    await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "en",
        progress: { phase: "downloading", loaded: 0.9, total: 1 },
      },
      { id: "another-extension" },
      vi.fn(),
    );
  });
  expect(
    screen.queryByLabelText("On-device language pack download"),
  ).not.toBeInTheDocument();
  await act(async () => {
    await fakeBrowser.runtime.onMessage.trigger(
      {
        type: "NATIVE_TRANSLATOR_PROGRESS",
        sourceLanguage: "ja",
        targetLanguage: "en",
        progress: { phase: "downloading", loaded: 0.4, total: 1 },
      },
      { id: browser.runtime.id },
      vi.fn(),
    );
  });
  expect(
    screen.getByText("Downloading on-device language pack 40%"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("On-device language pack download"),
  ).toHaveAttribute("value", "0.4");

  await act(async () => {
    finish({ state: "translated", appliedTarget: "en" });
  });
  await waitFor(() =>
    expect(
      screen.queryByLabelText("On-device language pack download"),
    ).not.toBeInTheDocument(),
  );
});

test("the Settings button flags on-device translation without adding a row (ADR 0020)", async () => {
  mockPopup(FREE_NO_TRIAL, "supported");
  render(<App />);
  await waitForPopupReady();
  const settings = screen.getByRole("button", { name: "Settings" });
  expect(settings).toHaveAccessibleDescription(
    "Translating on-device. Add your OpenAI API key in Settings for AI translation.",
  );
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
});

test("the Settings button warns when OpenAI rejected the key", async () => {
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      ((message as { type?: string }).type === "AUTH_STATUS"
        ? {
            authenticated: true,
            backendConfigured: true,
            user: { id: "user-1", email: "free@example.com" },
            entitlement: FREE_NO_TRIAL,
            onDeviceTranslation: "supported",
            engineSource: "on-device",
            providerKeyRejected: true,
          }
        : { pageLanguage: "Japanese", sourceLanguage: "ja" }) as never,
  );
  vi.spyOn(browser.tabs, "query").mockResolvedValue([
    { id: 1, windowId: 10, url: "https://news.yahoo.co.jp/a", active: true },
  ] as never);
  render(<App />);
  await waitForPopupReady();
  expect(
    screen.getByRole("button", { name: "Settings" }),
  ).toHaveAccessibleDescription(
    "OpenAI rejected your API key. Translating on-device; check the key in Settings.",
  );
});
