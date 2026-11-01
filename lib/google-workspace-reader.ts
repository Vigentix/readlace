import type { TargetLanguage } from "./translation";

export const SHEETS_PAGE_ROWS = 100;
/** Data-safety ceiling for one source row/column size, not a display cap. */
export const MAX_SOURCE_DIMENSION_PIXEL_SIZE = 10_000;
export const MAX_GOOGLE_RESPONSE_BYTES = 2_097_152;
export const MAX_LOADED_RECORDS = 10_000;
export const MAX_LOADED_SOURCE_CHARACTERS = 256_000;
export const MAX_TRANSLATION_RECORD_CHARACTERS = 4_000;
export const MAX_TRANSLATION_MESSAGE_RECORDS = 128;
export const MAX_TRANSLATION_MESSAGE_CHARACTERS = 8_000;

export interface WorkspaceEditorContext {
  kind: "sheets" | "docs";
  sourceTabId: number;
  fileId: string;
  activeId: string | null;
}

export type WorkspaceSourceIdentity = Pick<
  WorkspaceEditorContext,
  "sourceTabId" | "kind" | "fileId" | "activeId"
>;

export interface WorkspaceSourceVersion {
  backgroundEpoch: string;
  sourceRevision: number;
}

export interface WorkspaceReaderOwner {
  readerInstanceId: string;
  requestId: number;
}

export interface WorkspaceReaderSheetDescriptor {
  sheetId: string;
  title: string;
  index: number;
}

export interface WorkspaceReaderSourceChanged {
  type: "WORKSPACE_READER_SOURCE_CHANGED";
  sourceTabId: number;
  version: WorkspaceSourceVersion;
}

export interface WorkspaceReaderOpen {
  type: "WORKSPACE_READER_OPEN";
  sourceTabId: number;
  sourceWindowId?: number;
}

export type WorkspaceRecordKind =
  "text" | "formula" | "number" | "boolean" | "blank" | "error" | "unsupported";

export interface WorkspaceRecord {
  id: string;
  anchor: string;
  source: string;
  display: string;
  kind: WorkspaceRecordKind;
  translatable: boolean;
  sourceHash: string;
}

export interface WorkspaceSheetDiscoveryCursor {
  kind: "sheets-discovery";
  token: string;
}

export type WorkspaceSheetDiscoveryAxis = "columns" | "rows";

export type WorkspaceSheetDiscoveryProgress =
  | {
      status: "scanning";
      axis: WorkspaceSheetDiscoveryAxis;
      scanned: number;
      total: number;
      cursor: WorkspaceSheetDiscoveryCursor;
    }
  | { status: "complete"; grid: WorkspaceSheetGrid };

export interface WorkspaceSheetGrid {
  sheetId: string;
  title: string;
  generation: number;
  rowCount: number;
  lastUsedColumn: number;
  columns: WorkspaceSheetColumn[];
  frozenRowCount: number;
  frozenColumnCount: number;
  rightToLeft: boolean;
  hideGridlines: boolean;
  merges: WorkspaceSheetMerge[];
  /** Resolved style of a cell that has no stored format (source defaults). */
  defaultStyle: WorkspaceSheetCellStyle;
  /** Source row height for rows without explicit metadata. */
  defaultRowPixelSize: number;
  /** Source column width for columns without explicit metadata. */
  defaultColumnPixelSize: number;
}

export interface WorkspaceSheetColumn {
  index: number;
  pixelSize: number;
  hidden: boolean;
}

