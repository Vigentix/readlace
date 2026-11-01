import * as XLSX from "xlsx";
import {
  localSpreadsheetCellStyles,
  localSpreadsheetRichRuns,
  localSpreadsheetDigitWidth,
  localSpreadsheetStyleDefaults,
  localSpreadsheetView,
  localSpreadsheetRowHeights,
  type LocalRichRun,
  retainLocalSpreadsheetStyleFiles,
} from "./local-spreadsheet-styles";

import {
  MAX_LOADED_RECORDS,
  MAX_LOADED_SOURCE_CHARACTERS,
  MAX_SOURCE_DIMENSION_PIXEL_SIZE,
  SHEETS_PAGE_ROWS,
  WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE,
  type WorkspaceRecordKind,
  type WorkspaceSheetCellStyle,
  type WorkspaceSheetGrid,
  type WorkspaceSheetMerge,
  type WorkspaceSheetPage,
  type WorkspaceSheetRow,
  type WorkspaceSheetTextRun,
} from "./google-workspace-reader";

export const MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_LOCAL_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_LOCAL_ARCHIVE_ENTRIES = 4_096;
export const MAX_LOCAL_SHEETS = 50;
export const MAX_LOCAL_ROWS = 100_000;
export const MAX_LOCAL_COLUMNS = 16_384;
export const MAX_LOCAL_MERGES = 1_000;

export type LocalSpreadsheetErrorCode =
  | "unsupported-file-type"
  | "file-too-large"
  | "too-many-sheets"
  | "dimensions-too-large"
  | "content-too-large"
  | "encrypted-workbook"
  | "invalid-workbook"
  | "invalid-request";

export class LocalSpreadsheetError extends Error {
  constructor(readonly code: LocalSpreadsheetErrorCode) {
    super(code);
    this.name = "LocalSpreadsheetError";
  }
}

export interface LocalSpreadsheetMetadata {
  fileName: string;
  sheets: { index: number; name: string }[];
}

export interface LocalSpreadsheetSelection {
  sheetIndex: number;
  sheetName: string;
  grid: WorkspaceSheetGrid;
  page: WorkspaceSheetPage;
}

export interface LocalSpreadsheetWorkbook {
  readonly metadata: LocalSpreadsheetMetadata;
  selectSheet(sheetIndex: number): Promise<LocalSpreadsheetSelection>;
  loadPage(startRow: number): WorkspaceSheetPage;
}

export type LocalSpreadsheetWorkerRequest =
  | {
      type: "parse";
      requestId: string;
      fileName: string;
      bytes: ArrayBuffer;
    }
  | { type: "select-sheet"; requestId: string; sheetIndex: number }
  | { type: "load-page"; requestId: string; startRow: number }
  | { type: "dispose"; requestId: string };

export type LocalSpreadsheetWorkerResponse =
  | {
      type: "parsed";
      requestId: string;
      metadata: LocalSpreadsheetMetadata;
      sheet: LocalSpreadsheetSelection;
    }
  | {
      type: "sheet";
      requestId: string;
      sheet: LocalSpreadsheetSelection;
    }
  | {
      type: "page";
      requestId: string;
      page: WorkspaceSheetPage;
    }
  | { type: "disposed"; requestId: string }
  | {
      type: "error";
      requestId: string;
      error: LocalSpreadsheetErrorCode;
    };

interface NormalizedSheet {
  grid: WorkspaceSheetGrid;
  rows: Map<number, WorkspaceSheetRow>;
}

const allowedExtensions = new Set(["csv", "xlsx", "xlsm"]);

function extension(fileName: string) {
  const match = /\.([^.]+)$/.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Source dimensions are kept exact up to a data-safety ceiling that is far
// above Excel's own limits (409pt rows, 255-character columns); it bounds
// untrusted geometry and is not a display cap.
function pixelSize(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_SOURCE_DIMENSION_PIXEL_SIZE, Math.max(1, Math.round(value)))
    : fallback;
}

