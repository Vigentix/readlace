import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const {
  readerPreferences,
  readPreferences,
  savePreferences,
  takeIntent,
  validateIntent,
} = vi.hoisted(() => {
  const readerPreferences = { targetLanguage: "vi" };
  return {
    readerPreferences,
    readPreferences: vi.fn(async () => ({ ...readerPreferences })),
    savePreferences: vi.fn(async (patch: Record<string, string>) => {
      Object.assign(readerPreferences, patch);
    }),
    takeIntent: vi.fn(async () => undefined),
    validateIntent: vi.fn(async () => true),
  };
});
vi.mock("@/lib/reader-preferences", () => ({
  readReaderPreferences: readPreferences,
  saveReaderPreferences: savePreferences,
}));
vi.mock("@/lib/workspace-reader-intent", () => ({
  takeReaderIntent: takeIntent,
  readerIntentIsCurrent: validateIntent,
}));
// Product events (ADR 0017) use their own channel; keep them out of the
// Reader's sendMessage protocol assertions.

import {
  MAX_LOCAL_MERGES,
  type LocalSpreadsheetMetadata,
  type LocalSpreadsheetSelection,
  type LocalSpreadsheetWorkerRequest,
} from "@/lib/local-spreadsheet";
import {
  parseLocalSpreadsheetTranslateRequest,
  type LocalSpreadsheetTranslateRequest,
  type LocalSpreadsheetTranslateResponse,
} from "@/lib/local-spreadsheet-reader";
import {
  GOOGLE_DRIVE_OFFICE_XLSX_MIME,
  encodeGoogleDriveOfficeChunk,
  type GoogleDriveOfficeStartRequest,
} from "@/lib/google-drive-office-reader";
import type {
  WorkspaceReaderRequest,
  WorkspaceSheetCell,
  WorkspaceSheetGrid,
  WorkspaceSheetPage,
} from "@/lib/google-workspace-reader";
import { defaultWorkspaceSheetCellStyle } from "@/lib/google-workspace-reader";
import { UiLocaleScope } from "@/lib/i18n/react";
import LocalSpreadsheetReader, {
  type DriveOfficePortLike,
  type LocalSpreadsheetWorkerLike,
} from "./LocalSpreadsheetReader";

vi.mock("./SheetsGrid", async () => {
  const { useEffect } = await import("react");
  function MockSheetsGrid(props: {
    grid: WorkspaceSheetGrid;
    pages: WorkspaceSheetPage[];
    translations: ReadonlyMap<string, string>;
    presentation: string;
    includeNextViewport?: boolean;
    onNearPageEnd: (startRow?: number) => void;
    onViewportRecordsChange: (ids: string[]) => void;
  }) {
    const {
      grid,
      pages,
      translations,
      presentation,
      includeNextViewport = true,
      onNearPageEnd,
      onViewportRecordsChange,
    } = props;
    const currentPageStart = Math.min(...pages.map((page) => page.startRow));
    const visibleKey = pages
      .filter(
        (page) => includeNextViewport || page.startRow === currentPageStart,
      )
      .flatMap((page) =>
        page.rows.flatMap((row) =>
          row.cells.filter((cell) => cell.translatable).map((cell) => cell.id),
        ),
      )
      .join(",");
    useEffect(() => {
      onViewportRecordsChange(visibleKey ? visibleKey.split(",") : []);
    }, [grid.generation, onViewportRecordsChange, visibleKey]);
    return (
      <div data-testid="grid">
        <span>{grid.title}</span>
        <span data-testid="presentation">{presentation}</span>
        <span data-testid="translations">
          {JSON.stringify([...translations])}
        </span>
        <span data-testid="page-starts">
          {pages.map((page) => page.startRow).join(",")}
        </span>
        <button type="button" onClick={() => onNearPageEnd(100)}>
          Load page 100
        </button>
        <button
          type="button"
          onClick={() =>
            onViewportRecordsChange(
              pages
                .find((page) => page.startRow === 100)
                ?.rows.flatMap((row) =>
                  row.cells
                    .filter((cell) => cell.translatable)
                    .map((cell) => cell.id),
                ) ?? [],
            )
          }
        >
          Show page 100 viewport
        </button>
        <button
          type="button"
          onClick={() =>
            onViewportRecordsChange(
              pages
                .find((page) => page.startRow === 0)
                ?.rows.flatMap((row) =>
                  row.cells
                    .filter((cell) => cell.translatable)
                    .map((cell) => cell.id),
                ) ?? [],
            )
          }
        >
          Show first viewport
        </button>
      </div>
    );
  }
  return {
    default: MockSheetsGrid,
  };
});

class FakeWorker implements LocalSpreadsheetWorkerLike {
  listeners = new Set<(event: MessageEvent<unknown>) => void>();
  messages: {
    message: LocalSpreadsheetWorkerRequest;
    transfer?: Transferable[];
  }[] = [];
  terminated = false;

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ) {
    this.listeners.delete(listener);
  }

  postMessage(
    message: LocalSpreadsheetWorkerRequest,
    transfer?: Transferable[],
  ) {
    this.messages.push({ message, transfer });
  }

  terminate() {
    this.terminated = true;
  }

  emit(data: unknown) {
    for (const listener of this.listeners)
      listener({ data } as MessageEvent<unknown>);
  }
}

class FakePort implements DriveOfficePortLike {
  messages: unknown[] = [];
  disconnected = false;
  messageListeners = new Set<(message: unknown) => void>();
  disconnectListeners = new Set<() => void>();
  onMessage = {
    addListener: (listener: (message: unknown) => void) =>
      this.messageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) =>
      this.messageListeners.delete(listener),
  };
  onDisconnect = {
    addListener: (listener: () => void) =>
      this.disconnectListeners.add(listener),
    removeListener: (listener: () => void) =>
      this.disconnectListeners.delete(listener),
  };

  postMessage(message: unknown) {
    this.messages.push(message);
  }

  disconnect() {
    this.disconnected = true;
  }

  emit(message: unknown) {
    for (const listener of this.messageListeners) listener(message);
  }

  interrupt() {
    for (const listener of this.disconnectListeners) listener();
  }
}

const style: WorkspaceSheetCell["style"] = defaultWorkspaceSheetCellStyle();

function cell(
  id: string,
  anchor: string,
  source: string,
  overrides: Partial<WorkspaceSheetCell> = {},
): WorkspaceSheetCell {
  const rowIndex = Number(/\d+$/.exec(anchor)![0]) - 1;
  const columnIndex = anchor.charCodeAt(0) - 65;
  return {
    id,
    anchor,
    source,
    display: source,
    kind: "text",
    translatable: true,
    sourceHash: "a".repeat(40),
    rowIndex,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    style,
    ...overrides,
  };
}

function selection(
  sheetIndex = 0,
  generation = 1,
  sheetName = sheetIndex === 0 ? "Main" : "Second",
): LocalSpreadsheetSelection {
  const cells =
    sheetIndex === 0
      ? [
          cell("local:0:A1", "A1", "Hello"),
          cell("local:0:B1", "B1", "=A2", {
            display: "Cached formula text",
            kind: "formula",
            sourceHash: "b".repeat(40),
          }),
          cell("local:0:A2", "A2", "42", {
            display: "42",
            kind: "number",
            translatable: false,
            sourceHash: "c".repeat(40),
            rowIndex: 1,
          }),
        ]
      : [
          cell("local:1:A1", "A1", "Second text", {
            sourceHash: "d".repeat(40),
          }),
        ];
  const grid: WorkspaceSheetGrid = {
    sheetId: `local:${sheetIndex}`,
    title: sheetName,
    generation,
    rowCount: 150,
    lastUsedColumn: 1,
    columns: [
      { index: 0, pixelSize: 100, hidden: false },
      { index: 1, pixelSize: 100, hidden: false },
    ],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    hideGridlines: false,
    defaultStyle: defaultWorkspaceSheetCellStyle(),
    defaultRowPixelSize: 21,
    defaultColumnPixelSize: 100,
    merges: [],
  };
  const page: WorkspaceSheetPage = {
    sheetId: grid.sheetId,
    generation,
    startRow: 0,
    rowCount: 100,
    rows: [
      { index: 0, pixelSize: 21, hidden: false, cells: cells.slice(0, 2) },
      ...(cells[2]
        ? [{ index: 1, pixelSize: 21, hidden: false, cells: [cells[2]] }]
        : []),
    ],
    cursor: { kind: "sheets", nextRow: 100 },
  };
  return { sheetIndex, sheetName, grid, page };
}

function emptySelection(
  sheetIndex = 0,
  generation = 1,
  sheetName = sheetIndex === 0 ? "Main" : "Second",
): LocalSpreadsheetSelection {
  const grid: WorkspaceSheetGrid = {
    sheetId: `local:${sheetIndex}`,
    title: sheetName,
    generation,
    rowCount: 1,
    lastUsedColumn: -1,
    columns: [],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    hideGridlines: false,
    defaultStyle: defaultWorkspaceSheetCellStyle(),
    defaultRowPixelSize: 21,
    defaultColumnPixelSize: 100,
    merges: [],
  };
  return {
    sheetIndex,
    sheetName,
    grid,
    page: {
      sheetId: grid.sheetId,
      generation,
      startRow: 0,
      rowCount: 1,
      rows: [],
      cursor: null,
    },
  };
}

const metadata: LocalSpreadsheetMetadata = {
  fileName: "book.xlsx",
  sheets: [
    { index: 0, name: "Main" },
    { index: 1, name: "Second" },
  ],
};

function localFile(name = "book.xlsx", contents = "test") {
  const bytes = new TextEncoder().encode(contents).buffer;
  const file = new File([bytes], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn(async () => bytes.slice(0)),
  });
  return file;
}

function delayedFile(name: string) {
  let resolve!: (bytes: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>((done) => {
    resolve = done;
  });
  const file = new File(["pending"], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: vi.fn(() => bytes),
  });
  return { file, resolve };
}

const driveSource = {
  kind: "drive-office" as const,
  sourceTabId: 7,
  version: { backgroundEpoch: "epoch-1", sourceRevision: 3 },
};

