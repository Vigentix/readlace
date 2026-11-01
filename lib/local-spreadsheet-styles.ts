import type { WorkBook } from "xlsx";
import {
  defaultWorkspaceSheetCellStyle,
  safeWorkspaceFontFamily,
  type WorkspaceSheetBorderLine,
  type WorkspaceSheetCellStyle,
  type WorkspaceSheetHorizontal,
  type WorkspaceSheetSides,
  type WorkspaceSheetTextRun,
} from "./google-workspace-reader";

/**
 * Bounded OOXML style resolution for saved XLSX/XLSM workbooks.
 *
 * SheetJS Community Edition supplies cell data, merges and dimensions; its
 * `cellStyles` option is not an Excel renderer. The remaining style inputs are
 * read from `xl/styles.xml`, the worksheet XML and the theme, reached only
 * through workbook relationships. XF records are resolved against their
 * `cellStyleXfs` parent, so inherited alignment is not lost when a cell XF
 * has no `<alignment>` child. Excel itself writes the effective font, fill and
 * border ids into each cell XF; those ids are used as stored.
 */

const MAX_STYLES_BYTES = 2 * 1024 * 1024;
const MAX_THEME_BYTES = 512 * 1024;
const MAX_WORKSHEET_BYTES = 20 * 1024 * 1024;
const MAX_STYLE_RECORDS = 10_000;
const MAX_STYLED_CELLS = 10_000;
const MAX_SHARED_STRINGS_BYTES = 16 * 1024 * 1024;
const MAX_RICH_RUNS = 64;
const DEFAULT_ROW_POINTS = 15;
const DEFAULT_BASE_COLUMN_WIDTH = 8;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Extract only bounded saved attributes; never resolve entities or execute XML.
function attributes(tag: string) {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
    result[match[1]!] = match[2] ?? match[3]!;
  return result;
}

function xmlFile(
  workbook: WorkBook,
  path: string,
  limit: number,
): string | null {
  const files = object(object(workbook)?.files);
  const content = object(files?.[path])?.content;
  if (typeof content === "string")
    return content.length <= limit ? content : null;
  if (!ArrayBuffer.isView(content) || content.byteLength > limit) return null;
  return new TextDecoder().decode(content);
}

