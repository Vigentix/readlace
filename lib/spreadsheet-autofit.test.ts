import { describe, expect, it } from "vitest";
import {
  defaultWorkspaceSheetCellStyle,
  type WorkspaceSheetCell,
  type WorkspaceSheetRow,
} from "./google-workspace-reader";
import {
  autofitRowHeight,
  boundBlockToSource,
  contentRowHeight,
  fitCellText,
  wrappedLineCount,
} from "./spreadsheet-autofit";

// 10px per character, deterministic.
const measure = (text: string) => [...text].length * 10;

function row(display: string, over: Partial<WorkspaceSheetCell> = {}) {
  const cell: WorkspaceSheetCell = {
    id: "a",
    anchor: "A1",
    source: display,
    display,
    kind: "text",
    translatable: true,
    sourceHash: "h",
    rowIndex: 0,
    columnIndex: 0,
    rowSpan: 1,
    columnSpan: 1,
    style: { ...defaultWorkspaceSheetCellStyle(), wrapStrategy: "wrap" },
    ...over,
  };
  return {
    index: 0,
    pixelSize: 21,
    hidden: false,
    autoHeight: true,
    cells: [cell],
  } satisfies WorkspaceSheetRow;
}
const columns = [{ index: 0, width: 105, offset: 0, hidden: false }];
const fit = (r: WorkspaceSheetRow) =>
  autofitRowHeight(r, columns, (t) => measure(t));

describe("wrappedLineCount", () => {
  it("wraps at spaces and keeps manual newlines", () => {
    expect(wrappedLineCount("aaaa bbbb cccc", 100, measure)).toBe(2);
    expect(wrappedLineCount("a\nb\nc", 100, measure)).toBe(3);
  });
  it("breaks between CJK characters and inside overlong words", () => {
    expect(
      wrappedLineCount("日本語日本語日本語日本語日本語日本語", 100, measure),
    ).toBe(2);
    expect(wrappedLineCount("x".repeat(25), 100, measure)).toBe(3);
  });
});

describe("autofitRowHeight", () => {
  it("grows a stored-height-less wrap row with SOURCE text only", () => {
    const short = row("ok");
    const long = row("word ".repeat(30));
    expect(fit(short)).toBe(21);
    expect(fit(long)).toBeGreaterThan(100);
  });
  it("autofit counts only wrapped source cells; vertical merges and numbers never grow", () => {
    const base = row("word ".repeat(30));
    for (const patch of [
      { style: { ...base.cells[0]!.style, wrapStrategy: "overflow" as const } },
      { rowSpan: 2 },
      { kind: "number" as const },
    ])
      expect(fit(row("word ".repeat(30), patch))).toBe(21);
  });
  it("is independent of any translation of the cell", () => {
    const original = row("short");
    const translated = {
      ...original,
      cells: [{ ...original.cells[0]!, source: "short" }],
    };
    expect(fit(translated)).toBe(fit(original));
  });
});

describe("fitCellText", () => {
  const cell = (over: Partial<WorkspaceSheetCell> = {}) =>
    row("", over).cells[0]!;
  it("keeps overflow on one line when the corridor fits it", () => {
    const layout = { mode: "overflow" as const, before: 0, after: 300 };
    expect(fitCellText(cell(), "x".repeat(20), layout, 100, measure)).toEqual({
      wrap: false,
      lines: 1,
    });
  });
  it("wraps blocked overflow and clipped text inside the cell", () => {
    const blocked = { mode: "overflow" as const, before: 0, after: 0 };
    const clip = { mode: "clip" as const, before: 0, after: 0 };
    expect(
      fitCellText(cell(), "word ".repeat(10), blocked, 100, measure).wrap,
    ).toBe(true);
    expect(
      fitCellText(cell(), "word ".repeat(10), clip, 100, measure).lines,
    ).toBeGreaterThan(1);
  });
  it("never wraps numbers", () => {
    const clip = { mode: "clip" as const, before: 0, after: 0 };
    expect(
      fitCellText(cell({ kind: "number" }), "1".repeat(40), clip, 100, measure)
        .wrap,
    ).toBe(false);
  });
  it("counts manual newlines of one-line paragraphs", () => {
    const layout = { mode: "overflow" as const, before: 0, after: 0 };
    expect(fitCellText(cell(), "a\nb\nc", layout, 100, measure)).toEqual({
      wrap: false,
      lines: 3,
    });
  });
});

describe("contentRowHeight", () => {
  it("is the max over source and translation", () => {
    const r = row("short");
    const layouts = new Map([
      [
        0,
        {
          mode: "wrap" as const,
          forcedClip: null,
          align: "left" as const,
          before: 0,
          after: 0,
        },
      ],
    ]);
    const only = contentRowHeight(
      r,
      columns,
      layouts,
      (c) => [c.display],
      (t) => measure(t),
    );
    const both = contentRowHeight(
      r,
      columns,
      layouts,
      (c) => [c.display, "word ".repeat(40)],
      (t) => measure(t),
    );
    expect(only).toBe(0);
    expect(both).toBeGreaterThan(60);
  });
});

describe("boundBlockToSource", () => {
  const cell = (text: string) =>
    ({
      id: "c",
      anchor: "A1",
      source: text,
      display: text,
      kind: "text",
      translatable: true,
      sourceHash: "h",
      rowIndex: 0,
      columnIndex: 0,
      rowSpan: 1,
      columnSpan: 1,
      style: defaultWorkspaceSheetCellStyle(),
    }) as WorkspaceSheetCell;
  const layout = {
    mode: "overflow" as const,
    forcedClip: null,
    align: "left" as const,
    before: 0,
    after: 2400,
  };
  it("keeps a multi-line block inside the width its source occupied", () => {
    const text = "x".repeat(40) + "\n" + "y".repeat(20);
    const bounded = boundBlockToSource(cell(text), layout, 100, text, measure);
    // 400px line + padding/border slack, never the whole 2400px corridor.
    expect(bounded.after).toBeGreaterThan(280);
    expect(bounded.after).toBeLessThan(330);
  });

  it("leaves single-line text and non-overflow cells alone", () => {
    expect(
      boundBlockToSource(cell("one line"), layout, 100, "one line", measure),
    ).toBe(layout);
    expect(
      boundBlockToSource(
        cell("a\nb"),
        { ...layout, mode: "wrap" },
        100,
        "a\nb",
        measure,
      ).after,
    ).toBe(2400);
  });
});