async function driveStart(port: FakePort, expectedSource = driveSource) {
  await act(async () => undefined);
  await waitFor(() => expect(port?.messages).not.toHaveLength(0));
  const request = port.messages[0] as GoogleDriveOfficeStartRequest;
  expect(request).toEqual({
    type: "GOOGLE_DRIVE_OFFICE_START",
    readerInstanceId: expect.any(String),
    requestId: expect.any(Number),
    sourceTabId: expectedSource.sourceTabId,
    version: expectedSource.version,
  });
  return request;
}

function contextResponse(message: unknown, version = driveSource.version) {
  const request = message as Extract<
    WorkspaceReaderRequest,
    { type: "WORKSPACE_READER_CONTEXT" }
  >;
  return {
    type: request.type,
    readerInstanceId: request.readerInstanceId,
    requestId: request.requestId,
    version,
    ok: true,
    configured: true,
    connected: true,
    context: {
      kind: "sheets",
      sourceTabId: request.sourceTabId,
      fileId: "office-file",
      activeId: "1",
    },
    targetLanguage: "vi",
  };
}

test("renews a restarted worker lease only for the identified Drive file", async () => {
  const version = { backgroundEpoch: "worker-restarted", sourceRevision: 0 };
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => contextResponse(message, version) as never,
  );
  const port = new FakePort();
  render(
    <LocalSpreadsheetReader
      source={{ ...driveSource, fileId: "office-file" }}
      portFactory={() => port}
    />,
  );
  await driveStart(port, { ...driveSource, version });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("does not renew a worker lease onto another file", async () => {
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      const response = contextResponse(message, {
        backgroundEpoch: "worker-restarted",
        sourceRevision: 0,
      });
      return {
        ...response,
        context: { ...response.context, fileId: "different-file" },
      } as never;
    },
  );
  const portFactory = vi.fn(() => new FakePort());
  render(
    <LocalSpreadsheetReader
      source={{ ...driveSource, fileId: "office-file" }}
      portFactory={portFactory}
    />,
  );
  await screen.findByRole("alert");
  expect(portFactory).not.toHaveBeenCalled();
});

function driveEnvelope(request: GoogleDriveOfficeStartRequest) {
  return {
    readerInstanceId: request.readerInstanceId,
    requestId: request.requestId,
    sourceTabId: request.sourceTabId,
    version: request.version,
  };
}

function driveMetadata(
  request: GoogleDriveOfficeStartRequest,
  byteLength: number,
  overrides: Partial<{
    fileName: string;
    modifiedTime: string;
    md5Checksum: string | null;
  }> = {},
) {
  return {
    type: "GOOGLE_DRIVE_OFFICE_METADATA",
    ...driveEnvelope(request),
    fileName: "drive-book.xlsx",
    mimeType: GOOGLE_DRIVE_OFFICE_XLSX_MIME,
    byteLength,
    modifiedTime: "2026-09-28T00:00:00Z",
    md5Checksum: "a".repeat(32),
    ...overrides,
  };
}

function completeDriveDownload(
  port: FakePort,
  request: GoogleDriveOfficeStartRequest,
  contents: string,
  overrides?: Parameters<typeof driveMetadata>[2],
) {
  const bytes = new TextEncoder().encode(contents);
  act(() => {
    port.emit(driveMetadata(request, bytes.byteLength, overrides));
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_CHUNK",
      ...driveEnvelope(request),
      sequence: 0,
      data: encodeGoogleDriveOfficeChunk(bytes),
    });
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_COMPLETE",
      ...driveEnvelope(request),
      chunkCount: 1,
      byteLength: bytes.byteLength,
    });
  });
  return bytes;
}

function emitRuntimeMessage(message: unknown) {
  for (const [listener] of vi.mocked(browser.runtime.onMessage.addListener).mock
    .calls) {
    (listener as (message: unknown) => void)(message);
  }
}

async function chooseFile(file = localFile()) {
  fireEvent.change(screen.getByLabelText("Open local spreadsheet"), {
    target: { files: [file] },
  });
  await act(async () => undefined);
}

function parseRequest(worker: FakeWorker) {
  const request = worker.messages.at(-1)!.message;
  if (request.type !== "parse") throw new Error("Expected parse request");
  return request;
}

function translateRequest(value: unknown) {
  const request = parseLocalSpreadsheetTranslateRequest(value);
  if (!request) throw new Error("Expected local spreadsheet translate request");
  return request;
}

async function finishParse(worker: FakeWorker, selected = selection()) {
  const request = parseRequest(worker);
  act(() =>
    worker.emit({
      type: "parsed",
      requestId: request.requestId,
      metadata: { ...metadata, fileName: request.fileName },
      sheet: selected,
    }),
  );
  await screen.findByTestId("grid");
}

async function beginSecondSheetSelection(worker: FakeWorker) {
  await userEvent.click(screen.getByRole("combobox", { name: "Worksheet" }));
  await userEvent.click(await screen.findByRole("option", { name: "Second" }));
  const request = worker.messages.at(-1)!.message;
  if (request.type !== "select-sheet")
    throw new Error("Expected sheet request");
  return request;
}

beforeEach(() => {
  Object.assign(readerPreferences, {
    targetLanguage: "vi",
  });
  readPreferences.mockImplementation(async () => ({ ...readerPreferences }));
  savePreferences.mockImplementation(async (patch) => {
    Object.assign(readerPreferences, patch);
  });
  takeIntent.mockResolvedValue(undefined);
  validateIntent.mockResolvedValue(true);
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      (message as { type?: string }).type === "WORKSPACE_READER_CONTEXT"
        ? contextResponse(message)
        : undefined,
  );
  window.history.replaceState({}, "", "/reader.html?local=1");
  vi.spyOn(browser.runtime.onMessage, "addListener").mockImplementation(
    () => undefined,
  );
  vi.spyOn(browser.runtime.onMessage, "removeListener").mockImplementation(
    () => undefined,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

test("downloads an ordered Drive workbook without a picker and transfers one complete buffer to the Worker", async () => {
  const port = new FakePort();
  const worker = new FakeWorker();
  const { container } = render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
    />,
  );

  expect(
    screen.queryByLabelText("Open local spreadsheet"),
  ).not.toBeInTheDocument();
  expect(screen.getAllByText("Drive · read-only")).toHaveLength(2);
  expect(container.querySelector(".local-dropzone")).not.toBeInTheDocument();
  expect(await screen.findByText("Discovering worksheet…")).toBeInTheDocument();
  expect(
    container.querySelector(".spreadsheet-grid-skeleton"),
  ).toBeInTheDocument();
  const request = await driveStart(port);
  const bytes = new TextEncoder().encode("workbook");
  act(() => {
    port.emit(driveMetadata(request, bytes.byteLength));
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_CHUNK",
      ...driveEnvelope(request),
      sequence: 0,
      data: encodeGoogleDriveOfficeChunk(bytes.subarray(0, 4)),
    });
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_CHUNK",
      ...driveEnvelope(request),
      sequence: 1,
      data: encodeGoogleDriveOfficeChunk(bytes.subarray(4)),
    });
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_COMPLETE",
      ...driveEnvelope(request),
      chunkCount: 2,
      byteLength: bytes.byteLength,
    });
  });

  const parse = parseRequest(worker);
  expect(Array.from(new Uint8Array(parse.bytes))).toEqual(Array.from(bytes));
  expect(worker.messages).toHaveLength(1);
  expect(worker.messages[0]!.transfer).toEqual([parse.bytes]);
  expect(port.disconnected).toBe(true);
  await finishParse(worker);
  expect(screen.getByText("Google Drive file")).toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Worksheet" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Disconnect Google" }),
  ).toBeEnabled();
});

test("exits a changed source during parsing and rejects the delayed Worker result", async () => {
  const port = new FakePort();
  const worker = new FakeWorker();
  const onExit = vi.fn();
  const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
  const view = render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
      onExitDriveOffice={onExit}
    />,
  );
  const request = await driveStart(port);
  completeDriveDownload(port, request, "old snapshot");
  const parse = parseRequest(worker);

  act(() => {
    emitRuntimeMessage({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: 8,
      version: { ...driveSource.version, sourceRevision: 4 },
    });
    emitRuntimeMessage({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: driveSource.sourceTabId,
      version: driveSource.version,
    });
  });
  expect(worker.terminated).toBe(false);
  expect(onExit).not.toHaveBeenCalled();

  act(() =>
    emitRuntimeMessage({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: driveSource.sourceTabId,
      version: { ...driveSource.version, sourceRevision: 4 },
    }),
  );
  expect(worker.terminated).toBe(true);
  expect(onExit).toHaveBeenCalledOnce();
  act(() =>
    worker.emit({
      type: "parsed",
      requestId: parse.requestId,
      metadata,
      sheet: selection(0, 1, "Old Snapshot"),
    }),
  );
  expect(screen.queryByTestId("grid")).toBeNull();
  expect(sendMessage).toHaveBeenCalledOnce();
  const listener = vi
    .mocked(browser.runtime.onMessage.addListener)
    .mock.calls.at(-1)![0];
  view.unmount();
  expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledWith(
    listener,
  );
});

