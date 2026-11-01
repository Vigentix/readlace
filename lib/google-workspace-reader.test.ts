import { describe, expect, it } from "vitest";

import {
  MAX_GOOGLE_RESPONSE_BYTES,
  MAX_LOADED_RECORDS,
  MAX_LOADED_SOURCE_CHARACTERS,
  MAX_TRANSLATION_MESSAGE_CHARACTERS,
  MAX_TRANSLATION_MESSAGE_RECORDS,
  MAX_TRANSLATION_RECORD_CHARACTERS,
  SHEETS_PAGE_ROWS,
  mergeWorkspaceSheetDiscoveryFragments,
  mergeWorkspaceSheetPageFragments,
  parseDocsTabs,
  parseSheetsPage,
  parseWorkspaceEditorUrl,
  parseWorkspaceReaderOwner,
  parseWorkspaceReaderSheetCatalog,
  parseWorkspaceReaderSourceChanged,
  parseWorkspaceReaderOpen,
  parseWorkspaceSheetCellStyle,
  defaultWorkspaceSheetCellStyle,
  parseWorkspaceSheetDiscoveryFragment,
  parseWorkspaceSheetDiscoveryProgress,
  parseWorkspaceSheetGrid,
  parseWorkspaceSheetPage,
  parseWorkspaceSheetPageFragment,
  parseWorkspaceSourceVersion,
  sameWorkspaceSourceIdentity,
  sheetsPageRange,
  workspaceSourceIdentity,
  type WorkspaceEditorContext,
  type WorkspaceReaderErrorCode,
  type WorkspaceReaderRequest,
  type WorkspaceReaderResponse,
  type WorkspaceReaderSheetDescriptor,
  type WorkspaceSheetCell,
  type WorkspaceSheetCellStyle,
  type WorkspaceSheetGrid,
} from "./google-workspace-reader";

const owner = { readerInstanceId: "reader-instance-1", requestId: 0 } as const;
const version = { backgroundEpoch: "epoch-1", sourceRevision: 3 } as const;

const sheetsContext: WorkspaceEditorContext = {
  kind: "sheets",
  sourceTabId: 7,
  fileId: "sheet_123",
  activeId: "42",
};

const docsContext: WorkspaceEditorContext = {
  kind: "docs",
  sourceTabId: 8,
  fileId: "doc_123",
  activeId: "t.child",
};

function sheet(values: unknown[][], overrides: Record<string, unknown> = {}) {
  return {
    spreadsheetId: "sheet_123",
    sheets: [
      {
        properties: {
          sheetId: 42,
          title: "Q1's data",
          sheetType: "GRID",
          gridProperties: { rowCount: 250 },
        },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: values.map((row) => ({ values: row })),
          },
        ],
        ...overrides,
      },
    ],
  };
}

function paragraph(startIndex: number, ...elements: unknown[]) {
  return { startIndex, paragraph: { elements } };
}

function text(content: string) {
  return { textRun: { content } };
}

const cellStyle: WorkspaceSheetCellStyle = defaultWorkspaceSheetCellStyle();

function grid(rowCount: number, lastUsedColumn = 5): WorkspaceSheetGrid {
  const parsed = parseWorkspaceSheetGrid({
    sheetId: "42",
    title: "Grid",
    generation: 2,
    rowCount,
    lastUsedColumn,
    columns: [],
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    hideGridlines: false,
    merges: [],
    defaultStyle: defaultWorkspaceSheetCellStyle(),
    defaultRowPixelSize: 21,
    defaultColumnPixelSize: 100,
  });
  if (!parsed) throw new Error("invalid test grid");
  return parsed;
}

function gridCell(rowIndex: number, columnIndex: number): WorkspaceSheetCell {
  let column = "";
  for (
    let value = columnIndex + 1;
    value > 0;
    value = Math.floor((value - 1) / 26)
  ) {
    column = String.fromCharCode(65 + ((value - 1) % 26)) + column;
  }
  const anchor = `${column}${rowIndex + 1}`;
  return {
    id: `sheets:sheet_123:42:${anchor}`,
    anchor,
    source: anchor,
    display: anchor,
    kind: "text",
    translatable: true,
    sourceHash: "0".repeat(40),
    rowIndex,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    style: cellStyle,
  };
}