function relationshipPath(workbook: WorkBook, id: string | null, kind: string) {
  const xml = xmlFile(workbook, "xl/_rels/workbook.xml.rels", 256 * 1024);
  if (!xml) return null;
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attrs = attributes(match[0]);
    if ((id !== null && attrs.Id !== id) || !attrs.Type?.endsWith(`/${kind}`))
      continue;
    const target = attrs.Target;
    if (!target || attrs.TargetMode === "External" || /[:\\&#?]/.test(target))
      return null;
    const segments = (
      target.startsWith("/") ? target.slice(1) : `xl/${target}`
    ).split("/");
    const path: string[] = [];
    for (const segment of segments) {
      if (segment === "..") {
        if (!path.length) return null;
        path.pop();
      } else if (segment !== "." && segment !== "") path.push(segment);
    }
    return path[0] === "xl" ? path.join("/") : null;
  }
  return null;
}

export function retainLocalSpreadsheetStyleFiles(workbook: WorkBook) {
  const book = object(workbook)!;
  const files = object(book.files);
  if (!files) return true;
  const keep = new Set([
    "xl/styles.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/sharedStrings.xml",
  ]);
  const theme = relationshipPath(workbook, null, "theme");
  if (theme) keep.add(theme);
  for (const metadata of array(object(workbook.Workbook)?.Sheets)) {
    const id = object(metadata)?.id;
    const path =
      typeof id === "string"
        ? relationshipPath(workbook, id, "worksheet")
        : null;
    if (path) keep.add(path);
  }
  book.files = Object.fromEntries(
    Object.entries(files).filter(([path]) => keep.has(path)),
  );
  if (Array.isArray(book.keys))
    book.keys = book.keys.filter(
      (path) => typeof path === "string" && keep.has(path),
    );
  let retainedBytes = 0;
  for (const file of Object.values(object(book.files)!)) {
    const content = object(file)?.content;
    retainedBytes +=
      typeof content === "string"
        ? content.length * 2
        : ArrayBuffer.isView(content)
          ? content.byteLength
          : 0;
    if (retainedBytes > 20 * 1024 * 1024) {
      book.files = {};
      book.keys = [];
      return false;
    }
  }
  return true;
}

// ---- colors ---------------------------------------------------------------

type Rgb = [number, number, number];

function hex(rgb: Rgb) {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(value: string | undefined): Rgb | null {
  return value && /^[\da-f]{6}$/i.test(value)
    ? [
        Number.parseInt(value.slice(0, 2), 16),
        Number.parseInt(value.slice(2, 4), 16),
        Number.parseInt(value.slice(4, 6), 16),
      ]
    : null;
}

function applyTint([red, green, blue]: Rgb, tint: number): Rgb {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation =
      lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    hue =
      max === r
        ? (g - b) / delta + (g < b ? 6 : 0)
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
    hue /= 6;
  }
  // ECMA-376 18.8.19: tint scales HSL luminance toward black or white.
  const tinted =
    tint < 0 ? lightness * (1 + tint) : lightness * (1 - tint) + tint;
  if (saturation === 0) return [tinted * 255, tinted * 255, tinted * 255];
  const q =
    tinted < 0.5
      ? tinted * (1 + saturation)
      : tinted + saturation - tinted * saturation;
  const p = 2 * tinted - q;
  const channel = (offset: number) => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return (p + (q - p) * 6 * t) * 255;
    if (t < 1 / 2) return q * 255;
    if (t < 2 / 3) return (p + (q - p) * (2 / 3 - t) * 6) * 255;
    return p * 255;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

// Indexed palette entries 0-7 (the remainder is workbook-specific, unsupported).
const INDEXED_BASIC = [
  "000000",
  "ffffff",
  "ff0000",
  "00ff00",
  "0000ff",
  "ffff00",
  "ff00ff",
  "00ffff",
];

function themePalette(workbook: WorkBook): (string | null)[] {
  const path = relationshipPath(workbook, null, "theme");
  const xml = path ? xmlFile(workbook, path, MAX_THEME_BYTES) : null;
  const scheme = xml?.match(
    /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/,
  )?.[1];
  if (!scheme) return [];
  const slot = (name: string) => {
    const body = scheme.match(
      new RegExp(`<a:${name}\\b[^>]*>([\\s\\S]*?)</a:${name}>`),
    )?.[1];
    const srgb = body?.match(/<a:srgbClr\b[^>]*>/);
    const sys = body?.match(/<a:sysClr\b[^>]*>/);
    const value = srgb
      ? attributes(srgb[0]).val
      : sys
        ? attributes(sys[0]).lastClr
        : undefined;
    return parseHex(value) ? value!.toLowerCase() : null;
  };
  // Excel's theme index order differs from the file's dk1/lt1 order.
  return [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ].map(slot);
}

function resolveColor(
  tag: string | undefined,
  palette: readonly (string | null)[],
): string | null {
  if (!tag) return null;
  const attrs = attributes(tag);
  let base: string | null = null;
  if (attrs.rgb && /^[\da-f]{6}([\da-f]{2})?$/i.test(attrs.rgb))
    base = attrs.rgb.slice(-6).toLowerCase();
  else if (attrs.theme && /^\d+$/.test(attrs.theme))
    base = palette[Number(attrs.theme)] ?? null;
  else if (attrs.indexed && /^\d+$/.test(attrs.indexed))
    base = INDEXED_BASIC[Number(attrs.indexed)] ?? null;
  else if (attrs.auto === "1" || attrs.auto === "true") base = null;
  const rgb = parseHex(base ?? undefined);
  if (!rgb) return null;
  const tint = Number(attrs.tint);
  return hex(
    Number.isFinite(tint) && tint !== 0 && Math.abs(tint) <= 1
      ? applyTint(rgb, tint)
      : rgb,
  );
}

// ---- styles.xml -----------------------------------------------------------

interface FontRecord {
  name: string | null;
  size: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string | null;
}

interface XfRecord {
  fontId: number | null;
  fillId: number | null;
  borderId: number | null;
  xfId: number | null;
  applyAlignment: boolean | null;
  alignment: Record<string, string> | null;
}

export interface ParsedLocalStyles {
  fonts: FontRecord[];
  fills: (string | null)[];
  borders: WorkspaceSheetSides<{
    color: string;
    line: WorkspaceSheetBorderLine;
  } | null>[];
  cellStyleXfs: XfRecord[];
  cellXfs: XfRecord[];
  normalXfId: number | null;
}

function flag(value: string | undefined) {
  return value === "1" || value === "true";
}

function booleanElement(body: string, name: string) {
  const match = body.match(new RegExp(`<${name}\\b([^>]*?)/?>`));
  if (!match) return false;
  const value = attributes(match[0]).val;
  return value === undefined || value === "1" || value === "true";
}

function section(xml: string, name: string) {
  return xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
}

function* elements(body: string | undefined, name: string) {
  if (!body) return;
  let count = 0;
  for (const match of body.matchAll(
    new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, "g"),
  )) {
    if (++count > MAX_STYLE_RECORDS) return;
    yield { attrs: attributes(match[1] ?? ""), body: match[2] ?? "" };
  }
}

const BORDER_LINES: Record<string, WorkspaceSheetBorderLine> = {
  thin: { style: "solid", width: 1 },
  hair: { style: "dotted", width: 1 },
  dotted: { style: "dotted", width: 1 },
  dashed: { style: "dashed", width: 1 },
  dashDot: { style: "dashed", width: 1 },
  dashDotDot: { style: "dashed", width: 1 },
  mediumDashed: { style: "dashed", width: 2 },
  mediumDashDot: { style: "dashed", width: 2 },
  mediumDashDotDot: { style: "dashed", width: 2 },
  slantDashDot: { style: "dashed", width: 2 },
  medium: { style: "solid", width: 2 },
  thick: { style: "solid", width: 3 },
  double: { style: "double", width: 3 },
};

function integerAttribute(value: string | undefined) {
  return value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : null;
}

function xfRecords(body: string | undefined): XfRecord[] {
  const result: XfRecord[] = [];
  for (const xf of elements(body, "xf")) {
    const alignment = xf.body.match(/<alignment\b[^>]*?\/?>/);
    result.push({
      fontId: integerAttribute(xf.attrs.fontId),
      fillId: integerAttribute(xf.attrs.fillId),
      borderId: integerAttribute(xf.attrs.borderId),
      xfId: integerAttribute(xf.attrs.xfId),
      applyAlignment:
        xf.attrs.applyAlignment === undefined
          ? null
          : flag(xf.attrs.applyAlignment),
      alignment: alignment ? attributes(alignment[0]) : null,
    });
  }
  return result;
}

export function parseLocalSpreadsheetStyles(
  workbook: WorkBook,
): ParsedLocalStyles | null {
  const xml = xmlFile(workbook, "xl/styles.xml", MAX_STYLES_BYTES);
  if (!xml) return null;
  const palette = themePalette(workbook);
  const fonts: FontRecord[] = [];
  for (const font of elements(section(xml, "fonts"), "font")) {
    const colorTag = font.body.match(/<color\b[^>]*?\/?>/)?.[0];
    const size = Number(
      attributes(font.body.match(/<sz\b[^>]*?\/?>/)?.[0] ?? "").val,
    );
    const underline = font.body.match(/<u\b[^>]*?\/?>/)?.[0];
    fonts.push({
      name:
        safeWorkspaceFontFamily(
          attributes(font.body.match(/<name\b[^>]*?\/?>/)?.[0] ?? "").val,
        ) ?? null,
      size: Number.isFinite(size) && size > 0 && size <= 400 ? size : null,
      bold: booleanElement(font.body, "b"),
      italic: booleanElement(font.body, "i"),
      underline:
        underline !== undefined && attributes(underline).val !== "none",
      strike: booleanElement(font.body, "strike"),
      color: resolveColor(colorTag, palette),
    });
  }
  const fills: (string | null)[] = [];
  for (const fill of elements(section(xml, "fills"), "fill")) {
    const pattern = fill.body.match(/<patternFill\b([^>]*?)(?:\/>|>)/);
    // Only solid fills are painted; other patterns are an explicit gap.
    fills.push(
      pattern && attributes(pattern[1]!).patternType === "solid"
        ? resolveColor(fill.body.match(/<fgColor\b[^>]*?\/?>/)?.[0], palette)
        : null,
    );
  }
  const borders: ParsedLocalStyles["borders"] = [];
  for (const border of elements(section(xml, "borders"), "border")) {
    const sides = {
      top: null,
      right: null,
      bottom: null,
      left: null,
    } as ParsedLocalStyles["borders"][number];
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const line = border.body.match(
        new RegExp(`<${side}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${side}>)`),
      );
      const style = line ? attributes(line[1]!).style : undefined;
      const mapped = style ? BORDER_LINES[style] : undefined;
      if (!line || !mapped) continue;
      sides[side] = {
        line: mapped,
        color:
          resolveColor(line[2]?.match(/<color\b[^>]*?\/?>/)?.[0], palette) ??
          "#000000",
      };
    }
    borders.push(sides);
  }
  const cellStyleXfs = xfRecords(section(xml, "cellStyleXfs"));
  const cellXfs = xfRecords(section(xml, "cellXfs"));
  let normalXfId: number | null = null;
  let normals = 0;
  for (const style of elements(section(xml, "cellStyles"), "cellStyle")) {
    if (style.attrs.builtinId !== "0") continue;
    normals += 1;
    normalXfId = integerAttribute(style.attrs.xfId);
  }
  return {
    fonts,
    fills,
    borders,
    cellStyleXfs,
    cellXfs,
    // Ambiguous Normal metadata is not guessed.
    normalXfId: normals === 1 ? normalXfId : normals === 0 ? 0 : null,
  };
}