export interface WorkspaceSheetMerge {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

export interface WorkspaceSheetPage {
  sheetId: string;
  generation: number;
  startRow: number;
  rowCount: number;
  rows: WorkspaceSheetRow[];
  cursor: { kind: "sheets"; nextRow: number } | null;
}

export interface WorkspaceSheetRow {
  index: number;
  pixelSize: number;
  hidden: boolean;
  /**
   * Present (true) only when the source stored no height for this row, so the
   * viewer auto-fits it to its wrapped SOURCE text. Absent = height is stored.
   */
  autoHeight?: true;
  cells: WorkspaceSheetCell[];
}

/**
 * One run of a rich-text cell. Colors and flags are resolved; a null color
 * means the cell's own color. Runs concatenate to the cell's source text.
 */
export interface WorkspaceSheetTextRun {
  text: string;
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

export interface WorkspaceSheetCell extends WorkspaceRecord {
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  columnSpan: number;
  style: WorkspaceSheetCellStyle;
  /** Present only for rich-text cells whose runs differ in style. */
  runs?: readonly WorkspaceSheetTextRun[];
}

/**
 * Text layout strategy of one cell. These are three distinct source modes,
 * never one boolean: `overflow` continues across empty neighbors, `clip` stops
 * at the cell edge, `wrap` breaks lines inside the cell.
 */
export type WorkspaceSheetWrapStrategy = "overflow" | "clip" | "wrap";

export type WorkspaceSheetHorizontal =
  | "general"
  | "left"
  | "center"
  | "right"
  | "fill"
  | "justify"
  | "distributed"
  | "centerContinuous";

export interface WorkspaceSheetBorderLine {
  style: "solid" | "dashed" | "dotted" | "double";
  width: 1 | 2 | 3;
}

export interface WorkspaceSheetSides<T> {
  top: T;
  right: T;
  bottom: T;
  left: T;
}

export interface WorkspaceSheetCellStyle {
  background: string | null;
  color: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  /** Resolved family; null only when the source names no family at all. */
  fontFamily: string | null;
  /** Resolved size in points; null only when the source names no size. */
  fontSize: number | null;
  /** Physical alignment as stored; `general` depends on the value type. */
  horizontal: WorkspaceSheetHorizontal;
  vertical: "top" | "middle" | "bottom";
  wrapStrategy: WorkspaceSheetWrapStrategy;
  /** Excel shrink-to-fit; independent of the wrap strategy. */
  shrinkToFit: boolean;
  /** Explicit cell text direction; null follows the sheet direction. */
  direction: "ltr" | "rtl" | null;
  /** Degrees (-90..90) or stacked vertical text; 0 is horizontal. */
  rotation: number | "vertical";
  /** Excel indent levels. */
  indent: number;
  /** Inner text inset in CSS pixels. */
  padding: WorkspaceSheetSides<number>;
  borders: WorkspaceSheetSides<string | null>;
  /** Line style/width; non-null exactly where `borders` is non-null. */
  borderLines: WorkspaceSheetSides<WorkspaceSheetBorderLine | null>;
}

export const WORKSPACE_SHEET_DEFAULT_ROW_PIXEL_SIZE = 21;
export const WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE = 100;

/** Documented fallback only for a source that supplies no defaults at all. */
export function defaultWorkspaceSheetCellStyle(): WorkspaceSheetCellStyle {
  return {
    background: null,
    color: null,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    fontFamily: "Arial",
    fontSize: 10,
    horizontal: "general",
    vertical: "bottom",
    wrapStrategy: "overflow",
    shrinkToFit: false,
    direction: null,
    rotation: 0,
    indent: 0,
    padding: { top: 2, right: 3, bottom: 2, left: 3 },
    borders: { top: null, right: null, bottom: null, left: null },
    borderLines: { top: null, right: null, bottom: null, left: null },
  };
}

export interface WorkspaceSheetDiscoveryFragment {
  generation: number;
  startRow: number;
  rowCount: number;
  startColumn: number;
  columnCount: number;
  lastUsedColumn: number | null;
  lastUsedRow: number | null;
}

export interface WorkspaceSheetPageFragment {
  sheetId: string;
  generation: number;
  startRow: number;
  rowCount: number;
  startColumn: number;
  columnCount: number;
  rows: WorkspaceSheetRow[];
}

export type WorkspaceLoadCursor =
  { kind: "sheets"; nextRow: number } | { kind: "docs"; tabId: string } | null;

export type WorkspaceReaderErrorCode =
  | "reader-channel-unavailable"
  | "not-configured"
  | "unsupported-browser"
  | "unsupported-url"
  | "unsupported-file-type"
  | "google-auth-required"
  | "google-access-denied"
  | "google-oauth-configuration"
  | "google-oauth-response"
  | "google-oauth-scope"
  | "google-oauth-expired"
  | "google-oauth-network"
  | "google-oauth-failed"
  // ADR 0015 launch scope: the remote flag keeps the native Sheets Reader off,
  // an Office workbook needs a Drive scope that is not requested, and the
  // optional Google permissions were not granted at Connect.
  | "sheets-reader-unavailable"
  | "office-download-required"
  | "google-permission-denied"
  | "source-tab-changed"
  | "response-too-large"
  | "content-too-large"
  | "rate-limited"
  | "temporarily-unavailable"
  | "invalid-request"
  | "auth-required"
  | "auth-unavailable";

/**
 * ADR 0015 launch outcomes that are not failures of the source: the native
 * Sheets Reader flag is off, or the file is a Drive-stored Office workbook.
 * Reader shows the download guidance and the Local Reader action for both.
 */
export function isLocalReaderGuidanceError(
  code: unknown,
): code is "sheets-reader-unavailable" | "office-download-required" {
  return (
    code === "sheets-reader-unavailable" || code === "office-download-required"
  );
}

type WorkspaceReaderContextRequest = WorkspaceReaderOwner & {
  type: "WORKSPACE_READER_CONTEXT";
  sourceTabId: number;
  identifySource?: true;
};

type WorkspaceReaderSourceRequest = WorkspaceReaderOwner & {
  sourceTabId: number;
  version: WorkspaceSourceVersion;
};

export type WorkspaceReaderRequest =
  | WorkspaceReaderContextRequest
  | (WorkspaceReaderSourceRequest & {
      type: "WORKSPACE_READER_CONNECT";
    })
  | (WorkspaceReaderSourceRequest & {
      type: "WORKSPACE_READER_DISCONNECT";
    })
  | (WorkspaceReaderSourceRequest & {
      type: "WORKSPACE_READER_SELECT_SHEET";
      sheetId: string;
    })
  | (WorkspaceReaderSourceRequest & {
      type: "WORKSPACE_READER_DISCOVER";
      cursor: WorkspaceSheetDiscoveryCursor | null;
    })
  | (WorkspaceReaderSourceRequest & {
      type: "WORKSPACE_READER_LOAD";
      cursor: WorkspaceLoadCursor;
    })
  | (WorkspaceReaderSourceRequest & {
      type: "WORKSPACE_READER_TRANSLATE";
      targetLanguage: TargetLanguage;
      records: { id: string; sourceHash: string }[];
    });

export interface WorkspaceReaderTab {
  id: string;
  title: string;
  parentId: string | null;
  depth: number;
}

export type WorkspaceLoadOutcome =
  | {
      ok: true;
      context: WorkspaceEditorContext;
      title: string;
      records: WorkspaceRecord[];
      cursor: WorkspaceLoadCursor;
      page?: WorkspaceSheetPage;
      tabs?: WorkspaceReaderTab[];
    }
  | { ok: false; error: WorkspaceReaderErrorCode };

export type WorkspaceLoadSuccess = Extract<WorkspaceLoadOutcome, { ok: true }>;

export type WorkspaceReaderTranslateResult =
  | { id: string; sourceHash: string; text: string }
  | {
      id: string;
      sourceHash: string;
      error: "unresolved" | "provider-error";
    };

type WorkspaceReaderVersionedResponse = WorkspaceReaderOwner & {
  version: WorkspaceSourceVersion;
};

export type WorkspaceReaderResponse =
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_CONTEXT";
      ok: true;
      configured: boolean;
      connected: boolean;
      context: WorkspaceEditorContext;
      targetLanguage: TargetLanguage;
      sourceKind?: "native" | "office";
      sourceTitle?: string;
      sheets?: WorkspaceReaderSheetDescriptor[];
    })
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_CONNECT";
      ok: true;
      connected: boolean;
    })
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_DISCONNECT";
      ok: true;
      connected: boolean;
    })
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_SELECT_SHEET";
      ok: true;
      context: WorkspaceEditorContext;
      sheets: WorkspaceReaderSheetDescriptor[];
    })
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_DISCOVER";
      ok: true;
      sheets: WorkspaceReaderSheetDescriptor[];
      progress: WorkspaceSheetDiscoveryProgress;
    })
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_LOAD";
      generation: number;
    } & WorkspaceLoadSuccess)
  | (WorkspaceReaderVersionedResponse & {
      type: "WORKSPACE_READER_TRANSLATE";
      ok: true;
      generation: number;
      results: WorkspaceReaderTranslateResult[];
    })
  | (WorkspaceReaderOwner & {
      type: "WORKSPACE_READER_CONTEXT";
      ok: false;
      error: WorkspaceReaderErrorCode;
    })
  | (WorkspaceReaderVersionedResponse & {
      type: Exclude<WorkspaceReaderRequest["type"], "WORKSPACE_READER_CONTEXT">;
      ok: false;
      error: WorkspaceReaderErrorCode;
      discoveryCursor?: WorkspaceSheetDiscoveryCursor;
    });

// SHA-1 is a Web Crypto promise, so parsers expose their typed outcome promise.
export type WorkspaceLoadResult = Promise<WorkspaceLoadOutcome>;

export function workspaceRecordTranslationSource(
  record: Pick<WorkspaceRecord, "kind" | "source" | "display">,
) {
  return record.kind === "formula" ? record.display : record.source;
}

type ObjectValue = Record<string, unknown>;

interface DraftRecord extends Omit<WorkspaceRecord, "sourceHash"> {
  hashInput?: string;
}

class ParseFailure extends Error {
  constructor(readonly code: WorkspaceReaderErrorCode) {
    super(code);
  }
}