test("Refresh paints only the changed Drive snapshot and ignores the old parse", async () => {
  const ports: FakePort[] = [];
  const workers: FakeWorker[] = [];
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => {
        const port = new FakePort();
        ports.push(port);
        return port;
      }}
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );

  await act(async () => undefined);
  const first = await driveStart(ports[0]!);
  completeDriveDownload(ports[0]!, first, "old bytes", {
    modifiedTime: "2026-09-28T00:00:00Z",
    md5Checksum: "a".repeat(32),
  });
  const oldParse = parseRequest(workers[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(ports).toHaveLength(2));
  expect(workers[0]!.terminated).toBe(true);

  const second = await driveStart(ports[1]!);
  expect(second.readerInstanceId).not.toBe(first.readerInstanceId);
  const newBytes = completeDriveDownload(ports[1]!, second, "new bytes", {
    modifiedTime: "2026-09-28T00:01:00Z",
    md5Checksum: "b".repeat(32),
  });
  const newParse = parseRequest(workers[1]!);
  expect(Array.from(new Uint8Array(newParse.bytes))).toEqual(
    Array.from(newBytes),
  );

  act(() =>
    workers[0]!.emit({
      type: "parsed",
      requestId: oldParse.requestId,
      metadata: {
        fileName: oldParse.fileName,
        sheets: [{ index: 0, name: "Old Snapshot" }],
      },
      sheet: selection(0, 1, "Old Snapshot"),
    }),
  );
  expect(screen.queryByTestId("grid")).toBeNull();

  act(() =>
    workers[1]!.emit({
      type: "parsed",
      requestId: newParse.requestId,
      metadata: {
        fileName: newParse.fileName,
        sheets: [{ index: 0, name: "New Snapshot" }],
      },
      sheet: selection(0, 2, "New Snapshot"),
    }),
  );
  expect(await screen.findByTestId("grid")).toHaveTextContent("New Snapshot");
  expect(screen.queryByText("Old Snapshot")).toBeNull();
});

test("Refresh returns to the worksheet the user was reading", async () => {
  const ports: FakePort[] = [];
  const workers: FakeWorker[] = [];
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => {
        const port = new FakePort();
        ports.push(port);
        return port;
      }}
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await act(async () => undefined);
  const first = await driveStart(ports[0]!);
  completeDriveDownload(ports[0]!, first, "bytes");
  await finishParse(workers[0]!);
  await beginSecondSheetSelection(workers[0]!);
  const sheetRequest = workers[0]!.messages.at(-1)!.message;
  if (sheetRequest.type !== "select-sheet") throw new Error("sheet request");
  act(() =>
    workers[0]!.emit({
      type: "sheet",
      requestId: sheetRequest.requestId,
      sheet: selection(1, 2),
    }),
  );
  expect(await screen.findByTestId("grid")).toHaveTextContent("Second");

  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(ports).toHaveLength(2));
  const second = await driveStart(ports[1]!);
  completeDriveDownload(ports[1]!, second, "new bytes");
  const parse = parseRequest(workers[1]!);
  act(() =>
    workers[1]!.emit({
      type: "parsed",
      requestId: parse.requestId,
      metadata: { ...metadata, fileName: parse.fileName },
      sheet: selection(0, 3),
    }),
  );
  const restore = workers[1]!.messages.at(-1)!.message;
  expect(restore).toMatchObject({ type: "select-sheet", sheetIndex: 1 });
});

test("a background restart notice keeps the loaded Reader view", async () => {
  const port = new FakePort();
  const worker = new FakeWorker();
  const onExit = vi.fn();
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
      onExitDriveOffice={onExit}
    />,
  );
  const request = await driveStart(port);
  completeDriveDownload(port, request, "bytes");
  await finishParse(worker);
  act(() =>
    emitRuntimeMessage({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: driveSource.sourceTabId,
      version: {
        backgroundEpoch: "e0e0e0e0-0000-4000-8000-000000000000",
        sourceRevision: 0,
      },
    }),
  );
  expect(onExit).not.toHaveBeenCalled();
  expect(screen.getByTestId("grid")).toBeInTheDocument();
});

test.each([
  [
    "stale owner",
    (request: GoogleDriveOfficeStartRequest) => ({
      ...driveMetadata(request, 1),
      sourceTabId: request.sourceTabId + 1,
    }),
  ],
  [
    "out-of-order chunk",
    (request: GoogleDriveOfficeStartRequest) => [
      driveMetadata(request, 1),
      {
        type: "GOOGLE_DRIVE_OFFICE_CHUNK",
        ...driveEnvelope(request),
        sequence: 1,
        data: encodeGoogleDriveOfficeChunk(new Uint8Array([1])),
      },
    ],
  ],
  [
    "byte overflow",
    (request: GoogleDriveOfficeStartRequest) => [
      driveMetadata(request, 1),
      {
        type: "GOOGLE_DRIVE_OFFICE_CHUNK",
        ...driveEnvelope(request),
        sequence: 0,
        data: encodeGoogleDriveOfficeChunk(new Uint8Array([1, 2])),
      },
    ],
  ],
] as const)("rejects %s before parsing", async (_name, messages) => {
  const port = new FakePort();
  const workerFactory = vi.fn(() => new FakeWorker());
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={workerFactory}
    />,
  );
  const request = await driveStart(port);
  const emitted = messages(request);
  act(() => {
    for (const message of Array.isArray(emitted) ? emitted : [emitted])
      port.emit(message);
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid Drive download response",
  );
  expect(workerFactory).not.toHaveBeenCalled();
  expect(port.disconnected).toBe(true);
});

test("shows a structural Drive error without parsing or falling back to upload", async () => {
  const port = new FakePort();
  const workerFactory = vi.fn(() => new FakeWorker());
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={workerFactory}
    />,
  );
  const request = await driveStart(port);
  act(() =>
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_ERROR",
      ...driveEnvelope(request),
      error: "download-not-allowed",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not allow this file to be downloaded",
  );
  expect(screen.queryByLabelText("Open local spreadsheet")).toBeNull();
  expect(document.querySelector(".local-dropzone")).toBeNull();
  expect(
    screen.getByText(/does not allow this file to be downloaded/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Clear view" })).toBeEnabled();
  const connectionArea = document.querySelector(
    ".spreadsheet-connection-footer",
  );
  expect(connectionArea).not.toBeNull();
  expect(
    within(connectionArea as HTMLElement).getByText("Google Workspace"),
  ).toBeVisible();
  expect(
    within(connectionArea as HTMLElement).getByRole("button", {
      name: "Disconnect Google",
    }),
  ).toBeEnabled();
  expect(workerFactory).not.toHaveBeenCalled();
});

test("keeps Disconnect in the Drive connection area beside a separate Reconnect action", async () => {
  const port = new FakePort();
  render(
    <LocalSpreadsheetReader source={driveSource} portFactory={() => port} />,
  );
  const request = await driveStart(port);
  act(() =>
    port.emit({
      type: "GOOGLE_DRIVE_OFFICE_ERROR",
      ...driveEnvelope(request),
      error: "google-oauth-scope",
    }),
  );

  expect(
    await screen.findByRole("button", {
      name: "Reconnect Google Workspace",
    }),
  ).toBeEnabled();
  const connectionArea = document.querySelector(
    ".spreadsheet-connection-footer",
  );
  expect(
    within(connectionArea as HTMLElement).getByRole("button", {
      name: "Disconnect Google",
    }),
  ).toBeEnabled();
});

test("settles a Drive port creation failure without parsing or showing a picker", async () => {
  const workerFactory = vi.fn(() => new FakeWorker());
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => {
        throw new Error("Port unavailable");
      }}
      workerFactory={workerFactory}
    />,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Reader could not connect to the extension background",
  );
  expect(screen.queryByLabelText("Open local spreadsheet")).toBeNull();
  expect(workerFactory).not.toHaveBeenCalled();
});

test("keeps a loaded Drive workbook recoverable when global Disconnect fails", async () => {
  const port = new FakePort();
  const worker = new FakeWorker();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) =>
      (message as { type?: string }).type === "WORKSPACE_READER_CONTEXT"
        ? contextResponse(message)
        : undefined,
  );
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
    />,
  );
  const request = await driveStart(port);
  completeDriveDownload(port, request, "workbook");
  await finishParse(worker);

  await userEvent.click(
    screen.getByRole("button", { name: "Disconnect Google" }),
  );

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not disconnect",
  );
  expect(screen.getByTestId("grid")).toHaveTextContent("Main");
  expect(worker.terminated).toBe(false);
  expect(
    screen.getByRole("button", { name: "Disconnect Google" }),
  ).toBeEnabled();
});

test("cancels stale downloads on Clear, Refresh, source exit and unmount", async () => {
  const ports: FakePort[] = [];
  const onExit = vi.fn();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      if ((message as { type?: string }).type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(message, {
          ...driveSource.version,
          sourceRevision:
            (message as unknown as { requestId: number }).requestId < 5
              ? 3
              : (message as unknown as { requestId: number }).requestId < 8
                ? 4
                : 5,
        });
      const request = message as unknown as Extract<
        WorkspaceReaderRequest,
        { type: "WORKSPACE_READER_DISCONNECT" }
      >;
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        version: request.version,
        ok: true,
        connected: false,
      };
    },
  );
  const view = render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => {
        const port = new FakePort();
        ports.push(port);
        return port;
      }}
      onExitDriveOffice={onExit}
    />,
  );
  await act(async () => undefined);
  const first = await driveStart(ports[0]!);
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  expect(ports[0]!.messages.at(-1)).toEqual({
    ...first,
    type: "GOOGLE_DRIVE_OFFICE_CANCEL",
  });
  expect(ports[0]!.disconnected).toBe(true);

  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(ports).toHaveLength(2));
  const second = await driveStart(ports[1]!);
  act(() => ports[0]!.emit(driveMetadata(first, 1)));
  expect(screen.getByText("Discovering worksheet…")).toBeInTheDocument();

  const replacementSource = {
    ...driveSource,
    version: { ...driveSource.version, sourceRevision: 4 },
  };
  view.rerender(
    <LocalSpreadsheetReader
      source={replacementSource}
      portFactory={() => {
        const port = new FakePort();
        ports.push(port);
        return port;
      }}
      onExitDriveOffice={onExit}
    />,
  );
  await waitFor(() => expect(ports).toHaveLength(3));
  expect(ports[1]!.messages.at(-1)).toEqual({
    ...second,
    type: "GOOGLE_DRIVE_OFFICE_CANCEL",
  });
  const third = await driveStart(ports[2]!, replacementSource);

  await userEvent.click(
    screen.getByRole("button", { name: "Disconnect Google" }),
  );
  expect(ports[2]!.messages.at(-1)).toEqual({
    ...third,
    type: "GOOGLE_DRIVE_OFFICE_CANCEL",
  });
  await waitFor(() => expect(onExit).toHaveBeenCalledOnce());

  view.rerender(
    <LocalSpreadsheetReader
      source={{
        ...replacementSource,
        version: { ...driveSource.version, sourceRevision: 5 },
      }}
      portFactory={() => {
        const port = new FakePort();
        ports.push(port);
        return port;
      }}
    />,
  );
  await waitFor(() => expect(ports).toHaveLength(4));
  const fourth = await driveStart(ports[3]!, {
    ...replacementSource,
    version: { ...driveSource.version, sourceRevision: 5 },
  });
  view.unmount();
  expect(ports[3]!.messages.at(-1)).toEqual({
    ...fourth,
    type: "GOOGLE_DRIVE_OFFICE_CANCEL",
  });
  expect(ports[3]!.disconnected).toBe(true);
});

