import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceReaderRequest } from "@/lib/google-workspace-reader";

const adapters = vi.hoisted(() => ({
  native: vi.fn(),
  local: vi.fn(),
  retired: vi.fn(),
  fallback: vi.fn(async () => undefined),
}));
vi.mock("./App.tsx", async () => {
  const React = await import("react");
  return {
    driveOfficeReaderPath: (id: number) =>
      `/reader.html?office=1&sourceTabId=${id}`,
    openReaderTabFallback: adapters.fallback,
    default: function NativeAdapter(props: unknown) {
      adapters.native(props);
      React.useEffect(() => () => adapters.retired(), []);
      return <div>Native adapter</div>;
    },
  };
});
vi.mock("./LocalSpreadsheetReader.tsx", () => ({
  default: (props: unknown) => {
    adapters.local(props);
    return <div>Office adapter</div>;
  },
}));
import { ReaderPage, ReaderRoot } from "./main";

beforeEach(() => {
  window.history.replaceState({}, "", "/reader.html?sourceTabId=7");
  vi.spyOn(browser.runtime, "sendMessage").mockResolvedValue(undefined);
  vi.spyOn(browser.tabs, "getCurrent").mockResolvedValue(undefined);
  vi.spyOn(browser.tabs, "get").mockImplementation(
    async (id) =>
      ({
        id,
        windowId: 10,
        url:
          id === 9
            ? "https://drive.google.com/drive/my-drive"
            : `https://docs.google.com/spreadsheets/d/file_${id}/edit#gid=2`,
      }) as never,
  );
  vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation(
    () => undefined,
  );
  vi.spyOn(browser.runtime.onMessage, "removeListener").mockImplementation(
    () => undefined,
  );
  vi.spyOn(browser.tabs.onActivated, "addListener").mockImplementation(
    () => undefined,
  );
  vi.spyOn(browser.tabs.onActivated, "removeListener").mockImplementation(
    () => undefined,
  );
});
function sourceChange(revision: number) {
  act(() => {
    for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
      .mock.calls)
      (listener as (message: unknown) => void)({
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId: 7,
        version: { backgroundEpoch: "epoch-1", sourceRevision: revision },
      });
  });
}
function context(
  request: WorkspaceReaderRequest,
  fileId: string,
  sourceKind: "native" | "office",
) {
  return {
    ...request,
    ok: true,
    configured: true,
    connected: true,
    context: {
      kind: "sheets",
      sourceTabId: request.sourceTabId,
      fileId,
      activeId: "02",
    },
    version: { backgroundEpoch: "epoch-1", sourceRevision: 2 },
    provider: "google",
    targetLanguage: "vi",
    sourceKind,
    sourceTitle: fileId,
  };
}
test("native to Office transition retires old adapter and waits before value discovery", async () => {
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      context(
        message as unknown as WorkspaceReaderRequest,
        "book.xlsx",
        "office",
      ) as never,
  );
  render(<ReaderRoot />);
  expect(screen.getByText("Native adapter")).toBeInTheDocument();
  sourceChange(2);
  await screen.findByText("Office adapter");
  expect(adapters.retired).toHaveBeenCalled();
  expect(adapters.local).toHaveBeenLastCalledWith(
    expect.objectContaining({
      awaitingStart: true,
      sourceTitle: "book.xlsx",
      source: expect.objectContaining({ sourceTabId: 7 }),
    }),
  );
  expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "WORKSPACE_READER_CONTEXT",
      identifySource: true,
    }),
  );
});
test("latest metadata transition wins and old native result cannot replace Office", async () => {
  const pending: {
    request: WorkspaceReaderRequest;
    resolve: (value: unknown) => void;
  }[] = [];
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    (message) =>
      new Promise((resolve) =>
        pending.push({
          request: message as unknown as WorkspaceReaderRequest,
          resolve,
        }),
      ) as never,
  );
  render(<ReaderRoot />);
  sourceChange(2);
  expect(screen.getByRole("heading", { name: "Readlace" })).toBeInTheDocument();
  const loading = screen.getByRole("region", { name: "Spreadsheet source" });
  expect(loading.parentElement).toHaveClass("reader-results", "sheets-results");
  expect(loading.closest("main")).toHaveAttribute("aria-busy", "true");
  sourceChange(3);
  await act(async () => {
    pending[1]!.resolve(context(pending[1]!.request, "latest.xlsm", "office"));
  });
  await screen.findByText("Office adapter");
  await act(async () => {
    pending[0]!.resolve(context(pending[0]!.request, "old-native", "native"));
  });
  expect(screen.queryByText("Native adapter")).toBeNull();
  expect(adapters.local).toHaveBeenLastCalledWith(
    expect.objectContaining({ sourceTitle: "latest.xlsm" }),
  );
});
test("unsupported activation retires native work and returning does not auto-open", async () => {
  render(<ReaderRoot />);
  await screen.findByText("Native adapter");
  const activate = (tabId: number) =>
    act(() => {
      for (const [listener] of vi.mocked(browser.tabs.onActivated.addListener)
        .mock.calls)
        (listener as (info: { tabId: number }) => void)({ tabId });
    });
  activate(9);
  await waitFor(() => expect(screen.queryByText("Native adapter")).toBeNull());
  expect(adapters.retired).toHaveBeenCalled();
  activate(7);
  await waitFor(() =>
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1),
  );
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "WORKSPACE_READER_CONTEXT",
      identifySource: true,
    }),
  );
  expect(screen.queryByText("Native adapter")).toBeNull();
});
test.each(["office-download-required", "sheets-reader-unavailable"] as const)(
  "same-tab navigation answered with %s remounts the source adapter for download guidance",
  async (error) => {
    vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
      async (message) => {
        const request = message as unknown as WorkspaceReaderRequest;
        return { ...request, ok: false, error } as never;
      },
    );
    render(<ReaderRoot />);
    expect(screen.getByText("Native adapter")).toBeInTheDocument();
    sourceChange(2);
    await waitFor(() => expect(adapters.retired).toHaveBeenCalled());
    await screen.findByText("Native adapter");
    expect(adapters.native).toHaveBeenLastCalledWith(
      expect.objectContaining({ awaitingStart: true }),
    );
    expect(
      screen.queryByText(
        "Open a supported spreadsheet and click the extension icon to continue.",
      ),
    ).toBeNull();
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
  },
);

