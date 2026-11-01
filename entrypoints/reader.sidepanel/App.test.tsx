import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";

import type {
  WorkspaceEditorContext,
  WorkspaceReaderRequest,
  WorkspaceReaderResponse,
  WorkspaceRecord,
  WorkspaceSheetCell,
  WorkspaceSheetGrid,
  WorkspaceSheetPage,
} from "@/lib/google-workspace-reader";
import { defaultWorkspaceSheetCellStyle } from "@/lib/google-workspace-reader";
import App, {
  displayedSheetTranslations,
  driveOfficeReaderPath,
  openReaderTabFallback,
} from "./App";
import {
  readReaderPreferences,
  saveReaderPreferences,
} from "@/lib/reader-preferences";
vi.mock("@/lib/reader-preferences", () => ({
  readReaderPreferences: vi.fn(async () => ({
    targetLanguage: "vi",
  })),
  saveReaderPreferences: vi.fn(async () => undefined),
}));
// Product events (ADR 0017) use their own channel; keep them out of the
// Reader's sendMessage protocol assertions.
import SheetsGrid from "./SheetsGrid";
import { readerMessages } from "@/lib/i18n/catalog/reader";
import { UiLocaleScope } from "@/lib/i18n/react";
import {
  readerIntentKey,
  type WorkspaceReaderIntent,
} from "@/lib/workspace-reader-intent";

const sheetsContext: WorkspaceEditorContext = {
  kind: "sheets",
  sourceTabId: 7,
  fileId: "sheet-1",
  activeId: "42",
};
const docsContext: WorkspaceEditorContext = {
  kind: "docs",
  sourceTabId: 7,
  fileId: "doc-1",
  activeId: "tab-1",
};
const sourceVersion = { backgroundEpoch: "epoch-1", sourceRevision: 1 };

function record(
  id: string,
  anchor: string,
  source: string,
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    id,
    anchor,
    source,
    display: source,
    kind: "text",
    translatable: true,
    sourceHash: `hash-${id}`,
    ...overrides,
  };
}

const sheetCellStyle: WorkspaceSheetCell["style"] = {
  ...defaultWorkspaceSheetCellStyle(),
  vertical: "top",
  wrapStrategy: "wrap",
};

function sheetCell(
  rowIndex: number,
  columnIndex: number,
  source: string,
  overrides: Partial<WorkspaceSheetCell> = {},
): WorkspaceSheetCell {
  let column = columnIndex + 1;
  let columnLabel = "";
  while (column > 0) {
    column -= 1;
    columnLabel = String.fromCharCode(65 + (column % 26)) + columnLabel;
    column = Math.floor(column / 26);
  }
  const anchor = `${columnLabel}${rowIndex + 1}`;
  return {
    ...record(anchor.toLowerCase(), anchor, source),
    rowIndex,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    style: sheetCellStyle,
    ...overrides,
  };
}

function sheetFixture() {
  const cells = [
    sheetCell(0, 0, "Source\nline"),
    sheetCell(0, 2, "Merged", { columnSpan: 2 }),
    sheetCell(0, 5, "Far value"),
    sheetCell(0, 25, "Z value"),
    sheetCell(0, 26, "AA value"),
  ];
  const grid: WorkspaceSheetGrid = {
    sheetId: "42",
    title: "Quarterly plan",
    generation: 3,
    rowCount: 1,
    lastUsedColumn: 26,
    columns: Array.from({ length: 27 }, (_, index) => ({
      index,
      pixelSize: index === 0 ? 20 : index === 3 ? 900 : 100,
      hidden: index === 1,
    })),
    frozenRowCount: 1,
    frozenColumnCount: 1,
    rightToLeft: true,
    hideGridlines: false,
    merges: [{ startRow: 0, endRow: 1, startColumn: 2, endColumn: 4 }],
    defaultStyle: defaultWorkspaceSheetCellStyle(),
    defaultRowPixelSize: 21,
    defaultColumnPixelSize: 100,
  };
  const page: WorkspaceSheetPage = {
    sheetId: "42",
    generation: 3,
    startRow: 0,
    rowCount: 1,
    rows: [{ index: 0, pixelSize: 10, hidden: false, cells }],
    cursor: null,
  };
  return { grid, page, cells };
}

function contextResponse(
  request: WorkspaceReaderRequest,
  overrides: Partial<
    Extract<
      WorkspaceReaderResponse,
      { type: "WORKSPACE_READER_CONTEXT"; ok: true }
    >
  > = {},
) {
  return {
    type: "WORKSPACE_READER_CONTEXT",
    ok: true,
    configured: true,
    connected: true,
    context: sheetsContext,
    targetLanguage: "en",
    ...overrides,
    readerInstanceId: request.readerInstanceId,
    requestId: request.requestId,
    version:
      "version" in request
        ? request.version
        : (overrides.version ?? sourceVersion),
  } satisfies WorkspaceReaderResponse;
}

function loadResponse(
  request: WorkspaceReaderRequest,
  records: WorkspaceRecord[],
  overrides: Partial<
    Extract<WorkspaceReaderResponse, { type: "WORKSPACE_READER_LOAD" }>
  > = {},
) {
  return {
    type: "WORKSPACE_READER_LOAD",
    ok: true,
    generation: 3,
    context: sheetsContext,
    title: "Quarterly plan",
    records,
    cursor: null,
    ...overrides,
    readerInstanceId: request.readerInstanceId,
    requestId: request.requestId,
    version: "version" in request ? request.version : sourceVersion,
  } satisfies WorkspaceReaderResponse;
}

function mockRuntime(handler: (request: WorkspaceReaderRequest) => unknown) {
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation((async (
    request: WorkspaceReaderRequest,
  ) => {
    const response = await handler(request);
    if (!isReaderRequestType(request.type)) return response;
    const raw = response as Record<string, unknown>;
    const value =
      request.type === "WORKSPACE_READER_DISCOVER" &&
      raw.ok === true &&
      !("sheets" in raw)
        ? {
            ...raw,
            sheets: [{ sheetId: "42", title: "Quarterly plan", index: 0 }],
          }
        : raw;
    const protocol = {
      ...value,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
    };
    if (request.type === "WORKSPACE_READER_CONTEXT" && value.ok === false)
      return protocol;
    return {
      ...protocol,
      version: "version" in request ? request.version : sourceVersion,
    };
  }) as never);
}

function isReaderRequestType(
  value: unknown,
): value is WorkspaceReaderRequest["type"] {
  switch (value) {
    case "WORKSPACE_READER_CONTEXT":
    case "WORKSPACE_READER_CONNECT":
    case "WORKSPACE_READER_DISCONNECT":
    case "WORKSPACE_READER_SELECT_SHEET":
    case "WORKSPACE_READER_DISCOVER":
    case "WORKSPACE_READER_LOAD":
    case "WORKSPACE_READER_TRANSLATE":
      return true;
    default:
      return false;
  }
}

function capturedReaderRequest(value: unknown): WorkspaceReaderRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    !isReaderRequestType(candidate.type) ||
    typeof candidate.requestId !== "number" ||
    typeof candidate.sourceTabId !== "number"
  ) {
    return null;
  }
  return candidate as unknown as WorkspaceReaderRequest;
}

function readerRequests(type: WorkspaceReaderRequest["type"]) {
  const requests: WorkspaceReaderRequest[] = [];
  for (const [message] of vi.mocked(browser.runtime.sendMessage).mock.calls) {
    const request = capturedReaderRequest(message);
    if (request?.type === type) requests.push(request);
  }
  return requests;
}

function emitRuntimeMessage(message: unknown) {
  for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener).mock
    .calls) {
    (listener as (message: unknown) => void)(message);
  }
}

function translateRequest(
  request: WorkspaceReaderRequest,
): Extract<WorkspaceReaderRequest, { type: "WORKSPACE_READER_TRANSLATE" }> {
  if (request.type !== "WORKSPACE_READER_TRANSLATE") {
    throw new Error(`Unexpected ${request.type} request`);
  }
  return request;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let permissionRequest: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, "", "/reader.html");
  // ADR 0015: Connect requests the optional Google permissions first.
  permissionRequest = vi.fn(async () => true);
  Object.defineProperty(browser, "permissions", {
    configurable: true,
    value: { request: permissionRequest },
  });
  vi.mocked(readReaderPreferences).mockResolvedValue({
    targetLanguage: "vi",
  });
  vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation(
    () => undefined,
  );
  vi.spyOn(browser.runtime.onMessage, "removeListener").mockImplementation(
    () => undefined,
  );
  vi.spyOn(browser.tabs, "query").mockResolvedValue([
    {
      id: 7,
      active: true,
      url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
    },
  ] as never);
});