test("stops an interrupted or timed-out Drive download before parsing", async () => {
  vi.useFakeTimers();
  const ports = [new FakePort(), new FakePort()];
  let next = 0;
  const workerFactory = vi.fn(() => new FakeWorker());
  const view = render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => ports[next++]!}
      workerFactory={workerFactory}
    />,
  );
  await act(async () => undefined);
  act(() => ports[0]!.interrupt());
  expect(screen.getByRole("alert")).toHaveTextContent("extension background");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => undefined);
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(screen.getByRole("alert")).toHaveTextContent("longer than 30 seconds");
  expect(workerFactory).not.toHaveBeenCalled();
  expect(ports[1]!.disconnected).toBe(true);
  view.unmount();
});

test("opens picked and dropped files locally and transfers only their ArrayBuffer", async () => {
  const workers: FakeWorker[] = [];
  render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );

  expect(
    screen.getByText(/File bytes stay on this device/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/visible cell text is sent to Readlace for translation/),
  ).toBeInTheDocument();
  expect(screen.getByText(/never runs macros/)).toBeInTheDocument();
  await chooseFile();
  const first = workers[0]!;
  const request = parseRequest(first);
  expect(request.fileName).toBe("book.xlsx");
  expect(first.messages[0]!.transfer).toEqual([request.bytes]);
  await finishParse(first);
  expect(screen.getByText("book.xlsx")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Disconnect Google" }),
  ).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  const dropzone = screen
    .getByText("Choose or drop a spreadsheet")
    .closest("label")!;
  fireEvent.drop(dropzone, {
    dataTransfer: { files: [localFile("table.csv")] },
  });
  await waitFor(() => expect(workers).toHaveLength(2));
  expect(first.terminated).toBe(true);
  expect(parseRequest(workers[1]!).fileName).toBe("table.csv");
});

test("rejects an oversized raw merge array before accepting a worker grid", async () => {
  const worker = new FakeWorker();
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  const request = parseRequest(worker);
  const selected = selection();
  act(() =>
    worker.emit({
      type: "parsed",
      requestId: request.requestId,
      metadata,
      sheet: {
        ...selected,
        grid: {
          ...selected.grid,
          merges: Array.from({ length: MAX_LOCAL_MERGES + 1 }, () => ({
            startRow: 0,
            endRow: 1,
            startColumn: 0,
            endColumn: 1,
          })),
        },
      },
    }),
  );
  expect(worker.terminated).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "invalid spreadsheet response",
  );
});

test("accepts and switches empty worksheets without sending translation work", async () => {
  const worker = new FakeWorker();
  const sendMessage = vi
    .spyOn(browser.runtime, "sendMessage")
    .mockImplementation(async () => undefined);
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker, emptySelection());
  expect(screen.getByTestId("grid")).toHaveTextContent("Main");

  const sheetRequest = await beginSecondSheetSelection(worker);
  act(() =>
    worker.emit({
      type: "sheet",
      requestId: sheetRequest.requestId,
      sheet: emptySelection(1, 2),
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("grid")).toHaveTextContent("Second"),
  );
  expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();
  expect(sendMessage).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();

  const clear = screen.getByRole("button", { name: "Clear view" });
  expect(clear).toBeEnabled();
  await userEvent.click(clear);
  expect(screen.getByText("Choose or drop a spreadsheet")).toBeInTheDocument();
});

test("marks oversized visible cells partial without dispatching provider work", async () => {
  const worker = new FakeWorker();
  const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
  const selected = selection();
  const oversizedCell = cell("local:0:A1", "A1", "x".repeat(4_001));
  const oversizedSelection: LocalSpreadsheetSelection = {
    ...selected,
    page: {
      ...selected.page,
      rows: [
        {
          index: 0,
          pixelSize: 21,
          hidden: false,
          cells: [oversizedCell],
        },
      ],
    },
  };
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker, oversizedSelection);

  await userEvent.click(screen.getByRole("button", { name: "Translate" }));

  expect(sendMessage).not.toHaveBeenCalled();
  expect(await screen.findByRole("status")).toHaveTextContent(
    "exceed the 4,000-character translation limit",
  );
  expect(
    screen.getByRole("button", { name: "Retry unresolved" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
});

test("terminates a timed-out parser, replaced file, cleared view and unmounted Reader", async () => {
  vi.useFakeTimers();
  const workers: FakeWorker[] = [];
  const view = render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await chooseFile();
  await act(async () => vi.advanceTimersByTime(15_000));
  expect(workers[0]!.terminated).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent("longer than 15 seconds");
  vi.useRealTimers();

  await chooseFile(localFile("replacement.csv"));
  expect(workers).toHaveLength(2);
  await finishParse(workers[1]!, { ...selection(), sheetName: "Main" });
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  expect(workers[1]!.terminated).toBe(true);

  await chooseFile(localFile("last.xlsx"));
  view.unmount();
  expect(workers[2]!.terminated).toBe(true);
});

test("discards delayed file reads after replacement and unmount", async () => {
  const workers: FakeWorker[] = [];
  const view = render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  const first = delayedFile("first.xlsx");
  await chooseFile(first.file);
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  const dropzone = screen
    .getByText("Choose or drop a spreadsheet")
    .closest("label")!;
  fireEvent.drop(dropzone, {
    dataTransfer: { files: [localFile("replacement.csv")] },
  });
  await waitFor(() => expect(workers).toHaveLength(1));
  expect(parseRequest(workers[0]!).fileName).toBe("replacement.csv");
  await act(async () => {
    first.resolve(new TextEncoder().encode("stale").buffer);
    await Promise.resolve();
  });
  expect(workers).toHaveLength(1);

  view.unmount();
  const unmounted = delayedFile("unmounted.xlsx");
  const secondView = render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await chooseFile(unmounted.file);
  secondView.unmount();
  await act(async () => {
    unmounted.resolve(new TextEncoder().encode("late").buffer);
    await Promise.resolve();
  });
  expect(workers).toHaveLength(1);
});

test("terminates a worksheet selection that exceeds 15 seconds", async () => {
  const worker = new FakeWorker();
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);
  await userEvent.click(screen.getByRole("combobox", { name: "Worksheet" }));
  const option = await screen.findByRole("option", { name: "Second" });
  const realSetTimeout = globalThis.setTimeout;
  let expire!: () => void;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, timeout, ...arguments_) => {
      if (timeout === 15_000) {
        expire = () => handler(...arguments_);
        return realSetTimeout(() => undefined, 60_000);
      }
      return realSetTimeout(handler, timeout, ...arguments_);
    },
  );
  await userEvent.click(option);
  expect(worker.messages.at(-1)!.message.type).toBe("select-sheet");
  act(() => expire());
  expect(worker.terminated).toBe(true);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Worksheet loading took longer than 15 seconds",
  );
});

test("Clear view remains available and terminates a pending worksheet selection", async () => {
  const worker = new FakeWorker();
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);
  await beginSecondSheetSelection(worker);
  const clear = screen.getByRole("button", { name: "Clear view" });
  expect(clear).toBeEnabled();
  await userEvent.click(clear);
  expect(worker.terminated).toBe(true);
  expect(screen.getByText("Choose or drop a spreadsheet")).toBeInTheDocument();
});