test("unsupported same-tab navigation discards adapter without reusing native errors", async () => {
  vi.spyOn(browser.runtime, "sendMessage").mockResolvedValue(undefined);
  render(<ReaderRoot />);
  sourceChange(2);
  await screen.findByText(
    "Open a supported spreadsheet and click the extension icon to continue.",
  );
  expect(screen.queryByText("Native adapter")).toBeNull();
  expect(screen.queryByText("Office adapter")).toBeNull();
});

test("trusted explicit toolbar open restores a retired Reader load-only while forged open is ignored", async () => {
  render(<ReaderRoot />);
  act(() => {
    for (const [listener] of vi.mocked(browser.tabs.onActivated.addListener)
      .mock.calls)
      (listener as (info: { tabId: number }) => void)({ tabId: 9 });
  });
  await waitFor(() => expect(screen.queryByText("Native adapter")).toBeNull());
  const emitOpen = (sender: { id?: string; tab?: unknown }) =>
    act(() => {
      for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
        .mock.calls)
        (
          listener as (
            message: unknown,
            sender: { id?: string; tab?: unknown },
          ) => void
        )({ type: "WORKSPACE_READER_OPEN", sourceTabId: 7 }, sender);
    });
  emitOpen({ id: "untrusted" });
  expect(screen.queryByText("Native adapter")).toBeNull();
  emitOpen({ id: browser.runtime.id, tab: { id: 7 } });
  expect(screen.queryByText("Native adapter")).toBeNull();
  emitOpen({ id: browser.runtime.id });
  await screen.findByText("Native adapter");
  expect(adapters.native).toHaveBeenLastCalledWith(
    expect.objectContaining({
      awaitingStart: undefined,
      managedSourceLifecycle: true,
    }),
  );
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
});
test("account changes retire adapter and stale identification", async () => {
  render(<ReaderRoot />);
  act(() => {
    for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
      .mock.calls)
      (listener as (message: unknown) => void)({ type: "AUTH_STATE_CHANGED" });
  });
  expect(screen.queryByText("Native adapter")).toBeNull();
  expect(adapters.retired).toHaveBeenCalled();
});