describe("Google Workspace Reader constants and URLs", () => {
  it("bounds the metadata-only catalog before iterating or returning worksheet names", () => {
    expect(
      parseWorkspaceReaderSheetCatalog(
        {
          spreadsheetId: "sheet_123",
          sheets: Array.from({ length: 1001 }, (_, sheetId) => ({
            properties: { sheetId, title: "Sheet", sheetType: "GRID" },
          })),
        },
        "sheet_123",
      ),
    ).toBeNull();
  });
  it("pins every approved bound", () => {
    expect({
      SHEETS_PAGE_ROWS,
      MAX_GOOGLE_RESPONSE_BYTES,
      MAX_LOADED_RECORDS,
      MAX_LOADED_SOURCE_CHARACTERS,
      MAX_TRANSLATION_RECORD_CHARACTERS,
      MAX_TRANSLATION_MESSAGE_RECORDS,
      MAX_TRANSLATION_MESSAGE_CHARACTERS,
    }).toEqual({
      SHEETS_PAGE_ROWS: 100,
      MAX_GOOGLE_RESPONSE_BYTES: 2_097_152,
      MAX_LOADED_RECORDS: 10_000,
      MAX_LOADED_SOURCE_CHARACTERS: 256_000,
      MAX_TRANSLATION_RECORD_CHARACTERS: 4_000,
      MAX_TRANSLATION_MESSAGE_RECORDS: 128,
      MAX_TRANSLATION_MESSAGE_CHARACTERS: 8_000,
    });
  });

  it("keeps portable OAuth failures typed and distinct", () => {
    const codes = [
      "google-oauth-configuration",
      "google-oauth-response",
      "google-oauth-scope",
      "google-oauth-expired",
      "google-oauth-network",
      "google-oauth-failed",
    ] satisfies WorkspaceReaderErrorCode[];

    expect(codes).toHaveLength(6);
    expect(codes).not.toContain("google-access-denied");
  });

  it("accepts only exact HTTPS editor routes and active identifiers", () => {
    expect(
      parseWorkspaceEditorUrl(
        "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=42",
      ),
    ).toEqual({ kind: "sheets", fileId: "sheet_123", activeId: "42" });
    expect(
      parseWorkspaceEditorUrl(
        "https://docs.google.com/spreadsheets/d/sheet_123/edit?gid=41",
      ),
    ).toEqual({ kind: "sheets", fileId: "sheet_123", activeId: "41" });
    expect(
      parseWorkspaceEditorUrl(
        "https://docs.google.com/document/d/doc-123/edit?tab=t.child",
      ),
    ).toEqual({ kind: "docs", fileId: "doc-123", activeId: "t.child" });
    expect(
      parseWorkspaceEditorUrl(
        "https://docs.google.com/document/d/doc-123/edit",
      ),
    ).toEqual({ kind: "docs", fileId: "doc-123", activeId: null });
    expect(
      parseWorkspaceEditorUrl(
        "https://docs.google.com/spreadsheets/d/sheet_123/edit",
      ),
    ).toEqual({ kind: "sheets", fileId: "sheet_123", activeId: null });

    expect(
      parseWorkspaceEditorUrl(
        "https://docs.google.com/spreadsheets/d/sheet_123/edit?gid=1#gid=2",
      ),
    ).toEqual({ kind: "sheets", fileId: "sheet_123", activeId: "2" });

    for (const url of [
      "http://docs.google.com/spreadsheets/d/id/edit#gid=0",
      "https://docs.google.com.evil.test/spreadsheets/d/id/edit#gid=0",
      "https://user@docs.google.com/spreadsheets/d/id/edit#gid=0",
      "https://docs.google.com:444/spreadsheets/d/id/edit#gid=0",
      "https://docs.google.com/spreadsheets/u/0/d/id/edit#gid=0",
      "https://docs.google.com/spreadsheets/d/id/export#gid=0",
      "https://docs.google.com/spreadsheets/d/id/edit#gid=-1",
      "https://docs.google.com/spreadsheets/d/id/edit#gid=2147483648",
      "https://docs.google.com/spreadsheets/d/id/edit?gid=",
      "https://docs.google.com/spreadsheets/d/id/edit?gid=1&gid=1",
      "https://docs.google.com/spreadsheets/d/id/edit#gid=1&gid=1",
      "https://docs.google.com/spreadsheets/d/id/edit?gid=bad#gid=2",
      "https://docs.google.com/spreadsheets/d/id/edit?gid=1#gid=bad",
      "https://docs.google.com/document/d/id/edit?tab=x&tab=y",
      "https://docs.google.com/document/d/id/edit?tab=%2Fbad",
    ]) {
      expect(parseWorkspaceEditorUrl(url), url).toBeNull();
    }
  });

  it("keeps file identity across Sheets gid changes and retains Docs tab identity", () => {
    const raw = {
      sourceTabId: 7,
      ...parseWorkspaceEditorUrl(
        "https://docs.google.com/spreadsheets/d/sheet_123/edit",
      )!,
    };
    const a = { ...raw, activeId: "1" };
    const b = { ...raw, activeId: "2" };

    expect(workspaceSourceIdentity(a)).toEqual(a);
    expect(sameWorkspaceSourceIdentity(a, b)).toBe(true);
    expect(sameWorkspaceSourceIdentity(b, a)).toBe(true);
    expect(sameWorkspaceSourceIdentity(a, { ...a })).toBe(true);
    expect(sameWorkspaceSourceIdentity(raw, a)).toBe(true);
    expect(
      sameWorkspaceSourceIdentity(
        { ...a, kind: "docs" },
        { ...b, kind: "docs" },
      ),
    ).toBe(false);
    expect(sameWorkspaceSourceIdentity(a, { ...a, sourceTabId: 8 })).toBe(
      false,
    );
    expect(sameWorkspaceSourceIdentity(a, { ...a, fileId: "sheet_456" })).toBe(
      false,
    );
    expect(
      sameWorkspaceSourceIdentity(a, {
        ...a,
        kind: "docs",
        activeId: "1",
      }),
    ).toBe(false);
  });

  it("parses exact Reader ownership, versions, and source notifications", () => {
    expect(parseWorkspaceReaderOwner(owner)).toEqual(owner);
    expect(parseWorkspaceSourceVersion(version)).toEqual(version);
    expect(
      parseWorkspaceReaderSourceChanged({
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId: 7,
        version,
      }),
    ).toEqual({
      type: "WORKSPACE_READER_SOURCE_CHANGED",
      sourceTabId: 7,
      version,
    });

    for (const invalid of [
      { readerInstanceId: "", requestId: 0 },
      { readerInstanceId: "reader", requestId: -1 },
      { readerInstanceId: "reader", requestId: 0, token: "forbidden" },
    ]) {
      expect(parseWorkspaceReaderOwner(invalid)).toBeNull();
    }
    for (const invalid of [
      { backgroundEpoch: "", sourceRevision: 0 },
      { backgroundEpoch: "epoch", sourceRevision: -1 },
      { backgroundEpoch: "epoch", sourceRevision: 0, url: "forbidden" },
    ]) {
      expect(parseWorkspaceSourceVersion(invalid)).toBeNull();
    }
    expect(
      parseWorkspaceReaderSourceChanged({
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId: 7,
        version,
        range: "A:Z",
      }),
    ).toBeNull();
  });

  it("parses toolbar Reader-open without accepting provider, intent or source data", () => {
    const event = { type: "WORKSPACE_READER_OPEN", sourceTabId: 7 };
    expect(parseWorkspaceReaderOpen(event)).toEqual(event);
    expect(parseWorkspaceReaderOpen({ ...event, sourceWindowId: 1 })).toEqual({
      ...event,
      sourceWindowId: 1,
    });
    for (const invalid of [
      { ...event, sourceTabId: -1 },
      { ...event, sourceTabId: "7" },
      { ...event, provider: "google" },
      { ...event, fileId: "id" },
      { ...event, translate: true },
      { ...event, sourceWindowId: "1" },
      { ...event, sourceWindowId: -1 },
    ])
      expect(parseWorkspaceReaderOpen(invalid)).toBeNull();
  });

  it("parses only ordered GRID worksheets from one trusted metadata response", () => {
    expect(
      parseWorkspaceReaderSheetCatalog(
        {
          spreadsheetId: "sheet_123",
          sheets: [
            { properties: { sheetId: 9, title: "First", sheetType: "GRID" } },
            {
              properties: {
                sheetId: 10,
                title: "Chart",
                sheetType: "OBJECT",
              },
            },
            { properties: { sheetId: 3, title: "Second", sheetType: "GRID" } },
          ],
        },
        "sheet_123",
      ),
    ).toEqual([
      { sheetId: "9", title: "First", index: 0 },
      { sheetId: "3", title: "Second", index: 2 },
    ] satisfies WorkspaceReaderSheetDescriptor[]);

    for (const invalid of [
      { spreadsheetId: "foreign", sheets: [] },
      {
        spreadsheetId: "sheet_123",
        sheets: [
          { properties: { sheetId: 1, title: "One", sheetType: "GRID" } },
          { properties: { sheetId: 1, title: "Duplicate", sheetType: "GRID" } },
        ],
      },
      {
        spreadsheetId: "sheet_123",
        sheets: [{ properties: { sheetId: 1, sheetType: "GRID" } }],
      },
      {
        spreadsheetId: "sheet_123",
        sheets: [{ properties: { sheetId: 1, title: "Missing type" } }],
      },
    ]) {
      expect(parseWorkspaceReaderSheetCatalog(invalid, "sheet_123")).toBeNull();
    }
  });

  it("escapes a sheet title and builds only a 100-row A1 range", () => {
    expect(sheetsPageRange("Q1's data", 101)).toBe("'Q1''s data'!101:200");
    expect(sheetsPageRange("", 1)).toBeNull();
    expect(sheetsPageRange("Sheet", 0)).toBeNull();
  });

  it("keeps every Reader response correlated to its request type", () => {
    const page = mergeWorkspaceSheetPageFragments(grid(1, 0), 0, [
      {
        sheetId: "42",
        generation: 2,
        startRow: 0,
        rowCount: 1,
        startColumn: 0,
        columnCount: 1,
        rows: [],
      },
    ]);
    if (!page) throw new Error("invalid test page");
    const requests = [
      {
        ...owner,
        type: "WORKSPACE_READER_CONTEXT",
        sourceTabId: 7,
      },
      {
        ...owner,
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 1,
        sourceTabId: 7,
        version,
        cursor: null,
      },
    ] satisfies WorkspaceReaderRequest[];
    const responses = [
      {
        ...owner,
        type: "WORKSPACE_READER_CONTEXT",
        ok: true,
        version,
        configured: true,
        connected: false,
        context: sheetsContext,
        targetLanguage: "en",
      },
      {
        ...owner,
        type: "WORKSPACE_READER_CONNECT",
        requestId: 1,
        ok: true,
        version,
        connected: true,
      },
      {
        ...owner,
        type: "WORKSPACE_READER_DISCONNECT",
        requestId: 2,
        ok: true,
        version,
        connected: false,
      },
      {
        ...owner,
        type: "WORKSPACE_READER_DISCOVER",
        requestId: 3,
        ok: true,
        version,
        sheets: [{ sheetId: "42", title: "Grid", index: 0 }],
        progress: {
          status: "scanning",
          axis: "columns",
          scanned: 32,
          total: 64,
          cursor: { kind: "sheets-discovery", token: "opaque" },
        },
      },
      {
        ...owner,
        type: "WORKSPACE_READER_LOAD",
        requestId: 4,
        ok: true,
        version,
        generation: 2,
        context: sheetsContext,
        title: "Sheet",
        records: [],
        cursor: null,
        page,
      },
      {
        ...owner,
        type: "WORKSPACE_READER_LOAD",
        requestId: 5,
        ok: true,
        version,
        generation: 1,
        context: docsContext,
        title: "Document",
        records: [],
        cursor: null,
      },
      {
        ...owner,
        type: "WORKSPACE_READER_TRANSLATE",
        requestId: 6,
        ok: true,
        version,
        generation: 1,
        results: [
          { id: "one", sourceHash: "hash", text: "Translation" },
          { id: "two", sourceHash: "hash", error: "unresolved" },
        ],
      },
      {
        ...owner,
        type: "WORKSPACE_READER_LOAD",
        requestId: 7,
        ok: false,
        version,
        error: "google-auth-required",
      },
    ] satisfies WorkspaceReaderResponse[];

    expect(
      requests.map(({ type, requestId }) => ({ type, requestId })),
    ).toEqual([
      { type: "WORKSPACE_READER_CONTEXT", requestId: 0 },
      { type: "WORKSPACE_READER_DISCOVER", requestId: 1 },
    ]);
    expect(
      responses.map(({ type, requestId, ok }) => ({ type, requestId, ok })),
    ).toEqual([
      { type: "WORKSPACE_READER_CONTEXT", requestId: 0, ok: true },
      { type: "WORKSPACE_READER_CONNECT", requestId: 1, ok: true },
      { type: "WORKSPACE_READER_DISCONNECT", requestId: 2, ok: true },
      { type: "WORKSPACE_READER_DISCOVER", requestId: 3, ok: true },
      { type: "WORKSPACE_READER_LOAD", requestId: 4, ok: true },
      { type: "WORKSPACE_READER_LOAD", requestId: 5, ok: true },
      { type: "WORKSPACE_READER_TRANSLATE", requestId: 6, ok: true },
      { type: "WORKSPACE_READER_LOAD", requestId: 7, ok: false },
    ]);
    expect("page" in responses[4]!).toBe(true);
    expect("page" in responses[5]!).toBe(false);
  });
});