function storedRowHeight(metadata: { hpx?: unknown } | undefined) {
  return (
    typeof metadata?.hpx === "number" &&
    Number.isFinite(metadata.hpx) &&
    metadata.hpx > 0
  );
}

function rowPixelSize(value: unknown, fallback: number) {
  return pixelSize(value, fallback);
}

function columnPixelSize(
  column: XLSX.ColInfo | undefined,
  maximumDigitWidth: number | null,
  fallback: number,
) {
  if (
    maximumDigitWidth !== null &&
    typeof column?.width === "number" &&
    Number.isFinite(column.width) &&
    column.width > 0
  ) {
    // OOXML stores character width using the Normal font's maximum digit width.
    return Math.min(
      MAX_SOURCE_DIMENSION_PIXEL_SIZE,
      Math.max(
        1,
        Math.floor(
          ((256 * column.width + Math.floor(128 / maximumDigitWidth)) / 256) *
            maximumDigitWidth,
        ),
      ),
    );
  }
  return pixelSize(column?.wpx, fallback);
}

async function sha1(text: string) {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cachedDisplay(cell: XLSX.CellObject) {
  if (typeof cell.w === "string") return cell.w;
  if (cell.v === null || cell.v === undefined) return "";
  if (cell.v instanceof Date) return cell.v.toISOString();
  return String(cell.v);
}

function retainedSourceUnits(source: string, display: string) {
  return source.length + (display === source ? 0 : display.length);
}

function recordKind(cell: XLSX.CellObject): WorkspaceRecordKind {
  if (typeof cell.f === "string") return "formula";
  if (cell.t === "s" || (cell.t as string) === "str") return "text";
  if (cell.t === "n" || cell.t === "d") return "number";
  if (cell.t === "b") return "boolean";
  if (cell.t === "e") return "error";
  if (cell.v === null || cell.v === undefined) return "blank";
  return "unsupported";
}

function hasContent(cell: XLSX.CellObject | undefined) {
  return Boolean(
    cell &&
    (typeof cell.f === "string" ||
      (cell.v !== null && cell.v !== undefined && String(cell.v).length > 0)),
  );
}

function decodeRange(sheet: XLSX.WorkSheet): XLSX.Range | null {
  if (typeof sheet["!ref"] !== "string") return null;
  if (!/^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/.test(sheet["!ref"]))
    throw new LocalSpreadsheetError("invalid-workbook");
  try {
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    if (
      range.s.r < 0 ||
      range.s.c < 0 ||
      range.e.r < range.s.r ||
      range.e.c < range.s.c
    )
      throw new Error("invalid range");
    return range;
  } catch {
    throw new LocalSpreadsheetError("invalid-workbook");
  }
}

function validateRange(range: XLSX.Range | null) {
  if (
    range &&
    (range.s.r < 0 ||
      range.s.c < 0 ||
      range.e.r >= MAX_LOCAL_ROWS ||
      range.e.c >= MAX_LOCAL_COLUMNS)
  ) {
    throw new LocalSpreadsheetError("dimensions-too-large");
  }
}

function normalizedMerges(sheet: XLSX.WorkSheet) {
  if ((sheet["!merges"]?.length ?? 0) > MAX_LOCAL_MERGES)
    throw new LocalSpreadsheetError("content-too-large");
  const merges: WorkspaceSheetMerge[] = [];
  for (const merge of sheet["!merges"] ?? []) {
    validateRange(merge);
    if (merge.e.r < merge.s.r || merge.e.c < merge.s.c)
      throw new LocalSpreadsheetError("invalid-workbook");
    merges.push({
      startRow: merge.s.r,
      endRow: merge.e.r + 1,
      startColumn: merge.s.c,
      endColumn: merge.e.c + 1,
    });
  }
  return merges;
}

function sparseCells(sheet: XLSX.WorkSheet) {
  const cells: { row: number; column: number; cell: XLSX.CellObject }[] = [];
  for (const key of Object.keys(sheet)) {
    if (key.startsWith("!")) continue;
    const cell = sheet[key] as XLSX.CellObject | undefined;
    if (!hasContent(cell)) continue;
    if (!/^[A-Z]{1,3}[1-9]\d*$/.test(key))
      throw new LocalSpreadsheetError("invalid-workbook");
    let address: XLSX.CellAddress;
    try {
      address = XLSX.utils.decode_cell(key);
    } catch {
      throw new LocalSpreadsheetError("invalid-workbook");
    }
    if (address.r >= MAX_LOCAL_ROWS || address.c >= MAX_LOCAL_COLUMNS)
      throw new LocalSpreadsheetError("dimensions-too-large");
    cells.push({ row: address.r, column: address.c, cell: cell! });
  }
  return cells.toSorted(
    (left, right) => left.row - right.row || left.column - right.column,
  );
}

function freezeCounts(sheet: XLSX.WorkSheet) {
  const freeze = objectValue(
    (sheet as XLSX.WorkSheet & { "!freeze"?: unknown })["!freeze"],
  );
  const rows = freeze?.ySplit ?? freeze?.rows;
  const columns = freeze?.xSplit ?? freeze?.columns;
  return {
    rows:
      typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 0
        ? Math.min(rows, MAX_LOCAL_ROWS)
        : 0,
    columns:
      typeof columns === "number" &&
      Number.isSafeInteger(columns) &&
      columns >= 0
        ? Math.min(columns, MAX_LOCAL_COLUMNS)
        : 0,
  };
}

async function normalizeSheet(
  sheet: XLSX.WorkSheet,
  sheetIndex: number,
  sheetName: string,
  generation: number,
  workbook: XLSX.WorkBook,
  maximumDigitWidth: number | null,
): Promise<NormalizedSheet> {
  const usedRange = decodeRange(sheet);
  const merges = normalizedMerges(sheet);
  let lastRow = -1;
  let lastColumn = -1;
  let populated = 0;
  let sourceUnits = 0;
  const cells = sparseCells(sheet);

  for (const { row, column, cell } of cells) {
    populated += 1;
    if (populated > MAX_LOADED_RECORDS)
      throw new LocalSpreadsheetError("content-too-large");
    const kind = recordKind(cell);
    const source = kind === "formula" ? `=${cell.f!}` : cachedDisplay(cell);
    const display = cachedDisplay(cell);
    sourceUnits += retainedSourceUnits(source, display);
    if (sourceUnits > MAX_LOADED_SOURCE_CHARACTERS)
      throw new LocalSpreadsheetError("content-too-large");
    lastRow = Math.max(lastRow, row);
    lastColumn = Math.max(lastColumn, column);
  }

  for (const merge of merges) {
    lastRow = Math.max(lastRow, merge.endRow - 1);
    lastColumn = Math.max(lastColumn, merge.endColumn - 1);
  }

  // A painted blank (fill or border) is part of the sheet's layout: a yellow
  // block that runs past the last value must keep its full width and height.
  const paintedBounds = {
    row: Math.min(Math.max(lastRow, usedRange?.e.r ?? -1), MAX_LOCAL_ROWS - 1),
    column: Math.min(
      Math.max(lastColumn, usedRange?.e.c ?? -1),
      MAX_LOCAL_COLUMNS - 1,
    ),
  };
  const savedStyles = localSpreadsheetCellStyles(
    workbook,
    sheetIndex,
    paintedBounds.row,
    paintedBounds.column,
  );
  const richRuns = localSpreadsheetRichRuns(
    workbook,
    sheetIndex,
    paintedBounds.row,
    paintedBounds.column,
  );
  for (const [anchor, style] of savedStyles) {
    if (hasContent(sheet[anchor] as XLSX.CellObject | undefined)) continue;
    if (!style.background && !Object.values(style.borders).some(Boolean))
      continue;
    const address = XLSX.utils.decode_cell(anchor);
    lastRow = Math.max(lastRow, address.r);
    lastColumn = Math.max(lastColumn, address.c);
  }
  const rowCount = Math.max(1, lastRow + 1);
  const columnCount = lastColumn + 1;
  const defaults = localSpreadsheetStyleDefaults(
    workbook,
    sheetIndex,
    maximumDigitWidth,
  );
  const defaultColumnPixelSize =
    defaults.defaultColumnPixelSize === null
      ? WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE
      : Math.min(
          MAX_SOURCE_DIMENSION_PIXEL_SIZE,
          defaults.defaultColumnPixelSize,
        );
  for (const [anchor, style] of savedStyles) {
    if (hasContent(sheet[anchor] as XLSX.CellObject | undefined)) continue;
    // A blank cell is modeled only when it paints a fill or a border.
    if (!style.background && !Object.values(style.borders).some(Boolean))
      continue;
    const address = XLSX.utils.decode_cell(anchor);
    cells.push({ row: address.r, column: address.c, cell: { t: "z" } });
  }
  if (
    cells.length > MAX_LOADED_RECORDS ||
    savedStyles.size > MAX_LOADED_RECORDS
  )
    throw new LocalSpreadsheetError("content-too-large");
  // Sort again after adding painted blanks, so merge lookup can sweep rows.
  cells.sort(
    (left, right) => left.row - right.row || left.column - right.column,
  );
  const orderedMerges = merges.toSorted(
    (left, right) => left.startRow - right.startRow,
  );
  let mergeCursor = 0;
  let activeMerges: WorkspaceSheetMerge[] = [];
  let previousRow = -1;
  // Keep crypto work bounded rather than serially awaiting up to 10,000 digests.
  const hashes = new Map<string, string>();
  const sources = [...new Set(cells.map(({ cell }) => cachedDisplay(cell)))];
  for (let offset = 0; offset < sources.length; offset += 64) {
    await Promise.all(
      sources.slice(offset, offset + 64).map(async (source) => {
        hashes.set(source, await sha1(source));
      }),
    );
  }
  const rowMetadata = (sheet["!rows"] ?? []) as XLSX.RowInfo[];
  const savedRowHeights = localSpreadsheetRowHeights(
    workbook,
    sheetIndex,
    rowCount - 1,
  );
  const rowHeight = (row: number) =>
    savedRowHeights.get(row) ?? rowMetadata[row]?.hpx;
  const columnMetadata = (sheet["!cols"] ?? []) as XLSX.ColInfo[];
  const rows = new Map<number, WorkspaceSheetRow>();
  for (const { row, column, cell } of cells) {
    const kind = recordKind(cell);
    const source = kind === "formula" ? `=${cell.f!}` : cachedDisplay(cell);
    const display = cachedDisplay(cell);
    const translationSource = kind === "formula" ? display : source;
    if (row !== previousRow) {
      activeMerges = activeMerges.filter((merge) => row < merge.endRow);
      while (
        mergeCursor < orderedMerges.length &&
        orderedMerges[mergeCursor]!.startRow <= row
      ) {
        const merge = orderedMerges[mergeCursor++]!;
        if (row < merge.endRow) activeMerges.push(merge);
      }
      previousRow = row;
    }
    const merge = activeMerges.find(
      (candidate) =>
        column >= candidate.startColumn && column < candidate.endColumn,
    );
    if (merge && (row !== merge.startRow || column !== merge.startColumn))
      continue;
    const anchor = XLSX.utils.encode_cell({ r: row, c: column });
    let style = savedStyles.get(anchor) ?? defaults.defaultStyle;
    if (merge) {
      // A merged range paints the perimeter saved on its far-edge cells.
      const corner = (r: number, c: number) =>
        savedStyles.get(XLSX.utils.encode_cell({ r, c }));
      const topRight = corner(merge.startRow, merge.endColumn - 1);
      const bottomLeft = corner(merge.endRow - 1, merge.startColumn);
      const bottomRight = corner(merge.endRow - 1, merge.endColumn - 1);
      const side = (
        name: "top" | "right" | "bottom" | "left",
        donors: (WorkspaceSheetCellStyle | undefined)[],
      ) => {
        for (const donor of [style, ...donors]) {
          if (donor?.borders[name]) return donor;
        }
        return null;
      };
      const donors = {
        top: side("top", [topRight]),
        right: side("right", [topRight, bottomRight]),
        bottom: side("bottom", [bottomLeft, bottomRight]),
        left: side("left", [bottomLeft]),
      };
      style = {
        ...style,
        borders: {
          top: donors.top?.borders.top ?? null,
          right: donors.right?.borders.right ?? null,
          bottom: donors.bottom?.borders.bottom ?? null,
          left: donors.left?.borders.left ?? null,
        },
        borderLines: {
          top: donors.top?.borderLines.top ?? null,
          right: donors.right?.borderLines.right ?? null,
          bottom: donors.bottom?.borderLines.bottom ?? null,
          left: donors.left?.borderLines.left ?? null,
        },
      };
    }
    const sheetRow =
      rows.get(row) ??
      ({
        index: row,
        pixelSize: rowPixelSize(rowHeight(row), defaults.defaultRowPixelSize),
        hidden: rowMetadata[row]?.hidden === true,
        ...(storedRowHeight({ hpx: rowHeight(row) }) ||
        rowMetadata[row]?.hidden === true
          ? {}
          : { autoHeight: true as const }),
        cells: [],
      } satisfies WorkspaceSheetRow);
    sheetRow.cells.push({
      id: `local:${sheetIndex}:${anchor}`,
      anchor,
      source,
      display,
      kind,
      translatable:
        kind === "text"
          ? source.trim().length > 0
          : kind === "formula" &&
            (cell.t === "s" || (cell.t as string) === "str") &&
            display.trim().length > 0,
      sourceHash: hashes.get(translationSource)!,
      rowIndex: row,
      columnIndex: column,
      rowSpan: merge ? merge.endRow - merge.startRow : 1,
      columnSpan: merge ? merge.endColumn - merge.startColumn : 1,
      style,
      ...richTextRuns(
        richRuns.get(anchor),
        kind === "text" ? source : null,
        style,
      ),
    });
    rows.set(row, sheetRow);
  }
  for (const row of rows.values())
    row.cells.sort((left, right) => left.columnIndex - right.columnIndex);
  for (
    let index = 0;
    index < Math.min(rowMetadata.length, rowCount);
    index += 1
  ) {
    const metadata = rowMetadata[index];
    if (!metadata || rows.has(index)) continue;
    rows.set(index, {
      index,
      pixelSize: rowPixelSize(rowHeight(index), defaults.defaultRowPixelSize),
      hidden: metadata.hidden === true,
      cells: [],
    });
  }

  const view = localSpreadsheetView(workbook, sheetIndex);
  const freeze = view ?? freezeCounts(sheet);
  return {
    grid: {
      sheetId: `local:${sheetIndex}`,
      title: sheetName,
      generation,
      rowCount,
      lastUsedColumn: lastColumn,
      columns: Array.from({ length: columnCount }, (_, index) => ({
        index,
        pixelSize: columnPixelSize(
          columnMetadata[index],
          maximumDigitWidth,
          defaultColumnPixelSize,
        ),
        hidden: columnMetadata[index]?.hidden === true,
      })),
      frozenRowCount: Math.min(freeze.rows, rowCount),
      frozenColumnCount: Math.min(freeze.columns, columnCount),
      rightToLeft: view?.rightToLeft ?? false,
      hideGridlines: view?.hideGridlines ?? false,
      merges,
      defaultStyle: defaults.defaultStyle,
      defaultRowPixelSize: defaults.defaultRowPixelSize,
      defaultColumnPixelSize,
    },
    rows,
  };
}

function pageFor(sheet: NormalizedSheet, startRow: number): WorkspaceSheetPage {
  if (
    !Number.isSafeInteger(startRow) ||
    startRow < 0 ||
    startRow >= sheet.grid.rowCount ||
    startRow % SHEETS_PAGE_ROWS !== 0
  ) {
    throw new LocalSpreadsheetError("invalid-request");
  }
  const rowCount = Math.min(SHEETS_PAGE_ROWS, sheet.grid.rowCount - startRow);
  const rows: WorkspaceSheetRow[] = [];
  if (sheet.grid.lastUsedColumn !== -1) {
    for (let index = startRow; index < startRow + rowCount; index += 1) {
      const metadata = sheet.rows.get(index);
      rows.push(
        metadata ?? {
          index,
          pixelSize: sheet.grid.defaultRowPixelSize,
          hidden: false,
          cells: [],
        },
      );
    }
  }
  const nextRow = startRow + rowCount;
  return {
    sheetId: sheet.grid.sheetId,
    generation: sheet.grid.generation,
    startRow,
    rowCount,
    rows,
    cursor: nextRow < sheet.grid.rowCount ? { kind: "sheets", nextRow } : null,
  };
}

function isEncryptedContainer(bytes: ArrayBuffer) {
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
  return (
    prefix.length === 8 &&
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every(
      (byte, index) => prefix[index] === byte,
    )
  );
}

function isZipContainer(bytes: ArrayBuffer) {
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 4));
  return (
    prefix.length === 4 &&
    prefix[0] === 0x50 &&
    prefix[1] === 0x4b &&
    ((prefix[2] === 0x03 && prefix[3] === 0x04) ||
      (prefix[2] === 0x05 && prefix[3] === 0x06) ||
      (prefix[2] === 0x07 && prefix[3] === 0x08))
  );
}