test("switching to another supported tab keeps the first tab's adapter mounted and hidden", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    async (message) =>
      context(
        message as unknown as WorkspaceReaderRequest,
        `file_${(message as unknown as WorkspaceReaderRequest).sourceTabId}`,
        "native",
      ) as never,
  );
  const { container } = render(<ReaderRoot />);
  const activate = (tabId: number) =>
    act(() => {
      for (const [listener] of vi.mocked(browser.tabs.onActivated.addListener)
        .mock.calls)
        (listener as (info: { tabId: number; windowId: number }) => void)({
          tabId,
          windowId: 10,
        });
    });
  activate(8);
  await waitFor(() =>
    expect(container.querySelectorAll(".reader-pane")).toHaveLength(2),
  );
  const panes = () =>
    [...container.querySelectorAll(".reader-pane")].map((p) =>
      p.getAttribute("data-active"),
    );
  expect(panes()).toEqual(["false", "true"]);
  expect(adapters.retired).not.toHaveBeenCalled();
  for (const [props] of adapters.native.mock.calls)
    expect(props).not.toHaveProperty("onRequestWorksheet");
  expect(window.location.pathname).toBe("/reader.html");
  expect(window.location.search).toBe("");
  // Returning to tab 7 only reveals its pane: no remount, no identification.
  const sends = vi.mocked(browser.runtime.sendMessage).mock.calls.length;
  activate(7);
  await waitFor(() => expect(panes()).toEqual(["true", "false"]));
  expect(adapters.retired).not.toHaveBeenCalled();
  expect(vi.mocked(browser.runtime.sendMessage).mock.calls.length).toBe(sends);
  expect(window.location.search).toBe("");
});
test("closing a background tab unmounts only its pane", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    async (message) =>
      context(
        message as unknown as WorkspaceReaderRequest,
        "other",
        "native",
      ) as never,
  );
  const removed = vi
    .spyOn(browser.tabs.onRemoved, "addListener")
    .mockImplementation(() => undefined);
  const { container } = render(<ReaderRoot />);
  act(() => {
    for (const [listener] of vi.mocked(browser.tabs.onActivated.addListener)
      .mock.calls)
      (listener as (info: { tabId: number; windowId: number }) => void)({
        tabId: 8,
        windowId: 10,
      });
  });
  await waitFor(() =>
    expect(container.querySelectorAll(".reader-pane")).toHaveLength(2),
  );
  act(() => {
    for (const [listener] of removed.mock.calls)
      (listener as (tabId: number) => void)(7);
  });
  expect(container.querySelectorAll(".reader-pane")).toHaveLength(1);
  expect(adapters.retired).toHaveBeenCalledTimes(1);
});
test("different supported tab identifies metadata only before Translate", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    async (message) =>
      context(
        message as unknown as WorkspaceReaderRequest,
        "new-native",
        "native",
      ) as never,
  );
  render(<ReaderRoot />);
  act(() => {
    for (const [listener] of vi.mocked(browser.tabs.onActivated.addListener)
      .mock.calls)
      (listener as (info: { tabId: number; windowId: number }) => void)({
        tabId: 8,
        windowId: 10,
      });
  });
  await waitFor(() =>
    expect(adapters.native).toHaveBeenLastCalledWith(
      expect.objectContaining({
        awaitingStart: true,
        sourceTitle: "new-native",
      }),
    ),
  );
  expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "WORKSPACE_READER_CONTEXT",
      sourceTabId: 8,
      identifySource: true,
    }),
  );
});
test("global OPEN cannot rebind another window, including unresolved initial window lookup", async () => {
  let resolveInitial!: (value: unknown) => void;
  const initial = new Promise((resolve) => {
    resolveInitial = resolve;
  });
  vi.mocked(browser.tabs.get).mockImplementation((id) =>
    id === 7
      ? (initial as never)
      : (Promise.resolve({
          id,
          windowId: 20,
          url: "https://docs.google.com/spreadsheets/d/foreign/edit",
        }) as never),
  );
  render(<ReaderRoot />);
  const emit = () =>
    act(() => {
      for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
        .mock.calls)
        (listener as (message: unknown, sender: { id?: string }) => void)(
          { type: "WORKSPACE_READER_OPEN", sourceTabId: 8, sourceWindowId: 20 },
          { id: browser.runtime.id },
        );
    });
  emit();
  await act(async () => {
    resolveInitial({ id: 7, windowId: 10 });
  });
  expect(adapters.native).toHaveBeenCalledTimes(1);
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  expect(window.location.search).toBe("?sourceTabId=7");
});
test("fallback Reader tab ignores global toolbar opens and other source tab activation", async () => {
  vi.mocked(browser.tabs.getCurrent).mockResolvedValue({
    id: 90,
    windowId: 10,
  } as never);
  render(<ReaderRoot />);
  await act(async () => {
    for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
      .mock.calls)
      (listener as (message: unknown, sender: { id?: string }) => void)(
        { type: "WORKSPACE_READER_OPEN", sourceTabId: 8, sourceWindowId: 10 },
        { id: browser.runtime.id },
      );
    for (const [listener] of vi.mocked(browser.tabs.onActivated.addListener)
      .mock.calls)
      (listener as (info: { tabId: number; windowId: number }) => void)({
        tabId: 8,
        windowId: 10,
      });
  });
  expect(adapters.native).toHaveBeenCalledTimes(1);
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
});
test("managed Office transition cannot call a stale source exit over pending classification", async () => {
  const pending: {
    request: WorkspaceReaderRequest;
    resolve: (value: unknown) => void;
  }[] = [];
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    (message) =>
      new Promise((resolve) =>
        pending.push({
          request: message as unknown as WorkspaceReaderRequest,
          resolve,
        }),
      ) as never,
  );
  render(<ReaderRoot />);
  sourceChange(2);
  await act(async () => {
    pending[0]!.resolve(context(pending[0]!.request, "first.xlsx", "office"));
  });
  await screen.findByText("Office adapter");
  const office = adapters.local.mock.lastCall![0] as {
    managedSourceLifecycle: boolean;
    onExitDriveOffice: () => void;
  };
  expect(office.managedSourceLifecycle).toBe(true);
  sourceChange(3);
  await screen.findByText(/Identifying spreadsheet/);
  act(() => office.onExitDriveOffice());
  expect(screen.queryByText("Native adapter")).toBeNull();
  await act(async () => {
    pending[1]!.resolve(
      context(pending[1]!.request, "latest-native", "native"),
    );
  });
  await screen.findByText("Native adapter");
  expect(adapters.native).toHaveBeenLastCalledWith(
    expect.objectContaining({
      awaitingStart: true,
      sourceTitle: "latest-native",
    }),
  );
});