function objectValue(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function exactKeys(value: ObjectValue, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

const opaqueIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9._:-]+$/.test(value);

export function parseWorkspaceReaderSheetCatalog(
  input: unknown,
  expectedFileId: string,
): WorkspaceReaderSheetDescriptor[] | null {
  const root = objectValue(input);
  if (
    !root ||
    root.spreadsheetId !== expectedFileId ||
    !Array.isArray(root.sheets) ||
    root.sheets.length > 1_000
  )
    return null;

  const ids = new Set<string>();
  const sheets: WorkspaceReaderSheetDescriptor[] = [];
  for (const [index, inputSheet] of root.sheets.entries()) {
    const sheet = objectValue(inputSheet);
    const properties = objectValue(sheet?.properties);
    if (!sheet || !properties || typeof properties.sheetType !== "string")
      return null;
    if (properties.sheetType !== "GRID") continue;
    const sheetId = integer(properties.sheetId);
    if (
      sheetId === null ||
      typeof properties.title !== "string" ||
      properties.title.length === 0 ||
      properties.title.length > 1_000
    )
      return null;
    const id = String(sheetId);
    if (ids.has(id)) return null;
    ids.add(id);
    sheets.push({ sheetId: id, title: properties.title, index });
  }
  return sheets.length > 0 ? sheets : null;
}

export function workspaceSourceIdentity(
  context: WorkspaceEditorContext,
): WorkspaceSourceIdentity {
  const { sourceTabId, kind, fileId, activeId } = context;
  return { sourceTabId, kind, fileId, activeId };
}

export function sameWorkspaceSourceIdentity(
  left: WorkspaceSourceIdentity,
  right: WorkspaceSourceIdentity,
) {
  return (
    left.sourceTabId === right.sourceTabId &&
    left.kind === right.kind &&
    left.fileId === right.fileId &&
    (left.kind === "sheets" || left.activeId === right.activeId)
  );
}

export function parseWorkspaceReaderOwner(
  value: unknown,
): WorkspaceReaderOwner | null {
  const owner = objectValue(value);
  if (
    !owner ||
    !exactKeys(owner, ["readerInstanceId", "requestId"]) ||
    !opaqueIdentity(owner.readerInstanceId) ||
    integer(owner.requestId) === null
  ) {
    return null;
  }
  return {
    readerInstanceId: owner.readerInstanceId,
    requestId: owner.requestId as number,
  };
}

export function parseWorkspaceSourceVersion(
  value: unknown,
): WorkspaceSourceVersion | null {
  const version = objectValue(value);
  if (
    !version ||
    !exactKeys(version, ["backgroundEpoch", "sourceRevision"]) ||
    !opaqueIdentity(version.backgroundEpoch) ||
    integer(version.sourceRevision) === null
  ) {
    return null;
  }
  return {
    backgroundEpoch: version.backgroundEpoch,
    sourceRevision: version.sourceRevision as number,
  };
}

export function parseWorkspaceReaderSourceChanged(
  value: unknown,
): WorkspaceReaderSourceChanged | null {
  const message = objectValue(value);
  if (
    !message ||
    !exactKeys(message, ["type", "sourceTabId", "version"]) ||
    message.type !== "WORKSPACE_READER_SOURCE_CHANGED" ||
    integer(message.sourceTabId) === null
  ) {
    return null;
  }
  const version = parseWorkspaceSourceVersion(message.version);
  return version
    ? {
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId: message.sourceTabId as number,
        version,
      }
    : null;
}

export function parseWorkspaceReaderOpen(
  value: unknown,
): WorkspaceReaderOpen | null {
  const message = objectValue(value);
  return message &&
    exactKeys(message, [
      "type",
      "sourceTabId",
      ...(message.sourceWindowId === undefined ? [] : ["sourceWindowId"]),
    ]) &&
    message.type === "WORKSPACE_READER_OPEN" &&
    integer(message.sourceTabId) !== null &&
    (message.sourceWindowId === undefined ||
      integer(message.sourceWindowId) !== null)
    ? {
        type: "WORKSPACE_READER_OPEN",
        sourceTabId: message.sourceTabId as number,
        ...(message.sourceWindowId === undefined
          ? {}
          : { sourceWindowId: message.sourceWindowId as number }),
      }
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = integer(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function normalizeWorkspaceColor(
  value: unknown,
): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value)
      ? value.toLowerCase()
      : undefined;
  }

  const colorStyle = objectValue(value);
  if (!colorStyle) return undefined;
  const rgb =
    "rgbColor" in colorStyle
      ? exactKeys(colorStyle, ["rgbColor"])
        ? objectValue(colorStyle.rgbColor)
        : null
      : colorStyle;
  if (
    !rgb ||
    !Object.keys(rgb).every((key) =>
      ["red", "green", "blue", "alpha"].includes(key),
    )
  ) {
    return undefined;
  }
  const components = ["red", "green", "blue", "alpha"].map((key, index) => {
    const component = rgb[key];
    if (component === undefined) return index === 3 ? 1 : 0;
    return typeof component === "number" &&
      Number.isFinite(component) &&
      component >= 0 &&
      component <= 1
      ? component
      : null;
  });
  const [red, green, blue, alpha] = components;
  if (
    red === undefined ||
    red === null ||
    green === undefined ||
    green === null ||
    blue === undefined ||
    blue === null ||
    alpha === undefined ||
    alpha === null
  ) {
    return undefined;
  }
  const hex = [red, green, blue, ...(alpha < 1 ? [alpha] : [])]
    .map((component) =>
      Math.round(component * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `#${hex}`;
}

const HORIZONTAL_ALIGNMENTS: readonly WorkspaceSheetHorizontal[] = [
  "general",
  "left",
  "center",
  "right",
  "fill",
  "justify",
  "distributed",
  "centerContinuous",
];
const BORDER_LINE_STYLES = ["solid", "dashed", "dotted", "double"] as const;
// Family names reach CSS; reject anything that could leave a quoted string.
// eslint-disable-next-line no-control-regex -- control characters are the point
const SAFE_FONT_FAMILY = /^[^"'\\;{}<>\r\n\u0000-\u001f]{1,100}$/;

export function safeWorkspaceFontFamily(value: unknown): string | null {
  return typeof value === "string" && SAFE_FONT_FAMILY.test(value.trim())
    ? value.trim()
    : null;
}

function hexColor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" &&
    /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(value)
    ? value
    : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function parseSides<T>(
  input: unknown,
  parse: (value: unknown) => T | undefined,
): WorkspaceSheetSides<T> | null {
  const sides = objectValue(input);
  if (!sides || !exactKeys(sides, ["top", "right", "bottom", "left"]))
    return null;
  const top = parse(sides.top);
  const right = parse(sides.right);
  const bottom = parse(sides.bottom);
  const left = parse(sides.left);
  return top === undefined ||
    right === undefined ||
    bottom === undefined ||
    left === undefined
    ? null
    : { top, right, bottom, left };
}

function parseBorderLine(
  value: unknown,
): WorkspaceSheetBorderLine | null | undefined {
  if (value === null) return null;
  const line = objectValue(value);
  if (
    !line ||
    !exactKeys(line, ["style", "width"]) ||
    !BORDER_LINE_STYLES.includes(
      line.style as (typeof BORDER_LINE_STYLES)[number],
    ) ||
    ![1, 2, 3].includes(line.width as number)
  )
    return undefined;
  return line as unknown as WorkspaceSheetBorderLine;
}

/** Strict validator for the canonical, fully resolved style DTO. */
export function parseWorkspaceSheetCellStyle(
  input: unknown,
): WorkspaceSheetCellStyle | null {
  const style = objectValue(input);
  if (
    !style ||
    !exactKeys(style, [
      "background",
      "color",
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "fontFamily",
      "fontSize",
      "horizontal",
      "vertical",
      "wrapStrategy",
      "shrinkToFit",
      "direction",
      "rotation",
      "indent",
      "padding",
      "borders",
      "borderLines",
    ])
  )
    return null;
  const background = hexColor(style.background);
  const color = hexColor(style.color);
  const borders = parseSides(style.borders, hexColor);
  const borderLines = parseSides(style.borderLines, parseBorderLine);
  const padding = parseSides(
    style.padding,
    (value) => boundedNumber(value, 0, 100) ?? undefined,
  );
  const rotation =
    style.rotation === "vertical"
      ? "vertical"
      : Number.isInteger(style.rotation) &&
          (style.rotation as number) >= -90 &&
          (style.rotation as number) <= 90
        ? (style.rotation as number)
        : null;
  const fontFamily =
    style.fontFamily === null
      ? null
      : safeWorkspaceFontFamily(style.fontFamily);
  const fontSize =
    style.fontSize === null ? null : boundedNumber(style.fontSize, 1, 400);
  if (
    background === undefined ||
    color === undefined ||
    !borders ||
    !borderLines ||
    !padding ||
    rotation === null ||
    (style.fontFamily !== null && fontFamily === null) ||
    (style.fontSize !== null && fontSize === null) ||
    typeof style.bold !== "boolean" ||
    typeof style.italic !== "boolean" ||
    typeof style.underline !== "boolean" ||
    typeof style.strikethrough !== "boolean" ||
    typeof style.shrinkToFit !== "boolean" ||
    !HORIZONTAL_ALIGNMENTS.includes(
      style.horizontal as WorkspaceSheetHorizontal,
    ) ||
    !["top", "middle", "bottom"].includes(style.vertical as string) ||
    !["overflow", "clip", "wrap"].includes(style.wrapStrategy as string) ||
    (style.direction !== null &&
      style.direction !== "ltr" &&
      style.direction !== "rtl") ||
    !Number.isInteger(style.indent) ||
    (style.indent as number) < 0 ||
    (style.indent as number) > 250
  )
    return null;
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if ((borders[side] === null) !== (borderLines[side] === null)) return null;
  }
  return {
    background,
    color,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough,
    fontFamily,
    fontSize,
    horizontal: style.horizontal as WorkspaceSheetHorizontal,
    vertical: style.vertical as WorkspaceSheetCellStyle["vertical"],
    wrapStrategy: style.wrapStrategy as WorkspaceSheetWrapStrategy,
    shrinkToFit: style.shrinkToFit,
    direction: style.direction as WorkspaceSheetCellStyle["direction"],
    rotation,
    indent: style.indent as number,
    padding,
    borders,
    borderLines,
  };
}

export function parseWorkspaceSheetMerge(
  input: unknown,
): WorkspaceSheetMerge | null {
  const merge = objectValue(input);
  if (
    !merge ||
    !exactKeys(merge, ["startRow", "endRow", "startColumn", "endColumn"])
  ) {
    return null;
  }
  const startRow = integer(merge.startRow);
  const endRow = positiveInteger(merge.endRow);
  const startColumn = integer(merge.startColumn);
  const endColumn = positiveInteger(merge.endColumn);
  return startRow !== null &&
    endRow !== null &&
    startColumn !== null &&
    endColumn !== null &&
    startRow < endRow &&
    startColumn < endColumn
    ? { startRow, endRow, startColumn, endColumn }
    : null;
}

export function parseWorkspaceSheetGrid(
  input: unknown,
): WorkspaceSheetGrid | null {
  const grid = objectValue(input);
  if (
    !grid ||
    !exactKeys(grid, [
      "sheetId",
      "title",
      "generation",
      "rowCount",
      "lastUsedColumn",
      "columns",
      "frozenRowCount",
      "frozenColumnCount",
      "rightToLeft",
      "hideGridlines",
      "merges",
      "defaultStyle",
      "defaultRowPixelSize",
      "defaultColumnPixelSize",
    ]) ||
    typeof grid.sheetId !== "string" ||
    !grid.sheetId ||
    typeof grid.title !== "string" ||
    !grid.title ||
    integer(grid.generation) === null ||
    positiveInteger(grid.rowCount) === null ||
    !Number.isSafeInteger(grid.lastUsedColumn) ||
    (grid.lastUsedColumn as number) < -1 ||
    !Array.isArray(grid.columns) ||
    integer(grid.frozenRowCount) === null ||
    integer(grid.frozenColumnCount) === null ||
    typeof grid.rightToLeft !== "boolean" ||
    typeof grid.hideGridlines !== "boolean" ||
    !Array.isArray(grid.merges) ||
    positiveInteger(grid.defaultRowPixelSize) === null ||
    positiveInteger(grid.defaultColumnPixelSize) === null
  ) {
    return null;
  }
  const defaultStyle = parseWorkspaceSheetCellStyle(grid.defaultStyle);
  if (!defaultStyle) return null;
  const defaultRowPixelSize = grid.defaultRowPixelSize as number;
  const defaultColumnPixelSize = grid.defaultColumnPixelSize as number;
  const generation = grid.generation as number;
  const rowCount = grid.rowCount as number;
  const lastUsedColumn = grid.lastUsedColumn as number;
  const frozenRowCount = grid.frozenRowCount as number;
  const frozenColumnCount = grid.frozenColumnCount as number;
  if (frozenRowCount > rowCount || frozenColumnCount > lastUsedColumn + 1)
    return null;

  const columnsByIndex = new Map<number, WorkspaceSheetColumn>();
  for (const inputColumn of grid.columns) {
    const column = objectValue(inputColumn);
    if (!column || !exactKeys(column, ["index", "pixelSize", "hidden"]))
      return null;
    const index = integer(column.index);
    const pixelSize = positiveInteger(column.pixelSize);
    if (
      index === null ||
      index > lastUsedColumn ||
      pixelSize === null ||
      typeof column.hidden !== "boolean"
    ) {
      return null;
    }
    const parsed = { index, pixelSize, hidden: column.hidden };
    const previous = columnsByIndex.get(index);
    if (previous && JSON.stringify(previous) !== JSON.stringify(parsed))
      return null;
    columnsByIndex.set(index, parsed);
  }
  const columns = Array.from(
    { length: lastUsedColumn + 1 },
    (_, index) =>
      columnsByIndex.get(index) ?? {
        index,
        pixelSize: defaultColumnPixelSize,
        hidden: false,
      },
  );

  const merges: WorkspaceSheetMerge[] = [];
  for (const inputMerge of grid.merges) {
    const parsed = parseWorkspaceSheetMerge(inputMerge);
    if (!parsed || parsed.startRow >= rowCount || parsed.endRow > rowCount)
      return null;
    if (parsed.startColumn > lastUsedColumn) continue;
    const clipped = {
      ...parsed,
      endColumn: Math.min(parsed.endColumn, lastUsedColumn + 1),
    };
    if (
      merges.some(
        (merge) =>
          clipped.startRow < merge.endRow &&
          clipped.endRow > merge.startRow &&
          clipped.startColumn < merge.endColumn &&
          clipped.endColumn > merge.startColumn,
      )
    ) {
      return null;
    }
    merges.push(clipped);
  }
  merges.sort(
    (left, right) =>
      left.startRow - right.startRow || left.startColumn - right.startColumn,
  );

  return {
    sheetId: grid.sheetId,
    title: grid.title,
    generation,
    rowCount,
    lastUsedColumn,
    columns,
    frozenRowCount,
    frozenColumnCount,
    rightToLeft: grid.rightToLeft,
    hideGridlines: grid.hideGridlines,
    merges,
    defaultStyle,
    defaultRowPixelSize,
    defaultColumnPixelSize,
  };
}

export function parseWorkspaceSheetDiscoveryProgress(
  input: unknown,
): WorkspaceSheetDiscoveryProgress | null {
  const progress = objectValue(input);
  if (!progress || typeof progress.status !== "string") return null;
  if (progress.status === "complete") {
    if (!exactKeys(progress, ["status", "grid"])) return null;
    const grid = parseWorkspaceSheetGrid(progress.grid);
    return grid ? { status: "complete", grid } : null;
  }
  if (
    progress.status !== "scanning" ||
    !exactKeys(progress, ["status", "axis", "scanned", "total", "cursor"])
  ) {
    return null;
  }
  const axis = progress.axis;
  const scanned = integer(progress.scanned);
  const total = integer(progress.total);
  const cursor = objectValue(progress.cursor);
  if (
    (axis !== "columns" && axis !== "rows") ||
    scanned === null ||
    total === null ||
    scanned > total ||
    !cursor ||
    !exactKeys(cursor, ["kind", "token"]) ||
    cursor.kind !== "sheets-discovery" ||
    typeof cursor.token !== "string" ||
    !cursor.token ||
    cursor.token.length > 512
  ) {
    return null;
  }
  return {
    status: "scanning",
    axis,
    scanned,
    total,
    cursor: { kind: "sheets-discovery", token: cursor.token },
  };
}

export function parseWorkspaceSheetDiscoveryFragment(
  input: unknown,
): WorkspaceSheetDiscoveryFragment | null {
  const fragment = objectValue(input);
  if (
    !fragment ||
    !exactKeys(fragment, [
      "generation",
      "startRow",
      "rowCount",
      "startColumn",
      "columnCount",
      "lastUsedColumn",
      "lastUsedRow",
    ])
  ) {
    return null;
  }
  const generation = integer(fragment.generation);
  const startRow = integer(fragment.startRow);
  const rowCount = positiveInteger(fragment.rowCount);
  const startColumn = integer(fragment.startColumn);
  const columnCount = positiveInteger(fragment.columnCount);
  const lastUsedColumn =
    fragment.lastUsedColumn === null ? null : integer(fragment.lastUsedColumn);
  const lastUsedRow =
    fragment.lastUsedRow === null ? null : integer(fragment.lastUsedRow);
  if (
    generation === null ||
    startRow === null ||
    rowCount === null ||
    startColumn === null ||
    columnCount === null ||
    (lastUsedColumn === null && fragment.lastUsedColumn !== null) ||
    (lastUsedRow === null && fragment.lastUsedRow !== null) ||
    (lastUsedColumn !== null &&
      (lastUsedColumn < startColumn ||
        lastUsedColumn >= startColumn + columnCount)) ||
    (lastUsedRow !== null &&
      (lastUsedRow < startRow || lastUsedRow >= startRow + rowCount))
  ) {
    return null;
  }
  return {
    generation,
    startRow,
    rowCount,
    startColumn,
    columnCount,
    lastUsedColumn,
    lastUsedRow,
  };
}

export function mergeWorkspaceSheetDiscoveryFragments(
  generation: number,
  inputs: readonly unknown[],
): WorkspaceSheetColumn[] | null {
  if (integer(generation) === null) return null;
  let foundCurrent = false;
  let lastUsedColumn = -1;
  for (const input of inputs) {
    const candidate = objectValue(input);
    const candidateGeneration = integer(candidate?.generation);
    if (candidateGeneration === null) return null;
    if (candidateGeneration !== generation) continue;
    const fragment = parseWorkspaceSheetDiscoveryFragment(input);
    if (!fragment) return null;
    foundCurrent = true;
    if (fragment.lastUsedColumn !== null)
      lastUsedColumn = Math.max(lastUsedColumn, fragment.lastUsedColumn);
  }
  if (!foundCurrent) return null;
  return Array.from({ length: lastUsedColumn + 1 }, (_, index) => ({
    index,
    pixelSize: 100,
    hidden: false,
  }));
}

function invalid(): WorkspaceLoadOutcome {
  return { ok: false, error: "invalid-request" };
}

function responseSizeError(input: unknown): WorkspaceReaderErrorCode | null {
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return "invalid-request";
    return new TextEncoder().encode(json).byteLength > MAX_GOOGLE_RESPONSE_BYTES
      ? "response-too-large"
      : null;
  } catch {
    return "invalid-request";
  }
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

async function finalize(
  context: WorkspaceEditorContext,
  title: string,
  drafts: DraftRecord[],
  cursor: WorkspaceLoadCursor,
  tabs?: WorkspaceReaderTab[],
): WorkspaceLoadResult {
  if (drafts.length > MAX_LOADED_RECORDS) {
    return { ok: false, error: "content-too-large" };
  }

  const ids = new Set<string>();
  let sourceCharacters = 0;
  for (const record of drafts) {
    if (ids.has(record.id)) return invalid();
    ids.add(record.id);
    const translationText = workspaceRecordTranslationSource(record);
    sourceCharacters += translationText.length;
    if (
      record.translatable &&
      translationText.length > MAX_TRANSLATION_RECORD_CHARACTERS
    ) {
      return { ok: false, error: "content-too-large" };
    }
  }
  if (sourceCharacters > MAX_LOADED_SOURCE_CHARACTERS) {
    return { ok: false, error: "content-too-large" };
  }

  const records = await Promise.all(
    drafts.map(async ({ hashInput, ...record }) => ({
      ...record,
      sourceHash: await sha1(hashInput ?? record.source),
    })),
  );
  return { ok: true, context, title, records, cursor, ...(tabs && { tabs }) };
}

function oneParameter(
  parameters: URLSearchParams,
  name: string,
): string | null | undefined {
  const values = parameters.getAll(name);
  return values.length > 1 ? undefined : (values[0] ?? null);
}

function sheetGid(value: string | null | undefined) {
  if (value === null || value === undefined) return value;
  return /^(0|[1-9]\d{0,9})$/.test(value) && Number(value) <= 2_147_483_647
    ? value
    : undefined;
}

export function parseWorkspaceEditorUrl(
  url: string,
): Omit<WorkspaceEditorContext, "sourceTabId"> | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.origin !== "https://docs.google.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    return null;
  }

  const match = parsed.pathname.match(
    /^\/(spreadsheets|document)\/d\/([A-Za-z0-9_-]{1,200})(?:\/edit)?\/?$/,
  );
  if (!match) return null;
  const [, route, fileId] = match;
  if (!fileId) return null;

  if (route === "spreadsheets") {
    const searchGid = sheetGid(oneParameter(parsed.searchParams, "gid"));
    const hash = new URLSearchParams(parsed.hash.slice(1));
    const hashGid = sheetGid(oneParameter(hash, "gid"));
    if (searchGid === undefined || hashGid === undefined) return null;
    const gid = hashGid ?? searchGid;
    return { kind: "sheets", fileId, activeId: gid };
  }

  const tabId = oneParameter(parsed.searchParams, "tab");
  if (
    tabId === undefined ||
    (tabId !== null && !/^[A-Za-z0-9._-]{1,200}$/.test(tabId))
  ) {
    return null;
  }
  return { kind: "docs", fileId, activeId: tabId };
}