/** Reject expansion bombs before SheetJS retains or parses any package member. */
async function preflightZip(bytes: ArrayBuffer) {
  const data = new DataView(bytes);
  const invalid = () => {
    throw new LocalSpreadsheetError("invalid-workbook");
  };
  const check = (condition: boolean) => {
    if (!condition) invalid();
  };
  let end = -1;
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 65_557);
    offset--
  ) {
    if (
      data.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + data.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      end = offset;
      break;
    }
  }
  check(end >= 0);
  // Multi-disk and ZIP64 are outside this bounded 20 MiB saved-workbook contract.
  check(
    data.getUint16(end + 4, true) === 0 && data.getUint16(end + 6, true) === 0,
  );
  const count = data.getUint16(end + 10, true);
  check(
    count > 0 && count !== 0xffff && count === data.getUint16(end + 8, true),
  );
  if (count > MAX_LOCAL_ARCHIVE_ENTRIES)
    throw new LocalSpreadsheetError("content-too-large");
  const directorySize = data.getUint32(end + 12, true);
  const directory = data.getUint32(end + 16, true);
  check(directory + directorySize === end);
  const extraFields = (start: number, size: number) => {
    const stop = start + size;
    while (start < stop) {
      check(start + 4 <= stop);
      const kind = data.getUint16(start, true);
      const length = data.getUint16(start + 2, true);
      check(kind !== 1 && start + 4 + length <= stop);
      start += 4 + length;
    }
  };
  const members: {
    start: number;
    stop: number;
    payload: number;
    compressed: number;
    expanded: number;
    method: number;
  }[] = [];
  const names = new Set<string>();
  let cursor = directory;
  let expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    check(cursor + 46 <= end && data.getUint32(cursor, true) === 0x02014b50);
    const flags = data.getUint16(cursor + 8, true);
    const method = data.getUint16(cursor + 10, true);
    if (flags & 0x2041) throw new LocalSpreadsheetError("encrypted-workbook");
    check(method === 0 || method === 8);
    const compressed = data.getUint32(cursor + 20, true);
    const expanded = data.getUint32(cursor + 24, true);
    const nameLength = data.getUint16(cursor + 28, true);
    const extraLength = data.getUint16(cursor + 30, true);
    const commentLength = data.getUint16(cursor + 32, true);
    const start = data.getUint32(cursor + 42, true);
    check(
      data.getUint16(cursor + 34, true) === 0 &&
        compressed !== 0xffffffff &&
        expanded !== 0xffffffff,
    );
    check(cursor + 46 + nameLength + extraLength + commentLength <= end);
    const nameBytes = new Uint8Array(bytes, cursor + 46, nameLength);
    const name = new TextDecoder().decode(nameBytes);
    check(nameLength > 0 && !names.has(name));
    names.add(name);
    extraFields(cursor + 46 + nameLength, extraLength);
    check(
      start + 30 <= directory && data.getUint32(start, true) === 0x04034b50,
    );
    check(
      data.getUint16(start + 6, true) === flags &&
        data.getUint16(start + 8, true) === method,
    );
    const localNameLength = data.getUint16(start + 26, true);
    const localExtraLength = data.getUint16(start + 28, true);
    const payload = start + 30 + localNameLength + localExtraLength;
    check(payload + compressed <= directory && localNameLength === nameLength);
    check(
      nameBytes.every(
        (byte, index) => data.getUint8(start + 30 + index) === byte,
      ),
    );
    extraFields(start + 30 + localNameLength, localExtraLength);
    const localCompressed = data.getUint32(start + 18, true);
    const localExpanded = data.getUint32(start + 22, true);
    check(
      (localCompressed === compressed && localExpanded === expanded) ||
        (Boolean(flags & 8) && localCompressed === 0 && localExpanded === 0),
    );
    let stop = payload + compressed;
    if (flags & 8) {
      check(stop + 12 <= directory);
      const descriptor =
        stop + (data.getUint32(stop, true) === 0x08074b50 ? 4 : 0);
      check(
        descriptor + 12 <= directory &&
          data.getUint32(descriptor + 4, true) === compressed &&
          data.getUint32(descriptor + 8, true) === expanded,
      );
      stop = descriptor + 12;
    }
    check(method !== 0 || expanded === compressed);
    expandedTotal += expanded;
    if (expandedTotal > MAX_LOCAL_EXPANDED_BYTES)
      throw new LocalSpreadsheetError("content-too-large");
    members.push({ start, stop, payload, compressed, expanded, method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  check(cursor === end);
  members.sort((left, right) => left.start - right.start);
  for (let index = 1; index < members.length; index++)
    check(members[index - 1]!.stop <= members[index]!.start);
  for (const member of members) {
    if (member.method === 0) continue;
    // Observe actual output too: a forged central/local size must not bypass the cap.
    let inputOffset = 0;
    const stream = new ReadableStream<BufferSource>({
      pull(controller) {
        if (inputOffset === member.compressed) {
          controller.close();
          return;
        }
        // Small input chunks also bound native output queued before cancellation.
        const length = Math.min(1_024, member.compressed - inputOffset);
        controller.enqueue(
          new Uint8Array(bytes, member.payload + inputOffset, length),
        );
        inputOffset += length;
      },
    }).pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    let observed = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        observed += chunk.value.byteLength;
        if (observed > member.expanded) {
          await reader.cancel();
          throw new LocalSpreadsheetError("content-too-large");
        }
      }
      check(observed === member.expanded);
    } catch (error) {
      if (error instanceof LocalSpreadsheetError) throw error;
      invalid();
    } finally {
      reader.releaseLock();
    }
  }
}