test("an already observed initial source notification preserves first-icon load-only startup while a fresh file revision awaits Translate", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(
    async (message) =>
      context(
        message as unknown as WorkspaceReaderRequest,
        "new-file",
        "native",
      ) as never,
  );
  render(<ReaderRoot />);
  const initial = adapters.native.mock.lastCall![0] as {
    onSourceIdentified: (
      context: {
        kind: "sheets";
        sourceTabId: number;
        fileId: string;
        activeId: string;
      },
      version: { backgroundEpoch: string; sourceRevision: number },
    ) => void;
  };
  act(() =>
    initial.onSourceIdentified(
      { kind: "sheets", sourceTabId: 7, fileId: "initial-file", activeId: "2" },
      { backgroundEpoch: "epoch-1", sourceRevision: 1 },
    ),
  );
  sourceChange(1);
  expect(adapters.native).toHaveBeenCalledTimes(1);
  expect(adapters.retired).not.toHaveBeenCalled();
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  sourceChange(2);
  await waitFor(() =>
    expect(adapters.native).toHaveBeenLastCalledWith(
      expect.objectContaining({ awaitingStart: true, sourceTitle: "new-file" }),
    ),
  );
  expect(adapters.retired).toHaveBeenCalled();
  expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
});

test("initial native identification transfers Office metadata title without a stale Root title", async () => {
  render(<ReaderRoot />);
  const initial = adapters.native.mock.lastCall![0] as {
    onOpenDriveOfficeSpreadsheet: (source: {
      sourceTabId: number;
      version: { backgroundEpoch: string; sourceRevision: number };
      sourceTitle: string;
    }) => void;
  };
  act(() =>
    initial.onOpenDriveOfficeSpreadsheet({
      sourceTabId: 7,
      version: { backgroundEpoch: "epoch-1", sourceRevision: 1 },
      sourceTitle: "Issues.xlsx",
    }),
  );
  await screen.findByText("Office adapter");
  expect(adapters.local).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sourceTitle: "Issues.xlsx",
      source: expect.objectContaining({ sourceTitle: "Issues.xlsx" }),
    }),
  );
});