describe("Sheets grid contracts and pure parsers", () => {
  it("accepts only the strict canonical resolved cell style", () => {
    expect(parseWorkspaceSheetCellStyle(cellStyle)).toEqual(cellStyle);
    const rich: WorkspaceSheetCellStyle = {
      ...cellStyle,
      wrapStrategy: "clip",
      shrinkToFit: false,
      fontFamily: "Noto Sans JP",
      fontSize: 9.5,
      direction: "rtl",
      rotation: "vertical",
      indent: 2,
      borders: { ...cellStyle.borders, bottom: "#ffffff" },
      borderLines: {
        ...cellStyle.borderLines,
        bottom: { style: "dashed", width: 2 },
      },
    };
    expect(parseWorkspaceSheetCellStyle(rich)).toEqual(rich);
    // A raw Google CellFormat or the retired boolean model is not canonical.
    expect(parseWorkspaceSheetCellStyle({ wrapStrategy: "WRAP" })).toBeNull();
    const withoutStrategy: Record<string, unknown> = { ...cellStyle };
    delete withoutStrategy.wrapStrategy;
    expect(
      parseWorkspaceSheetCellStyle({ ...withoutStrategy, wrap: true }),
    ).toBeNull();
    for (const invalid of [
      { color: "red" },
      { wrapStrategy: "WRAP" },
      { fontFamily: 'Arial"; background:url(x)' },
      { fontSize: 0 },
      { horizontal: "start" },
      { rotation: 91 },
      { indent: -1 },
      { direction: "auto" },
      { padding: { ...cellStyle.padding, left: -1 } },
      { borders: { ...cellStyle.borders, top: "url(javascript:bad)" } },
      // A drawn line needs a color and a colored border needs a line.
      { borders: { ...cellStyle.borders, top: "#000000" } },
      {
        borderLines: {
          ...cellStyle.borderLines,
          top: { style: "solid", width: 1 },
        },
      },
      {
        borders: { ...cellStyle.borders, top: "#000000" },
        borderLines: {
          ...cellStyle.borderLines,
          top: { style: "wavy", width: 1 },
        },
      },
    ])
      expect(
        parseWorkspaceSheetCellStyle({ ...cellStyle, ...invalid }),
      ).toBeNull();
  });

  it("keeps absolute sparse columns ordered and clips merges to the used grid", () => {
    expect(
      mergeWorkspaceSheetDiscoveryFragments(2, [
        {
          generation: 1,
          startRow: 0,
          rowCount: 100,
          startColumn: 0,
          columnCount: 32,
          lastUsedColumn: 25,
          lastUsedRow: 99,
        },
        {
          generation: 2,
          startRow: 100,
          rowCount: 100,
          startColumn: 0,
          columnCount: 32,
          lastUsedColumn: 5,
          lastUsedRow: 199,
        },
        {
          generation: 2,
          startRow: 0,
          rowCount: 100,
          startColumn: 0,
          columnCount: 32,
          lastUsedColumn: 2,
          lastUsedRow: 99,
        },
        {
          generation: 2,
          startRow: 0,
          rowCount: 100,
          startColumn: 0,
          columnCount: 32,
          lastUsedColumn: 2,
          lastUsedRow: 99,
        },
      ])?.map(({ index }) => index),
    ).toEqual([0, 1, 2, 3, 4, 5]);

    const parsed = parseWorkspaceSheetGrid({
      sheetId: "42",
      title: "Sparse",
      generation: 2,
      rowCount: 101,
      lastUsedColumn: 26,
      columns: [
        { index: 26, pixelSize: 88, hidden: false },
        { index: 0, pixelSize: 72, hidden: false },
        { index: 25, pixelSize: 99, hidden: true },
      ],
      frozenRowCount: 1,
      frozenColumnCount: 1,
      rightToLeft: true,
      hideGridlines: true,
      defaultStyle: defaultWorkspaceSheetCellStyle(),
      defaultRowPixelSize: 21,
      defaultColumnPixelSize: 100,
      merges: [{ startRow: 0, endRow: 1, startColumn: 25, endColumn: 30 }],
    });
    expect(parsed?.columns).toHaveLength(27);
    expect(parsed?.columns.slice(24)).toEqual([
      { index: 24, pixelSize: 100, hidden: false },
      { index: 25, pixelSize: 99, hidden: true },
      { index: 26, pixelSize: 88, hidden: false },
    ]);
    expect(parsed?.merges).toEqual([
      { startRow: 0, endRow: 1, startColumn: 25, endColumn: 27 },
    ]);
    expect(
      parseWorkspaceSheetGrid({
        ...parsed,
        merges: [
          { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
          { startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 },
        ],
      }),
    ).toBeNull();
  });

  it("represents an empty completed sheet without admitting other negative indexes", () => {
    const empty = {
      sheetId: "42",
      title: "Empty",
      generation: 2,
      rowCount: 100,
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
    expect(parseWorkspaceSheetGrid(empty)).toEqual(empty);
    expect(
      parseWorkspaceSheetDiscoveryProgress({ status: "complete", grid: empty }),
    ).toEqual({ status: "complete", grid: empty });
    expect(
      parseWorkspaceSheetGrid({ ...empty, lastUsedColumn: -2 }),
    ).toBeNull();
    expect(
      parseWorkspaceSheetGrid({
        ...empty,
        lastUsedColumn: 0,
        columns: [{ index: -1, pixelSize: 100, hidden: false }],
      }),
    ).toBeNull();
    expect(
      parseWorkspaceSheetGrid({ ...empty, frozenColumnCount: -1 }),
    ).toBeNull();
    expect(
      parseWorkspaceSheetGrid({
        ...empty,
        merges: [{ startRow: 0, endRow: 1, startColumn: -1, endColumn: 1 }],
      }),
    ).toBeNull();
  });

  it("round-trips only the canonical empty-grid page", () => {
    const emptyGrid = parseWorkspaceSheetGrid({
      sheetId: "42",
      title: "Empty",
      generation: 2,
      rowCount: 250,
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
    });
    if (!emptyGrid) throw new Error("invalid empty test grid");
    const page = {
      sheetId: "42",
      generation: 2,
      startRow: 0,
      rowCount: 100,
      rows: [],
      cursor: null,
    };
    expect(parseWorkspaceSheetPage(page, emptyGrid)).toEqual(page);
    for (const malformed of [
      { ...page, startRow: 100 },
      { ...page, rowCount: 99 },
      { ...page, generation: 3 },
      {
        ...page,
        rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [] }],
      },
      { ...page, cursor: { kind: "sheets", nextRow: 100 } },
    ]) {
      expect(parseWorkspaceSheetPage(malformed, emptyGrid)).toBeNull();
    }
  });

  it("validates strict two-axis discovery progress", () => {
    for (const axis of ["columns", "rows"] as const) {
      const progress = {
        status: "scanning",
        axis,
        scanned: 32,
        total: 64,
        cursor: { kind: "sheets-discovery", token: "opaque" },
      };
      expect(parseWorkspaceSheetDiscoveryProgress(progress)).toEqual(progress);
      expect(
        parseWorkspaceSheetDiscoveryProgress({ ...progress, range: "A:Z" }),
      ).toBeNull();
      expect(
        parseWorkspaceSheetDiscoveryProgress({ ...progress, scanned: 65 }),
      ).toBeNull();
    }
    expect(
      parseWorkspaceSheetDiscoveryProgress({
        status: "scanning",
        axis: "depth",
        scanned: 0,
        total: 0,
        cursor: { kind: "sheets-discovery", token: "opaque" },
      }),
    ).toBeNull();
    expect(
      parseWorkspaceSheetDiscoveryProgress({
        status: "scanning",
        scanned: 0,
        total: 0,
        cursor: { kind: "sheets-discovery", token: "opaque" },
      }),
    ).toBeNull();
  });

  it("validates absolute discovery fragment bounds and exact keys", () => {
    const fragment = {
      generation: 2,
      startRow: 100,
      rowCount: 100,
      startColumn: 32,
      columnCount: 32,
      lastUsedColumn: 63,
      lastUsedRow: 199,
    };
    expect(parseWorkspaceSheetDiscoveryFragment(fragment)).toEqual(fragment);
    expect(
      parseWorkspaceSheetDiscoveryFragment({
        ...fragment,
        lastUsedColumn: null,
        lastUsedRow: null,
      }),
    ).not.toBeNull();
    for (const malformed of [
      { ...fragment, extra: true },
      {
        generation: 2,
        startRow: 100,
        rowCount: 100,
        startColumn: 32,
        columnCount: 32,
        lastUsedColumn: 63,
      },
      { ...fragment, lastUsedRow: undefined },
      { ...fragment, lastUsedRow: 99 },
      { ...fragment, lastUsedRow: 200 },
      { ...fragment, lastUsedColumn: 31 },
      { ...fragment, lastUsedColumn: 64 },
    ]) {
      expect(parseWorkspaceSheetDiscoveryFragment(malformed)).toBeNull();
    }
  });

  it("accepts rich-text runs that spell the cell text and rejects the rest", () => {
    const run = (text: string, extra = {}) => ({
      text,
      color: "#ff0000",
      bold: false,
      italic: false,
      underline: false,
      strikethrough: true,
      ...extra,
    });
    const withRuns = (runs: unknown) => {
      const cell = { ...gridCell(0, 0), source: "AB", display: "AB", runs };
      return {
        sheetId: "42",
        generation: 2,
        startRow: 0,
        rowCount: 100,
        startColumn: 0,
        columnCount: 16,
        rows: [{ index: 0, pixelSize: 21, hidden: false, cells: [cell] }],
      };
    };
    const parsed = parseWorkspaceSheetPageFragment(
      withRuns([run("A"), run("B", { color: null })]),
    );
    expect(parsed?.rows[0]?.cells[0]?.runs).toHaveLength(2);
    for (const malformed of [
      [run("A")],
      [run("A"), run("B", { color: "red" })],
      [run("A"), run("B", { extra: 1 })],
      [],
    ]) {
      expect(parseWorkspaceSheetPageFragment(withRuns(malformed))).toBeNull();
    }
  });

  it("merges split, overlapping and duplicate page fragments by absolute indexes", () => {
    const sheetGrid = grid(101, 26);
    const left = {
      sheetId: "42",
      generation: 2,
      startRow: 0,
      rowCount: 100,
      startColumn: 0,
      columnCount: 16,
      rows: [
        {
          index: 0,
          pixelSize: 21,
          hidden: false,
          cells: [gridCell(0, 5), gridCell(0, 0), gridCell(0, 2)],
        },
      ],
    };
    const right = {
      ...left,
      startColumn: 16,
      columnCount: 11,
      rows: [
        {
          index: 0,
          pixelSize: 21,
          hidden: false,
          cells: [gridCell(0, 26), gridCell(0, 25)],
        },
      ],
    };
    const stale = { generation: 1, stale: true };
    const page = mergeWorkspaceSheetPageFragments(sheetGrid, 0, [
      right,
      stale,
      left,
      left,
    ]);
    expect(page?.rows).toHaveLength(100);
    expect(page?.rows[0]?.cells.map(({ anchor }) => anchor)).toEqual([
      "A1",
      "C1",
      "F1",
      "Z1",
      "AA1",
    ]);
    expect(page?.cursor).toEqual({ kind: "sheets", nextRow: 100 });
    expect(parseWorkspaceSheetPage(page, sheetGrid)).toEqual(page);

    const conflict = structuredClone(left);
    conflict.rows[0]!.cells[0]!.source = "different";
    expect(
      mergeWorkspaceSheetPageFragments(sheetGrid, 0, [left, conflict, right]),
    ).toBeNull();
    expect(mergeWorkspaceSheetPageFragments(sheetGrid, 0, [left])).toBeNull();
    expect(mergeWorkspaceSheetPageFragments(sheetGrid, 0, [stale])).toBeNull();
  });

  it.each([
    [1, 1, null],
    [3, 3, null],
    [99, 99, null],
    [100, 100, null],
    [101, 100, { kind: "sheets", nextRow: 100 }],
  ] as const)(
    "commits the logical %i-row boundary",
    (totalRows, pageRows, cursor) => {
      const sheetGrid = grid(totalRows, 0);
      const page = mergeWorkspaceSheetPageFragments(sheetGrid, 0, [
        {
          sheetId: "42",
          generation: 2,
          startRow: 0,
          rowCount: pageRows,
          startColumn: 0,
          columnCount: 1,
          rows: [],
        },
      ]);
      expect(page).toMatchObject({ startRow: 0, rowCount: pageRows, cursor });
    },
  );

  it("validates page fragments and the final one-row page", () => {
    expect(
      parseWorkspaceSheetPageFragment({
        sheetId: "42",
        generation: 2,
        startRow: 0,
        rowCount: 100,
        startColumn: 0,
        columnCount: 1,
        rows: [{ index: 100, pixelSize: 21, hidden: false, cells: [] }],
      }),
    ).toBeNull();

    const last = mergeWorkspaceSheetPageFragments(grid(101, 0), 100, [
      {
        sheetId: "42",
        generation: 2,
        startRow: 100,
        rowCount: 1,
        startColumn: 0,
        columnCount: 1,
        rows: [],
      },
    ]);
    expect(last).toMatchObject({ startRow: 100, rowCount: 1, cursor: null });
  });
});