class ParsedLocalSpreadsheet implements LocalSpreadsheetWorkbook {
  readonly metadata: LocalSpreadsheetMetadata;
  private selected: NormalizedSheet | null = null;
  private generation = 0;
  private readonly maximumDigitWidth: number | null;

  constructor(
    private readonly workbook: XLSX.WorkBook,
    fileName: string,
  ) {
    this.metadata = {
      fileName,
      sheets: workbook.SheetNames.map((name, index) => ({ index, name })),
    };
    this.maximumDigitWidth = localSpreadsheetDigitWidth(workbook);
  }

  async selectSheet(sheetIndex: number) {
    if (
      !Number.isSafeInteger(sheetIndex) ||
      sheetIndex < 0 ||
      sheetIndex >= this.workbook.SheetNames.length
    ) {
      throw new LocalSpreadsheetError("invalid-request");
    }
    const sheetName = this.workbook.SheetNames[sheetIndex]!;
    const sheet = this.workbook.Sheets[sheetName];
    if (!sheet) throw new LocalSpreadsheetError("invalid-workbook");
    this.selected = await normalizeSheet(
      sheet,
      sheetIndex,
      sheetName,
      ++this.generation,
      this.workbook,
      this.maximumDigitWidth,
    );
    return {
      sheetIndex,
      sheetName,
      grid: this.selected.grid,
      page: pageFor(this.selected, 0),
    };
  }