test("switches sheets in the retained worker and deduplicates 100-row page loads", async () => {
  const worker = new FakeWorker();
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  const sheetRequest = await beginSecondSheetSelection(worker);
  expect(sheetRequest).toMatchObject({ type: "select-sheet", sheetIndex: 1 });
  expect(
    worker.messages.filter(({ message }) => message.type === "parse"),
  ).toHaveLength(1);
  act(() =>
    worker.emit({
      type: "sheet",
      requestId: sheetRequest.requestId,
      sheet: selection(1, 2),
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("grid")).toHaveTextContent("Second"),
  );

  const load = screen.getByRole("button", { name: "Load page 100" });
  await userEvent.click(load);
  await userEvent.click(load);
  const pageRequests = worker.messages.filter(
    ({ message }) => message.type === "load-page",
  );
  expect(pageRequests).toHaveLength(1);
  const request = pageRequests[0]!.message;
  if (request.type !== "load-page") throw new Error("Expected page request");
  const page: WorkspaceSheetPage = {
    sheetId: "local:1",
    generation: 2,
    startRow: 100,
    rowCount: 50,
    rows: [],
    cursor: null,
  };
  act(() => worker.emit({ type: "page", requestId: request.requestId, page }));
  await waitFor(() =>
    expect(screen.getByTestId("page-starts")).toHaveTextContent("0,100"),
  );
});

test("continues an active translation session after a Reader worksheet change", async () => {
  const worker = new FakeWorker();
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `Translated ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    },
  );
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Translation on" })).toBeDisabled();

  const sheetRequest = await beginSecondSheetSelection(worker);
  act(() =>
    worker.emit({
      type: "sheet",
      requestId: sheetRequest.requestId,
      sheet: selection(1, 2),
    }),
  );

  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]).toMatchObject({
    generation: 2,
    records: [
      {
        id: "local:1:A1",
        sourceHash: "d".repeat(40),
        text: "Second text",
      },
    ],
  });
  // Worker callbacks can queue a drain before React commits the next sheet.
  // Reproduce that ordering rather than letting act flush the queued drain last.
  await userEvent.click(screen.getByRole("combobox", { name: "Worksheet" }));
  await userEvent.click(await screen.findByRole("option", { name: "Main" }));
  const returnRequest = worker.messages.at(-1)!.message;
  if (returnRequest.type !== "select-sheet")
    throw new Error("Expected sheet request");
  const microtask = vi
    .spyOn(globalThis, "queueMicrotask")
    .mockImplementationOnce((callback) => callback());
  act(() =>
    worker.emit({
      type: "sheet",
      requestId: returnRequest.requestId,
      sheet: selection(0, 3),
    }),
  );
  microtask.mockRestore();
  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]).toMatchObject({
    generation: 3,
    records: [{ id: "local:0:A1" }, { id: "local:0:B1" }],
  });
  expect(screen.getByTestId("translations")).toHaveTextContent(
    "Translated Hello",
  );
});

test("translates only visible text using cached formula display and supports Original, Stop and Clear", async () => {
  const worker = new FakeWorker();
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          id: record.id,
          sourceHash: record.sourceHash,
          text: `Translated ${record.text}`,
        })),
      };
    },
  );
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.records).toEqual([
    { id: "local:0:A1", sourceHash: "a".repeat(40), text: "Hello" },
    {
      id: "local:0:B1",
      sourceHash: "b".repeat(40),
      text: "Cached formula text",
    },
  ]);
  expect(Object.keys(requests[0]!)).toEqual([
    "type",
    "readerInstanceId",
    "requestId",
    "generation",
    "targetLanguage",
    "records",
  ]);
  expect(JSON.stringify(requests[0])).not.toContain("book.xlsx");
  expect(JSON.stringify(requests[0])).not.toContain("bytes");
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Translated Cached formula text",
    ),
  );
  const completed = screen.getByRole("button", { name: "Translation on" });
  expect(completed).toBeDisabled();
  fireEvent.click(completed);
  expect(requests).toHaveLength(1);
  expect(screen.getByText(/translations? completed\./)).toHaveClass(
    "reader-sr-only",
  );

  await userEvent.click(screen.getByRole("button", { name: "Original" }));
  expect(screen.getByTestId("presentation")).toHaveTextContent("original");
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(
    screen.getByRole("button", { name: "Resume translation" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  expect(screen.getByText("Choose or drop a spreadsheet")).toBeInTheDocument();
  expect(worker.terminated).toBe(true);
});

test("excludes a cell that exists only in the next viewport from local translation", async () => {
  const worker = new FakeWorker();
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `Translated ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    },
  );
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  await userEvent.click(screen.getByRole("button", { name: "Load page 100" }));
  const pageRequest = worker.messages.at(-1)!.message;
  if (pageRequest.type !== "load-page")
    throw new Error("Expected page request");
  const nextViewport = cell("local:0:A101", "A101", "Next viewport", {
    rowIndex: 100,
    sourceHash: "e".repeat(40),
  });
  act(() =>
    worker.emit({
      type: "page",
      requestId: pageRequest.requestId,
      page: {
        sheetId: "local:0",
        generation: 1,
        startRow: 100,
        rowCount: 50,
        rows: [
          { index: 100, pixelSize: 21, hidden: false, cells: [nextViewport] },
        ],
        cursor: null,
      },
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("page-starts")).toHaveTextContent("0,100"),
  );
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.records.map(({ id }) => id)).not.toContain(
    nextViewport.id,
  );
  expect(requests[0]!.records.map(({ id }) => id)).toEqual([
    "local:0:A1",
    "local:0:B1",
  ]);
});

test("retries only unresolved cells in the current viewport and ignores rapid clicks", async () => {
  const worker = new FakeWorker();
  let resolveFirst!: (value: LocalSpreadsheetTranslateResponse) => void;
  const sendMessage = vi
    .spyOn(browser.runtime, "sendMessage")
    .mockImplementationOnce(
      () =>
        new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          id: record.id,
          sourceHash: record.sourceHash,
          text: `Accepted ${record.text}`,
        })),
      };
    })
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          id: record.id,
          sourceHash: record.sourceHash,
          text: `Accepted ${record.text}`,
        })),
      };
    });
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  const translate = screen.getByRole("button", {
    name: "Translate",
  });
  await userEvent.click(translate);
  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
  expect(translate).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Clear view" })).toBeDisabled();
  for (const select of screen.getAllByRole("combobox"))
    expect(select).toBeDisabled();
  fireEvent.click(translate);
  expect(sendMessage).toHaveBeenCalledTimes(1);

  const first = translateRequest(sendMessage.mock.calls[0]![0]);
  act(() =>
    resolveFirst({
      type: first.type,
      readerInstanceId: first.readerInstanceId,
      requestId: first.requestId,
      generation: first.generation,
      ok: true,
      results: first.records.map((record) => ({
        id: record.id,
        sourceHash: record.sourceHash,
        error: "provider-error",
      })),
    }),
  );
  await waitFor(() => expect(translate).toBeEnabled());
  expect(screen.getByRole("status")).toHaveTextContent(
    "2 cells could not be translated.",
  );
  expect(screen.getByRole("button", { name: "Clear view" })).toBeEnabled();

  await userEvent.click(screen.getByRole("button", { name: "Load page 100" }));
  const pageRequest = worker.messages.at(-1)!.message;
  if (pageRequest.type !== "load-page")
    throw new Error("Expected page request");
  const newVisibleCell = cell("local:0:A101", "A101", "New viewport", {
    rowIndex: 100,
    sourceHash: "e".repeat(40),
  });
  act(() =>
    worker.emit({
      type: "page",
      requestId: pageRequest.requestId,
      page: {
        sheetId: "local:0",
        generation: 1,
        startRow: 100,
        rowCount: 50,
        rows: [
          {
            index: 100,
            pixelSize: 21,
            hidden: false,
            cells: [newVisibleCell],
          },
        ],
        cursor: null,
      },
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Show page 100 viewport" }),
  );
  // A new, never-attempted viewport must not be locked out by the earlier
  // failure: the same button translates it, without re-sending the failed cells.
  const retry = screen.getByRole("button", { name: "Retry unresolved" });
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  expect(
    translateRequest(sendMessage.mock.calls[1]![0]).records.map(({ id }) => id),
  ).toEqual([newVisibleCell.id]);

  await userEvent.click(
    screen.getByRole("button", { name: "Show first viewport" }),
  );
  await waitFor(() => expect(retry).toBeEnabled());
  await userEvent.click(retry);
  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
  expect(translateRequest(sendMessage.mock.calls[2]![0]).records).toEqual(
    first.records,
  );
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Accepted Cached formula text",
    ),
  );
});

test("queues an immediate Resume after Stop until the stale physical request settles", async () => {
  const worker = new FakeWorker();
  let resolveFirst!: (value: LocalSpreadsheetTranslateResponse) => void;
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage")
    .mockImplementationOnce(
      (message) =>
        new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
          requests.push(translateRequest(message));
          resolveFirst = resolve;
        }),
    )
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `Resumed ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    });
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Resume translation" }),
  );
  expect(requests).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();

  const first = requests[0]!;
  act(() =>
    resolveFirst({
      type: first.type,
      readerInstanceId: first.readerInstanceId,
      requestId: first.requestId,
      generation: first.generation,
      ok: true,
      results: first.records.map(({ id, sourceHash }) => ({
        id,
        sourceHash,
        text: "Stale result",
      })),
    }),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Resumed Cached formula text",
    ),
  );
  expect(screen.getByTestId("translations")).not.toHaveTextContent(
    "Stale result",
  );
});

test("drops a pending partial-retry scope when Stop precedes a viewport change", async () => {
  const worker = new FakeWorker();
  let resolveRetry!: (value: LocalSpreadsheetTranslateResponse) => void;
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage")
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash }) => ({
          id,
          sourceHash,
          error: "provider-error",
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    })
    .mockImplementationOnce(
      (message) =>
        new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
          requests.push(translateRequest(message));
          resolveRetry = resolve;
        }),
    )
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `Fresh ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    });
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Retry unresolved" }),
    ).toBeEnabled(),
  );

  await userEvent.click(screen.getByRole("button", { name: "Load page 100" }));
  const pageRequest = worker.messages.at(-1)!.message;
  if (pageRequest.type !== "load-page")
    throw new Error("Expected page request");
  const newVisibleCell = cell("local:0:A101", "A101", "New viewport", {
    rowIndex: 100,
    sourceHash: "e".repeat(40),
  });
  act(() =>
    worker.emit({
      type: "page",
      requestId: pageRequest.requestId,
      page: {
        sheetId: "local:0",
        generation: 1,
        startRow: 100,
        rowCount: 50,
        rows: [
          {
            index: 100,
            pixelSize: 21,
            hidden: false,
            cells: [newVisibleCell],
          },
        ],
        cursor: null,
      },
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("page-starts")).toHaveTextContent("0,100"),
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Retry unresolved" }),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  const staleRetry = requests[1]!;
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Show page 100 viewport" }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Resume translation" }),
  );
  expect(requests).toHaveLength(2);

  act(() =>
    resolveRetry({
      type: staleRetry.type,
      readerInstanceId: staleRetry.readerInstanceId,
      requestId: staleRetry.requestId,
      generation: staleRetry.generation,
      ok: true,
      results: staleRetry.records.map(({ id, sourceHash }) => ({
        id,
        sourceHash,
        text: "Stale retry",
      })),
    }),
  );

  await waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]!.records).toEqual([
    {
      id: newVisibleCell.id,
      sourceHash: newVisibleCell.sourceHash,
      text: newVisibleCell.source,
    },
  ]);
  expect(requests[2]!.records.map(({ id }) => id)).not.toEqual(
    staleRetry.records.map(({ id }) => id),
  );
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Fresh New viewport",
    ),
  );
  expect(screen.getByTestId("translations")).not.toHaveTextContent(
    "Stale retry",
  );
});