describe("Sheets page parser", () => {
  it("preserves A1, formula/display/type order and returns the next page", async () => {
    const result = await parseSheetsPage(
      sheet([
        [
          {
            userEnteredValue: { stringValue: "こんにちは" },
            effectiveValue: { stringValue: "こんにちは" },
            formattedValue: "こんにちは",
          },
          {
            userEnteredValue: { formulaValue: "=A1" },
            effectiveValue: { stringValue: "Hello" },
            formattedValue: "Hello",
          },
          {
            userEnteredValue: { numberValue: 1234 },
            effectiveValue: { numberValue: 1234 },
            formattedValue: "1,234",
          },
          {
            userEnteredValue: { boolValue: true },
            effectiveValue: { boolValue: true },
            formattedValue: "TRUE",
          },
          {},
          {
            userEnteredValue: { formulaValue: "=1/0" },
            effectiveValue: {
              errorValue: { type: "DIVIDE_BY_ZERO", message: "#DIV/0!" },
            },
            formattedValue: "#DIV/0!",
          },
        ],
      ]),
      sheetsContext,
      1,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("Q1's data");
    expect(result.cursor).toEqual({ kind: "sheets", nextRow: 101 });
    expect(
      result.records.map(({ anchor, source, display, kind, translatable }) => ({
        anchor,
        source,
        display,
        kind,
        translatable,
      })),
    ).toEqual([
      {
        anchor: "A1",
        source: "こんにちは",
        display: "こんにちは",
        kind: "text",
        translatable: true,
      },
      {
        anchor: "B1",
        source: "=A1",
        display: "Hello",
        kind: "formula",
        translatable: true,
      },
      {
        anchor: "C1",
        source: "1234",
        display: "1,234",
        kind: "number",
        translatable: false,
      },
      {
        anchor: "D1",
        source: "true",
        display: "TRUE",
        kind: "boolean",
        translatable: false,
      },
      {
        anchor: "E1",
        source: "",
        display: "",
        kind: "blank",
        translatable: false,
      },
      {
        anchor: "F1",
        source: "=1/0",
        display: "#DIV/0!",
        kind: "formula",
        translatable: false,
      },
    ]);
    expect(
      result.records.every((record) =>
        /^[a-f0-9]{40}$/.test(record.sourceHash),
      ),
    ).toBe(true);
    expect(new Set(result.records.map((record) => record.id)).size).toBe(6);
  });

  it("rejects non-grid sheets, wrong identities and overlapping A1 records", async () => {
    const nonGrid = sheet([], {
      properties: {
        sheetId: 42,
        title: "Object",
        sheetType: "OBJECT",
        gridProperties: { rowCount: 1 },
      },
    });
    await expect(parseSheetsPage(nonGrid, sheetsContext, 1)).resolves.toEqual({
      ok: false,
      error: "unsupported-file-type",
    });
    await expect(
      parseSheetsPage(
        { ...sheet([]), spreadsheetId: "other" },
        sheetsContext,
        1,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-request" });

    const overlap = sheet([]);
    overlap.sheets[0]!.data = [
      { startRow: 0, startColumn: 0, rowData: [{ values: [{}] }] },
      { startRow: 0, startColumn: 0, rowData: [{ values: [{}] }] },
    ];
    await expect(parseSheetsPage(overlap, sheetsContext, 1)).resolves.toEqual({
      ok: false,
      error: "invalid-request",
    });
    await expect(
      parseSheetsPage(
        sheet(Array.from({ length: SHEETS_PAGE_ROWS + 1 }, () => [{}])),
        sheetsContext,
        1,
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-request" });
  });

  it("binds a URL without gid to the first returned native sheet", async () => {
    const result = await parseSheetsPage(
      sheet([[{ userEnteredValue: { stringValue: "First" } }]]),
      { ...sheetsContext, activeId: null },
      1,
    );
    expect(result).toMatchObject({
      ok: true,
      context: { activeId: "42" },
      records: [{ anchor: "A1", source: "First" }],
    });
  });

  it("enforces response, record, source and per-translation bounds", async () => {
    await expect(
      parseSheetsPage(
        { ...sheet([]), padding: "x".repeat(MAX_GOOGLE_RESPONSE_BYTES) },
        sheetsContext,
        1,
      ),
    ).resolves.toEqual({ ok: false, error: "response-too-large" });

    await expect(
      parseSheetsPage(
        sheet([Array.from({ length: MAX_LOADED_RECORDS + 1 }, () => ({}))]),
        sheetsContext,
        1,
      ),
    ).resolves.toEqual({ ok: false, error: "content-too-large" });

    for (const source of [
      "x".repeat(MAX_TRANSLATION_RECORD_CHARACTERS + 1),
      "x".repeat(MAX_LOADED_SOURCE_CHARACTERS + 1),
    ]) {
      await expect(
        parseSheetsPage(
          sheet([[{ userEnteredValue: { stringValue: source } }]]),
          sheetsContext,
          1,
        ),
      ).resolves.toEqual({ ok: false, error: "content-too-large" });
    }

    const formulaDisplays = Array.from(
      {
        length:
          MAX_LOADED_SOURCE_CHARACTERS / MAX_TRANSLATION_RECORD_CHARACTERS + 1,
      },
      () => ({
        userEnteredValue: { formulaValue: "=A1" },
        effectiveValue: {
          stringValue: "x".repeat(MAX_TRANSLATION_RECORD_CHARACTERS),
        },
        formattedValue: "x".repeat(MAX_TRANSLATION_RECORD_CHARACTERS),
      }),
    );
    await expect(
      parseSheetsPage(sheet([formulaDisplays]), sheetsContext, 1),
    ).resolves.toEqual({ ok: false, error: "content-too-large" });
  });
});

describe("Docs tabs parser", () => {
  it("preserves tab hierarchy and paragraph/nested-table order", async () => {
    const result = await parseDocsTabs(
      {
        documentId: "doc_123",
        tabs: [
          {
            tabProperties: { tabId: "t.root", title: "Root" },
            documentTab: { body: { content: [paragraph(1, text("Root\n"))] } },
            childTabs: [
              {
                tabProperties: {
                  tabId: "t.child",
                  title: "Child",
                  parentTabId: "t.root",
                },
                documentTab: {
                  body: {
                    content: [
                      paragraph(1, text("Before\n")),
                      {
                        startIndex: 8,
                        table: {
                          tableRows: [
                            {
                              tableCells: [
                                {
                                  content: [paragraph(9, text("Cell\n"))],
                                },
                              ],
                            },
                          ],
                        },
                      },
                      paragraph(20, { equation: {} }),
                      paragraph(21, text("After\n")),
                    ],
                  },
                },
              },
            ],
          },
          {
            tabProperties: { tabId: "t.second", title: "Second" },
            documentTab: {
              body: { content: [paragraph(1, text("Second\n"))] },
            },
          },
        ],
      },
      docsContext,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("Child");
    expect(result.context.activeId).toBe("t.child");
    expect(result.cursor).toBeNull();
    expect(result.tabs).toEqual([
      { id: "t.root", title: "Root", parentId: null, depth: 0 },
      { id: "t.child", title: "Child", parentId: "t.root", depth: 1 },
      { id: "t.second", title: "Second", parentId: null, depth: 0 },
    ]);
    expect(
      result.records.map(({ anchor, source, kind, translatable }) => ({
        anchor,
        source,
        kind,
        translatable,
      })),
    ).toEqual([
      { anchor: "P1.0", source: "Before", kind: "text", translatable: true },
      {
        anchor: "T8.R1.C1.P9.0",
        source: "Cell",
        kind: "text",
        translatable: true,
      },
      {
        anchor: "P20.0",
        source: "[Unsupported equation]",
        kind: "unsupported",
        translatable: false,
      },
      { anchor: "P21.0", source: "After", kind: "text", translatable: true },
    ]);
  });

  it("uses the first top-level tab when the URL has no tab", async () => {
    const result = await parseDocsTabs(
      {
        tabs: [
          {
            tabProperties: { tabId: "t.0", title: "First" },
            documentTab: { body: { content: [paragraph(1, text("First\n"))] } },
          },
        ],
      },
      { ...docsContext, activeId: null },
    );
    expect(result).toMatchObject({
      ok: true,
      title: "First",
      context: { activeId: "t.0" },
    });
  });

  it("rejects malformed identities, duplicate tabs and oversized Docs text", async () => {
    await expect(
      parseDocsTabs({ documentId: "other", tabs: [] }, docsContext),
    ).resolves.toEqual({ ok: false, error: "invalid-request" });
    await expect(
      parseDocsTabs(
        {
          tabs: [
            {
              tabProperties: { tabId: "t.0", title: "One" },
              documentTab: { body: { content: [] } },
              childTabs: [
                {
                  tabProperties: {
                    tabId: "t.0",
                    title: "Duplicate",
                    parentTabId: "t.0",
                  },
                  documentTab: { body: { content: [] } },
                },
              ],
            },
          ],
        },
        { ...docsContext, activeId: "t.0" },
      ),
    ).resolves.toEqual({ ok: false, error: "invalid-request" });
    await expect(
      parseDocsTabs(
        {
          tabs: [
            {
              tabProperties: { tabId: "t.child", title: "Large" },
              documentTab: {
                body: {
                  content: [
                    paragraph(
                      1,
                      text("x".repeat(MAX_LOADED_SOURCE_CHARACTERS + 1)),
                    ),
                  ],
                },
              },
            },
          ],
        },
        docsContext,
      ),
    ).resolves.toEqual({ ok: false, error: "content-too-large" });
  });
});