/** Normal style font drives column units, default row height and padding. */
function normalFont(styles: ParsedLocalStyles): FontRecord | null {
  if (styles.normalXfId === null) return null;
  const xf = styles.cellStyleXfs[styles.normalXfId] ?? styles.cellXfs[0];
  return xf?.fontId === null || xf?.fontId === undefined
    ? (styles.fonts[0] ?? null)
    : (styles.fonts[xf.fontId] ?? null);
}

export function localSpreadsheetDigitWidth(workbook: WorkBook): number | null {
  const styles = parseLocalSpreadsheetStyles(workbook);
  const font = styles ? normalFont(styles) : null;
  if (
    !font ||
    !font.name ||
    !font.size ||
    typeof OffscreenCanvas === "undefined"
  )
    return null;
  try {
    const context = new OffscreenCanvas(1, 1).getContext("2d");
    if (!context) return null;
    context.font = `${(font.size * 96) / 72}px "${font.name}"`;
    const width = Math.ceil(
      Math.max(
        ...Array.from(
          { length: 10 },
          (_, index) => context.measureText(String(index)).width,
        ),
      ),
    );
    return Number.isFinite(width) && width >= 1 && width <= 200 ? width : null;
  } catch {
    return null;
  }
}

// ---- XF -> canonical style ------------------------------------------------

