import {
  defaultWorkspaceSheetCellStyle,
  normalizeWorkspaceColor,
  safeWorkspaceFontFamily,
  type WorkspaceSheetBorderLine,
  type WorkspaceSheetCellStyle,
  type WorkspaceSheetHorizontal,
} from "./google-workspace-reader";

/**
 * Native Sheets `CellFormat` -> canonical resolved style.
 *
 * The API omits `effectiveFormat` when it equals the spreadsheet default and
 * may omit individual defaulted fields, so a stored format is always resolved
 * over the spreadsheet default (which in turn is resolved over the theme). An
 * absent field inherits; an explicit value, including `false`, overrides.
 * Conditional-format results arrive already applied in `effectiveFormat`.
 */

type ObjectValue = Record<string, unknown>;

export interface GoogleSheetsTheme {
  primaryFontFamily: string | null;
  colors: ReadonlyMap<string, string>;
}

const FORMAT_KEYS = [
  "backgroundColor",
  "backgroundColorStyle",
  "textFormat",
  "horizontalAlignment",
  "verticalAlignment",
  "wrapStrategy",
  "borders",
  "padding",
  "textDirection",
  "textRotation",
] as const;
const TEXT_FORMAT_KEYS = [
  "foregroundColor",
  "foregroundColorStyle",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "fontFamily",
  "fontSize",
] as const;
const THEME_COLOR_TYPES = [
  "TEXT",
  "BACKGROUND",
  "ACCENT1",
  "ACCENT2",
  "ACCENT3",
  "ACCENT4",
  "ACCENT5",
  "ACCENT6",
  "LINK",
];

function objectValue(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;
}

function onlyKeys(value: ObjectValue, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export const EMPTY_GOOGLE_SHEETS_THEME: GoogleSheetsTheme = {
  primaryFontFamily: null,
  colors: new Map(),
};

/** Parses `spreadsheetTheme`; an absent theme is valid, a malformed one is not. */
export function parseGoogleSheetsTheme(
  input: unknown,
): GoogleSheetsTheme | null {
  if (input === undefined) return EMPTY_GOOGLE_SHEETS_THEME;
  const theme = objectValue(input);
  if (!theme || !onlyKeys(theme, ["primaryFontFamily", "themeColors"]))
    return null;
  if (
    theme.primaryFontFamily !== undefined &&
    typeof theme.primaryFontFamily !== "string"
  )
    return null;
  if (theme.themeColors !== undefined && !Array.isArray(theme.themeColors))
    return null;
  const colors = new Map<string, string>();
  for (const pairInput of (theme.themeColors ?? []) as unknown[]) {
    const pair = objectValue(pairInput);
    if (
      !pair ||
      typeof pair.colorType !== "string" ||
      !THEME_COLOR_TYPES.includes(pair.colorType)
    )
      continue;
    const color = objectValue(pair.color);
    const rgb = color ? normalizeWorkspaceColor(color.rgbColor ?? color) : null;
    if (typeof rgb === "string") colors.set(pair.colorType, rgb);
  }
  return {
    primaryFontFamily:
      typeof theme.primaryFontFamily === "string"
        ? safeWorkspaceFontFamily(theme.primaryFontFamily)
        : null,
    colors,
  };
}

/** `undefined` = field absent (inherit), `null` = present but unresolvable. */
function colorField(
  style: unknown,
  rgb: unknown,
  theme: GoogleSheetsTheme,
): string | null | undefined | "invalid" {
  if (style === undefined && rgb === undefined) return undefined;
  const colorStyle = objectValue(style);
  if (style !== undefined && !colorStyle) return "invalid";
  if (colorStyle && "themeColor" in colorStyle) {
    if (
      !onlyKeys(colorStyle, ["themeColor"]) ||
      typeof colorStyle.themeColor !== "string"
    )
      return "invalid";
    const resolved = theme.colors.get(colorStyle.themeColor);
    if (resolved) return resolved;
    // An unresolvable theme slot falls back to the deprecated RGB twin.
    if (rgb === undefined) return null;
  }
  const value = normalizeWorkspaceColor(
    colorStyle && "rgbColor" in colorStyle ? colorStyle : (rgb ?? colorStyle),
  );
  return value === undefined ? "invalid" : value;
}

function borderLine(
  value: unknown,
  theme: GoogleSheetsTheme,
):
  | { color: string; line: WorkspaceSheetBorderLine }
  | null
  | undefined
  | "invalid" {
  if (value === undefined) return undefined;
  const border = objectValue(value);
  if (
    !border ||
    !onlyKeys(border, ["style", "width", "color", "colorStyle"]) ||
    typeof border.style !== "string"
  )
    return "invalid";
  const lines: Record<string, WorkspaceSheetBorderLine | null> = {
    NONE: null,
    SOLID: { style: "solid", width: 1 },
    SOLID_MEDIUM: { style: "solid", width: 2 },
    SOLID_THICK: { style: "solid", width: 3 },
    DOTTED: { style: "dotted", width: 1 },
    DASHED: { style: "dashed", width: 1 },
    DOUBLE: { style: "double", width: 3 },
  };
  if (!(border.style in lines)) return "invalid";
  const line = lines[border.style]!;
  if (!line) return null;
  const color = colorField(border.colorStyle, border.color, theme);
  if (color === "invalid") return "invalid";
  return { color: color ?? "#000000", line };
}

function paddingValue(value: unknown) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
}