  loadPage(startRow: number) {
    if (!this.selected) throw new LocalSpreadsheetError("invalid-request");
    return pageFor(this.selected, startRow);
  }
}

export async function parseLocalSpreadsheet(
  bytes: ArrayBuffer,
  fileName: string,
): Promise<LocalSpreadsheetWorkbook> {
  const fileExtension = extension(fileName);
  if (!allowedExtensions.has(fileExtension))
    throw new LocalSpreadsheetError("unsupported-file-type");
  if (bytes.byteLength > MAX_LOCAL_FILE_BYTES)
    throw new LocalSpreadsheetError("file-too-large");
  if (fileExtension !== "csv" && isEncryptedContainer(bytes))
    throw new LocalSpreadsheetError("encrypted-workbook");
  if (fileExtension !== "csv" && !isZipContainer(bytes))
    throw new LocalSpreadsheetError("invalid-workbook");
  if (fileExtension !== "csv") await preflightZip(bytes);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: "array",
      raw: fileExtension === "csv",
      cellFormula: true,
      cellText: true,
      cellStyles: true,
      cellDates: false,
      bookVBA: false,
      bookFiles: fileExtension !== "csv",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new LocalSpreadsheetError(
      /password|encrypted|encryption/i.test(message)
        ? "encrypted-workbook"
        : "invalid-workbook",
    );
  }
  if (!workbook.SheetNames.length)
    throw new LocalSpreadsheetError("invalid-workbook");
  if (workbook.SheetNames.length > MAX_LOCAL_SHEETS)
    throw new LocalSpreadsheetError("too-many-sheets");
  if (!retainLocalSpreadsheetStyleFiles(workbook))
    throw new LocalSpreadsheetError("content-too-large");
  return new ParsedLocalSpreadsheet(workbook, fileName);
}