test("source-bound fallback bootstrap preserves metadata-only awaiting-start", () => {
  window.history.replaceState(
    {},
    "",
    "/reader.html?sourceTabId=7&awaitStart=1&readerSheetId=30003",
  );
  render(<ReaderRoot />);
  expect(adapters.native).toHaveBeenLastCalledWith(
    expect.objectContaining({ awaitingStart: true, desiredSheetId: "30003" }),
  );
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
});

test("Root channel capability failure offers user-only awaiting-start Reader-tab fallback", async () => {
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) => {
    const request = message as unknown as WorkspaceReaderRequest;
    return {
      type: request.type,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      ok: false,
      error: "reader-channel-unavailable",
    } as never;
  });
  render(<ReaderRoot />);
  sourceChange(2);
  const button = await screen.findByRole("button", {
    name: "Open Reader in a tab",
  });
  expect(adapters.fallback).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(adapters.fallback).toHaveBeenCalledWith(
    7,
    true,
    undefined,
    expect.any(Function),
  );
  expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
});

function restartNotice(epoch = "epoch-2") {
  act(() => {
    for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
      .mock.calls)
      (listener as (message: unknown) => void)({
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId: 7,
        version: { backgroundEpoch: epoch, sourceRevision: 0 },
      });
  });
}

test("a restart-time notice for the same file verifies silently and keeps the adapter", async () => {
  let file = "same.xlsx";
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      context(
        message as unknown as WorkspaceReaderRequest,
        file,
        "native",
      ) as never,
  );
  render(<ReaderRoot />);
  sourceChange(2);
  await screen.findByText("Native adapter");
  adapters.retired.mockClear();
  restartNotice();
  await waitFor(() =>
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2),
  );
  await act(async () => undefined);
  expect(screen.getByText("Native adapter")).toBeInTheDocument();
  expect(adapters.retired).not.toHaveBeenCalled();
  // A different file after the restart replaces the stale one.
  file = "other.xlsx";
  restartNotice("epoch-3");
  await waitFor(() => expect(adapters.retired).toHaveBeenCalled());
});

test("Reader page follows the UI locale for its shell, title and html lang", async () => {
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      ((message as { type?: string }).type === "UI_LOCALE_GET"
        ? { locale: "vi", stored: "vi" }
        : undefined) as never,
  );
  const emit = (message: unknown) =>
    act(() => {
      for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener)
        .mock.calls)
        (listener as (message: unknown, sender: { id?: string }) => void)(
          message,
          { id: browser.runtime.id },
        );
    });
  render(<ReaderPage />);
  emit({
    type: "WORKSPACE_READER_SOURCE_CHANGED",
    sourceTabId: 7,
    version: { backgroundEpoch: "epoch-1", sourceRevision: 2 },
  });
  expect(
    await screen.findByText(
      "Hãy mở một bảng tính được hỗ trợ rồi bấm biểu tượng tiện ích để tiếp tục.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Trình đọc bảng tính")).toBeInTheDocument();
  expect(screen.getByText("Chưa tải")).toBeInTheDocument();
  expect(document.title).toBe("Readlace – Trình đọc");
  expect(document.documentElement.lang).toBe("vi");
  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
    type: "UI_LOCALE_GET",
  });

  emit({ type: "UI_LOCALE_CHANGED", locale: "en" });
  expect(
    screen.getByText(
      "Open a supported spreadsheet and click the extension icon to continue.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("Spreadsheet Reader")).toBeInTheDocument();
  expect(document.title).toBe("Readlace Reader");
  expect(document.documentElement.lang).toBe("en");
});
