import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceSheetCellStyle,
  type WorkspaceSheetCell,
  type WorkspaceSheetCellStyle,
  type WorkspaceSheetRow,
} from "./google-workspace-reader";
import {
  computeRowTextLayouts,
  isOccupied,
  resolveAlignment,
  resolveTextMode,
  type LayoutColumn,
} from "./spreadsheet-layout";

function columns(widths: number[], hidden: number[] = []): LayoutColumn[] {
  let offset = 0;
  return widths.map((width, index) => {
    const isHidden = hidden.includes(index);
    const column = {
      index,
      width: isHidden ? 0 : width,
      offset,
      hidden: isHidden,
    };
    offset += column.width;
    return column;
  });
}

function cell(
  columnIndex: number,
  text: string,
  style: Partial<WorkspaceSheetCellStyle> = {},
  extra: Partial<WorkspaceSheetCell> = {},
): WorkspaceSheetCell {
  return {
    id: `c${columnIndex}`,
    anchor: `A${columnIndex}`,
    source: text,
    display: text,
    kind: text ? "text" : "blank",
    translatable: text.length > 0,
    sourceHash: "h",
    rowIndex: 0,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    style: { ...defaultWorkspaceSheetCellStyle(), ...style },
    ...extra,
  };
}

function row(cells: WorkspaceSheetCell[]): WorkspaceSheetRow {
  return { index: 0, pixelSize: 21, hidden: false, cells };
}

const grid = (over = {}) => ({
  merges: [],
  frozenColumnCount: 0,
  rightToLeft: false,
  ...over,
});