test("rotates translation ownership when a lower-generation workbook replaces a cleared file", async () => {
  const workers: FakeWorker[] = [];
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  const generations = new Map<string, number>();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      const previous = generations.get(request.readerInstanceId);
      if (previous !== undefined && request.generation < previous) {
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          generation: request.generation,
          ok: false,
          error: "invalid-request",
        } satisfies LocalSpreadsheetTranslateResponse;
      }
      generations.set(request.readerInstanceId, request.generation);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `Accepted ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    },
  );
  render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await chooseFile();
  await finishParse(workers[0]!, selection(0, 2));
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));

  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  await chooseFile(localFile("new.xlsx"));
  await finishParse(workers[1]!, selection(0, 1));
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests.map(({ generation }) => generation)).toEqual([2, 1]);
  expect(requests[1]!.readerInstanceId).not.toBe(requests[0]!.readerInstanceId);
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Accepted Cached formula text",
    ),
  );
});

test("queues a new-file translation until the deferred old request settles", async () => {
  const workers: FakeWorker[] = [];
  let resolveOld!: (value: LocalSpreadsheetTranslateResponse) => void;
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage")
    .mockImplementationOnce(
      (message) =>
        new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
          requests.push(translateRequest(message));
          resolveOld = resolve;
        }),
    )
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `New ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    });
  render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await chooseFile();
  await finishParse(workers[0]!, selection(0, 2));
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  const old = requests[0]!;

  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  await chooseFile(localFile("new.xlsx"));
  await finishParse(workers[1]!, selection(0, 1));
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();
  expect(requests).toHaveLength(1);

  act(() =>
    resolveOld({
      type: old.type,
      readerInstanceId: old.readerInstanceId,
      requestId: old.requestId,
      generation: old.generation,
      ok: true,
      results: old.records.map(({ id, sourceHash }) => ({
        id,
        sourceHash,
        text: "Old result",
      })),
    }),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "New Cached formula text",
    ),
  );
  expect(screen.getByTestId("translations")).not.toHaveTextContent(
    "Old result",
  );
});

test("holds a queued new-file translation through the watchdog until the old physical request settles", async () => {
  const workers: FakeWorker[] = [];
  let resolveOld!: (value: LocalSpreadsheetTranslateResponse) => void;
  const requests: LocalSpreadsheetTranslateRequest[] = [];
  vi.spyOn(browser.runtime, "sendMessage")
    .mockImplementationOnce(
      (message) =>
        new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
          requests.push(translateRequest(message));
          resolveOld = resolve;
        }),
    )
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      requests.push(request);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash, text }) => ({
          id,
          sourceHash,
          text: `After timeout ${text}`,
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    });
  render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await chooseFile();
  await finishParse(workers[0]!, selection(0, 2));
  const realSetTimeout = globalThis.setTimeout;
  let expire!: () => void;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, timeout, ...arguments_) => {
      if (timeout === 30_000) {
        expire = () => handler(...arguments_);
        return realSetTimeout(() => undefined, 60_000);
      }
      return realSetTimeout(handler, timeout, ...arguments_);
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  const old = requests[0]!;
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  await chooseFile(localFile("new.xlsx"));
  await finishParse(workers[1]!, selection(0, 1));
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  expect(requests).toHaveLength(1);

  act(() => expire());
  await act(async () => undefined);
  expect(requests).toHaveLength(1);
  expect(screen.getByTestId("translations")).not.toHaveTextContent(
    "After timeout",
  );
  act(() =>
    resolveOld({
      type: old.type,
      readerInstanceId: old.readerInstanceId,
      requestId: old.requestId,
      generation: old.generation,
      ok: true,
      results: old.records.map(({ id, sourceHash }) => ({
        id,
        sourceHash,
        text: "Late old result",
      })),
    }),
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "After timeout Cached formula text",
    ),
  );
  expect(screen.getByTestId("translations")).not.toHaveTextContent(
    "Late old result",
  );
});

test("surfaces managed-auth errors and discards stale translation results", async () => {
  const worker = new FakeWorker();
  let resolveResponse!: (value: LocalSpreadsheetTranslateResponse) => void;
  vi.spyOn(browser.runtime, "sendMessage")
    .mockImplementationOnce(async () =>
      Promise.resolve({
        type: "LOCAL_SPREADSHEET_TRANSLATE",
        readerInstanceId: "wrong-reader",
        requestId: 1,
        generation: 1,
        ok: true,
        results: [
          { id: "local:0:A1", sourceHash: "a".repeat(40), text: "Stale" },
        ],
      } satisfies LocalSpreadsheetTranslateResponse),
    )
    .mockImplementationOnce(
      () =>
        new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
          resolveResponse = resolve;
        }),
    )
    .mockImplementationOnce(async (message) => {
      const request = translateRequest(message);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: false,
        error: "auth-required",
      };
    });
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);

  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "invalid translation response",
  );
  expect(screen.getByTestId("translations")).toHaveTextContent("[]");

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(2),
  );
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  const secondRequest = translateRequest(
    vi.mocked(browser.runtime.sendMessage).mock.calls[1]![0],
  );
  act(() =>
    resolveResponse({
      type: secondRequest.type,
      readerInstanceId: secondRequest.readerInstanceId,
      requestId: secondRequest.requestId,
      generation: secondRequest.generation,
      ok: false,
      error: "auth-required",
    }),
  );
  await act(async () => undefined);
  expect(screen.getByTestId("translations")).toHaveTextContent("[]");

  await userEvent.click(
    screen.getByRole("button", { name: "Resume translation" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Sign in to your Readlace account",
  );
});

test("waits for Translate on a changed Drive file, then discovers and translates exactly once with saved preferences", async () => {
  readerPreferences.targetLanguage = "ja";
  const port = new FakePort();
  const worker = new FakeWorker();
  const portFactory = vi.fn(() => port);
  const send = vi
    .spyOn(browser.runtime, "sendMessage")
    .mockImplementation(async (message) => {
      if ((message as { type?: string }).type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(message);
      const request = translateRequest(message);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          ...record,
          text: "translated",
        })),
      };
    });
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      awaitingStart
      sourceTitle="New workbook.xlsx"
      portFactory={portFactory}
      workerFactory={() => worker}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled(),
  );
  expect(screen.getByText("New workbook.xlsx")).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Japanese");
  expect(portFactory).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  expect(portFactory).toHaveBeenCalledOnce();
  expect(
    document.querySelector(".spreadsheet-grid-skeleton"),
  ).toBeInTheDocument();
  completeDriveDownload(port, await driveStart(port), "new bytes");
  await finishParse(worker);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(translateRequest(send.mock.calls[1]![0])).toMatchObject({
    targetLanguage: "ja",
  });
  expect(translateRequest(send.mock.calls[1]![0])).not.toHaveProperty(
    "provider",
  );
});

test("toolbar Drive discovery remains load-only and Clear/remount preserves chosen preferences", async () => {
  const port = new FakePort();
  const worker = new FakeWorker();
  const send = vi.spyOn(browser.runtime, "sendMessage");
  const view = render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
    />,
  );
  completeDriveDownload(port, await driveStart(port), "workbook");
  await finishParse(worker);
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Vietnamese");
  expect(send).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole("combobox", { name: "Translate to" }));
  await userEvent.click(await screen.findByRole("option", { name: "English" }));
  expect(savePreferences).toHaveBeenCalledWith({ targetLanguage: "en" });
  await userEvent.click(screen.getByRole("button", { name: "Clear view" }));
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("English");
  view.unmount();
  const nextWorker = new FakeWorker();
  render(<LocalSpreadsheetReader workerFactory={() => nextWorker} />);
  await chooseFile();
  await finishParse(nextWorker);
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("English");
  expect(send).toHaveBeenCalledOnce();
});

test("an explicit popup Translate intent starts Drive translation after loading, while old source bytes are cancelled", async () => {
  const port = new FakePort();
  const worker = new FakeWorker();
  const intent = {
    id: "popup-click",
    createdAt: Date.now(),
    context: {
      kind: "sheets" as const,
      fileId: "office-file",
      activeId: "1",
      sourceTabId: driveSource.sourceTabId,
    },
    targetLanguage: "vi" as const,
    account: "user@example.com",
  };
  const send = vi
    .spyOn(browser.runtime, "sendMessage")
    .mockImplementation(async (message) => {
      if ((message as { type?: string }).type === "WORKSPACE_READER_CONTEXT")
        return contextResponse(message);
      const request = translateRequest(message);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          ...record,
          text: "translated",
        })),
      };
    });
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      translateIntent={intent}
      portFactory={() => port}
      workerFactory={() => worker}
    />,
  );
  await waitFor(() => expect(validateIntent).toHaveBeenCalledWith(intent));
  completeDriveDownload(port, await driveStart(port), "workbook");
  await finishParse(worker);
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(savePreferences).toHaveBeenCalledWith({
    targetLanguage: "vi",
  });
});

test("late preference hydration never replaces an explicit user choice", async () => {
  let resolvePreferences!: (value: { targetLanguage: string }) => void;
  readPreferences.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePreferences = resolve;
      }),
  );
  const worker = new FakeWorker();
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);
  expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();
  await userEvent.click(screen.getByRole("combobox", { name: "Translate to" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Japanese" }),
  );
  await act(async () => resolvePreferences({ targetLanguage: "en" }));
  expect(
    screen.getByRole("combobox", { name: "Translate to" }),
  ).toHaveTextContent("Japanese");
  expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled();
});

test("account changes cancel a Drive download and reject delayed bytes", async () => {
  const port = new FakePort();
  const workerFactory = vi.fn(() => new FakeWorker());
  const view = render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={workerFactory}
    />,
  );
  const request = await driveStart(port);
  act(() => emitRuntimeMessage({ type: "AUTH_STATE_CHANGED" }));
  expect(port.messages.at(-1)).toMatchObject({
    type: "GOOGLE_DRIVE_OFFICE_CANCEL",
  });
  expect(port.disconnected).toBe(true);
  completeDriveDownload(port, request, "late old-account bytes");
  expect(workerFactory).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("session changed");
  view.unmount();
});