export function sheetsPageRange(title: string, startRow: number) {
  if (!title || !Number.isSafeInteger(startRow) || startRow < 1) return null;
  const escapedTitle = title.replaceAll("'", "''");
  return `'${escapedTitle}'!${startRow}:${startRow + SHEETS_PAGE_ROWS - 1}`;
}

function columnName(index: number) {
  let column = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    column = String.fromCharCode(65 + ((value - 1) % 26)) + column;
  }
  return column;
}

const EXTENDED_VALUE_KEYS = [
  "stringValue",
  "numberValue",
  "boolValue",
  "formulaValue",
  "errorValue",
] as const;

function extendedValue(value: unknown) {
  const candidate = objectValue(value);
  if (!candidate) return null;
  const keys = EXTENDED_VALUE_KEYS.filter((key) => key in candidate);
  const key = keys.length === 1 ? keys[0] : undefined;
  return key ? { key, value: candidate[key] } : null;
}

function primitiveDisplay(value: ReturnType<typeof extendedValue>) {
  if (!value) return "";
  if (value.key === "stringValue" && typeof value.value === "string") {
    return value.value;
  }
  if (value.key === "numberValue" && typeof value.value === "number") {
    return String(value.value);
  }
  if (value.key === "boolValue" && typeof value.value === "boolean") {
    return String(value.value);
  }
  if (value.key === "errorValue") {
    const error = objectValue(value.value);
    if (typeof error?.message === "string") return error.message;
    if (typeof error?.type === "string") return error.type;
  }
  return "";
}

