import type {
  WorkspaceSheetCell,
  WorkspaceSheetRow,
} from "./google-workspace-reader";
import type { CellTextLayout, LayoutColumn } from "./spreadsheet-layout";

/**
 * Reader text fitting and row growth.
 *
 * Column widths always stay the source widths. A row grows (never shrinks)
 * when one of its single-row cells needs more line boxes than one: wrapped
 * source text, manual newlines, or text that does not fit its source mode and
 * therefore wraps inside its cell. The height is the maximum over every
 * presentation of the cell, so Original and Translation share one geometry.
 */

const LINE_HEIGHT = 1.25;
const BORDER = 1;

export type MeasureText = (
  text: string,
  fontPx: number,
  family: string | null,
  bold: boolean,
  italic: boolean,
) => number;

let canvasContext: OffscreenCanvasRenderingContext2D | null | undefined;
const widthCache = new Map<string, number>();

/** Canvas-backed measurement with a deterministic estimate as fallback. */
export const measureTextWidth: MeasureText = (
  text,
  fontPx,
  family,
  bold,
  italic,
) => {
  if (canvasContext === undefined) {
    try {
      canvasContext =
        typeof OffscreenCanvas === "undefined"
          ? null
          : (new OffscreenCanvas(1, 1).getContext("2d") ?? null);
    } catch {
      canvasContext = null;
    }
  }
  if (!canvasContext) {
    let width = 0;
    for (const char of text)
      width += (char.codePointAt(0)! > 0x2e7f ? 1 : 0.55) * fontPx;
    return width;
  }
  const key = `${bold ? "b" : ""}${italic ? "i" : ""}|${fontPx}|${family ?? ""}|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  canvasContext.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontPx}px ${
    family ? `"${family}", ` : ""
  }sans-serif`;
  const width = canvasContext.measureText(text).width;
  if (widthCache.size > 20_000) widthCache.clear();
  widthCache.set(key, width);
  return width;
};

function isBreakableAfter(char: string) {
  return char === " " || char.codePointAt(0)! > 0x2e7f;
}

/** Number of lines `text` occupies at `width` px (greedy wrap, manual newlines kept). */
export function wrappedLineCount(
  text: string,
  width: number,
  measure: (text: string) => number,
): number {
  if (width <= 0) return text.split("\n").length;
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    lines += 1;
    let current = 0;
    let pending = ""; // current unbreakable run
    const flush = () => {
      if (!pending) return;
      const runWidth = measure(pending);
      if (current > 0 && current + runWidth > width) {
        lines += 1;
        current = 0;
      }
      if (runWidth > width) {
        // A long run breaks anywhere.
        let part = "";
        for (const char of pending) {
          const next = measure(part + char);
          if (next > width && part) {
            lines += 1;
            part = char;
          } else part += char;
        }
        current = measure(part);
      } else current += runWidth;
      pending = "";
    };
    for (const char of paragraph) {
      pending += char;
      if (isBreakableAfter(char)) flush();
    }
    flush();
  }
  return lines;
}

export interface CellFit {
  /** Paint as wrapped text inside the cell (or merge) footprint. */
  wrap: boolean;
  /** Line boxes the text occupies in that mode. */
  lines: number;
}

const fitCache = new Map<string, CellFit>();

/**
 * Reader readability rule: text that fits its source mode keeps it (overflow
 * across empty neighbours, or one line inside its cell). Text that would be
 * cut instead wraps: overflow text across its corridor, other text inside its
 * own cell or merge, and the row grows to show it. Only textual cells wrap;
 * numbers and errors keep their single line.
 */
export function fitCellText(
  cell: WorkspaceSheetCell,
  text: string,
  layout: Pick<CellTextLayout, "mode" | "before" | "after"> | undefined,
  width: number,
  measure: MeasureText = measureTextWidth,
): CellFit {
  if (!text || width <= 0) return { wrap: false, lines: 0 };
  const style = cell.style;
  const mode = layout?.mode ?? style.wrapStrategy;
  const key = `${mode}|${layout?.before ?? 0}|${layout?.after ?? 0}|${width}|${style.fontFamily ?? ""}|${style.fontSize ?? ""}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}|${style.indent}|${style.padding.left},${style.padding.right}|${cell.kind}|${text}`;
  const cached = fitCache.get(key);
  if (cached) return cached;
  const fontPx = ((style.fontSize ?? 10) * 96) / 72;
  const measureRun = (value: string) =>
    measure(value, fontPx, style.fontFamily, style.bold, style.italic);
  const indent = style.indent * 3 * 0.278 * fontPx;
  // Content box of the text layer: cell minus borders, padding and indent,
  // less a small safety margin so a measured fit never clips in CSS.
  const inner = Math.max(
    1,
    width - style.padding.left - style.padding.right - indent - 2 * BORDER - 2,
  );
  const paragraphs = text.split("\n");
  const textual = cell.kind === "text" || cell.kind === "formula";
  let fit: CellFit;
  if (!textual) {
    fit = { wrap: false, lines: paragraphs.length };
  } else if (mode === "wrap") {
    fit = { wrap: true, lines: wrappedLineCount(text, inner, measureRun) };
  } else {
    const longest = Math.max(...paragraphs.map(measureRun));
    const available =
      inner +
      (mode === "overflow" ? (layout?.before ?? 0) + (layout?.after ?? 0) : 0);
    // Overflow text that does not fit its corridor wraps across that same
    // corridor (cell plus valid empty neighbours), never into a blocker.
    fit =
      longest <= available
        ? { wrap: false, lines: paragraphs.length }
        : { wrap: true, lines: wrappedLineCount(text, available, measureRun) };
  }
  if (fitCache.size > 50_000) fitCache.clear();
  fitCache.set(key, fit);
  return fit;
}