export function localSpreadsheetError(error: unknown) {
  return error instanceof LocalSpreadsheetError
    ? error.code
    : "invalid-workbook";
}

/**
 * Resolved runs for a rich-text cell, only when they spell the cell's text and
 * differ in style from one another or from the cell font.
 */
function richTextRuns(
  runs: readonly LocalRichRun[] | undefined,
  source: string | null,
  cellStyle: WorkspaceSheetCellStyle,
): { runs: readonly WorkspaceSheetTextRun[] } | Record<string, never> {
  if (!runs || source === null) return {};
  if (runs.map((run) => run.text).join("") !== source) return {};
  const resolved = runs.map((run): WorkspaceSheetTextRun => {
    const style = run.style;
    return {
      text: run.text,
      color: style ? style.color : cellStyle.color,
      bold: style ? style.bold : cellStyle.bold,
      italic: style ? style.italic : cellStyle.italic,
      underline: style ? style.underline : cellStyle.underline,
      strikethrough: style ? style.strikethrough : cellStyle.strikethrough,
    };
  });
  const [first] = resolved;
  const uniform = resolved.every(
    (run) =>
      run.color === first!.color &&
      run.bold === first!.bold &&
      run.italic === first!.italic &&
      run.underline === first!.underline &&
      run.strikethrough === first!.strikethrough,
  );
  const sameAsCell =
    first!.color === cellStyle.color &&
    first!.bold === cellStyle.bold &&
    first!.italic === cellStyle.italic &&
    first!.underline === cellStyle.underline &&
    first!.strikethrough === cellStyle.strikethrough;
  return uniform && sameAsCell ? {} : { runs: resolved };
}