function sheetCellDraft(
  cellInput: unknown,
  fileId: string,
  sheetId: string,
  anchor: string,
): DraftRecord {
  const cell = objectValue(cellInput);
  if (!cell) throw new ParseFailure("invalid-request");
  if (
    cell.formattedValue !== undefined &&
    typeof cell.formattedValue !== "string"
  ) {
    throw new ParseFailure("invalid-request");
  }

  const entered =
    cell.userEnteredValue === undefined
      ? null
      : extendedValue(cell.userEnteredValue);
  const effective =
    cell.effectiveValue === undefined
      ? null
      : extendedValue(cell.effectiveValue);
  if (
    (cell.userEnteredValue !== undefined && !entered) ||
    (cell.effectiveValue !== undefined && !effective)
  ) {
    return {
      id: `sheets:${fileId}:${sheetId}:${anchor}`,
      anchor,
      source: "[Unsupported cell]",
      display: "[Unsupported cell]",
      kind: "unsupported",
      translatable: false,
    };
  }

  const id = `sheets:${fileId}:${sheetId}:${anchor}`;
  const formatted = cell.formattedValue as string | undefined;
  if (entered?.key === "formulaValue") {
    if (typeof entered.value !== "string") {
      throw new ParseFailure("invalid-request");
    }
    const display = formatted ?? primitiveDisplay(effective);
    const textualResult = effective?.key === "stringValue";
    return {
      id,
      anchor,
      source: entered.value,
      display,
      kind: "formula",
      translatable: textualResult && display.trim().length > 0,
      hashInput: `${entered.value}\0${display}`,
    };
  }

  const value = entered ?? effective;
  if (!value) {
    return {
      id,
      anchor,
      source: "",
      display: formatted ?? "",
      kind: "blank",
      translatable: false,
    };
  }

  const display = formatted ?? primitiveDisplay(value);
  if (value.key === "stringValue" && typeof value.value === "string") {
    return {
      id,
      anchor,
      source: value.value,
      display,
      kind: value.value.length ? "text" : "blank",
      translatable: value.value.trim().length > 0,
    };
  }
  if (value.key === "numberValue" && typeof value.value === "number") {
    return {
      id,
      anchor,
      source: String(value.value),
      display,
      kind: "number",
      translatable: false,
    };
  }
  if (value.key === "boolValue" && typeof value.value === "boolean") {
    return {
      id,
      anchor,
      source: String(value.value),
      display,
      kind: "boolean",
      translatable: false,
    };
  }
  if (value.key === "errorValue") {
    return {
      id,
      anchor,
      source: primitiveDisplay(value),
      display,
      kind: "error",
      translatable: false,
    };
  }
  throw new ParseFailure("invalid-request");
}