describe("overflow corridor", () => {
  const cols = columns([100, 100, 100, 100]);

  it("runs over empty neighbors and stops at the first populated cell", () => {
    const layouts = computeRowTextLayouts(
      row([cell(0, "long"), cell(2, "blocker")]),
      grid(),
      cols,
    );
    expect(layouts.get(0)).toMatchObject({
      mode: "overflow",
      before: 0,
      after: 100,
    });
    expect(layouts.get(2)).toMatchObject({ after: 100 });
  });

  it.each([
    ["whitespace", { source: " ", display: " ", kind: "text" as const }],
    [
      "formula with empty display",
      { source: "=A1", display: "", kind: "formula" as const },
    ],
    ["error", { source: "#N/A", display: "#N/A", kind: "error" as const }],
    ["unsupported", { source: "", display: "", kind: "unsupported" as const }],
  ])("treats a %s neighbor as a blocker", (_name, extra) => {
    const blocker = cell(1, "", {}, extra);
    expect(isOccupied(blocker)).toBe(true);
    const layouts = computeRowTextLayouts(
      row([cell(0, "long"), blocker]),
      grid(),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(0);
  });

  it("a styled blank neighbor is not occupied, but its different fill ends plain text", () => {
    const styled = cell(1, "", { background: "#ffff00" });
    expect(isOccupied(styled)).toBe(false);
    const layouts = computeRowTextLayouts(
      row([cell(0, "long"), styled]),
      grid(),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(0);
  });

  it("filled text runs only over empty neighbors with the same fill", () => {
    const yellow = { background: "#ffff00" };
    const layouts = computeRowTextLayouts(
      row([
        cell(0, "long", yellow),
        cell(1, "", yellow),
        cell(2, "", yellow),
        cell(3, "", { background: "#00ff00" }),
      ]),
      grid(),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(200);
  });

  it("filled text stays in its cell when the next cell is unfilled", () => {
    const layouts = computeRowTextLayouts(
      row([cell(0, "long", { background: "#ffff00" })]),
      grid(),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(0);
  });

  it("stops at a merged range that starts in a neighbor column", () => {
    const layouts = computeRowTextLayouts(
      row([cell(0, "long")]),
      grid({
        merges: [{ startRow: 0, endRow: 1, startColumn: 2, endColumn: 4 }],
      }),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(100);
  });

  it("ignores a merge on a different row", () => {
    const layouts = computeRowTextLayouts(
      row([cell(0, "long")]),
      grid({
        merges: [{ startRow: 3, endRow: 4, startColumn: 1, endColumn: 2 }],
      }),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(300);
  });

  it("skips an empty hidden column and is blocked by a populated one", () => {
    const hiddenCols = columns([100, 100, 100], [1]);
    expect(
      computeRowTextLayouts(row([cell(0, "long")]), grid(), hiddenCols).get(0)!
        .after,
    ).toBe(100);
    expect(
      computeRowTextLayouts(
        row([cell(0, "long"), cell(1, "x")]),
        grid(),
        hiddenCols,
      ).get(0)!.after,
    ).toBe(0);
  });

  it("never crosses the frozen boundary", () => {
    const layouts = computeRowTextLayouts(
      row([cell(0, "long")]),
      grid({ frozenColumnCount: 2 }),
      cols,
    );
    expect(layouts.get(0)!.after).toBe(100);
  });

  it("centers on the symmetric free extent", () => {
    const layouts = computeRowTextLayouts(
      row([cell(1, "long", { horizontal: "center" }), cell(3, "x")]),
      grid(),
      cols,
    );
    // 100 free on the left, 100 on the right (column 2 only).
    expect(layouts.get(1)).toMatchObject({ before: 100, after: 100 });
    const blocked = computeRowTextLayouts(
      row([cell(1, "long", { horizontal: "center" }), cell(2, "x")]),
      grid(),
      cols,
    );
    expect(blocked.get(1)).toMatchObject({ before: 0, after: 0 });
  });

  it("right-aligned text overflows toward lower columns", () => {
    const layouts = computeRowTextLayouts(
      row([cell(3, "long", { horizontal: "right" }), cell(0, "x")]),
      grid(),
      cols,
    );
    expect(layouts.get(3)).toMatchObject({ before: 200, after: 0 });
  });

  it("mirrors the corridor for a right-to-left grid", () => {
    const layouts = computeRowTextLayouts(
      row([cell(1, "long", { horizontal: "left" })]),
      grid({ rightToLeft: true }),
      cols,
    );
    // Physical right edge is toward lower column index in RTL.
    expect(layouts.get(1)).toMatchObject({ before: 100, after: 0 });
  });
});

describe("text modes", () => {
  it("keeps clip and wrap inside the cell footprint", () => {
    const layouts = computeRowTextLayouts(
      row([
        cell(0, "long", { wrapStrategy: "clip" }),
        cell(1, "long", { wrapStrategy: "wrap" }),
      ]),
      grid(),
      columns([100, 100, 100]),
    );
    expect(layouts.get(0)).toMatchObject({ mode: "clip", after: 0 });
    expect(layouts.get(1)).toMatchObject({ mode: "wrap", after: 0 });
  });

  it.each([
    ["merge", {}, { columnSpan: 2 }],
    ["shrink-to-fit", { shrinkToFit: true }, {}],
    ["rotation", { rotation: 45 }, {}],
    ["fill", { horizontal: "fill" as const }, {}],
    ["non-text", {}, { kind: "number" as const, translatable: false }],
  ])("forces clip for %s", (reason, style, extra) => {
    expect(resolveTextMode(cell(0, "1", style, extra))).toEqual({
      mode: "clip",
      forcedClip: reason,
    });
  });

  it("keeps wrap for a merged wrapped cell", () => {
    expect(
      resolveTextMode(cell(0, "x", { wrapStrategy: "wrap" }, { columnSpan: 2 }))
        .mode,
    ).toBe("wrap");
  });

  it("resolves general alignment by value kind and direction", () => {
    expect(resolveAlignment(cell(0, "1", {}, { kind: "number" }), false)).toBe(
      "right",
    );
    expect(resolveAlignment(cell(0, "x"), false)).toBe("left");
    expect(resolveAlignment(cell(0, "x"), true)).toBe("right");
    expect(resolveAlignment(cell(0, "x", { direction: "ltr" }), true)).toBe(
      "left",
    );
  });
});

describe("invariants", () => {
  it("is independent of the displayed text (translation) when source is fixed", () => {
    const cols = columns([100, 100, 100]);
    const original = cell(0, "short");
    const translated = {
      ...original,
      display: "a much longer translated text",
    };
    const blocker = cell(2, "x");
    expect(
      computeRowTextLayouts(row([translated, blocker]), grid(), cols).get(0),
    ).toEqual(
      computeRowTextLayouts(row([original, blocker]), grid(), cols).get(0),
    );
  });

  it("scales linearly with uniform column width scaling", () => {
    const row0 = row([cell(0, "long"), cell(3, "x")]);
    const a = computeRowTextLayouts(
      row0,
      grid(),
      columns([50, 60, 70, 80]),
    ).get(0)!;
    const b = computeRowTextLayouts(
      row0,
      grid(),
      columns([100, 120, 140, 160]),
    ).get(0)!;
    expect(b.after).toBe(a.after * 2);
  });

  it("is unchanged by shifting everything one column to the right", () => {
    const cols = columns([100, 100, 100, 100, 100]);
    const base = computeRowTextLayouts(
      row([cell(0, "long"), cell(2, "x")]),
      grid(),
      cols,
    ).get(0)!;
    const shifted = computeRowTextLayouts(
      row([cell(1, "long"), cell(3, "x")]),
      grid(),
      cols,
    ).get(1)!;
    expect(shifted).toEqual(base);
  });
});

describe("text boxed in by visible rules or fills", () => {
  const sides = (value: string | null) => ({
    top: value,
    right: value,
    bottom: value,
    left: value,
  });
  const empty = (index: number, style: Partial<WorkspaceSheetCellStyle>) =>
    cell(index, "", style);
  const layoutFor = (
    first: Partial<WorkspaceSheetCellStyle>,
    others: Partial<WorkspaceSheetCellStyle>[] = [{}, {}],
  ) =>
    computeRowTextLayouts(
      row([
        cell(0, "Long annotation", first),
        ...others.map((style, index) => empty(index + 1, style)),
      ]),
      grid(),
      columns([100, 100, 100]),
    ).get(0)!;

  it("lets plain and white-bordered text run over empty neighbors", () => {
    expect(layoutFor({}).after).toBe(200);
    expect(layoutFor({ borders: sides("#ffffff") }).after).toBe(200);
  });

  it("lets filled text run over same-fill neighbors whose borders match the fill", () => {
    const yellow = { background: "#ffff00" };
    const matching = { ...yellow, borders: sides("#ffff00") };
    expect(layoutFor(matching, [matching, matching]).after).toBe(200);
    expect(layoutFor(yellow, [{}, {}]).after).toBe(0);
  });

  it("stops at the first visible vertical rule", () => {
    const rule = "#000000";
    // Own right border closes the cell.
    expect(layoutFor({ borders: { ...sides(null), right: rule } }).after).toBe(
      0,
    );
    // A rule on the far edge of the second cell boxes the corridor to 200px.
    expect(
      layoutFor({}, [{}, { borders: { ...sides(null), right: rule } }]).after,
    ).toBe(200);
    // A left rule on the next cell closes the corridor immediately.
    expect(
      layoutFor({}, [{ borders: { ...sides(null), left: rule } }, {}]).after,
    ).toBe(0);
  });

  it("lets text run along a top or bottom rule", () => {
    const rule = { ...sides(null), top: "#000000", bottom: "#000000" };
    expect(
      layoutFor({ borders: rule }, [{ borders: rule }, { borders: rule }])
        .after,
    ).toBe(200);
  });

  it("treats an explicit white background as no background", () => {
    const white = { background: "#ffffff" };
    expect(layoutFor(white, [white, white]).after).toBe(200);
  });
});