test("continues an initially paused discovery with its returned cursor only after clicking Continue", async () => {
  const { grid, page, cells } = sheetFixture();
  const discoveryCursor = {
    kind: "sheets-discovery" as const,
    token: "resume-initial-discovery",
  };
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER") {
      if (request.cursor === null)
        return {
          type: request.type,
          requestId: request.requestId,
          ok: false,
          error: "temporarily-unavailable",
          discoveryCursor,
        };
      expect(request.cursor).toEqual(discoveryCursor);
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        progress: { status: "complete", grid },
      };
    }
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, cells, { page });
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App />);
  const continueButton = await screen.findByRole("button", {
    name: "Continue discovery",
  });
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(0);
  await userEvent.click(continueButton);
  await screen.findByRole("grid");
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(2);
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("reports row discovery and skips empty viewport translation", async () => {
  const columnsCursor = {
    kind: "sheets-discovery" as const,
    token: "columns-progress",
  };
  const rowsCursor = {
    kind: "sheets-discovery" as const,
    token: "rows-progress",
  };
  const columns = deferred<unknown>();
  const rows = deferred<unknown>();
  const pause = deferred<unknown>();
  const resume = deferred<unknown>();
  const numeric = sheetCell(0, 0, "1", {
    kind: "number",
    translatable: false,
  });
  const text = sheetCell(2, 0, "Outside the viewport");
  const grid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    rowCount: 3,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    merges: [],
  };
  const page: WorkspaceSheetPage = {
    sheetId: "42",
    generation: 3,
    startRow: 0,
    rowCount: 3,
    rows: [
      { index: 0, pixelSize: 21, hidden: false, cells: [numeric] },
      { index: 1, pixelSize: 21, hidden: false, cells: [] },
      { index: 2, pixelSize: 21, hidden: false, cells: [text] },
    ],
    cursor: null,
  };
  let discoveryRequest = 0;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER") {
      discoveryRequest += 1;
      if (discoveryRequest === 1) return columns.promise;
      if (discoveryRequest === 2) return rows.promise;
      if (discoveryRequest === 3) return pause.promise;
      expect(request.cursor).toEqual(rowsCursor);
      return resume.promise;
    }
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, [numeric, text], { page });
    if (request.type === "WORKSPACE_READER_TRANSLATE")
      throw new Error("Empty viewport must not reach the provider");
    throw new Error(`Unexpected ${request.type}`);
  });
  const { container } = render(<App />);

  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1),
  );
  columns.resolve({
    type: "WORKSPACE_READER_DISCOVER",
    ok: true,
    progress: {
      status: "scanning",
      axis: "columns",
      scanned: 32,
      total: 64,
      cursor: columnsCursor,
    },
  });
  await waitFor(() => expect(discoveryRequest).toBe(2));
  expect(screen.getByText("Discovering worksheet…")).toBeInTheDocument();
  expect(screen.queryByText("Discovering columns 32/64…")).toBeNull();

  rows.resolve({
    type: "WORKSPACE_READER_DISCOVER",
    ok: true,
    progress: {
      status: "scanning",
      axis: "rows",
      scanned: 100,
      total: 300,
      cursor: rowsCursor,
    },
  });
  await waitFor(() => expect(discoveryRequest).toBe(3));
  expect(screen.getByText("Discovering worksheet…")).toBeInTheDocument();
  expect(screen.queryByText("Discovering rows 100/300…")).toBeNull();

  pause.resolve({
    type: "WORKSPACE_READER_DISCOVER",
    ok: false,
    error: "temporarily-unavailable",
    discoveryCursor: rowsCursor,
  });
  const continueButton = await screen.findByRole("button", {
    name: "Continue discovery",
  });
  await userEvent.click(continueButton);
  await waitFor(() => expect(discoveryRequest).toBe(4));
  expect(screen.getByText("Discovering worksheet…")).toBeInTheDocument();

  resume.resolve({
    type: "WORKSPACE_READER_DISCOVER",
    ok: true,
    progress: { status: "complete", grid },
  });
  await screen.findByRole("grid", { name: "Quarterly plan sheet" });

  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  const rectangle = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) satisfies DOMRect;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 42 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle(100, 42),
    },
  });
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-sheet-row-index]",
  )) {
    const index = Number(row.dataset.sheetRowIndex);
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => rectangle(-1_000 - index * 21, 21),
    });
  }
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));

  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("retires a paused cursor after the source changes and Refresh starts fresh", async () => {
  const discoveryCursor = {
    kind: "sheets-discovery" as const,
    token: "retired-discovery",
  };
  const cursors: unknown[] = [];
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER") {
      cursors.push(request.cursor);
      return request.cursor === null
        ? {
            type: request.type,
            requestId: request.requestId,
            ok: false,
            error: "temporarily-unavailable",
            discoveryCursor,
          }
        : {
            type: request.type,
            requestId: request.requestId,
            ok: false,
            error: "source-tab-changed",
          };
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue discovery" }),
  );
  await screen.findByText(
    "The source tab changed. Refresh Reader to continue.",
  );
  expect(
    screen.queryByRole("button", { name: "Continue discovery" }),
  ).not.toBeInTheDocument();
  expect(cursors).toEqual([null, discoveryCursor]);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: "Continue discovery" });
  expect(cursors).toEqual([null, discoveryCursor, null]);
});

test("actual file change clears data and waits for Translate with zero values/provider discovery", async () => {
  let fileId = "sheet-1";
  let activeId = "42";
  const { grid, page, cells } = sheetFixture();
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, {
        context: { ...sheetsContext, fileId, activeId },
        sourceTitle: fileId,
      });
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        ok: true,
        progress: { status: "complete", grid },
      };
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, cells, { page });
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App />);
  await screen.findByRole("grid");
  activeId = "02";
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1);
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toHaveTextContent(
    "Quarterly plan",
  );
  fileId = "new-file";
  emitRuntimeMessage({
    type: "WORKSPACE_READER_SOURCE_CHANGED",
    sourceTabId: 7,
    version: { backgroundEpoch: "epoch-1", sourceRevision: 2 },
  });
  await screen.findByText(
    "Click Translate to discover and translate this file.",
  );
  expect(screen.queryByRole("grid")).toBeNull();
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Vietnamese");
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
});

test("selects native worksheets in catalog order and continues only an active Reader session", async () => {
  const sheets = [
    { sheetId: "42", title: "First worksheet", index: 0 },
    { sheetId: "43", title: "Second worksheet", index: 1 },
  ];
  let selectedSheetId = "42";
  const selectedGeneration = () => (selectedSheetId === "42" ? 3 : 4);
  const selectedContext = () => ({
    ...sheetsContext,
    activeId: selectedSheetId,
  });
  const selectedGrid = (): WorkspaceSheetGrid => ({
    ...sheetFixture().grid,
    sheetId: selectedSheetId,
    title: sheets.find(({ sheetId }) => sheetId === selectedSheetId)!.title,
    generation: selectedGeneration(),
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    rightToLeft: false,
    merges: [],
  });
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: selectedContext() });
    if (request.type === "WORKSPACE_READER_SELECT_SHEET") {
      selectedSheetId = request.sheetId;
      return {
        type: request.type,
        ok: true,
        context: selectedContext(),
        sheets,
      };
    }
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        ok: true,
        sheets,
        progress: { status: "complete", grid: selectedGrid() },
      };
    if (request.type === "WORKSPACE_READER_LOAD") {
      const cell = sheetCell(0, 0, `Source ${selectedSheetId}`);
      const page: WorkspaceSheetPage = {
        sheetId: selectedSheetId,
        generation: selectedGeneration(),
        startRow: 0,
        rowCount: 1,
        rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [cell] }],
        cursor: null,
      };
      return loadResponse(request, [cell], {
        context: selectedContext(),
        title: selectedGrid().title,
        generation: selectedGeneration(),
        page,
      });
    }
    if (request.type === "WORKSPACE_READER_TRANSLATE")
      return {
        type: request.type,
        ok: true,
        generation: selectedGeneration(),
        results: request.records.map(({ id, sourceHash }) => ({
          id,
          sourceHash,
          text: `Translated ${selectedSheetId}`,
        })),
      };
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App />);

  await screen.findByRole("gridcell", { name: "A1: Source 42" });
  await user.click(screen.getByRole("combobox", { name: "Worksheet" }));
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "First worksheet",
    "Second worksheet",
  ]);
  await user.click(screen.getByRole("option", { name: "Second worksheet" }));
  await screen.findByRole("gridcell", { name: "A1: Source 43" });
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "Translate" }));
  await screen.findByRole("gridcell", { name: "A1: Translated 43" });
  expect(document.querySelector(".reader-status")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(
    "1 translation completed.",
  );
  const activePrimary = screen.getByRole("button", { name: "Translation on" });
  expect(activePrimary).toBeDisabled();
  await user.click(activePrimary);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(1);

  await user.click(screen.getByRole("combobox", { name: "Worksheet" }));
  await user.click(
    await screen.findByRole("option", { name: "First worksheet" }),
  );
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(2),
  );
  await screen.findByRole("gridcell", { name: "A1: Translated 42" });
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(2);

  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(
    screen.getByRole("button", { name: "Resume translation" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("keeps stable native action states and Stop discards an in-flight result", async () => {
  const cell = sheetCell(0, 0, "Original");
  const grid = {
    ...sheetFixture().grid,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    rightToLeft: false,
    merges: [],
  };
  const page = {
    ...sheetFixture().page,
    rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [cell] }],
  };
  const translation = deferred<unknown>();
  mockRuntime((message) => {
    if (message.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(message);
    if (message.type === "WORKSPACE_READER_TRANSLATE") {
      return translation.promise;
    }
    if (message.type === "WORKSPACE_READER_DISCONNECT")
      return { type: message.type, ok: true, connected: false };
    throw new Error(`Unexpected ${message.type}`);
  });
  const user = userEvent.setup();
  render(<App sheetMock={{ grid, pages: [page] }} />);

  await screen.findByRole("gridcell", { name: "A1: Original" });
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Translation" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Translate" }));
  expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Disconnect Google" }),
  ).toBeEnabled();

  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(
    screen.getByRole("button", { name: "Resume translation" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  const request = translateRequest(
    readerRequests("WORKSPACE_READER_TRANSLATE")[0]!,
  );
  translation.resolve({
    type: "WORKSPACE_READER_TRANSLATE",
    ok: true,
    requestId: request.requestId,
    generation: 3,
    results: [
      {
        id: cell.id,
        sourceHash: cell.sourceHash,
        text: "Late translation",
      },
    ],
  });
  await waitFor(() =>
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false"),
  );
  expect(screen.queryByText("Late translation")).toBeNull();
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Disconnect Google" }));
  expect(
    await screen.findByRole("button", { name: "Connect Google Workspace" }),
  ).toBeEnabled();
});

test("native partial continues new visible cells, retries failures and preserves accepted cells", async () => {
  const cells = [
    sheetCell(0, 0, "First source"),
    sheetCell(1, 0, "New visible source"),
    sheetCell(2, 0, "Third source"),
  ];
  const grid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    rowCount: 3,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    merges: [],
  };
  const page: WorkspaceSheetPage = {
    sheetId: "42",
    generation: 3,
    startRow: 0,
    rowCount: 3,
    rows: cells.map((cell, index) => ({
      index,
      pixelSize: 21,
      hidden: false,
      cells: [cell],
    })),
    cursor: null,
  };
  let translationCall = 0;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_TRANSLATE") {
      translationCall += 1;
      return {
        type: request.type,
        ok: true,
        generation: 3,
        results: request.records.map(({ id, sourceHash }) =>
          translationCall === 1
            ? { id, sourceHash, error: "unresolved" as const }
            : { id, sourceHash, text: "Resolved translation" },
        ),
      };
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  const { container } = render(<App sheetMock={{ grid, pages: [page] }} />);
  await screen.findByRole("gridcell", { name: "A1: First source" });
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  const rectangle = (top: number) =>
    ({
      top,
      bottom: top + 21,
      left: 0,
      right: 100,
      width: 100,
      height: 21,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) satisfies DOMRect;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 21 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle(100),
    },
  });
  let visibleRow = 0;
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-sheet-row-index]",
  )) {
    const index = Number(row.dataset.sheetRowIndex);
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => rectangle(index === visibleRow ? 100 : -1_000 - index * 21),
    });
  }
  fireEvent.scroll(viewport);
  await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Translate" }));
  expect(
    await screen.findByRole("button", { name: "Retry unresolved" }),
  ).toBeEnabled();
  expect(
    translateRequest(readerRequests("WORKSPACE_READER_TRANSLATE")[0]!),
  ).toMatchObject({
    records: [{ id: "a1" }],
  });

  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  visibleRow = 1;
  viewport.scrollTop = 21;
  fireEvent.scroll(viewport);
  await screen.findByRole("gridcell", { name: "A2: Resolved translation" });
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(2);
  expect(
    translateRequest(readerRequests("WORKSPACE_READER_TRANSLATE")[1]!),
  ).toMatchObject({ records: [{ id: "a2" }] });
  expect(
    screen.getByRole("button", { name: "Retry unresolved" }),
  ).toBeDisabled();

  visibleRow = 0;
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Retry unresolved" }),
    ).toBeEnabled(),
  );
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Retry unresolved" }));
  await screen.findByRole("gridcell", { name: "A1: Resolved translation" });
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(3);
  expect(
    translateRequest(readerRequests("WORKSPACE_READER_TRANSLATE")[2]!),
  ).toMatchObject({ records: [{ id: "a1" }] });
  visibleRow = 1;
  viewport.scrollTop = 21;
  fireEvent.scroll(viewport);
  await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(3);
  visibleRow = 2;
  // Explicitly retire the watcher before another cell becomes eligible.
  await user.click(screen.getByRole("button", { name: "Stop" }));
  viewport.scrollTop = 42;
  fireEvent.scroll(viewport);
  await act(() => new Promise((resolve) => window.setTimeout(resolve, 20)));
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(3);
  expect(
    screen.getByRole("gridcell", { name: "A3: Third source" }),
  ).toBeInTheDocument();
});