function parseWorkspaceSheetCell(input: unknown): WorkspaceSheetCell | null {
  const cell = objectValue(input);
  if (
    !cell ||
    !exactKeys(cell, [
      "id",
      "anchor",
      "source",
      "display",
      "kind",
      "translatable",
      "sourceHash",
      "rowIndex",
      "columnIndex",
      "rowSpan",
      "columnSpan",
      "style",
      ...("runs" in cell ? ["runs"] : []),
    ]) ||
    typeof cell.id !== "string" ||
    typeof cell.anchor !== "string" ||
    typeof cell.source !== "string" ||
    typeof cell.display !== "string" ||
    ![
      "text",
      "formula",
      "number",
      "boolean",
      "blank",
      "error",
      "unsupported",
    ].includes(cell.kind as string) ||
    typeof cell.translatable !== "boolean" ||
    typeof cell.sourceHash !== "string" ||
    !/^[0-9a-f]{40}$/.test(cell.sourceHash)
  ) {
    return null;
  }
  const rowIndex = integer(cell.rowIndex);
  const columnIndex = integer(cell.columnIndex);
  const rowSpan = positiveInteger(cell.rowSpan);
  const columnSpan = positiveInteger(cell.columnSpan);
  const style = parseWorkspaceSheetCellStyle(cell.style);
  const runs =
    "runs" in cell ? parseTextRuns(cell.runs, cell.source) : undefined;
  if (
    runs === null ||
    rowIndex === null ||
    columnIndex === null ||
    rowSpan === null ||
    columnSpan === null ||
    !style ||
    cell.anchor !== `${columnName(columnIndex)}${rowIndex + 1}` ||
    !cell.id.endsWith(`:${cell.anchor}`)
  ) {
    return null;
  }
  return {
    id: cell.id,
    anchor: cell.anchor,
    source: cell.source,
    display: cell.display,
    kind: cell.kind as WorkspaceRecordKind,
    translatable: cell.translatable,
    sourceHash: cell.sourceHash,
    rowIndex,
    columnIndex,
    rowSpan,
    columnSpan,
    style,
    ...(runs ? { runs } : {}),
  };
}

const MAX_TEXT_RUNS = 64;

/** Runs must spell the cell's source text exactly; null means invalid. */
function parseTextRuns(
  input: unknown,
  source: unknown,
): readonly WorkspaceSheetTextRun[] | null {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_TEXT_RUNS ||
    typeof source !== "string"
  )
    return null;
  const runs: WorkspaceSheetTextRun[] = [];
  for (const item of input) {
    const run = objectValue(item);
    if (
      !run ||
      !exactKeys(run, [
        "text",
        "color",
        "bold",
        "italic",
        "underline",
        "strikethrough",
      ]) ||
      typeof run.text !== "string" ||
      typeof run.bold !== "boolean" ||
      typeof run.italic !== "boolean" ||
      typeof run.underline !== "boolean" ||
      typeof run.strikethrough !== "boolean"
    )
      return null;
    const color = hexColor(run.color);
    if (color === undefined) return null;
    runs.push({
      text: run.text,
      color,
      bold: run.bold,
      italic: run.italic,
      underline: run.underline,
      strikethrough: run.strikethrough,
    });
  }
  return runs.map((run) => run.text).join("") === source ? runs : null;
}

function parseWorkspaceSheetRow(input: unknown): WorkspaceSheetRow | null {
  const row = objectValue(input);
  if (
    !row ||
    !exactKeys(
      row,
      "autoHeight" in row
        ? ["index", "pixelSize", "hidden", "cells", "autoHeight"]
        : ["index", "pixelSize", "hidden", "cells"],
    ) ||
    !Array.isArray(row.cells) ||
    ("autoHeight" in row && row.autoHeight !== true)
  ) {
    return null;
  }
  const index = integer(row.index);
  const pixelSize = positiveInteger(row.pixelSize);
  if (index === null || pixelSize === null || typeof row.hidden !== "boolean")
    return null;
  const cells: WorkspaceSheetCell[] = [];
  const columnIndexes = new Set<number>();
  for (const inputCell of row.cells) {
    const cell = parseWorkspaceSheetCell(inputCell);
    if (!cell || cell.rowIndex !== index || columnIndexes.has(cell.columnIndex))
      return null;
    columnIndexes.add(cell.columnIndex);
    cells.push(cell);
  }
  cells.sort((left, right) => left.columnIndex - right.columnIndex);
  return {
    index,
    pixelSize,
    hidden: row.hidden,
    ...(row.autoHeight === true ? { autoHeight: true as const } : {}),
    cells,
  };
}