/**
 * A multi-line overflowing text is a block: the width its source occupies is
 * the block's footprint, so a longer translation wraps inside that width
 * instead of running far past it. Single-line text (titles, labels) keeps its
 * whole corridor. The returned layout never extends beyond the source block.
 */
export function boundBlockToSource(
  cell: WorkspaceSheetCell,
  layout: CellTextLayout,
  footprint: number,
  source: string,
  measure: MeasureText = measureTextWidth,
): CellTextLayout {
  if (
    layout.mode !== "overflow" ||
    layout.before + layout.after <= 0 ||
    !source.includes("\n") ||
    footprint <= 0
  )
    return layout;
  const style = cell.style;
  const fontPx = ((style.fontSize ?? 10) * 96) / 72;
  const longest = Math.max(
    ...source
      .split("\n")
      .map((line) =>
        measure(line, fontPx, style.fontFamily, style.bold, style.italic),
      ),
  );
  const indent = style.indent * 3 * 0.278 * fontPx;
  // Inverse of the content box used by fitCellText, plus a little slack.
  const needed = Math.ceil(
    longest +
      style.padding.left +
      style.padding.right +
      indent +
      2 * BORDER +
      2 +
      4,
  );
  const allowed = Math.max(0, Math.max(footprint, needed) - footprint);
  if (layout.before + layout.after <= allowed) return layout;
  if (layout.before > 0 && layout.after > 0) {
    const side = Math.floor(allowed / 2);
    return {
      ...layout,
      before: Math.min(layout.before, side),
      after: Math.min(layout.after, side),
    };
  }
  return layout.after > 0
    ? { ...layout, after: Math.min(layout.after, allowed) }
    : { ...layout, before: Math.min(layout.before, allowed) };
}

/** Height that shows `lines` line boxes of the cell's font. */
export function lineBoxHeight(cell: WorkspaceSheetCell, lines: number) {
  const fontPx = ((cell.style.fontSize ?? 10) * 96) / 72;
  return Math.ceil(
    lines * fontPx * LINE_HEIGHT +
      cell.style.padding.top +
      cell.style.padding.bottom +
      2 * BORDER,
  );
}

/**
 * Row height needed to show every text of its single-row cells. `texts`
 * yields every presentation of a cell (source and translation) so the
 * height is the same in Original and Translation and never jumps on toggle.
 * One-line content never grows a row: the source height already fits it.
 */
export function cellContentHeight(
  cell: WorkspaceSheetCell,
  columns: readonly LayoutColumn[],
  layout: CellTextLayout | undefined,
  texts: readonly (string | undefined)[],
  measure: MeasureText = measureTextWidth,
): number {
  let width = 0;
  for (let index = 0; index < Math.max(1, cell.columnSpan); index += 1)
    width += columns[cell.columnIndex + index]?.width ?? 0;
  if (width <= 0) return 0;
  let height = 0;
  for (const text of texts) {
    if (!text) continue;
    const { lines } = fitCellText(cell, text, layout, width, measure);
    if (lines > 1) height = Math.max(height, lineBoxHeight(cell, lines));
  }
  return height;
}

export function contentRowHeight(
  row: WorkspaceSheetRow,
  columns: readonly LayoutColumn[],
  layouts: ReadonlyMap<number, CellTextLayout> | undefined,
  texts: (cell: WorkspaceSheetCell) => readonly (string | undefined)[],
  measure: MeasureText = measureTextWidth,
): number {
  let height = 0;
  for (const cell of row.cells) {
    if (cell.rowSpan > 1) continue;
    height = Math.max(
      height,
      cellContentHeight(
        cell,
        columns,
        layouts?.get(cell.columnIndex),
        texts(cell),
        measure,
      ),
    );
  }
  return height;
}

/** Source-only auto-fit (rows without a stored height). */
export function autofitRowHeight(
  row: WorkspaceSheetRow,
  columns: readonly LayoutColumn[],
  measure: MeasureText = measureTextWidth,
): number {
  return Math.max(
    row.pixelSize,
    contentRowHeight(
      row,
      columns,
      undefined,
      (cell) => [cell.style.wrapStrategy === "wrap" ? cell.display : undefined],
      measure,
    ),
  );
}