test("root-managed source changes cancel the old adapter without competing exit callbacks or eager new-file downloads", async () => {
  const oldPort = new FakePort();
  const newPort = new FakePort();
  const oldWorker = new FakeWorker();
  const onExit = vi.fn();
  const newPortFactory = vi.fn(() => newPort);
  const view = render(
    <LocalSpreadsheetReader
      key="old-file"
      source={driveSource}
      managedSourceLifecycle
      onExitDriveOffice={onExit}
      portFactory={() => oldPort}
      workerFactory={() => oldWorker}
    />,
  );
  const request = await driveStart(oldPort);
  completeDriveDownload(oldPort, request, "old workbook");
  const parse = parseRequest(oldWorker);
  act(() =>
    emitRuntimeMessage({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: driveSource.sourceTabId,
      version: { ...driveSource.version, sourceRevision: 4 },
    }),
  );
  expect(oldWorker.terminated).toBe(true);
  expect(onExit).not.toHaveBeenCalled();
  act(() =>
    oldWorker.emit({
      type: "parsed",
      requestId: parse.requestId,
      metadata,
      sheet: selection(),
    }),
  );
  expect(screen.queryByTestId("grid")).toBeNull();
  await act(async () => Promise.resolve());
  expect(onExit).not.toHaveBeenCalled();
  view.rerender(
    <LocalSpreadsheetReader
      key="new-file"
      source={{
        ...driveSource,
        version: { ...driveSource.version, sourceRevision: 4 },
      }}
      managedSourceLifecycle
      awaitingStart
      sourceTitle="New workbook.xlsx"
      portFactory={newPortFactory}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled(),
  );
  expect(newPortFactory).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) =>
    contextResponse(message, { ...driveSource.version, sourceRevision: 4 }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  expect(newPortFactory).toHaveBeenCalledOnce();
});

test("binds the original global Reader surface with the same owner before every Drive Port", async () => {
  window.history.replaceState({}, "", "/reader.html");
  const ports: FakePort[] = [];
  const send = vi.mocked(browser.runtime.sendMessage);
  const portFactory = vi.fn(() => {
    const port = new FakePort();
    ports.push(port);
    return port;
  });
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      sourceTitle="Current workbook.xlsx"
      portFactory={portFactory}
    />,
  );
  await act(async () => undefined);
  const first = await driveStart(ports[0]!);
  expect(send.mock.calls[0]![0]).toEqual({
    type: "WORKSPACE_READER_CONTEXT",
    readerInstanceId: first.readerInstanceId,
    requestId: first.requestId - 1,
    sourceTabId: 7,
  });
  act(() => ports[0]!.interrupt());
  expect(screen.getByRole("alert")).toHaveTextContent("extension background");
  expect(screen.getByText("Current workbook.xlsx")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const second = await driveStart(ports[1]!);
  expect(send.mock.calls[1]![0]).toEqual({
    type: "WORKSPACE_READER_CONTEXT",
    readerInstanceId: second.readerInstanceId,
    requestId: second.requestId - 1,
    sourceTabId: 7,
  });
  expect(second.requestId).toBeGreaterThan(first.requestId);
});

test.each([
  ["missing", () => undefined],
  [
    "owner",
    (request: unknown) => ({
      ...contextResponse(request),
      readerInstanceId: "other-owner",
    }),
  ],
  [
    "request",
    (request: unknown) => ({ ...contextResponse(request), requestId: 999 }),
  ],
  [
    "version",
    (request: unknown) =>
      contextResponse(request, { ...driveSource.version, sourceRevision: 2 }),
  ],
  [
    "tab",
    (request: unknown) => ({
      ...contextResponse(request),
      context: { ...contextResponse(request).context, sourceTabId: 8 },
    }),
  ],
  [
    "extra",
    (request: unknown) => ({ ...contextResponse(request), unexpected: true }),
  ],
])(
  "rejects %s Context before opening a Drive channel",
  async (label, response) => {
    vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) =>
      response(message),
    );
    const portFactory = vi.fn(() => new FakePort());
    const workerFactory = vi.fn(() => new FakeWorker());
    render(
      <LocalSpreadsheetReader
        source={driveSource}
        portFactory={portFactory}
        workerFactory={workerFactory}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      label === "version" ? "source tab changed" : "extension background",
    );
    expect(portFactory).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
  },
);

test.each(["Clear view", "Disconnect Google", "auth", "source", "unmount"])(
  "retires a delayed Context on %s without opening a Port",
  async (action) => {
    let finish!: (value: unknown) => void;
    let contextRequest: unknown;
    vi.mocked(browser.runtime.sendMessage).mockImplementation((message) => {
      if ((message as { type?: string }).type !== "WORKSPACE_READER_CONTEXT")
        return Promise.resolve(undefined);
      contextRequest = message;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const portFactory = vi.fn(() => new FakePort());
    const workerFactory = vi.fn(() => new FakeWorker());
    const view = render(
      <LocalSpreadsheetReader
        source={driveSource}
        portFactory={portFactory}
        workerFactory={workerFactory}
      />,
    );
    await act(async () => undefined);
    if (action === "auth")
      act(() => emitRuntimeMessage({ type: "AUTH_STATE_CHANGED" }));
    else if (action === "source")
      act(() =>
        emitRuntimeMessage({
          type: "WORKSPACE_READER_SOURCE_CHANGED",
          sourceTabId: 7,
          version: { ...driveSource.version, sourceRevision: 4 },
        }),
      );
    else if (action === "unmount") view.unmount();
    else await userEvent.click(screen.getByRole("button", { name: action }));
    await act(async () => finish(contextResponse(contextRequest)));
    expect(portFactory).not.toHaveBeenCalled();
    expect(workerFactory).not.toHaveBeenCalled();
  },
);

test("keeps Office pre-start settings editable with a truthful worksheet placeholder and zero download", async () => {
  const portFactory = vi.fn(() => new FakePort());
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      awaitingStart
      sourceTitle="Awaiting.xlsx"
      portFactory={portFactory}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Translate" })).toBeEnabled(),
  );
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Worksheet" })).toHaveTextContent(
    "Translate to load worksheets",
  );
  expect(
    screen.queryByRole("combobox", { name: "Provider" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("combobox", { name: "Translate to" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Japanese" }),
  );
  expect(savePreferences).toHaveBeenCalledWith({ targetLanguage: "ja" });
  expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  expect(portFactory).not.toHaveBeenCalled();
});

test.each([false, true])(
  "opens a bound Reader tab only on explicit channel recovery (awaitingStart=%s)",
  async (awaitingStart) => {
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue(undefined);
    const create = vi
      .spyOn(browser.tabs, "create")
      .mockResolvedValue({ id: 90, windowId: 12 } as never);
    vi.spyOn(browser.tabs, "get").mockResolvedValue({
      id: 7,
      windowId: 12,
      url: "https://docs.google.com/spreadsheets/d/office-file/edit",
    } as never);
    const portFactory = vi.fn(() => new FakePort());
    render(
      <LocalSpreadsheetReader
        source={driveSource}
        awaitingStart={awaitingStart}
        portFactory={portFactory}
      />,
    );
    if (awaitingStart)
      await userEvent.click(
        await screen.findByRole("button", { name: "Translate" }),
      );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "extension background",
    );
    expect(create).not.toHaveBeenCalled();
    expect(portFactory).not.toHaveBeenCalled();
    const send = vi.mocked(browser.runtime.sendMessage);
    expect(
      send.mock.calls.every(
        ([message]) =>
          (message as { type?: string }).type === "WORKSPACE_READER_CONTEXT",
      ),
    ).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Open Reader in a tab" }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith({
      windowId: 12,
      active: true,
      url: browser.runtime.getURL(
        `/reader.html?sourceTabId=7${awaitingStart ? "&awaitStart=1" : ""}`,
      ),
    });
    expect(portFactory).not.toHaveBeenCalled();
    expect(
      send.mock.calls.every(
        ([message]) =>
          (message as { type?: string }).type === "WORKSPACE_READER_CONTEXT",
      ),
    ).toBe(true);
  },
);

test("discards delayed channel recovery after its source retires", async () => {
  vi.mocked(browser.runtime.sendMessage).mockResolvedValue(undefined);
  let finish!: (tab: unknown) => void;
  vi.spyOn(browser.tabs, "get").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  const create = vi.spyOn(browser.tabs, "create");
  render(<LocalSpreadsheetReader source={driveSource} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "extension background",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Open Reader in a tab" }),
  );
  expect(
    screen.getByRole("button", { name: "Open Reader in a tab" }),
  ).toBeDisabled();
  act(() =>
    emitRuntimeMessage({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: 7,
      version: { ...driveSource.version, sourceRevision: 4 },
    }),
  );
  await act(async () => finish({ id: 7, windowId: 12 }));
  expect(create).not.toHaveBeenCalled();
});

test.each([
  "https://drive.google.com/drive/my-drive",
  "https://docs.google.com/spreadsheets/d/another-file/edit",
])("refuses channel recovery when the source URL moved to %s", async (url) => {
  const port = new FakePort();
  const create = vi.spyOn(browser.tabs, "create");
  vi.spyOn(browser.tabs, "get").mockResolvedValue({
    id: 7,
    windowId: 12,
    url,
  } as never);
  render(
    <LocalSpreadsheetReader source={driveSource} portFactory={() => port} />,
  );
  await driveStart(port);
  act(() => port.interrupt());
  await userEvent.click(
    screen.getByRole("button", { name: "Open Reader in a tab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not open a tab",
  );
  expect(create).not.toHaveBeenCalled();
});

test("offers channel recovery after a loaded Drive grid cannot authorize translation", async () => {
  let translations = 0;
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) => {
    if ((message as { type?: string }).type === "WORKSPACE_READER_CONTEXT")
      return contextResponse(message);
    const request = translateRequest(message);
    if (++translations === 1)
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          id: record.id,
          sourceHash: record.sourceHash,
          text: "Accepted translation",
        })),
      };
    return {
      type: request.type,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      generation: request.generation,
      ok: false,
      error: "reader-channel-unavailable",
    };
  });
  const port = new FakePort();
  const worker = new FakeWorker();
  const create = vi.spyOn(browser.tabs, "create");
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
    />,
  );
  completeDriveDownload(port, await driveStart(port), "workbook");
  await finishParse(worker);
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Accepted translation",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Load page 100" }));
  const pageRequest = worker.messages.at(-1)!.message;
  if (pageRequest.type !== "load-page")
    throw new Error("Expected page request");
  act(() =>
    worker.emit({
      type: "page",
      requestId: pageRequest.requestId,
      page: {
        sheetId: "local:0",
        generation: 1,
        startRow: 100,
        rowCount: 50,
        rows: [
          {
            index: 100,
            pixelSize: 21,
            hidden: false,
            cells: [
              cell("local:0:A101", "A101", "Next viewport", {
                sourceHash: "e".repeat(40),
              }),
            ],
          },
        ],
        cursor: null,
      },
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Show page 100 viewport" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "extension background",
  );
  expect(screen.getByTestId("grid")).toHaveTextContent("Main");
  expect(screen.getByTestId("translations")).toHaveTextContent(
    "Accepted translation",
  );
  expect(
    screen.getByRole("button", { name: "Open Reader in a tab" }),
  ).toBeEnabled();
  expect(create).not.toHaveBeenCalled();
});