export function parseWorkspaceSheetPageFragment(
  input: unknown,
): WorkspaceSheetPageFragment | null {
  const fragment = objectValue(input);
  if (
    !fragment ||
    !exactKeys(fragment, [
      "sheetId",
      "generation",
      "startRow",
      "rowCount",
      "startColumn",
      "columnCount",
      "rows",
    ]) ||
    typeof fragment.sheetId !== "string" ||
    !fragment.sheetId ||
    !Array.isArray(fragment.rows)
  ) {
    return null;
  }
  const generation = integer(fragment.generation);
  const startRow = integer(fragment.startRow);
  const rowCount = positiveInteger(fragment.rowCount);
  const startColumn = integer(fragment.startColumn);
  const columnCount = positiveInteger(fragment.columnCount);
  if (
    generation === null ||
    startRow === null ||
    rowCount === null ||
    startColumn === null ||
    columnCount === null
  ) {
    return null;
  }
  const rows: WorkspaceSheetRow[] = [];
  const rowIndexes = new Set<number>();
  for (const inputRow of fragment.rows) {
    const row = parseWorkspaceSheetRow(inputRow);
    if (
      !row ||
      row.index < startRow ||
      row.index >= startRow + rowCount ||
      rowIndexes.has(row.index) ||
      row.cells.some(
        (cell) =>
          cell.columnIndex < startColumn ||
          cell.columnIndex >= startColumn + columnCount,
      )
    ) {
      return null;
    }
    rowIndexes.add(row.index);
    rows.push(row);
  }
  rows.sort((left, right) => left.index - right.index);
  return {
    sheetId: fragment.sheetId,
    generation,
    startRow,
    rowCount,
    startColumn,
    columnCount,
    rows,
  };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeWorkspaceSheetPageFragments(
  gridInput: WorkspaceSheetGrid,
  startRow: number,
  inputs: readonly unknown[],
): WorkspaceSheetPage | null {
  const grid = parseWorkspaceSheetGrid(gridInput);
  if (
    !grid ||
    integer(startRow) === null ||
    startRow % SHEETS_PAGE_ROWS !== 0 ||
    startRow >= grid.rowCount
  ) {
    return null;
  }
  const rowCount = Math.min(SHEETS_PAGE_ROWS, grid.rowCount - startRow);
  const endRow = startRow + rowCount;
  const endColumn = grid.lastUsedColumn + 1;
  const coverage = Array.from(
    { length: rowCount },
    () => [] as [number, number][],
  );
  const rows = new Map<number, WorkspaceSheetRow>();
  let foundCurrent = false;

  for (const input of inputs) {
    const candidate = objectValue(input);
    const candidateGeneration = integer(candidate?.generation);
    if (candidateGeneration === null) return null;
    if (candidateGeneration !== grid.generation) continue;
    const fragment = parseWorkspaceSheetPageFragment(input);
    if (
      !fragment ||
      fragment.sheetId !== grid.sheetId ||
      fragment.startRow < startRow ||
      fragment.startRow + fragment.rowCount > endRow ||
      fragment.startColumn + fragment.columnCount > endColumn
    ) {
      return null;
    }
    foundCurrent = true;
    for (
      let row = fragment.startRow;
      row < fragment.startRow + fragment.rowCount;
      row += 1
    ) {
      coverage[row - startRow]!.push([
        fragment.startColumn,
        fragment.startColumn + fragment.columnCount,
      ]);
    }
    for (const row of fragment.rows) {
      const previous = rows.get(row.index);
      if (!previous) {
        rows.set(row.index, { ...row, cells: [...row.cells] });
        continue;
      }
      if (
        previous.pixelSize !== row.pixelSize ||
        previous.hidden !== row.hidden ||
        previous.autoHeight !== row.autoHeight
      )
        return null;
      const cells = new Map(
        previous.cells.map((cell) => [cell.columnIndex, cell]),
      );
      for (const cell of row.cells) {
        const duplicate = cells.get(cell.columnIndex);
        if (duplicate && !sameValue(duplicate, cell)) return null;
        cells.set(cell.columnIndex, cell);
      }
      previous.cells = [...cells.values()].sort(
        (left, right) => left.columnIndex - right.columnIndex,
      );
    }
  }
  if (!foundCurrent) return null;
  for (const intervals of coverage) {
    intervals.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
    let coveredUntil = 0;
    for (const [start, end] of intervals) {
      if (start > coveredUntil) return null;
      coveredUntil = Math.max(coveredUntil, end);
    }
    if (coveredUntil < endColumn) return null;
  }

  const mergedRows = Array.from({ length: rowCount }, (_, offset) => {
    const index = startRow + offset;
    return (
      rows.get(index) ?? { index, pixelSize: 21, hidden: false, cells: [] }
    );
  });
  let recordCount = 0;
  let sourceCharacters = 0;
  for (const row of mergedRows) {
    for (const cell of row.cells) {
      if (
        cell.columnIndex > grid.lastUsedColumn ||
        cell.rowIndex + cell.rowSpan > grid.rowCount ||
        cell.columnIndex + cell.columnSpan > endColumn
      ) {
        return null;
      }
      const merge = grid.merges.find(
        (candidate) =>
          cell.rowIndex >= candidate.startRow &&
          cell.rowIndex < candidate.endRow &&
          cell.columnIndex >= candidate.startColumn &&
          cell.columnIndex < candidate.endColumn,
      );
      if (
        (merge &&
          (cell.rowIndex !== merge.startRow ||
            cell.columnIndex !== merge.startColumn ||
            cell.rowSpan !== merge.endRow - merge.startRow ||
            cell.columnSpan !== merge.endColumn - merge.startColumn)) ||
        (!merge && (cell.rowSpan !== 1 || cell.columnSpan !== 1))
      ) {
        return null;
      }
      const source = workspaceRecordTranslationSource(cell);
      if (
        cell.translatable &&
        source.length > MAX_TRANSLATION_RECORD_CHARACTERS
      )
        return null;
      recordCount += 1;
      sourceCharacters += source.length;
    }
  }
  if (
    recordCount > MAX_LOADED_RECORDS ||
    sourceCharacters > MAX_LOADED_SOURCE_CHARACTERS
  )
    return null;

  return {
    sheetId: grid.sheetId,
    generation: grid.generation,
    startRow,
    rowCount,
    rows: mergedRows,
    cursor: endRow < grid.rowCount ? { kind: "sheets", nextRow: endRow } : null,
  };
}

export function parseWorkspaceSheetPage(
  input: unknown,
  grid: WorkspaceSheetGrid,
): WorkspaceSheetPage | null {
  const page = objectValue(input);
  if (
    !page ||
    !exactKeys(page, [
      "sheetId",
      "generation",
      "startRow",
      "rowCount",
      "rows",
      "cursor",
    ]) ||
    typeof page.sheetId !== "string" ||
    integer(page.generation) === null ||
    integer(page.startRow) === null ||
    positiveInteger(page.rowCount) === null ||
    !Array.isArray(page.rows)
  ) {
    return null;
  }
  if (grid.lastUsedColumn === -1) {
    const parsedGrid = parseWorkspaceSheetGrid(grid);
    const rowCount = parsedGrid
      ? Math.min(SHEETS_PAGE_ROWS, parsedGrid.rowCount)
      : 0;
    return parsedGrid &&
      page.sheetId === parsedGrid.sheetId &&
      page.generation === parsedGrid.generation &&
      page.startRow === 0 &&
      page.rowCount === rowCount &&
      page.rows.length === 0 &&
      page.cursor === null
      ? {
          sheetId: parsedGrid.sheetId,
          generation: parsedGrid.generation,
          startRow: 0,
          rowCount,
          rows: [],
          cursor: null,
        }
      : null;
  }
  const parsed = mergeWorkspaceSheetPageFragments(
    grid,
    page.startRow as number,
    [
      {
        sheetId: page.sheetId,
        generation: page.generation,
        startRow: page.startRow,
        rowCount: page.rowCount,
        startColumn: 0,
        columnCount: grid.lastUsedColumn + 1,
        rows: page.rows,
      },
    ],
  );
  if (
    !parsed ||
    parsed.rowCount !== page.rowCount ||
    !sameValue(parsed.cursor, page.cursor)
  )
    return null;
  return parsed;
}

export async function parseSheetsPage(
  input: unknown,
  context: WorkspaceEditorContext,
  startRow: number,
): WorkspaceLoadResult {
  const sizeError = responseSizeError(input);
  if (sizeError) return { ok: false, error: sizeError };
  if (
    context.kind !== "sheets" ||
    !Number.isSafeInteger(startRow) ||
    startRow < 1
  ) {
    return invalid();
  }

  try {
    const root = objectValue(input);
    if (!root || !Array.isArray(root.sheets)) return invalid();
    if (
      root.spreadsheetId !== undefined &&
      root.spreadsheetId !== context.fileId
    ) {
      return invalid();
    }

    if (
      context.activeId !== null &&
      !/^(0|[1-9]\d{0,9})$/.test(context.activeId)
    ) {
      return invalid();
    }
    const activeSheetId =
      context.activeId === null ? null : Number(context.activeId);
    const sheets = root.sheets.map(objectValue);
    const matchingSheets = sheets.filter(
      (candidate) =>
        activeSheetId === null ||
        integer(objectValue(candidate?.properties)?.sheetId) === activeSheetId,
    );
    if (matchingSheets.length !== 1 && activeSheetId !== null) return invalid();
    const sheet = matchingSheets[0];
    const properties = objectValue(sheet?.properties);
    if (!sheet || !properties) return invalid();
    if (properties.sheetType !== "GRID") {
      return { ok: false, error: "unsupported-file-type" };
    }
    if (typeof properties.title !== "string" || !properties.title) {
      return invalid();
    }
    const rowCount = integer(objectValue(properties.gridProperties)?.rowCount);
    const sheetId = integer(properties.sheetId);
    if (rowCount === null || sheetId === null) return invalid();
    if (sheet.data !== undefined && !Array.isArray(sheet.data))
      return invalid();

    const drafts: DraftRecord[] = [];
    const blocks = (sheet.data ?? []) as unknown[];
    for (const blockInput of blocks) {
      const block = objectValue(blockInput);
      if (!block) return invalid();
      const rowOffset =
        block.startRow === undefined ? startRow - 1 : integer(block.startRow);
      const columnOffset =
        block.startColumn === undefined ? 0 : integer(block.startColumn);
      if (rowOffset === null || columnOffset === null) return invalid();
      if (block.rowData !== undefined && !Array.isArray(block.rowData)) {
        return invalid();
      }
      const rows = (block.rowData ?? []) as unknown[];
      const pageStart = startRow - 1;
      if (
        rowOffset < pageStart ||
        rowOffset + rows.length > pageStart + SHEETS_PAGE_ROWS
      ) {
        return invalid();
      }
      for (const [rowIndex, rowInput] of rows.entries()) {
        const row = objectValue(rowInput);
        if (!row || (row.values !== undefined && !Array.isArray(row.values))) {
          return invalid();
        }
        for (const [columnIndex, cell] of (
          (row.values ?? []) as unknown[]
        ).entries()) {
          const anchor = `${columnName(columnOffset + columnIndex)}${rowOffset + rowIndex + 1}`;
          drafts.push(
            sheetCellDraft(cell, context.fileId, String(sheetId), anchor),
          );
        }
      }
    }

    const cursor =
      startRow + SHEETS_PAGE_ROWS <= rowCount
        ? ({ kind: "sheets", nextRow: startRow + SHEETS_PAGE_ROWS } as const)
        : null;
    return finalize(
      { ...context, activeId: String(sheetId) },
      properties.title,
      drafts,
      cursor,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ParseFailure ? error.code : "invalid-request",
    };
  }
}

interface ParsedTab {
  tab: ObjectValue;
  descriptor: WorkspaceReaderTab;
}

function flattenTabs(input: unknown[]) {
  const parsed: ParsedTab[] = [];
  const ids = new Set<string>();

  const visit = (tabInput: unknown, parentId: string | null, depth: number) => {
    const tab = objectValue(tabInput);
    const properties = objectValue(tab?.tabProperties);
    if (!tab || !properties) throw new ParseFailure("invalid-request");
    const { tabId, title } = properties;
    if (
      typeof tabId !== "string" ||
      !/^[A-Za-z0-9._-]{1,200}$/.test(tabId) ||
      typeof title !== "string" ||
      ids.has(tabId)
    ) {
      throw new ParseFailure("invalid-request");
    }
    ids.add(tabId);
    const declaredParent = properties.parentTabId;
    if (
      declaredParent !== undefined &&
      declaredParent !== "" &&
      declaredParent !== parentId
    ) {
      throw new ParseFailure("invalid-request");
    }
    const descriptor = { id: tabId, title, parentId, depth };
    parsed.push({ tab, descriptor });
    if (tab.childTabs !== undefined && !Array.isArray(tab.childTabs)) {
      throw new ParseFailure("invalid-request");
    }
    for (const child of (tab.childTabs ?? []) as unknown[]) {
      visit(child, tabId, depth + 1);
    }
  };

  for (const tab of input) visit(tab, null, 0);
  return parsed;
}

function unsupportedDraft(
  context: WorkspaceEditorContext,
  tabId: string,
  anchor: string,
  ordinal: number,
  label: string,
): DraftRecord {
  const text = `[Unsupported ${label}]`;
  return {
    id: `docs:${context.fileId}:${tabId}:${anchor}:${ordinal}`,
    anchor,
    source: text,
    display: text,
    kind: "unsupported",
    translatable: false,
  };
}

function docsDrafts(
  contentInput: unknown,
  context: WorkspaceEditorContext,
  tabId: string,
) {
  if (!Array.isArray(contentInput)) throw new ParseFailure("invalid-request");
  const drafts: DraftRecord[] = [];
  let ordinal = 0;
  const addText = (anchor: string, source: string) => {
    const normalized = source.endsWith("\n") ? source.slice(0, -1) : source;
    drafts.push({
      id: `docs:${context.fileId}:${tabId}:${anchor}:${ordinal++}`,
      anchor,
      source: normalized,
      display: normalized,
      kind: normalized.length ? "text" : "blank",
      translatable: normalized.trim().length > 0,
    });
  };
  const addUnsupported = (anchor: string, label: string) => {
    drafts.push(unsupportedDraft(context, tabId, anchor, ordinal++, label));
  };

  const walk = (content: unknown[], prefix = "") => {
    for (const elementInput of content) {
      const element = objectValue(elementInput);
      const startIndex = integer(element?.startIndex);
      if (!element || startIndex === null) {
        throw new ParseFailure("invalid-request");
      }
      const paragraph = objectValue(element.paragraph);
      if (paragraph) {
        if (!Array.isArray(paragraph.elements)) {
          throw new ParseFailure("invalid-request");
        }
        let text = "";
        let chunk = 0;
        const flush = () => {
          if (text || chunk === 0) {
            addText(`${prefix}P${startIndex}.${chunk++}`, text);
          }
          text = "";
        };
        for (const paragraphElementInput of paragraph.elements) {
          const paragraphElement = objectValue(paragraphElementInput);
          if (!paragraphElement) throw new ParseFailure("invalid-request");
          const textRun = objectValue(paragraphElement.textRun);
          if (textRun) {
            if (typeof textRun.content !== "string") {
              throw new ParseFailure("invalid-request");
            }
            text += textRun.content;
            continue;
          }
          if (text) flush();
          const label =
            [
              "equation",
              "inlineObjectElement",
              "pageBreak",
              "columnBreak",
              "footnoteReference",
              "horizontalRule",
              "autoText",
              "person",
              "richLink",
              "dateElement",
            ].find((key) => key in paragraphElement) ?? "paragraph element";
          addUnsupported(`${prefix}P${startIndex}.${chunk++}`, label);
        }
        if (text || paragraph.elements.length === 0) flush();
        continue;
      }

      const table = objectValue(element.table);
      if (table) {
        if (!Array.isArray(table.tableRows)) {
          throw new ParseFailure("invalid-request");
        }
        for (const [rowIndex, rowInput] of table.tableRows.entries()) {
          const row = objectValue(rowInput);
          if (!row || !Array.isArray(row.tableCells)) {
            throw new ParseFailure("invalid-request");
          }
          for (const [cellIndex, cellInput] of row.tableCells.entries()) {
            const cell = objectValue(cellInput);
            if (!cell || !Array.isArray(cell.content)) {
              throw new ParseFailure("invalid-request");
            }
            walk(
              cell.content,
              `${prefix}T${startIndex}.R${rowIndex + 1}.C${cellIndex + 1}.`,
            );
          }
        }
        continue;
      }

      addUnsupported(
        `${prefix}S${startIndex}`,
        "tableOfContents" in element ? "table of contents" : "document element",
      );
    }
  };

  walk(contentInput);
  return drafts;
}

export async function parseDocsTabs(
  input: unknown,
  context: WorkspaceEditorContext,
): WorkspaceLoadResult {
  const sizeError = responseSizeError(input);
  if (sizeError) return { ok: false, error: sizeError };
  if (context.kind !== "docs") return invalid();

  try {
    const root = objectValue(input);
    if (!root || !Array.isArray(root.tabs) || root.tabs.length === 0) {
      return invalid();
    }
    if (root.documentId !== undefined && root.documentId !== context.fileId) {
      return invalid();
    }
    const tabs = flattenTabs(root.tabs);
    const activeId = context.activeId ?? tabs[0]?.descriptor.id;
    const active = tabs.find(({ descriptor }) => descriptor.id === activeId);
    const body = objectValue(objectValue(active?.tab.documentTab)?.body);
    if (!active || !body || !Array.isArray(body.content)) return invalid();

    const drafts = docsDrafts(body.content, context, active.descriptor.id);
    return finalize(
      { ...context, activeId: active.descriptor.id },
      active.descriptor.title,
      drafts,
      null,
      tabs.map(({ descriptor }) => descriptor),
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ParseFailure ? error.code : "invalid-request",
    };
  }
}