/** Resolves one `CellFormat` over `base`; null = malformed (fail closed). */
export function resolveGoogleCellFormat(
  input: unknown,
  base: WorkspaceSheetCellStyle,
  theme: GoogleSheetsTheme,
): WorkspaceSheetCellStyle | null {
  const format = objectValue(input ?? {});
  if (!format || !onlyKeys(format, FORMAT_KEYS)) return null;
  const textFormat = objectValue(format.textFormat ?? {});
  if (
    !textFormat ||
    !onlyKeys(textFormat, TEXT_FORMAT_KEYS) ||
    (["bold", "italic", "underline", "strikethrough"] as const).some(
      (key) =>
        textFormat[key] !== undefined && typeof textFormat[key] !== "boolean",
    ) ||
    (textFormat.fontFamily !== undefined &&
      typeof textFormat.fontFamily !== "string") ||
    (textFormat.fontSize !== undefined &&
      !(
        typeof textFormat.fontSize === "number" &&
        Number.isFinite(textFormat.fontSize) &&
        textFormat.fontSize > 0 &&
        textFormat.fontSize <= 400
      ))
  )
    return null;

  const background = colorField(
    format.backgroundColorStyle,
    format.backgroundColor,
    theme,
  );
  const color = colorField(
    textFormat.foregroundColorStyle,
    textFormat.foregroundColor,
    theme,
  );
  if (background === "invalid" || color === "invalid") return null;

  const horizontals: Record<string, WorkspaceSheetHorizontal | undefined> = {
    HORIZONTAL_ALIGN_UNSPECIFIED: undefined,
    LEFT: "left",
    CENTER: "center",
    RIGHT: "right",
  };
  const verticals: Record<
    string,
    WorkspaceSheetCellStyle["vertical"] | undefined
  > = {
    VERTICAL_ALIGN_UNSPECIFIED: undefined,
    TOP: "top",
    MIDDLE: "middle",
    BOTTOM: "bottom",
  };
  const wraps: Record<
    string,
    WorkspaceSheetCellStyle["wrapStrategy"] | undefined
  > = {
    WRAP_STRATEGY_UNSPECIFIED: undefined,
    OVERFLOW_CELL: "overflow",
    CLIP: "clip",
    WRAP: "wrap",
    // Legacy wrap also wraps; it only clips over-long words.
    LEGACY_WRAP: "wrap",
  };
  const directions: Record<
    string,
    WorkspaceSheetCellStyle["direction"] | undefined
  > = {
    TEXT_DIRECTION_UNSPECIFIED: undefined,
    LEFT_TO_RIGHT: "ltr",
    RIGHT_TO_LEFT: "rtl",
  };
  const enumValue = <T>(
    value: unknown,
    table: Record<string, T | undefined>,
    inherited: T,
  ) => {
    if (value === undefined) return inherited;
    if (typeof value !== "string" || !(value in table)) return "invalid";
    return table[value] ?? inherited;
  };
  const horizontal = enumValue(
    format.horizontalAlignment,
    horizontals,
    base.horizontal,
  );
  const vertical = enumValue(
    format.verticalAlignment,
    verticals,
    base.vertical,
  );
  const wrapStrategy = enumValue(format.wrapStrategy, wraps, base.wrapStrategy);
  const direction = enumValue(format.textDirection, directions, base.direction);
  if (
    horizontal === "invalid" ||
    vertical === "invalid" ||
    wrapStrategy === "invalid" ||
    direction === "invalid"
  )
    return null;

  let rotation = base.rotation;
  if (format.textRotation !== undefined) {
    const spec = objectValue(format.textRotation);
    if (!spec || !onlyKeys(spec, ["angle", "vertical"])) return null;
    if (spec.vertical === true) rotation = "vertical";
    else if (spec.angle !== undefined) {
      if (
        !Number.isInteger(spec.angle) ||
        (spec.angle as number) < -90 ||
        (spec.angle as number) > 90
      )
        return null;
      rotation = spec.angle as number;
    } else if (spec.vertical !== undefined && spec.vertical !== false)
      return null;
    else rotation = 0;
  }

  let padding = base.padding;
  if (format.padding !== undefined) {
    const spec = objectValue(format.padding);
    if (!spec || !onlyKeys(spec, ["top", "right", "bottom", "left"]))
      return null;
    const next = { ...base.padding };
    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (spec[side] === undefined) continue;
      const value = paddingValue(spec[side]);
      if (value === null) return null;
      next[side] = value;
    }
    padding = next;
  }

  const borders = { ...base.borders };
  const borderLines = { ...base.borderLines };
  if (format.borders !== undefined) {
    const spec = objectValue(format.borders);
    if (!spec || !onlyKeys(spec, ["top", "right", "bottom", "left"]))
      return null;
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const border = borderLine(spec[side], theme);
      if (border === "invalid") return null;
      if (border === undefined) continue;
      borders[side] = border?.color ?? null;
      borderLines[side] = border?.line ?? null;
    }
  }

  return {
    ...base,
    background: background === undefined ? base.background : background,
    color: color === undefined ? base.color : color,
    bold: (textFormat.bold as boolean | undefined) ?? base.bold,
    italic: (textFormat.italic as boolean | undefined) ?? base.italic,
    underline: (textFormat.underline as boolean | undefined) ?? base.underline,
    strikethrough:
      (textFormat.strikethrough as boolean | undefined) ?? base.strikethrough,
    fontFamily:
      textFormat.fontFamily === undefined
        ? base.fontFamily
        : (safeWorkspaceFontFamily(textFormat.fontFamily) ?? base.fontFamily),
    fontSize: (textFormat.fontSize as number | undefined) ?? base.fontSize,
    horizontal,
    vertical,
    wrapStrategy,
    direction,
    rotation,
    padding,
    borders,
    borderLines,
  };
}

/**
 * Spreadsheet-level default: documented API default format over the theme's
 * primary font. Used verbatim for cells whose effective format was omitted.
 */
export function resolveGoogleDefaultStyle(
  defaultFormat: unknown,
  theme: GoogleSheetsTheme,
): WorkspaceSheetCellStyle | null {
  const base = defaultWorkspaceSheetCellStyle();
  if (theme.primaryFontFamily) base.fontFamily = theme.primaryFontFamily;
  return resolveGoogleCellFormat(defaultFormat, base, theme);
}