const HORIZONTALS: Record<string, WorkspaceSheetHorizontal> = {
  general: "general",
  left: "left",
  center: "center",
  right: "right",
  fill: "fill",
  justify: "justify",
  distributed: "distributed",
  centerContinuous: "centerContinuous",
};

function excelRotation(value: string | undefined): number | "vertical" {
  const raw = integerAttribute(value);
  if (raw === null || raw === 0) return 0;
  if (raw === 255) return "vertical";
  if (raw <= 90) return raw;
  if (raw <= 180) return -(raw - 90);
  return 0;
}

function resolveXf(
  styles: ParsedLocalStyles,
  xf: XfRecord,
  base: WorkspaceSheetCellStyle,
): WorkspaceSheetCellStyle {
  const parent =
    xf.xfId === null ? null : (styles.cellStyleXfs[xf.xfId] ?? null);
  const font = xf.fontId === null ? null : (styles.fonts[xf.fontId] ?? null);
  const fill = xf.fillId === null ? undefined : styles.fills[xf.fillId];
  const border = xf.borderId === null ? undefined : styles.borders[xf.borderId];
  // Own alignment wins; otherwise inherit the style XF unless the cell XF
  // explicitly declines it with applyAlignment="0".
  const alignment =
    xf.alignment ??
    (xf.applyAlignment === false ? null : (parent?.alignment ?? null));
  const horizontal = alignment?.horizontal
    ? (HORIZONTALS[alignment.horizontal] ?? base.horizontal)
    : "general";
  const wrapped = flag(alignment?.wrapText);
  const verticals: Record<string, WorkspaceSheetCellStyle["vertical"]> = {
    top: "top",
    center: "middle",
    bottom: "bottom",
    justify: "top",
    distributed: "middle",
  };
  const lines = (pick: "color" | "line") =>
    ({
      top: border?.top?.[pick] ?? null,
      right: border?.right?.[pick] ?? null,
      bottom: border?.bottom?.[pick] ?? null,
      left: border?.left?.[pick] ?? null,
    }) as WorkspaceSheetSides<never>;
  const readingOrder = integerAttribute(alignment?.readingOrder);
  const shrink = flag(alignment?.shrinkToFit);
  return {
    ...base,
    background: fill === undefined ? base.background : fill,
    color: font ? font.color : base.color,
    bold: font?.bold ?? base.bold,
    italic: font?.italic ?? base.italic,
    underline: font?.underline ?? base.underline,
    strikethrough: font?.strike ?? base.strikethrough,
    fontFamily: font?.name ?? base.fontFamily,
    fontSize: font?.size ?? base.fontSize,
    horizontal,
    vertical: alignment?.vertical
      ? (verticals[alignment.vertical] ?? "bottom")
      : "bottom",
    // Excel: wrap and shrink-to-fit are independent attributes; shrink does
    // not apply to wrapped text. Unwrapped text overflows by default, but a
    // fill alignment clips.
    wrapStrategy: wrapped
      ? "wrap"
      : horizontal === "fill"
        ? "clip"
        : "overflow",
    shrinkToFit: shrink && !wrapped,
    direction: readingOrder === 1 ? "ltr" : readingOrder === 2 ? "rtl" : null,
    rotation: excelRotation(alignment?.textRotation),
    indent: Math.min(250, integerAttribute(alignment?.indent) ?? 0),
    borders: lines("color") as WorkspaceSheetCellStyle["borders"],
    borderLines: lines("line") as WorkspaceSheetCellStyle["borderLines"],
  };
}