test("rebinds once after a lost background binding and retries the same batch", async () => {
  let translations = 0;
  let contexts = 0;
  vi.mocked(browser.runtime.sendMessage).mockImplementation(async (message) => {
    if ((message as { type?: string }).type === "WORKSPACE_READER_CONTEXT") {
      contexts += 1;
      return contextResponse(message);
    }
    const request = translateRequest(message);
    if (++translations === 1)
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: false,
        error: "reader-channel-unavailable",
      };
    return {
      type: request.type,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      generation: request.generation,
      ok: true,
      results: request.records.map((record) => ({
        id: record.id,
        sourceHash: record.sourceHash,
        text: "Recovered translation",
      })),
    };
  });
  const port = new FakePort();
  const worker = new FakeWorker();
  render(
    <LocalSpreadsheetReader
      source={driveSource}
      portFactory={() => port}
      workerFactory={() => worker}
    />,
  );
  completeDriveDownload(port, await driveStart(port), "workbook");
  await finishParse(worker);
  const handshakes = contexts;
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Recovered translation",
    ),
  );
  expect(translations).toBe(2);
  expect(contexts).toBe(handshakes + 1);
  expect(screen.queryByText(/extension background/)).toBeNull();
});

test("reports a slow background request truthfully and keeps retry blocked until it settles", async () => {
  const worker = new FakeWorker();
  let resolveRequest!: (value: LocalSpreadsheetTranslateResponse) => void;
  let request!: LocalSpreadsheetTranslateRequest;
  const send = vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    (message) =>
      new Promise<LocalSpreadsheetTranslateResponse>((resolve) => {
        request = translateRequest(message);
        resolveRequest = resolve;
      }),
  );
  render(<LocalSpreadsheetReader workerFactory={() => worker} />);
  await chooseFile();
  await finishParse(worker);
  const realSetTimeout = globalThis.setTimeout;
  let expire!: () => void;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (handler, timeout, ...args) => {
      if (timeout === 30_000) {
        expire = () => handler(...args);
        return realSetTimeout(() => undefined, 60_000);
      }
      return realSetTimeout(handler, timeout, ...args);
    },
  );
  await userEvent.click(screen.getByRole("button", { name: "Translate" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  act(() => expire());
  expect(
    screen.getByText(
      "Translation is taking longer than 30 seconds. Waiting for the background request to finish.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Translating…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  act(() =>
    resolveRequest({
      type: request.type,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      generation: request.generation,
      ok: true,
      results: request.records.map(({ id, sourceHash }) => ({
        id,
        sourceHash,
        text: "Completed after waiting",
      })),
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("translations")).toHaveTextContent(
      "Completed after waiting",
    ),
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Waiting for the background request/)).toBeNull();
});

function dropOnPage(files: File[], target: Element = document.body) {
  fireEvent.dragOver(target, { dataTransfer: { types: ["Files"] } });
  fireEvent.drop(target, { dataTransfer: { types: ["Files"], files } });
}

test.each(["book.xlsx", "macro.XLSM", "table.csv"])(
  "opens %s dropped anywhere on the page, never through an upload path",
  async (name) => {
    const workers: FakeWorker[] = [];
    const sendMessage = vi.spyOn(browser.runtime, "sendMessage");
    render(
      <LocalSpreadsheetReader
        workerFactory={() => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        }}
      />,
    );

    dropOnPage([localFile(name)]);

    await waitFor(() => expect(workers).toHaveLength(1));
    const request = parseRequest(workers[0]!);
    expect(request.fileName).toBe(name);
    expect(workers[0]!.messages[0]!.transfer).toEqual([request.bytes]);
    expect(sendMessage).not.toHaveBeenCalled();
  },
);

test("refuses dropped unsupported, oversized and multiple files with a clear message", async () => {
  const workers: FakeWorker[] = [];
  render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );

  const pdf = localFile("spec.pdf");
  dropOnPage([pdf]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Choose a .csv, .xlsx, or .xlsm file.",
  );
  expect(pdf.arrayBuffer).not.toHaveBeenCalled();

  const oversized = localFile("huge.xlsx");
  Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
  dropOnPage([oversized]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "exceeds the 20 MiB local Reader limit",
  );
  expect(oversized.arrayBuffer).not.toHaveBeenCalled();

  dropOnPage([localFile("a.xlsx"), localFile("b.csv")]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Drop one spreadsheet at a time.",
  );
  expect(workers).toHaveLength(0);
});

test("keeps the open workbook when a stray file is dropped and replaces it with a supported one", async () => {
  const workers: FakeWorker[] = [];
  render(
    <LocalSpreadsheetReader
      workerFactory={() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      }}
    />,
  );
  await chooseFile();
  await finishParse(workers[0]!);

  fireEvent.dragOver(document.body, { dataTransfer: { types: ["Files"] } });
  expect(
    screen.getByText("Drop to open this spreadsheet locally"),
  ).toBeInTheDocument();
  fireEvent.drop(document.body, {
    dataTransfer: { types: ["Files"], files: [localFile("notes.docx")] },
  });
  expect(
    screen.queryByText("Drop to open this spreadsheet locally"),
  ).toBeNull();
  expect(
    await screen.findByText("Choose a .csv, .xlsx, or .xlsm file."),
  ).toBeInTheDocument();
  expect(screen.getByTestId("grid")).toBeInTheDocument();
  expect(workers[0]!.terminated).toBe(false);

  dropOnPage([localFile("next.csv")]);
  await waitFor(() => expect(workers).toHaveLength(2));
  expect(workers[0]!.terminated).toBe(true);
  expect(parseRequest(workers[1]!).fileName).toBe("next.csv");
});

test("ignores page drops for a Drive Office workbook", async () => {
  const workerFactory = vi.fn(() => new FakeWorker());
  render(
    <LocalSpreadsheetReader
      workerFactory={workerFactory}
      portFactory={() => new FakePort()}
      source={driveSource}
      awaitingStart
    />,
  );
  dropOnPage([localFile("book.xlsx")]);
  await act(async () => undefined);
  expect(workerFactory).not.toHaveBeenCalled();
});

test("words the empty and drop state in Vietnamese and keeps stored messages locale-neutral", async () => {
  const workers: FakeWorker[] = [];
  const reader = (locale: "en" | "vi") => (
    <UiLocaleScope locale={locale}>
      <LocalSpreadsheetReader
        workerFactory={() => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker;
        }}
      />
    </UiLocaleScope>
  );
  const { rerender } = render(reader("vi"));

  expect(screen.getByText("Trình đọc bảng tính")).toBeInTheDocument();
  expect(screen.getByText("File ở lại trên máy")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Chọn file trên máy" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Mở file bảng tính")).toBeInTheDocument();
  expect(screen.getByText("Chọn hoặc thả file bảng tính")).toBeInTheDocument();
  expect(
    screen.getByText(".csv, .xlsx hoặc .xlsm · tối đa 20 MiB"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Dữ liệu file ở lại trên máy này/),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Chọn một file bảng tính để bắt đầu.",
  );

  dropOnPage([localFile("spec.pdf")]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Hãy chọn file .csv, .xlsx hoặc .xlsm.",
  );
  const oversized = localFile("huge.xlsx");
  Object.defineProperty(oversized, "size", { value: 20 * 1024 * 1024 + 1 });
  dropOnPage([oversized]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "File này vượt giới hạn 20 MiB của trình đọc bảng tính.",
  );
  dropOnPage([localFile("a.xlsx"), localFile("b.csv")]);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Mỗi lần chỉ thả một file bảng tính.",
  );

  // The refusal is stored as a message key: switching the UI locale rewords
  // it without another drop.
  rerender(reader("en"));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Drop one spreadsheet at a time.",
  );
  expect(workers).toHaveLength(0);
});

test("words the loaded Local Reader, partial results and drop overlay in Vietnamese", async () => {
  const worker = new FakeWorker();
  vi.spyOn(browser.runtime, "sendMessage").mockImplementation(
    async (message) => {
      const request = translateRequest(message);
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map((record) => ({
          id: record.id,
          sourceHash: record.sourceHash,
          error: "provider-error",
        })),
      } satisfies LocalSpreadsheetTranslateResponse;
    },
  );
  render(
    <UiLocaleScope locale="vi">
      <LocalSpreadsheetReader workerFactory={() => worker} />
    </UiLocaleScope>,
  );
  fireEvent.change(screen.getByLabelText("Mở file bảng tính"), {
    target: { files: [localFile()] },
  });
  await act(async () => undefined);
  await finishParse(worker);

  expect(screen.getByText("File trên máy")).toBeInTheDocument();
  expect(screen.getByText("Bảng tính trên máy")).toBeInTheDocument();
  expect(
    screen.getByRole("region", { name: "Bảng tính trên máy" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Dịch sang" })).toHaveTextContent(
    "Tiếng Việt",
  );

  await userEvent.click(screen.getByRole("button", { name: "Dịch" }));
  expect(
    await screen.findByRole("button", { name: "Dịch lại phần còn thiếu" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Không dịch được 2 ô.");

  fireEvent.dragOver(document.body, { dataTransfer: { types: ["Files"] } });
  expect(
    screen.getByText("Thả để mở bảng tính này trên máy"),
  ).toBeInTheDocument();
});
