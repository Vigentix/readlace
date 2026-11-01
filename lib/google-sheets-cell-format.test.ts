import { describe, expect, it } from "vitest";
import { defaultWorkspaceSheetCellStyle } from "./google-workspace-reader";
import {
  EMPTY_GOOGLE_SHEETS_THEME,
  parseGoogleSheetsTheme,
  resolveGoogleCellFormat,
  resolveGoogleDefaultStyle,
} from "./google-sheets-cell-format";

const base = defaultWorkspaceSheetCellStyle();
const resolve = (format: unknown, from = base) =>
  resolveGoogleCellFormat(format, from, EMPTY_GOOGLE_SHEETS_THEME);

describe("wrap strategy", () => {
  it.each([
    ["OVERFLOW_CELL", "overflow"],
    ["CLIP", "clip"],
    ["WRAP", "wrap"],
    ["LEGACY_WRAP", "wrap"],
  ])("maps %s to %s", (value, expected) => {
    expect(resolve({ wrapStrategy: value })?.wrapStrategy).toBe(expected);
  });

  it("inherits for unspecified or omitted values", () => {
    const clip = { ...base, wrapStrategy: "clip" as const };
    expect(
      resolve({ wrapStrategy: "WRAP_STRATEGY_UNSPECIFIED" }, clip)
        ?.wrapStrategy,
    ).toBe("clip");
    expect(resolve({}, clip)?.wrapStrategy).toBe("clip");
    expect(resolve(undefined, clip)).toEqual(clip);
  });

  it("rejects an unknown enum and unknown keys", () => {
    expect(resolve({ wrapStrategy: "SOMETHING" })).toBeNull();
    expect(resolve({ mystery: 1 })).toBeNull();
    expect(resolve({ textFormat: { mystery: 1 } })).toBeNull();
  });
});

describe("explicit false versus absent", () => {
  const bold = { ...base, bold: true, italic: true };
  it("explicit false overrides an inherited true; absent inherits", () => {
    const next = resolve({ textFormat: { bold: false } }, bold);
    expect(next?.bold).toBe(false);
    expect(next?.italic).toBe(true);
  });
  it("rejects non-boolean flags", () => {
    expect(resolve({ textFormat: { bold: "yes" } })).toBeNull();
  });
});

describe("fonts, alignment, padding and direction", () => {
  it("reads family and size in points", () => {
    const next = resolve({
      textFormat: { fontFamily: "Roboto", fontSize: 14 },
    });
    expect(next).toMatchObject({ fontFamily: "Roboto", fontSize: 14 });
  });
  it("rejects invalid font sizes", () => {
    expect(resolve({ textFormat: { fontSize: 0 } })).toBeNull();
    expect(resolve({ textFormat: { fontSize: 1000 } })).toBeNull();
  });
  it("maps alignment, direction and rotation", () => {
    expect(
      resolve({
        horizontalAlignment: "RIGHT",
        verticalAlignment: "TOP",
        textDirection: "RIGHT_TO_LEFT",
        textRotation: { angle: 45 },
      }),
    ).toMatchObject({
      horizontal: "right",
      vertical: "top",
      direction: "rtl",
      rotation: 45,
    });
    expect(resolve({ textRotation: { vertical: true } })?.rotation).toBe(
      "vertical",
    );
    expect(resolve({ textRotation: { angle: 200 } })).toBeNull();
  });
  it("merges partial padding over the inherited padding", () => {
    expect(resolve({ padding: { left: 8 } })?.padding).toEqual({
      ...base.padding,
      left: 8,
    });
    expect(resolve({ padding: { left: -1 } })).toBeNull();
  });
});

describe("colors and borders", () => {
  it("resolves theme colors and falls back to the rgb twin", () => {
    const theme = parseGoogleSheetsTheme({
      primaryFontFamily: "Noto Sans",
      themeColors: [
        {
          colorType: "ACCENT1",
          color: { rgbColor: { red: 1, green: 0, blue: 0 } },
        },
      ],
    })!;
    expect(
      resolveGoogleCellFormat(
        { backgroundColorStyle: { themeColor: "ACCENT1" } },
        base,
        theme,
      )?.background,
    ).toBe("#ff0000");
    expect(
      resolveGoogleCellFormat(
        {
          backgroundColorStyle: { themeColor: "ACCENT2" },
          backgroundColor: { red: 0, green: 0, blue: 1 },
        },
        base,
        theme,
      )?.background,
    ).toBe("#0000ff");
  });

  it("maps border styles to a line and width, with consistent color/line nullity", () => {
    const next = resolve({
      borders: {
        top: { style: "SOLID_MEDIUM", color: { red: 0, green: 0, blue: 0 } },
        left: { style: "DASHED" },
        bottom: { style: "NONE" },
      },
    })!;
    expect(next.borderLines.top).toEqual({ style: "solid", width: 2 });
    expect(next.borderLines.left).toEqual({ style: "dashed", width: 1 });
    expect(next.borders.left).not.toBeNull();
    expect(next.borders.bottom).toBeNull();
    expect(next.borderLines.bottom).toBeNull();
    expect(resolve({ borders: { top: { style: "WAVY" } } })).toBeNull();
  });
});

describe("spreadsheet defaults", () => {
  it("uses the theme primary font under the default format", () => {
    const theme = parseGoogleSheetsTheme({ primaryFontFamily: "Noto Sans" })!;
    expect(resolveGoogleDefaultStyle(undefined, theme)?.fontFamily).toBe(
      "Noto Sans",
    );
    expect(
      resolveGoogleDefaultStyle(
        { wrapStrategy: "WRAP", textFormat: { fontSize: 12 } },
        theme,
      ),
    ).toMatchObject({
      wrapStrategy: "wrap",
      fontSize: 12,
      fontFamily: "Noto Sans",
    });
  });
  it("accepts an absent theme and rejects a malformed one", () => {
    expect(parseGoogleSheetsTheme(undefined)).toBe(EMPTY_GOOGLE_SHEETS_THEME);
    expect(parseGoogleSheetsTheme({ extra: 1 })).toBeNull();
    expect(parseGoogleSheetsTheme({ themeColors: "x" })).toBeNull();
  });
});