test("keeps oversized-only native partial disabled without provider work", async () => {
  const oversizedCell = sheetCell(0, 0, "a".repeat(4_001));
  const grid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    rightToLeft: false,
    merges: [],
  };
  const page: WorkspaceSheetPage = {
    ...sheetFixture().page,
    rows: [
      {
        index: 0,
        pixelSize: 21,
        hidden: false,
        cells: [oversizedCell],
      },
    ],
  };
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    throw new Error(`Provider work is forbidden for ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App sheetMock={{ grid, pages: [page] }} />);

  await screen.findByRole("gridcell", { name: /^A1:/ });
  await user.click(screen.getByRole("button", { name: "Translate" }));
  const retry = await screen.findByRole("button", { name: "Retry unresolved" });
  expect(retry).toBeDisabled();
  expect(screen.getByText("0 translated; 1 unresolved.")).toBeInTheDocument();
  await user.click(retry);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("settles a correlated native channel error without a source version", async () => {
  const { grid, page } = sheetFixture();
  mockRuntime((request) => contextResponse(request));
  const original = vi
    .mocked(browser.runtime.sendMessage)
    .getMockImplementation()!;
  vi.mocked(browser.runtime.sendMessage).mockImplementation((async (
    message: unknown,
  ) => {
    const request = capturedReaderRequest(message);
    if (request?.type === "WORKSPACE_READER_TRANSLATE")
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        ok: false,
        error: "reader-channel-unavailable",
        version: undefined,
      };
    return (original as (message: unknown) => unknown)(message);
  }) as never);
  render(<App sheetMock={{ grid, pages: [page] }} />);
  await screen.findByRole("grid");
  await userEvent.click(screen.getByRole("button", { name: /^Translate$/ }));
  await screen.findByText(/Reader cannot verify/);
  expect(screen.getByRole("grid")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Translating…" })).toBeNull();
});
test("keeps global Disconnect available while context refresh is pending", async () => {
  const { grid, page } = sheetFixture();
  const pendingContext = deferred<unknown>();
  let contextCalls = 0;
  let refreshRequest: WorkspaceReaderRequest | undefined;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT") {
      contextCalls += 1;
      if (contextCalls === 1) return contextResponse(request);
      refreshRequest = request;
      return pendingContext.promise;
    }
    if (request.type === "WORKSPACE_READER_DISCONNECT")
      return { type: request.type, ok: true, connected: false };
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App sheetMock={{ grid, pages: [page] }} />);
  await screen.findByRole("grid", { name: "Quarterly plan sheet" });

  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(refreshRequest).toBeDefined());
  const disconnect = screen.getByRole("button", { name: "Disconnect Google" });
  expect(disconnect).toBeEnabled();
  await user.click(disconnect);
  expect(
    await screen.findByRole("button", { name: "Connect Google Workspace" }),
  ).toBeEnabled();

  pendingContext.resolve(contextResponse(refreshRequest!));
  await act(() => Promise.resolve());
  expect(
    screen.getByRole("button", { name: "Connect Google Workspace" }),
  ).toBeEnabled();
  expect(readerRequests("WORKSPACE_READER_DISCONNECT")).toHaveLength(1);
});

test("does not drain a queued source rebuild after unmount", async () => {
  const pendingContext = deferred<unknown>();
  let contextRequest: WorkspaceReaderRequest | undefined;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT") {
      contextRequest = request;
      return pendingContext.promise;
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  const view = render(<App />);
  await waitFor(() => expect(contextRequest).toBeDefined());
  emitRuntimeMessage({
    type: "WORKSPACE_READER_SOURCE_CHANGED",
    sourceTabId: 7,
    version: { backgroundEpoch: "epoch-2", sourceRevision: 2 },
  });
  view.unmount();
  pendingContext.resolve(contextResponse(contextRequest!));
  await Promise.resolve();
  await Promise.resolve();
  expect(readerRequests("WORKSPACE_READER_CONTEXT")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test.each([false, true])(
  "a popup click auto-translates after discovery with popup settings (already open: %s)",
  async (alreadyOpen) => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_key: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.spyOn(browser.tabs, "get").mockResolvedValue({
      id: 7,
      url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
    } as never);
    const cell = sheetCell(0, 0, "Original");
    const grid = {
      ...sheetFixture().grid,
      lastUsedColumn: 0,
      columns: [{ index: 0, pixelSize: 100, hidden: false }],
      rightToLeft: false,
      merges: [],
    };
    const page = {
      ...sheetFixture().page,
      rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [cell] }],
    };
    const discovery = deferred<unknown>();
    let discoveryRequest: WorkspaceReaderRequest | undefined;
    mockRuntime((request) => {
      if ((request.type as string) === "AUTH_STATUS")
        return {
          authenticated: true,
          user: { email: "reader@example.com" },
        } as never;
      if (request.type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(request);
      if (request.type === "WORKSPACE_READER_DISCOVER") {
        discoveryRequest = request;
        return discovery.promise;
      }
      if (request.type === "WORKSPACE_READER_LOAD")
        return loadResponse(request, [cell], { page });
      if (request.type === "WORKSPACE_READER_TRANSLATE")
        return {
          type: request.type,
          requestId: request.requestId,
          ok: true,
          generation: 3,
          results: [
            { id: cell.id, sourceHash: cell.sourceHash, text: "Bản dịch" },
          ],
        };
      throw new Error(`Unexpected ${request.type}`);
    });
    const intent: WorkspaceReaderIntent = {
      id: "popup-click",
      createdAt: Date.now(),
      context: sheetsContext,
      targetLanguage: "vi",
      account: "reader@example.com",
    };
    if (!alreadyOpen)
      await browser.storage.session.set({ [readerIntentKey(7)]: intent });
    render(<App />);
    await waitFor(() => expect(discoveryRequest).toBeDefined());
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
    if (alreadyOpen)
      await browser.storage.session.set({ [readerIntentKey(7)]: intent });
    await waitFor(async () =>
      expect(await browser.storage.session.get(readerIntentKey(7))).toEqual({}),
    );
    discovery.resolve({
      type: "WORKSPACE_READER_DISCOVER",
      requestId: discoveryRequest!.requestId,
      ok: true,
      progress: { status: "complete", grid },
    });
    await screen.findByRole("gridcell", { name: "A1: Bản dịch" });
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(1);
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")[0]).toMatchObject({
      targetLanguage: "vi",
    });
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")[0]).not.toHaveProperty(
      "provider",
    );
  },
);

test("shows unconfigured and managed-account context errors without reading a file", async () => {
  mockRuntime((request) =>
    contextResponse(request, { configured: false, connected: false }),
  );
  const { unmount } = render(<App />);

  expect(
    await screen.findByText(
      "Google Workspace Reader is not configured in this build.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Connect Google/ })).toBeNull();
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(0);

  unmount();
  vi.clearAllMocks();
  vi.spyOn(browser.tabs, "query").mockResolvedValue([
    { id: 7, active: true },
  ] as never);
  mockRuntime((request) => ({
    type: "WORKSPACE_READER_CONTEXT",
    requestId: request.requestId,
    ok: false,
    error: "auth-required",
  }));
  render(<App />);

  expect(
    await screen.findByText(
      "Sign in to your Readlace account in the extension popup.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false");
});

test.each(["discover", "page", "docs"] as const)(
  "keeps connection controls consistent after %s authorization failure",
  async (stage) => {
    const source = record("p1", "P1", "Source");
    const { grid, page, cells } = sheetFixture();
    mockRuntime((request) => {
      if (request.type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(request, {
          context: stage === "docs" ? docsContext : sheetsContext,
        });
      if (request.type === "WORKSPACE_READER_DISCOVER")
        return stage === "discover"
          ? { type: request.type, ok: false, error: "google-oauth-expired" }
          : {
              type: request.type,
              ok: true,
              progress: { status: "complete", grid },
            };
      if (request.type === "WORKSPACE_READER_LOAD")
        return stage === "page"
          ? { type: request.type, ok: false, error: "google-auth-required" }
          : loadResponse(request, stage === "docs" ? [source] : cells, {
              context: stage === "docs" ? docsContext : sheetsContext,
              page: stage === "docs" ? undefined : page,
            });
      if (request.type === "WORKSPACE_READER_TRANSLATE")
        return {
          type: request.type,
          ok: false,
          error: "google-oauth-network",
        };
      throw new Error(`Unexpected ${request.type}`);
    });
    render(<App />);
    if (stage === "docs") {
      await screen.findByRole("checkbox", { name: "Select P1" });
      await userEvent.click(
        screen.getByRole("button", { name: "Translate loaded" }),
      );
      await waitFor(() =>
        expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(1),
      );
      await screen.findByText(
        "Google authorization could not reach the network.",
      );
      expect(screen.getByText("Access unavailable")).toBeInTheDocument();
    } else {
      await screen.findByRole("button", { name: "Reconnect Google Workspace" });
      expect(screen.getByText("Not connected")).toBeInTheDocument();
    }
  },
);

test("direct Reader remains load-only when optional intent storage is unavailable", async () => {
  const storage = browser.storage;
  Object.defineProperty(browser, "storage", {
    configurable: true,
    value: undefined,
  });
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: docsContext });
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, [record("p1", "P1", "Readable source")], {
        context: docsContext,
      });
    throw new Error(`Unexpected ${request.type}`);
  });
  const view = render(<App />);
  try {
    expect(await screen.findByText("Readable source")).toBeInTheDocument();
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  } finally {
    view.unmount();
    Object.defineProperty(browser, "storage", {
      configurable: true,
      value: storage,
    });
  }
});

test("a replacement popup click waits for the physical request and ignores its stale result", async () => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_key: string, callback: () => Promise<unknown>) => callback(),
    },
  });
  vi.spyOn(browser.tabs, "get").mockResolvedValue({
    id: 7,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
  } as never);
  const cell = sheetCell(0, 0, "Original");
  const grid = {
    ...sheetFixture().grid,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    rightToLeft: false,
    merges: [],
  };
  const page = {
    ...sheetFixture().page,
    rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [cell] }],
  };
  const first = deferred<unknown>();
  let firstRequest: WorkspaceReaderRequest | undefined;
  mockRuntime((request) => {
    if ((request.type as string) === "AUTH_STATUS")
      return {
        authenticated: true,
        user: { email: "reader@example.com" },
      } as never;
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_TRANSLATE") {
      if (!firstRequest) {
        firstRequest = request;
        return first.promise;
      }
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        generation: 3,
        results: [
          {
            id: cell.id,
            sourceHash: cell.sourceHash,
            text: "Latest translation",
          },
        ],
      };
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App sheetMock={{ grid, pages: [page] }} />);
  await screen.findByRole("gridcell", { name: "A1: Original" });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(firstRequest).toBeDefined());
  const intent: WorkspaceReaderIntent = {
    id: "replacement",
    createdAt: Date.now(),
    context: sheetsContext,
    targetLanguage: "ja",
    account: "reader@example.com",
  };
  await browser.storage.session.set({ [readerIntentKey(7)]: intent });
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Translate to" }),
    ).toHaveTextContent("Japanese"),
  );
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(1);
  first.resolve({
    type: "WORKSPACE_READER_TRANSLATE",
    requestId: firstRequest!.requestId,
    ok: true,
    generation: 3,
    results: [
      { id: cell.id, sourceHash: cell.sourceHash, text: "Stale translation" },
    ],
  });
  await screen.findByRole("gridcell", { name: "A1: Latest translation" });
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(2);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")[1]).toMatchObject({
    targetLanguage: "ja",
  });
  expect(screen.queryByText("Stale translation")).toBeNull();
});

test("shows the existing empty state for a discovered sheet with no columns", async () => {
  const emptyGrid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    rowCount: 100,
    lastUsedColumn: -1,
    columns: [],
    frozenColumnCount: 0,
    merges: [],
  };
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        progress: { status: "complete", grid: emptyGrid },
      };
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App />);

  expect(
    await screen.findByText("This worksheet has no readable text"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("Quarterly plan")).toHaveLength(2);
  expect(screen.queryByRole("grid")).toBeNull();
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(0);
});

test("keeps Google authorization explicit and recovers after access is denied", async () => {
  const source = record("a1", "A1", "こんにちは");
  let attempts = 0;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, {
        connected: attempts >= 2,
        context: docsContext,
      });
    if (request.type === "WORKSPACE_READER_CONNECT") {
      attempts += 1;
      return attempts === 1
        ? {
            type: request.type,
            requestId: request.requestId,
            ok: false,
            error: "google-access-denied",
          }
        : {
            type: request.type,
            requestId: request.requestId,
            ok: true,
            connected: true,
          };
    }
    return loadResponse(request, [source], { context: docsContext });
  });
  const user = userEvent.setup();
  render(<App />);

  const connect = await screen.findByRole("button", {
    name: "Connect Google Workspace",
  });
  expect(readerRequests("WORKSPACE_READER_CONNECT")).toHaveLength(0);
  await user.click(connect);
  expect(
    await screen.findByText(
      "Google denied access. Check consent and file permissions.",
    ),
  ).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(0);

  await user.click(connect);
  expect(await screen.findByText("1 record loaded.")).toBeInTheDocument();
  expect(screen.getByText("こんにちは")).toBeInTheDocument();
});

test("requests the optional Google permissions inside the Connect click before authorization (ADR 0015)", async () => {
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { connected: false });
    if (request.type === "WORKSPACE_READER_CONNECT")
      return {
        type: request.type,
        requestId: request.requestId,
        ok: false,
        error: "google-access-denied",
      };
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App />);
  const connect = await screen.findByRole("button", {
    name: "Connect Google Workspace",
  });
  const sendCalls = vi.mocked(browser.runtime.sendMessage).mock.calls.length;
  // A synchronous click: the request must happen before any await.
  fireEvent.click(connect);
  expect(permissionRequest).toHaveBeenCalledOnce();
  expect(permissionRequest).toHaveBeenCalledWith({
    permissions: ["identity"],
    origins: ["https://sheets.googleapis.com/*"],
  });
  expect(vi.mocked(browser.runtime.sendMessage).mock.calls).toHaveLength(
    sendCalls,
  );
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_CONNECT")).toHaveLength(1),
  );
});

test("stops Connect without authorization when the optional permissions are declined (ADR 0015)", async () => {
  permissionRequest.mockResolvedValue(false);
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { connected: false });
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Connect Google Workspace" }),
  );
  expect(
    await screen.findByText(
      "Allow Google access when Chrome asks to connect Google Workspace.",
    ),
  ).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_CONNECT")).toHaveLength(0);
  expect(
    screen.getByRole("button", { name: "Reconnect Google Workspace" }),
  ).toBeEnabled();
});

test.each([
  [
    "sheets-reader-unavailable",
    "Reading Google Sheets directly is coming soon. File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  ],
  [
    "office-download-required",
    "This Excel workbook is stored in Google Drive, which Reader cannot open yet. File → Download → Microsoft Excel (.xlsx), then open it in Local Reader.",
  ],
] as const)(
  "shows the %s launch notice with an Open local spreadsheet action (ADR 0015)",
  async (error, message) => {
    const create = vi
      .spyOn(browser.tabs, "create")
      .mockResolvedValue({ id: 9 } as never);
    mockRuntime((request) => {
      if (request.type === "WORKSPACE_READER_CONTEXT")
        return {
          type: request.type,
          requestId: request.requestId,
          ok: false,
          error,
        };
      throw new Error(`Unexpected ${request.type}`);
    });
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Connect Google Workspace/ }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Open local spreadsheet" }),
    );
    expect(create).toHaveBeenCalledWith({
      url: expect.stringContaining("/reader.html?local=1"),
    });
    expect(permissionRequest).not.toHaveBeenCalled();
  },
);

test("can reconnect immediately after an explicit disconnect", async () => {
  const source = record("a1", "A1", "こんにちは");
  let connected = true;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { connected, context: docsContext });
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, [source], { context: docsContext });
    if (request.type === "WORKSPACE_READER_DISCONNECT") {
      connected = false;
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        connected: false,
      };
    }
    if (request.type === "WORKSPACE_READER_CONNECT") {
      connected = true;
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        connected: true,
      };
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App />);

  expect(await screen.findByText("1 record loaded.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  const connect = await screen.findByRole("button", {
    name: "Connect Google Workspace",
  });

  await user.click(connect);

  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_CONNECT")).toHaveLength(1),
  );
  expect(await screen.findByText("1 record loaded.")).toBeInTheDocument();
});

test("renders Sheets records as plain text and translates checked records in source order", async () => {
  const records = [
    record("b2", "B2", '<img src="x" onerror="alert(1)">'),
    record("a1", "A1", "=A2", {
      display: "計画",
      kind: "formula",
      sourceHash: "hash-formula",
    }),
    record("c1", "C1", "12", {
      display: "12",
      kind: "number",
      translatable: false,
    }),
    record("d1", "D1", "#DIV/0!", {
      kind: "error",
      translatable: false,
    }),
  ];
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: docsContext });
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, records, { context: docsContext });
    const translation = translateRequest(request);
    return {
      type: "WORKSPACE_READER_TRANSLATE",
      requestId: translation.requestId,
      ok: true,
      generation: 3,
      results: [
        {
          id: "b2",
          sourceHash: "hash-b2",
          text: "<b>Safe translation</b>",
        },
        { id: "a1", sourceHash: "hash-formula", error: "unresolved" },
      ],
    };
  });
  const user = userEvent.setup();
  const { container } = render(<App />);

  await screen.findByText("4 records loaded.");
  expect(screen.getByText("Formula")).toBeInTheDocument();
  expect(screen.getByText("Displayed value: 計画")).toBeInTheDocument();
  expect(screen.getByText("Non-text")).toBeInTheDocument();
  expect(screen.getByText("Error")).toBeInTheDocument();
  // The brand mark is inline SVG, so any <img> would be record markup.
  expect(container.querySelectorAll("img")).toHaveLength(0);

  const formulaCheckbox = screen.getByRole("checkbox", { name: "Select A1" });
  formulaCheckbox.focus();
  await user.keyboard("[Space]");
  await user.click(screen.getByRole("checkbox", { name: "Select B2" }));
  const translateSelected = screen.getByRole("button", {
    name: "Translate selected (2)",
  });
  translateSelected.focus();
  await user.keyboard("[Enter]");

  expect(
    await screen.findByText("1 translated; 1 unresolved."),
  ).toBeInTheDocument();
  const request = translateRequest(
    readerRequests("WORKSPACE_READER_TRANSLATE")[0]!,
  );
  expect(request).not.toHaveProperty("provider");
  expect(request).toMatchObject({
    targetLanguage: "vi",
    records: [
      { id: "b2", sourceHash: "hash-b2" },
      { id: "a1", sourceHash: "hash-formula" },
    ],
  });
  expect(screen.getByText("<b>Safe translation</b>")).toBeInTheDocument();
  expect(container.querySelector("b")).toBeNull();
  expect(screen.getByText("Unresolved")).toBeInTheDocument();
});

test("renders mocked Sheets pages as an ordered responsive grid", async () => {
  const { grid, page, cells } = sheetFixture();
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, cells);
    throw new Error(`Unexpected ${request.type} request`);
  });
  const user = userEvent.setup();
  const { container } = render(
    <App
      sheetMock={{
        grid,
        pages: [page],
        translations: new Map([[cells[0]!.id, "Translation\nline"]]),
      }}
    />,
  );

  await screen.findByRole("grid", { name: "Quarterly plan sheet" });
  expect(screen.getByRole("columnheader", { name: "A" })).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "B" })).toBeNull();
  expect(screen.getByRole("columnheader", { name: "F" })).toBeInTheDocument();
  expect(
    screen.getByRole("note", { name: "Column B hidden" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("grid")).toHaveAttribute("dir", "rtl");

  const merged = screen.getByRole("gridcell", { name: "C1: Merged" });
  expect(merged).toHaveStyle({ gridColumn: "3 / span 2" });
  expect(
    screen.getByRole("gridcell", { name: "E1: Blank" }),
  ).toBeInTheDocument();
  const firstRow = container.querySelector<HTMLElement>(".sheets-grid-row");
  expect(firstRow?.getAttribute("style")).toContain(
    "grid-template-columns: 20px 0px 100px 900px",
  );
  // Source height 10px is a floor; wrapped text grows the row.
  expect(Number.parseInt(firstRow!.style.height, 10)).toBeGreaterThanOrEqual(
    10,
  );

  const translated = screen.getByRole("gridcell", {
    name: /A1: Translation\s+line/,
  });
  await user.click(translated);
  expect(translated).toHaveStyle({ insetInlineStart: "44px" });
  const details = screen.getByRole("complementary", {
    name: "Selected cell details",
  });
  expect(details.textContent).toContain("SourceSource\nline");
  expect(details.textContent).toContain("TranslationTranslation\nline");

  await user.keyboard("[ArrowLeft]");
  await waitFor(() =>
    expect(document.activeElement).toHaveAttribute("data-cell-address", "C1"),
  );
  await user.click(screen.getByRole("button", { name: "Original" }));
  expect(
    screen.getByRole("gridcell", { name: /A1: Source\s+line/ }),
  ).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);

  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  expect(viewport.parentElement).toHaveClass("sheets-grid-layout");
  expect(viewport.closest(".reader-results")).toHaveClass("sheets-results");
  Object.defineProperty(viewport, "clientWidth", {
    configurable: true,
    value: 160,
  });
  viewport.scrollLeft = -3180;
  fireEvent.scroll(viewport);
  await waitFor(() => {
    expect(screen.getByRole("columnheader", { name: "Z" })).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "AA" }),
    ).toBeInTheDocument();
  });
  Object.defineProperty(viewport, "clientWidth", {
    configurable: true,
    value: 900,
  });
  window.dispatchEvent(new Event("resize"));
  expect(screen.getByText("C1")).toBeInTheDocument();
});

test("reports viewport plus one viewport from rendered row geometry after wrapping", async () => {
  const grid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    rowCount: 6,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    merges: [],
  };
  const page: WorkspaceSheetPage = {
    sheetId: "42",
    generation: 3,
    startRow: 0,
    rowCount: 6,
    rows: Array.from({ length: 6 }, (_, index) => ({
      index,
      pixelSize: 21,
      hidden: index === 1,
      cells: [sheetCell(index, 0, `Row ${index + 1}`)],
    })),
    cursor: null,
  };
  const onViewportRecordsChange = vi.fn();
  const props = {
    grid,
    pages: [page],
    presentation: "original" as const,
    onNearPageEnd: vi.fn(),
    onViewportRecordsChange,
  };
  const { container, rerender } = render(
    <SheetsGrid {...props} translations={new Map()} />,
  );
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  const rectangle = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) satisfies DOMRect;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 100 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle(100, 100),
    },
  });
  let wrapped = false;
  const visibleIndexes = [0, 2, 3, 4, 5];
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-sheet-row-index]",
  )) {
    const index = Number(row.dataset.sheetRowIndex);
    const position = visibleIndexes.indexOf(index);
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        rectangle(100 + position * (wrapped ? 160 : 40), wrapped ? 160 : 40),
    });
  }

  fireEvent.scroll(viewport);
  await waitFor(() =>
    expect(onViewportRecordsChange).toHaveBeenLastCalledWith([
      "a1",
      "a3",
      "a4",
      "a5",
      "a6",
    ]),
  );

  wrapped = true;
  onViewportRecordsChange.mockClear();
  rerender(
    <SheetsGrid
      {...props}
      presentation="translation"
      translations={new Map([["a1", "Wrapped translation"]])}
    />,
  );
  await waitFor(() =>
    expect(onViewportRecordsChange).toHaveBeenLastCalledWith(["a1", "a3"]),
  );
});

test("discovers before grid paint and loads the next page once near row 80", async () => {
  const grid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    rowCount: 300,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    frozenRowCount: 1,
    frozenColumnCount: 0,
    rightToLeft: false,
    merges: [],
  };
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        progress: { status: "complete", grid },
      };
    if (request.type === "WORKSPACE_READER_LOAD") {
      const startRow =
        request.cursor?.kind === "sheets" ? request.cursor.nextRow : 0;
      const rows = Array.from({ length: 100 }, (_, offset) => {
        const index = startRow + offset;
        const source =
          index === 0
            ? "First page"
            : index === 100
              ? "Next page"
              : index === 200
                ? "Third page"
                : `Row ${index + 1}`;
        return {
          index,
          pixelSize: 21,
          hidden: false,
          cells: [sheetCell(index, 0, source)],
        };
      });
      const page: WorkspaceSheetPage = {
        sheetId: "42",
        generation: 3,
        startRow,
        rowCount: 100,
        rows,
        cursor:
          startRow < 200 ? { kind: "sheets", nextRow: startRow + 100 } : null,
      };
      return loadResponse(
        request,
        page.rows.flatMap((row) => row.cells),
        {
          page,
          cursor: page.cursor,
        },
      );
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  const { container } = render(<App />);

  expect(await screen.findByText("First page")).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  const rectangle = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) satisfies DOMRect;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 210 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle(100, 210),
    },
  });
  const showRows = (first: number) => {
    for (const row of container.querySelectorAll<HTMLElement>(
      "[data-sheet-row-index]",
    )) {
      const index = Number(row.dataset.sheetRowIndex);
      const visible = index >= first && index < first + 10;
      Object.defineProperties(row, {
        offsetTop: {
          configurable: true,
          value: 3_301 + (index - 80) * 42,
        },
        offsetHeight: { configurable: true, value: 42 },
        getBoundingClientRect: {
          configurable: true,
          value: () =>
            visible
              ? rectangle(100 + (index - first) * 21, 21)
              : rectangle(-1_000, 21),
        },
      });
    }
  };
  showRows(80);
  viewport.scrollTop = 1_680;
  fireEvent.scroll(viewport);
  fireEvent.scroll(viewport);
  await screen.findByText("Next page");
  expect(screen.getByText("First page")).toBeInTheDocument();
  expect(screen.getByText("Next page")).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_LOAD").at(-1)).toMatchObject({
    cursor: { kind: "sheets", nextRow: 100 },
  });
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(2);

  showRows(180);
  viewport.scrollTop = 3_780;
  const frozenRow = container.querySelector<HTMLElement>(
    '[data-sheet-row-index="0"]',
  )!;
  Object.defineProperties(frozenRow, {
    offsetTop: { configurable: true, value: viewport.scrollTop },
    offsetHeight: { configurable: true, value: 21 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle(100, 21),
    },
  });
  fireEvent.scroll(viewport);
  fireEvent.scroll(viewport);
  expect(await screen.findByText("Third page")).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(3);
  expect(readerRequests("WORKSPACE_READER_LOAD").at(-1)).toMatchObject({
    cursor: { kind: "sheets", nextRow: 200 },
  });
});

test("serializes distinct rapid-scroll page loads", async () => {
  const grid: WorkspaceSheetGrid = {
    ...sheetFixture().grid,
    rowCount: 400,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    merges: [],
  };
  const delayed = deferred<unknown>();
  let delayedRequest:
    | Extract<WorkspaceReaderRequest, { type: "WORKSPACE_READER_LOAD" }>
    | undefined;
  const pageResponse = (
    request: Extract<WorkspaceReaderRequest, { type: "WORKSPACE_READER_LOAD" }>,
  ) => {
    const startRow =
      request.cursor?.kind === "sheets" ? request.cursor.nextRow : 0;
    const cell = sheetCell(startRow, 0, `Page ${startRow}`);
    const page: WorkspaceSheetPage = {
      sheetId: "42",
      generation: 3,
      startRow,
      rowCount: 100,
      rows: [{ index: startRow, pixelSize: 21, hidden: false, cells: [cell] }],
      cursor: { kind: "sheets", nextRow: startRow + 100 },
    };
    return loadResponse(request, [cell], { page, cursor: page.cursor });
  };
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        requestId: request.requestId,
        ok: true,
        progress: { status: "complete", grid },
      };
    if (request.type === "WORKSPACE_READER_LOAD") {
      if (request.cursor?.kind === "sheets" && request.cursor.nextRow === 100) {
        delayedRequest = request;
        return delayed.promise;
      }
      return pageResponse(request);
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  const { container } = render(<App />);

  expect(await screen.findByText("Page 0")).toBeInTheDocument();
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: 21,
  });
  viewport.scrollTop = 100 * 21;
  fireEvent.scroll(viewport);
  fireEvent.scroll(viewport);
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(2),
  );
  viewport.scrollTop = 200 * 21;
  fireEvent.scroll(viewport);
  fireEvent.scroll(viewport);
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(2);

  if (!delayedRequest) throw new Error("Expected delayed page request");
  delayed.resolve(pageResponse(delayedRequest));
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(3),
  );
  expect(
    readerRequests("WORKSPACE_READER_LOAD").map((request) =>
      request.type === "WORKSPACE_READER_LOAD" ? request.cursor : null,
    ),
  ).toEqual([
    null,
    { kind: "sheets", nextRow: 100 },
    { kind: "sheets", nextRow: 200 },
  ]);
  expect(screen.queryByText(/invalid response/i)).toBeNull();
});

test("binds displayed translations to the current source hash", () => {
  const oldRecord = record("a1", "A1", "Old source", {
    sourceHash: "hash-old",
  });
  const editedRecord = record("a1", "A1", "Edited source", {
    sourceHash: "hash-new",
  });
  const accepted = new Map([
    ["a1", { sourceHash: "hash-old", text: "Old translation" }],
  ]);

  expect(displayedSheetTranslations([oldRecord], accepted).get("a1")).toBe(
    "Old translation",
  );
  expect(displayedSheetTranslations([editedRecord], accepted).has("a1")).toBe(
    false,
  );

  accepted.set("a1", {
    sourceHash: "hash-new",
    text: "New translation",
  });
  expect(displayedSheetTranslations([editedRecord], accepted).get("a1")).toBe(
    "New translation",
  );
});
test("loads only the chosen Docs tab", async () => {
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: docsContext });
    if (request.type !== "WORKSPACE_READER_LOAD")
      throw new Error("Unexpected request");
    const tabId =
      request.cursor?.kind === "docs" ? request.cursor.tabId : "tab-1";
    return loadResponse(
      request,
      [record(`p-${tabId}`, "P1.0", `Text from ${tabId}`)],
      {
        context: { ...docsContext, activeId: tabId },
        title: tabId === "tab-1" ? "Overview" : "Details",
        tabs: [
          { id: "tab-1", title: "Overview", parentId: null, depth: 0 },
          { id: "tab-2", title: "Details", parentId: null, depth: 0 },
        ],
      },
    );
  });
  const user = userEvent.setup();
  render(<App />);

  await screen.findByText("Text from tab-1");
  await user.click(screen.getByRole("combobox", { name: "Document tab" }));
  await user.click(await screen.findByRole("option", { name: "Details" }));

  expect(await screen.findByText("Text from tab-2")).toBeInTheDocument();
  expect(screen.queryByText("Text from tab-1")).toBeNull();
  expect(screen.queryByRole("grid")).toBeNull();
  expect(readerRequests("WORKSPACE_READER_LOAD").at(-1)).toMatchObject({
    cursor: { kind: "docs", tabId: "tab-2" },
  });
});

test("marks oversized records locally without provider dispatch", async () => {
  const source = record("large", "A1", "a".repeat(4_001));
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: docsContext });
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, [source], { context: docsContext });
    throw new Error("Translation must not be sent");
  });
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    await screen.findByRole("button", { name: "Translate loaded" }),
  );
  expect(await screen.findByText("Too large")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Selected content exceeds the per-record translation limit.",
    ),
  ).toBeInTheDocument();
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("rejects a stale translation generation", async () => {
  const source = record("a1", "A1", "Source");
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: docsContext });
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, [source], { context: docsContext });
    const translation = translateRequest(request);
    return {
      type: "WORKSPACE_READER_TRANSLATE",
      requestId: translation.requestId,
      ok: true,
      generation: 99,
      results: [{ id: "a1", sourceHash: "hash-a1", text: "Stale result" }],
    };
  });
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    await screen.findByRole("button", { name: "Translate loaded" }),
  );
  expect(
    await screen.findByText(
      "The source tab changed. Refresh Reader to continue.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Stale result")).toBeNull();
});

test("sends bounded translation batches sequentially and disables conflicting actions", async () => {
  const first = deferred<unknown>();
  const records = [
    record("one", "A1", `${"a".repeat(3_999)}1`),
    record("two", "A2", `${"b".repeat(3_999)}2`),
    record("three", "A3", `${"c".repeat(3_999)}3`),
  ];
  let translationCalls = 0;
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, { context: docsContext });
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, records, { context: docsContext });
    const translation = translateRequest(request);
    translationCalls += 1;
    if (translationCalls === 1) return first.promise;
    return {
      type: "WORKSPACE_READER_TRANSLATE",
      requestId: translation.requestId,
      ok: true,
      generation: 3,
      results: translation.records.map(({ id, sourceHash }) => ({
        id,
        sourceHash,
        text: `translated-${id}`,
      })),
    };
  });
  const user = userEvent.setup();
  render(<App />);

  await user.click(
    await screen.findByRole("button", { name: "Translate loaded" }),
  );
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(1);
  expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  for (const name of ["Translate loaded", "Refresh", "Disconnect"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  expect(screen.getByRole("combobox", { name: "Translate to" })).toBeDisabled();
  const liveStatus = screen.getByRole("status");
  expect(liveStatus).toHaveAttribute("aria-live", "polite");
  expect(within(liveStatus).getByText("Translating…")).toBeInTheDocument();

  const firstRequest = translateRequest(
    readerRequests("WORKSPACE_READER_TRANSLATE")[0]!,
  );
  first.resolve({
    type: "WORKSPACE_READER_TRANSLATE",
    requestId: firstRequest.requestId,
    ok: true,
    generation: 3,
    results: firstRequest.records.map(({ id, sourceHash }) => ({
      id,
      sourceHash,
      text: `translated-${id}`,
    })),
  });

  expect(
    await screen.findByText("3 translations completed."),
  ).toBeInTheDocument();
  const requests = readerRequests("WORKSPACE_READER_TRANSLATE").map(
    translateRequest,
  );
  expect(requests).toHaveLength(2);
  expect(requests.map((request) => request.records.length)).toEqual([2, 1]);
  expect(requests[0]!.requestId).toBeLessThan(requests[1]!.requestId);
});

test("hands an Office workbook to Drive Reader with bound source ownership", async () => {
  expect(driveOfficeReaderPath(7)).toBe("/reader.html?office=1&sourceTabId=7");
  let unmount: () => void = () => undefined;
  const openDriveOfficeSpreadsheet = vi.fn(() => unmount());
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        requestId: request.requestId,
        ok: false,
        error: "unsupported-file-type",
      };
    throw new Error(`Unexpected ${request.type}`);
  });

  ({ unmount } = render(
    <App onOpenDriveOfficeSpreadsheet={openDriveOfficeSpreadsheet} />,
  ));

  await waitFor(() =>
    expect(openDriveOfficeSpreadsheet).toHaveBeenCalledOnce(),
  );
  expect(openDriveOfficeSpreadsheet).toHaveBeenCalledWith(
    {
      sourceTabId: 7,
      version: sourceVersion,
      fileId: sheetsContext.fileId,
    },
    undefined,
  );
  expect(
    screen.queryByText(
      "This file type is not supported. Open a native Google Sheet or a Drive .xlsx/.xlsm workbook.",
    ),
  ).not.toBeInTheDocument();
});

test("latest Reader dropdown wins delayed A/B/C and Refresh rebinds Reader worksheet rather than editor gid", async () => {
  const sheets = ["42", "43", "44", "45"].map((sheetId, index) => ({
    sheetId,
    title: `Sheet ${sheetId}`,
    index,
  }));
  let selected = "42";
  let contextCalls = 0;
  const delayed = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const context = () => ({ ...sheetsContext, activeId: selected });
  const grid = () => ({
    ...sheetFixture().grid,
    sheetId: selected,
    title: `Sheet ${selected}`,
    lastUsedColumn: 0,
    columns: [{ index: 0, pixelSize: 100, hidden: false }],
    rightToLeft: false,
    merges: [],
  });
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, {
        context: {
          ...sheetsContext,
          activeId: ++contextCalls === 1 ? "42" : "02",
        },
        targetLanguage: "en",
      });
    if (request.type === "WORKSPACE_READER_SELECT_SHEET") {
      selected = request.sheetId;
      const response = {
        type: request.type,
        ok: true,
        context: context(),
        sheets,
      };
      if (request.sheetId === "43" || request.sheetId === "44") {
        const pending = deferred<unknown>();
        delayed.set(request.sheetId, pending);
        return pending.promise;
      }
      return response;
    }
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        ok: true,
        sheets,
        progress: { status: "complete", grid: grid() },
      };
    if (request.type === "WORKSPACE_READER_LOAD") {
      const cell = sheetCell(0, 0, `Source ${selected}`);
      const page = {
        ...sheetFixture().page,
        sheetId: selected,
        rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [cell] }],
      };
      return loadResponse(request, [cell], {
        context: context(),
        title: `Sheet ${selected}`,
        page,
      });
    }
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("gridcell", { name: "A1: Source 42" });
  for (const id of ["43", "44", "45"]) {
    await user.click(screen.getByRole("combobox", { name: "Worksheet" }));
    await user.click(
      await screen.findByRole("option", { name: `Sheet ${id}` }),
    );
    if (id === "43") {
      expect(screen.getAllByText("Connected")).not.toHaveLength(0);
      expect(
        screen.queryByRole("combobox", { name: "Provider" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Translate to" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Loading worksheet…")).toBeInTheDocument();
      expect(screen.queryByText("Preparing Reader…")).toBeNull();
    }
  }
  await screen.findByRole("gridcell", { name: "A1: Source 45" });
  await act(async () => {
    for (const id of ["44", "43"])
      delayed.get(id)!.resolve({
        type: "WORKSPACE_READER_SELECT_SHEET",
        ok: true,
        context: { ...sheetsContext, activeId: id },
        sheets,
      });
  });
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toHaveTextContent(
    "Sheet 45",
  );
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(2);
  await user.click(screen.getByRole("combobox", { name: "Translate to" }));
  await user.click(await screen.findByRole("option", { name: "Japanese" }));
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("gridcell", { name: "A1: Source 45" });
  expect(readerRequests("WORKSPACE_READER_SELECT_SHEET").at(-1)).toMatchObject({
    sheetId: "45",
  });
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Japanese");
  expect(saveReaderPreferences).toHaveBeenLastCalledWith({
    targetLanguage: "ja",
  });
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("late preference hydration cannot overwrite an explicit choice", async () => {
  const preferences =
    deferred<Awaited<ReturnType<typeof readReaderPreferences>>>();
  vi.mocked(readReaderPreferences).mockReturnValue(preferences.promise);
  mockRuntime((request) => contextResponse(request));
  const { grid, page } = sheetFixture();
  const user = userEvent.setup();
  render(<App sheetMock={{ grid, pages: [page] }} />);
  await screen.findByRole("grid");
  await user.click(screen.getByRole("combobox", { name: "Translate to" }));
  await user.click(await screen.findByRole("option", { name: "Japanese" }));
  await act(async () => {
    preferences.resolve({ targetLanguage: "en" });
  });
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Japanese");
});

test("discovery loading is announced once by the source state without fake numeric warning", async () => {
  const discover = deferred<unknown>();
  const { grid, page, cells } = sheetFixture();
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER") return discover.promise;
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, cells, { page });
    throw new Error(`Unexpected ${request.type}`);
  });
  const { container } = render(<App />);
  await screen.findByRole("button", { name: "Loading…" });
  expect(screen.getByText("Discovering worksheet…")).toBeInTheDocument();
  expect(screen.queryByText(/Discovering columns/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(container.querySelector(".reader-actionable-message")).toBeNull();
  await act(async () => {
    discover.resolve({
      type: "WORKSPACE_READER_DISCOVER",
      ok: true,
      progress: { status: "complete", grid },
    });
  });
  await screen.findByRole("grid");
  expect(screen.queryByText("Discovering worksheet…")).toBeNull();
});

test("Translate on an awaiting empty worksheet settles to translation-on with zero values or provider calls", async () => {
  const grid = {
    ...sheetFixture().grid,
    rowCount: 0,
    lastUsedColumn: -1,
    columns: [],
    merges: [],
  };
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        ok: true,
        progress: { status: "complete", grid },
      };
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App awaitingStart />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Translate" }),
  );
  await screen.findByText("This worksheet has no readable text");
  expect(screen.getByRole("button", { name: "Translation on" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Translation on" }),
  ).toHaveAttribute("aria-busy", "false");
  expect(screen.queryByTestId("reader-spinner")).toBeNull();
  expect(readerRequests("WORKSPACE_READER_LOAD")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});
test("active Reader dropdown to an empty worksheet settles instead of spinning", async () => {
  const sheets = [
    { sheetId: "42", title: "Text sheet", index: 0 },
    { sheetId: "43", title: "Empty sheet", index: 1 },
  ];
  let selected = "42";
  const first = sheetFixture();
  const context = () => ({ ...sheetsContext, activeId: selected });
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request);
    if (request.type === "WORKSPACE_READER_SELECT_SHEET") {
      selected = request.sheetId;
      return { type: request.type, ok: true, context: context(), sheets };
    }
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        ok: true,
        sheets,
        progress: {
          status: "complete",
          grid:
            selected === "42"
              ? first.grid
              : {
                  ...first.grid,
                  sheetId: "43",
                  title: "Empty sheet",
                  rowCount: 0,
                  lastUsedColumn: -1,
                  columns: [],
                  merges: [],
                },
        },
      };
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, first.cells, { page: first.page });
    if (request.type === "WORKSPACE_READER_TRANSLATE")
      return {
        type: request.type,
        ok: true,
        generation: 3,
        results: request.records.map(({ id, sourceHash }) => ({
          id,
          sourceHash,
          text: "Translated",
        })),
      };
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("grid");
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await screen.findByRole("button", { name: "Translation on" });
  const requests = readerRequests("WORKSPACE_READER_TRANSLATE").length;
  await user.click(screen.getByRole("combobox", { name: "Worksheet" }));
  await user.click(await screen.findByRole("option", { name: "Empty sheet" }));
  await screen.findByText("This worksheet has no readable text");
  expect(
    screen.getByRole("button", { name: "Translation on" }),
  ).toHaveAttribute("aria-busy", "false");
  expect(screen.queryByTestId("reader-spinner")).toBeNull();
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(requests);
});
test.each(["WORKSPACE_READER_DISCOVER", "WORKSPACE_READER_LOAD"] as const)(
  "terminal %s failure retires translation intent without an endless spinner",
  async (stage) => {
    const { grid } = sheetFixture();
    mockRuntime((request) => {
      if (request.type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(request);
      if (request.type === stage)
        return {
          type: request.type,
          ok: false,
          error: "temporarily-unavailable",
        };
      if (request.type === "WORKSPACE_READER_DISCOVER")
        return {
          type: request.type,
          ok: true,
          progress: { status: "complete", grid },
        };
      throw new Error(`Unexpected ${request.type}`);
    });
    render(<App awaitingStart />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Translate" }),
    );
    await screen.findByText("Google Workspace is temporarily unavailable.");
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
    expect(screen.queryByTestId("reader-spinner")).toBeNull();
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  },
);

test("accepted initial context reports its exact owner source version before load-only discovery", async () => {
  const observed = vi.fn();
  const { grid, page } = sheetFixture();
  mockRuntime((request) => contextResponse(request));
  render(
    <App sheetMock={{ grid, pages: [page] }} onSourceIdentified={observed} />,
  );
  await screen.findByRole("grid");
  expect(observed).toHaveBeenCalledWith(sheetsContext, sourceVersion);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("native pre-start catalog, settings, selection and Refresh remain metadata-only until Translate", async () => {
  const sheets = [
    { sheetId: "30002", title: "Overview", index: 0 },
    { sheetId: "30003", title: "Rules", index: 1 },
  ];
  const { grid, page } = sheetFixture();
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, {
        context: { ...sheetsContext, activeId: "30002" },
        sheets,
        sourceTitle: "Workbook",
      });
    if (request.type === "WORKSPACE_READER_SELECT_SHEET")
      return {
        type: request.type,
        ok: true,
        context: { ...sheetsContext, activeId: request.sheetId },
        sheets,
      };
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        type: request.type,
        ok: true,
        sheets,
        progress: {
          status: "complete",
          grid: { ...grid, sheetId: "30003", title: "Rules" },
        },
      };
    if (request.type === "WORKSPACE_READER_LOAD")
      return loadResponse(request, [], {
        page: { ...page, sheetId: "30003", rows: [] },
      });
    throw new Error(`Unexpected ${request.type}`);
  });
  const user = userEvent.setup();
  render(<App awaitingStart />);
  const worksheet = await screen.findByRole("combobox", { name: "Worksheet" });
  await waitFor(() => expect(worksheet).toHaveTextContent("Overview"));
  expect(screen.queryByText("30002")).toBeNull();
  for (const label of ["Worksheet", "Translate to"])
    expect(screen.getByRole("combobox", { name: label })).toBeEnabled();
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Vietnamese");
  await user.click(screen.getByRole("combobox", { name: "Translate to" }));
  await user.click(await screen.findByRole("option", { name: "English" }));
  await user.click(worksheet);
  await user.click(await screen.findByRole("option", { name: "Rules" }));
  await waitFor(() => expect(worksheet).toHaveTextContent("Rules"));
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_SELECT_SHEET")).toHaveLength(2),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled(),
  );
  expect(worksheet).toHaveTextContent("Rules");
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("English");
  expect(
    readerRequests("WORKSPACE_READER_CONTEXT").every(
      (request) =>
        request.type === "WORKSPACE_READER_CONTEXT" && request.identifySource,
    ),
  ).toBe(true);
  for (const type of [
    "WORKSPACE_READER_DISCOVER",
    "WORKSPACE_READER_LOAD",
    "WORKSPACE_READER_TRANSLATE",
  ] as const)
    expect(readerRequests(type)).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Translate" }));
  await screen.findByRole("grid");
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(1);
  expect(readerRequests("WORKSPACE_READER_SELECT_SHEET").at(-1)).toMatchObject({
    sheetId: "30003",
  });
  expect(worksheet).toHaveTextContent("Rules");
});

test("native pre-start missing catalog hides gid and metadata failure can Refresh without discovery", async () => {
  let lookups = 0;
  mockRuntime((request) => {
    if (request.type !== "WORKSPACE_READER_CONTEXT")
      throw new Error(`Unexpected ${request.type}`);
    if (++lookups === 2)
      return {
        type: request.type,
        ok: false,
        error: "temporarily-unavailable",
      };
    return contextResponse(request, {
      context: { ...sheetsContext, activeId: "30002" },
      sourceTitle: "Workbook",
      sheets: [],
    });
  });
  render(<App awaitingStart />);
  const user = userEvent.setup();
  const worksheet = await screen.findByRole("combobox", { name: "Worksheet" });
  expect(worksheet).toHaveTextContent(
    "Worksheet names unavailable. Refresh to retry.",
  );
  expect(worksheet).toBeDisabled();
  expect(screen.queryByText("30002")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Google Workspace is temporarily unavailable.");
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_CONTEXT")).toHaveLength(3),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("Google Workspace is temporarily unavailable."),
    ).toBeNull(),
  );
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("native pre-start ignores delayed earlier worksheet selection without discovering values", async () => {
  const sheets = ["30002", "30003", "30004"].map((sheetId, index) => ({
    sheetId,
    title: ["Overview", "Rules", "Conditions"][index]!,
    index,
  }));
  const selections: {
    request: Extract<
      WorkspaceReaderRequest,
      { type: "WORKSPACE_READER_SELECT_SHEET" }
    >;
    resolve: (response: unknown) => void;
  }[] = [];
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, {
        context: { ...sheetsContext, activeId: "30002" },
        sheets,
      });
    if (request.type === "WORKSPACE_READER_SELECT_SHEET")
      return new Promise((resolve) => selections.push({ request, resolve }));
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App awaitingStart />);
  const user = userEvent.setup();
  const worksheet = await screen.findByRole("combobox", { name: "Worksheet" });
  await user.click(worksheet);
  await user.click(await screen.findByRole("option", { name: "Rules" }));
  await user.click(worksheet);
  await user.click(await screen.findByRole("option", { name: "Conditions" }));
  const respond = (index: number) =>
    act(async () => {
      const { request, resolve } = selections[index]!;
      resolve({
        type: request.type,
        ok: true,
        sheets,
        context: { ...sheetsContext, activeId: request.sheetId },
      });
    });
  await respond(1);
  await respond(0);
  expect(worksheet).toHaveTextContent("Conditions");
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("initial Office metadata hands the approved file title to Drive Reader", async () => {
  const open = vi.fn();
  mockRuntime((request) =>
    contextResponse(request, {
      sourceKind: "office",
      sourceTitle: "Issues.xlsx",
    }),
  );
  render(<App onOpenDriveOfficeSpreadsheet={open} />);
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith(
      {
        sourceTabId: 7,
        version: sourceVersion,
        sourceTitle: "Issues.xlsx",
        fileId: sheetsContext.fileId,
      },
      undefined,
    ),
  );
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
});

test("native pre-start worker recovery refreshes metadata and retains selection without discovery", async () => {
  const sheets = [
    { sheetId: "30002", title: "Overview", index: 0 },
    { sheetId: "30003", title: "Rules", index: 1 },
  ];
  let epoch = "epoch-1";
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation((async (
    request: WorkspaceReaderRequest,
  ) => {
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(request, {
        context: { ...sheetsContext, activeId: "30002" },
        sheets,
        version: { backgroundEpoch: epoch, sourceRevision: 1 },
      });
    if (request.type === "WORKSPACE_READER_SELECT_SHEET") {
      if (epoch === "epoch-1") {
        epoch = "epoch-2";
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          ok: false,
          error: "source-tab-changed",
          version: { backgroundEpoch: epoch, sourceRevision: 1 },
        };
      }
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        ok: true,
        context: { ...sheetsContext, activeId: request.sheetId },
        sheets,
        version: request.version,
      };
    }
    throw new Error(`Unexpected ${request.type}`);
  }) as never);
  render(<App awaitingStart />);
  const user = userEvent.setup();
  const worksheet = await screen.findByRole("combobox", { name: "Worksheet" });
  await user.click(worksheet);
  await user.click(await screen.findByRole("option", { name: "Rules" }));
  await waitFor(() =>
    expect(readerRequests("WORKSPACE_READER_CONTEXT")).toHaveLength(2),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled(),
  );
  expect(worksheet).toHaveTextContent("Rules");
  expect(readerRequests("WORKSPACE_READER_SELECT_SHEET").at(-1)).toMatchObject({
    sheetId: "30003",
    version: { backgroundEpoch: "epoch-2", sourceRevision: 1 },
  });
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("native channel failure stays local and opens an awaiting-start tab only after the user asks", async () => {
  vi.mocked(readReaderPreferences).mockResolvedValue({
    targetLanguage: "en",
  });
  vi.spyOn(browser.tabs, "get").mockResolvedValue({
    id: 7,
    windowId: 70,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
  } as never);
  vi.spyOn(browser.tabs, "create").mockResolvedValue({ id: 80 } as never);
  mockRuntime((request) => ({
    type: request.type,
    ok: false,
    error: "reader-channel-unavailable",
  }));
  render(<App awaitingStart />);
  const button = await screen.findByRole("button", {
    name: "Open Reader in a tab",
  });
  expect(screen.getByText("Access unavailable")).toBeInTheDocument();
  expect(
    screen.queryByText("Google Workspace is temporarily unavailable."),
  ).toBeNull();
  expect(browser.tabs.create).not.toHaveBeenCalled();
  await userEvent.click(button);
  await waitFor(() =>
    expect(browser.tabs.create).toHaveBeenCalledWith({
      windowId: 70,
      active: true,
      url: browser.runtime.getURL(
        "/reader.html?sourceTabId=7&awaitStart=1" as never,
      ),
    }),
  );
  expect(saveReaderPreferences).toHaveBeenCalledWith({
    targetLanguage: "en",
  });
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
  expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
});

test("fallback source validation rejects changed files, unsupported sources and retired handoffs", async () => {
  const get = vi.spyOn(browser.tabs, "get").mockResolvedValue({
    id: 7,
    windowId: 70,
    url: "https://docs.google.com/spreadsheets/d/other-file/edit",
  } as never);
  vi.spyOn(browser.tabs, "create").mockResolvedValue({ id: 80 } as never);
  await expect(openReaderTabFallback(7, true, "sheet-1")).rejects.toThrow();
  get.mockResolvedValue({
    id: 7,
    windowId: 70,
    url: "https://drive.google.com/drive/my-drive",
  } as never);
  await expect(openReaderTabFallback(7, true)).rejects.toThrow();
  get.mockResolvedValue({
    id: 7,
    windowId: 70,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
  } as never);
  await expect(
    openReaderTabFallback(7, true, "sheet-1", () => false),
  ).rejects.toThrow();
  expect(browser.tabs.create).not.toHaveBeenCalled();
});

test.each(["30003", "999"])(
  "fallback worksheet hint %s is validated against fresh catalog before discovery",
  async (desiredSheetId) => {
    const sheets = [
      { sheetId: "30002", title: "Overview", index: 0 },
      { sheetId: "30003", title: "Rules", index: 1 },
    ];
    mockRuntime((request) => {
      if (request.type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(request, {
          context: { ...sheetsContext, activeId: "30002" },
          sheets,
        });
      if (request.type === "WORKSPACE_READER_SELECT_SHEET")
        return {
          type: request.type,
          ok: true,
          sheets,
          context: { ...sheetsContext, activeId: request.sheetId },
        };
      throw new Error(`Unexpected ${request.type}`);
    });
    render(<App awaitingStart desiredSheetId={desiredSheetId} />);
    const worksheet = await screen.findByRole("combobox", {
      name: "Worksheet",
    });
    await waitFor(() =>
      expect(worksheet).toHaveTextContent(
        desiredSheetId === "30003" ? "Rules" : "Overview",
      ),
    );
    expect(readerRequests("WORKSPACE_READER_SELECT_SHEET")).toHaveLength(
      desiredSheetId === "30003" ? 1 : 0,
    );
    expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  },
);

test("same-file channel recovery transfers known Reader selection and saved settings to fallback", async () => {
  const sheets = [
    { sheetId: "30002", title: "Overview", index: 0 },
    { sheetId: "30003", title: "Rules", index: 1 },
  ];
  let lookups = 0;
  vi.spyOn(browser.tabs, "get").mockResolvedValue({
    id: 7,
    windowId: 70,
    url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=30002",
  } as never);
  vi.spyOn(browser.tabs, "create").mockResolvedValue({ id: 80 } as never);
  mockRuntime((request) => {
    if (request.type === "WORKSPACE_READER_CONTEXT") {
      if (++lookups > 1)
        return {
          type: request.type,
          ok: false,
          error: "reader-channel-unavailable",
        };
      return contextResponse(request, {
        context: { ...sheetsContext, activeId: "30002" },
        sheets,
      });
    }
    if (request.type === "WORKSPACE_READER_SELECT_SHEET")
      return {
        type: request.type,
        ok: true,
        sheets,
        context: { ...sheetsContext, activeId: request.sheetId },
      };
    throw new Error(`Unexpected ${request.type}`);
  });
  render(<App awaitingStart />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Worksheet" }));
  await user.click(await screen.findByRole("option", { name: "Rules" }));
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await user.click(
    await screen.findByRole("button", { name: "Open Reader in a tab" }),
  );
  await waitFor(() =>
    expect(browser.tabs.create).toHaveBeenCalledWith({
      windowId: 70,
      active: true,
      url: browser.runtime.getURL(
        "/reader.html?sourceTabId=7&awaitStart=1&readerSheetId=30003" as never,
      ),
    }),
  );
  expect(readerRequests("WORKSPACE_READER_DISCOVER")).toHaveLength(0);
});

test.each([false, true])(
  "channel fallback requeues original popup intent only with current account (stale: %s)",
  async (stale) => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_key: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.spyOn(browser.tabs, "get").mockResolvedValue({
      id: 7,
      windowId: 70,
      url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
    } as never);
    let retire: () => void = () => undefined;
    vi.spyOn(browser.tabs, "create").mockImplementation(async () => {
      retire();
      return { id: 80 } as never;
    });
    mockRuntime((request) => {
      if ((request.type as string) === "AUTH_STATUS")
        return {
          authenticated: true,
          unavailable: false,
          user: { email: stale ? "other@example.com" : "reader@example.com" },
        };
      return {
        type: request.type,
        ok: false,
        error: "reader-channel-unavailable",
      };
    });
    const intent: WorkspaceReaderIntent = {
      id: "original-click",
      createdAt: Date.now(),
      context: sheetsContext,
      targetLanguage: "vi",
      account: "reader@example.com",
    };
    await browser.storage.session.set({ [readerIntentKey(7)]: intent });
    const view = render(<App />);
    retire = view.unmount;
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Reader in a tab" }),
    );
    await waitFor(() => expect(browser.tabs.create).toHaveBeenCalledOnce());
    await waitFor(async () =>
      expect(
        (await browser.storage.session.get(readerIntentKey(7)))[
          readerIntentKey(7)
        ],
      ).toEqual(stale ? undefined : intent),
    );
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  },
);

test.each([false, true])(
  "failed fallback opener cleans only its own queued intent (newer: %s)",
  async (newer) => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_key: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.spyOn(browser.storage.onChanged, "addListener").mockImplementation(
      () => undefined,
    );
    vi.spyOn(browser.tabs, "get").mockResolvedValue({
      id: 7,
      windowId: 70,
      url: "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=42",
    } as never);
    const intent: WorkspaceReaderIntent = {
      id: "original-click",
      createdAt: Date.now(),
      context: sheetsContext,
      targetLanguage: "vi",
      account: "reader@example.com",
    };
    const replacement = { ...intent, id: "newer-click" };
    vi.spyOn(browser.tabs, "create").mockImplementation(async () => {
      if (newer)
        await browser.storage.session.set({
          [readerIntentKey(7)]: replacement,
        });
      throw new Error("Cannot open tab");
    });
    mockRuntime((request) => {
      if ((request.type as string) === "AUTH_STATUS")
        return {
          authenticated: true,
          unavailable: false,
          user: { email: intent.account },
        };
      return {
        type: request.type,
        ok: false,
        error: "reader-channel-unavailable",
      };
    });
    await browser.storage.session.set({ [readerIntentKey(7)]: intent });
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Open Reader in a tab" }),
    );
    await screen.findByText("Reader could not open in a tab. Try again.");
    expect(
      (await browser.storage.session.get(readerIntentKey(7)))[
        readerIntentKey(7)
      ],
    ).toEqual(newer ? replacement : undefined);
    expect(
      screen.getByRole("button", { name: "Open Reader in a tab" }),
    ).toBeEnabled();
    expect(readerRequests("WORKSPACE_READER_TRANSLATE")).toHaveLength(0);
  },
);

test("Refresh after worker replacement rebuilds a completed native watcher against the new source version", async () => {
  const sourceCell = sheetCell(0, 0, "Hello");
  const fixture = sheetFixture();
  let contextReads = 0;
  let refreshed = false;
  const translate = vi.fn();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation((async (
    request: WorkspaceReaderRequest,
  ) => {
    if (request.type === "WORKSPACE_READER_CONTEXT") {
      refreshed = ++contextReads > 1;
      return contextResponse(request, {
        sheets: [{ sheetId: "42", title: "Quarterly plan", index: 0 }],
        version: refreshed
          ? { backgroundEpoch: "replacement-worker", sourceRevision: 1 }
          : sourceVersion,
      });
    }
    const generation = refreshed ? 1 : 3;
    const version = refreshed
      ? { backgroundEpoch: "replacement-worker", sourceRevision: 1 }
      : sourceVersion;
    const grid = {
      ...fixture.grid,
      generation,
      rowCount: 1,
      lastUsedColumn: 0,
      frozenRowCount: 0,
      frozenColumnCount: 0,
      rightToLeft: false,
      merges: [],
      columns: [{ index: 0, pixelSize: 100, hidden: false }],
    };
    const page = {
      ...fixture.page,
      generation,
      rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [sourceCell] }],
    };
    const identity = {
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      version,
    };
    if (request.type === "WORKSPACE_READER_DISCOVER")
      return {
        ...identity,
        type: request.type,
        ok: true,
        sheets: [{ sheetId: "42", title: "Quarterly plan", index: 0 }],
        progress: { status: "complete", grid },
      };
    if (request.type === "WORKSPACE_READER_LOAD")
      return {
        ...loadResponse(request, [sourceCell], { page, generation }),
        ...identity,
      };
    if (request.type === "WORKSPACE_READER_TRANSLATE") {
      translate(request);
      return {
        ...identity,
        type: request.type,
        ok: true,
        generation,
        results: request.records.map(({ id, sourceHash }) => ({
          id,
          sourceHash,
          text: "Accepted translation",
        })),
      };
    }
    throw new Error(`Unexpected ${request.type}`);
  }) as never);
  render(<App />);
  await screen.findByRole("gridcell", { name: "A1: Hello" });
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await screen.findByRole("gridcell", { name: "A1: Accepted translation" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Translation on" }),
    ).toBeDisabled(),
  );
  expect(translate).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(contextReads).toBe(2));
  await waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
  await screen.findByRole("gridcell", { name: "A1: Accepted translation" });
  expect(translate.mock.calls[1]![0]).toMatchObject({
    version: { backgroundEpoch: "replacement-worker", sourceRevision: 1 },
    records: [{ id: sourceCell.id, sourceHash: sourceCell.sourceHash }],
  });
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(contextReads).toBe(3));
  await screen.findByRole("gridcell", { name: "A1: Hello" });
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
  expect(translate).toHaveBeenCalledTimes(2);
});

test("renders the Google Workspace Reader in Vietnamese and follows a locale switch", async () => {
  mockRuntime((request) =>
    contextResponse(request, { connected: false, context: docsContext }),
  );
  const { rerender } = render(
    <UiLocaleScope locale="en">
      <App />
    </UiLocaleScope>,
  );
  expect(
    await screen.findByText("Connect Google Workspace to load this file."),
  ).toBeInTheDocument();

  // Status lines are stored as message refs, so a switch re-renders them.
  rerender(
    <UiLocaleScope locale="vi">
      <App />
    </UiLocaleScope>,
  );
  expect(
    screen.getByText("Kết nối Google Workspace để tải file này."),
  ).toBeInTheDocument();
  expect(screen.getByText("Trình đọc Google Workspace")).toBeInTheDocument();
  expect(screen.getByText("Chưa kết nối")).toBeInTheDocument();
  expect(screen.getByText("Thẻ tài liệu")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Kết nối Google Workspace" }),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Connect Google Workspace/)).toBeNull();
});

test.each([
  ["auth-required", "Hãy đăng nhập tài khoản Readlace trong popup tiện ích."],
  [
    "sheets-reader-unavailable",
    "Sắp có tính năng đọc trực tiếp Google Sheets. Tệp → Tải xuống → Microsoft Excel (.xlsx), rồi mở bằng trình đọc bảng tính.",
  ],
] as const)(
  "maps the %s error code to its Vietnamese message at render",
  async (error, message) => {
    mockRuntime((request) => ({
      type: "WORKSPACE_READER_CONTEXT",
      requestId: request.requestId,
      ok: false,
      error,
    }));
    render(
      <UiLocaleScope locale="vi">
        <App />
      </UiLocaleScope>,
    );
    expect(await screen.findByText(message)).toBeInTheDocument();
    if (error === "sheets-reader-unavailable")
      expect(
        screen.getByRole("button", { name: "Mở file bảng tính" }),
      ).toBeInTheDocument();
  },
);

test("Vietnamese Reader counts use the plural rules and digits of vi-VN", () => {
  const vi = readerMessages.translator("vi");
  const en = readerMessages.translator("en");
  expect(
    vi.t("workspace.status.discoveringColumns", { scanned: 1234, total: 5000 }),
  ).toBe("Đang dò cột 1.234/5.000…");
  expect(vi.t("workspace.status.recordsLoaded", { count: 1 })).toBe(
    "Đã tải 1 mục.",
  );
  expect(en.t("workspace.status.recordsLoaded", { count: 1 })).toBe(
    "1 record loaded.",
  );
  expect(en.t("workspace.status.recordsLoaded", { count: 0 })).toBe(
    "0 records loaded.",
  );
  expect(en.t("workspace.error.sheetsReaderUnavailable")).toBe(
    `${en.t("notice.sheetsComingSoon")} ${en.t("notice.sheetsDownloadSteps")}`,
  );
  expect(en.t("workspace.error.officeDownloadRequired")).toBe(
    `${en.t("notice.officeDownloadRequired")} ${en.t("notice.sheetsDownloadSteps")}`,
  );
});