export interface LocalSpreadsheetStyleDefaults {
  defaultStyle: WorkspaceSheetCellStyle;
  defaultRowPixelSize: number;
  /** Excel default column width in pixels, or null when the digit width is unknown. */
  defaultColumnPixelSize: number | null;
}

function worksheetXml(workbook: WorkBook, sheetIndex: number) {
  const sheet = object(array(object(workbook.Workbook)?.Sheets)[sheetIndex]);
  const path =
    typeof sheet?.id === "string"
      ? relationshipPath(workbook, sheet.id, "worksheet")
      : null;
  return path ? xmlFile(workbook, path, MAX_WORKSHEET_BYTES) : null;
}

/** SheetJS does not expose saved worksheet views in its worksheet object. */
export function localSpreadsheetView(workbook: WorkBook, sheetIndex: number) {
  const xml = worksheetXml(workbook, sheetIndex);
  if (!xml) return null;
  const views = [
    ...(section(xml, "sheetViews") ?? "").matchAll(
      /<sheetView\b([^>]*?)(?:\/>|>([\s\S]*?)<\/sheetView>)/g,
    ),
  ];
  const view =
    views.find((item) => attributes(item[1]!).workbookViewId === "0") ??
    views[0];
  const attrs = attributes(view?.[1] ?? "");
  const pane = attributes(view?.[2]?.match(/<pane\b[^>]*\/?>/)?.[0] ?? "");
  const frozen = pane.state === "frozen" || pane.state === "frozenSplit";
  const split = (value: string | undefined) => {
    const count = Number(value);
    return frozen && Number.isSafeInteger(count) && count >= 0 ? count : 0;
  };
  return {
    rows: split(pane.ySplit),
    columns: split(pane.xSplit),
    rightToLeft: flag(attrs.rightToLeft),
    hideGridlines:
      attrs.showGridLines === "0" || attrs.showGridLines === "false",
  };
}

/** Saved row ht is in points; SheetJS may derive hpx using a different DPI. */
export function localSpreadsheetRowHeights(
  workbook: WorkBook,
  sheetIndex: number,
  lastRow: number,
) {
  const heights = new Map<number, number>();
  const xml = worksheetXml(workbook, sheetIndex);
  if (!xml) return heights;
  for (const match of xml.matchAll(/<row\b[^>]*\/?>/g)) {
    const attrs = attributes(match[0]);
    const row = Number(attrs.r) - 1;
    const height = Number(attrs.ht);
    if (
      Number.isSafeInteger(row) &&
      row >= 0 &&
      row <= lastRow &&
      Number.isFinite(height) &&
      height > 0
    ) {
      heights.set(row, (height * 96) / 72);
    }
  }
  return heights;
}

/** Baseline for a spreadsheet with no formatting (CSV, minimal packages). */
export function localSpreadsheetBaseStyle(): WorkspaceSheetCellStyle {
  return {
    ...defaultWorkspaceSheetCellStyle(),
    // Excel inset: roughly two pixels either side, none vertically.
    padding: { top: 0, right: 2, bottom: 0, left: 2 },
  };
}

export function localSpreadsheetStyleDefaults(
  workbook: WorkBook,
  sheetIndex: number,
  maximumDigitWidth: number | null,
): LocalSpreadsheetStyleDefaults {
  const styles = parseLocalSpreadsheetStyles(workbook);
  const base = localSpreadsheetBaseStyle();
  const normal = styles ? normalFont(styles) : null;
  if (normal?.name) base.fontFamily = normal.name;
  if (normal?.size) base.fontSize = normal.size;
  const defaultStyle =
    styles && styles.cellXfs[0]
      ? resolveXf(styles, styles.cellXfs[0], base)
      : base;
  const format = worksheetXml(workbook, sheetIndex)?.match(
    /<sheetFormatPr\b[^>]*?\/?>/,
  )?.[0];
  const attrs = attributes(format ?? "");
  const points = Number(attrs.defaultRowHeight);
  const defaultRowPixelSize = Math.max(
    1,
    Math.round(
      ((Number.isFinite(points) && points > 0 ? points : DEFAULT_ROW_POINTS) *
        96) /
        72,
    ),
  );
  const customWidth = Number(attrs.defaultColWidth);
  const baseWidth = Number(attrs.baseColWidth);
  let defaultColumnPixelSize: number | null = null;
  if (maximumDigitWidth !== null) {
    defaultColumnPixelSize =
      Number.isFinite(customWidth) && customWidth > 0
        ? Math.max(
            1,
            Math.floor(
              ((256 * customWidth + Math.floor(128 / maximumDigitWidth)) /
                256) *
                maximumDigitWidth,
            ),
          )
        : // Excel rounds baseColWidth characters plus 5px padding up to 8px.
          Math.ceil(
            ((Number.isFinite(baseWidth) && baseWidth > 0
              ? baseWidth
              : DEFAULT_BASE_COLUMN_WIDTH) *
              maximumDigitWidth +
              5) /
              8,
          ) * 8;
  }
  return { defaultStyle, defaultRowPixelSize, defaultColumnPixelSize };
}

/**
 * Resolved style per populated or visibly styled cell inside the content
 * rectangle. Cells whose XF is absent use the default style (xf 0).
 */
export function localSpreadsheetCellStyles(
  workbook: WorkBook,
  sheetIndex: number,
  lastRow: number,
  lastColumn: number,
) {
  const result = new Map<string, WorkspaceSheetCellStyle>();
  const xml = worksheetXml(workbook, sheetIndex);
  const styles = parseLocalSpreadsheetStyles(workbook);
  if (!xml || !styles) return result;
  const base = localSpreadsheetStyleDefaults(workbook, sheetIndex, null);
  const normalized = new Map<number, WorkspaceSheetCellStyle>();
  for (const match of xml.matchAll(/<c\b[^>]*>/g)) {
    const attrs = attributes(match[0]);
    if (
      !attrs.r ||
      !/^[A-Z]{1,3}[1-9]\d*$/.test(attrs.r) ||
      !/^\d+$/.test(attrs.s ?? "")
    )
      continue;
    const address = /^([A-Z]+)(\d+)$/.exec(attrs.r)!;
    let column = 0;
    for (const letter of address[1]!)
      column = column * 26 + letter.charCodeAt(0) - 64;
    if (Number(address[2]) - 1 > lastRow || column - 1 > lastColumn) continue;
    const index = Number(attrs.s);
    const xf = styles.cellXfs[index];
    if (!xf) continue;
    let style = normalized.get(index);
    if (!style) {
      style = resolveXf(styles, xf, base.defaultStyle);
      normalized.set(index, style);
    }
    const cell = workbook.Sheets[workbook.SheetNames[sheetIndex]!]?.[attrs.r];
    const populated =
      cell &&
      (typeof cell.f === "string" ||
        (cell.v !== null && cell.v !== undefined && String(cell.v).length > 0));
    // A blank cell is retained only when it paints something.
    if (
      !populated &&
      !style.background &&
      !Object.values(style.borders).some(Boolean)
    )
      continue;
    result.set(attrs.r, style);
    if (result.size > MAX_STYLED_CELLS) break;
  }
  return result;
}

// ---- rich text -----------------------------------------------------------

export interface LocalRichRun {
  text: string;
  /** null: the run has no font properties and inherits the cell font. */
  style: Omit<WorkspaceSheetTextRun, "text"> | null;
}

function decodeXmlText(text: string) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (_, entity) => {
      const name = String(entity).toLowerCase();
      if (name === "amp") return "&";
      if (name === "lt") return "<";
      if (name === "gt") return ">";
      if (name === "quot") return '"';
      if (name === "apos") return "'";
      const code = name.startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
}

/**
 * Rich-text runs of the string cells of one worksheet, keyed by address. A
 * run without its own font properties inherits the cell font (`inherit`).
 */
export function localSpreadsheetRichRuns(
  workbook: WorkBook,
  sheetIndex: number,
  lastRow: number,
  lastColumn: number,
): Map<string, LocalRichRun[]> {
  const result = new Map<string, LocalRichRun[]>();
  const sheetXml = worksheetXml(workbook, sheetIndex);
  const sharedXml = xmlFile(
    workbook,
    "xl/sharedStrings.xml",
    MAX_SHARED_STRINGS_BYTES,
  );
  if (!sheetXml) return result;
  const palette = themePalette(workbook);
  const decodeRuns = (body: string) => {
    // Phonetic annotations are not part of the displayed string.
    body = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    const runs: LocalRichRun[] = [];
    for (const run of body.matchAll(/<r\b[^>]*>([\s\S]*?)<\/r>/g)) {
      if (runs.length >= MAX_RICH_RUNS) return null;
      const inner = run[1] ?? "";
      const text = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((part) => decodeXmlText(part[1] ?? ""))
        .join("");
      const props = inner.match(/<rPr\b[^>]*>([\s\S]*?)<\/rPr>/)?.[1];
      let style: Omit<WorkspaceSheetTextRun, "text"> | null = null;
      if (props !== undefined) {
        const underline = props.match(/<u\b[^>]*?\/?>/)?.[0];
        style = {
          color: resolveColor(props.match(/<color\b[^>]*?\/?>/)?.[0], palette),
          bold: booleanElement(props, "b"),
          italic: booleanElement(props, "i"),
          underline:
            underline !== undefined && attributes(underline).val !== "none",
          strikethrough: booleanElement(props, "strike"),
        };
      }
      runs.push({ text, style });
    }
    return runs.length >= 2 || (runs.length === 1 && runs[0]!.style)
      ? runs
      : null;
  };
  // Which shared strings does this sheet use, and at which addresses?
  const wanted = new Map<number, string[]>();
  let cells = 0;
  for (const match of sheetXml.matchAll(
    /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
  )) {
    const attrs = attributes(match[1] ?? "");
    if (!attrs.r || !/^[A-Z]{1,3}[1-9]\d*$/.test(attrs.r)) continue;
    const address = /^([A-Z]+)(\d+)$/.exec(attrs.r)!;
    let column = 0;
    for (const letter of address[1]!)
      column = column * 26 + letter.charCodeAt(0) - 64;
    if (Number(address[2]) - 1 > lastRow || column - 1 > lastColumn) continue;
    if (attrs.t !== "s" && attrs.t !== "inlineStr") continue;
    if (++cells > MAX_STYLED_CELLS) break;
    const body = match[2] ?? "";
    if (attrs.t === "inlineStr") {
      const inline = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/)?.[1];
      const runs = inline === undefined ? null : decodeRuns(inline);
      if (runs) result.set(attrs.r, runs);
      continue;
    }
    const value = body.match(/<v\b[^>]*>(\d+)<\/v>/)?.[1];
    if (value === undefined) continue;
    const index = Number(value);
    const list = wanted.get(index) ?? [];
    list.push(attrs.r);
    wanted.set(index, list);
  }
  if (wanted.size === 0 || !sharedXml) return result;
  let index = -1;
  for (const item of sharedXml.matchAll(
    /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g,
  )) {
    index += 1;
    const addresses = wanted.get(index);
    if (!addresses) continue;
    const runs = decodeRuns(item[1] ?? "");
    if (!runs) continue;
    for (const address of addresses) result.set(address, runs);
  }
  return result;
}
