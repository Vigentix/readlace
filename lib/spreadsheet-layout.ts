import type {
  WorkspaceSheetCell,
  WorkspaceSheetGrid,
  WorkspaceSheetMerge,
  WorkspaceSheetRow,
} from "./google-workspace-reader";

/**
 * Source-fidelity text layout for the Reader spreadsheet grid.
 *
 * Everything here derives from SOURCE metadata only: wrap strategy, source
 * occupancy, merges, frozen panes and column geometry. A translation replaces
 * the displayed string and nothing else, so row heights, column widths,
 * merge footprints and the overflow corridor of a cell are identical in
 * Original and Translation presentation.
 *
 * Verified from primary documentation: Google OVERFLOW_CELL continues into
 * the next cell "so long as that cell is empty", CLIP clips, WRAP wraps at
 * the cell width; OOXML wrap, shrink-to-fit, indent and rotation are
 * independent alignment attributes. Design rules (documented assumptions, kept
 * conservative so text never paints over populated content):
 *  - any stored value, whitespace, formula (even with an empty result), error
 *    or unsupported cell blocks overflow; a styled blank does not;
 *  - a merged range blocks overflow into it, and merged text stays inside its
 *    merge footprint;
 *  - an empty hidden column is skipped (zero width), a populated one blocks;
 *  - overflow never crosses the frozen-pane boundary;
 *  - centered text uses the symmetric free extent so it stays centered.
 */

export const MAX_OVERFLOW_ORIGIN_COLUMNS = 64;

export interface LayoutColumn {
  index: number;
  width: number;
  offset: number;
  hidden: boolean;
}

export type CellTextMode = "overflow" | "clip" | "wrap";
export type PhysicalAlignment = "left" | "center" | "right" | "justify";

export interface CellTextLayout {
  mode: CellTextMode;
  /** Why an `overflow`/`clip` source strategy is painted as `clip`. */
  forcedClip:
    "merge" | "shrink-to-fit" | "rotation" | "fill" | "non-text" | null;
  align: PhysicalAlignment;
  /** Extra paint px toward lower / higher column index (overflow only). */
  before: number;
  after: number;
}

interface Interval {
  start: number;
  end: number;
}

/** A cell that makes its column unavailable for neighbor overflow. */
export function isOccupied(cell: WorkspaceSheetCell): boolean {
  return (
    cell.kind !== "blank" || cell.source.length > 0 || cell.display.length > 0
  );
}

function isTextual(cell: WorkspaceSheetCell) {
  return cell.kind === "text" || (cell.kind === "formula" && cell.translatable);
}

export function resolveAlignment(
  cell: WorkspaceSheetCell,
  gridRightToLeft: boolean,
): PhysicalAlignment {
  const style = cell.style;
  switch (style.horizontal) {
    case "left":
    case "fill":
      return "left";
    case "right":
      return "right";
    case "center":
    case "centerContinuous":
    case "distributed":
      return "center";
    case "justify":
      return "justify";
    case "general": {
      if (cell.kind === "number") return "right";
      if (cell.kind === "boolean" || cell.kind === "error") return "center";
      const rtl =
        (style.direction ?? (gridRightToLeft ? "rtl" : "ltr")) === "rtl";
      return rtl ? "right" : "left";
    }
  }
}

export function resolveTextMode(cell: WorkspaceSheetCell): {
  mode: CellTextMode;
  forcedClip: CellTextLayout["forcedClip"];
} {
  const style = cell.style;
  if (style.wrapStrategy === "wrap") return { mode: "wrap", forcedClip: null };
  if (cell.columnSpan > 1 || cell.rowSpan > 1)
    return { mode: "clip", forcedClip: "merge" };
  if (style.shrinkToFit) return { mode: "clip", forcedClip: "shrink-to-fit" };
  if (style.rotation !== 0) return { mode: "clip", forcedClip: "rotation" };
  if (style.horizontal === "fill") return { mode: "clip", forcedClip: "fill" };
  if (!isTextual(cell)) return { mode: "clip", forcedClip: "non-text" };
  return { mode: style.wrapStrategy, forcedClip: null };
}

function rowBlockers(
  row: WorkspaceSheetRow,
  merges: readonly WorkspaceSheetMerge[],
): Interval[] {
  const intervals: Interval[] = [];
  for (const cell of row.cells) {
    if (isOccupied(cell))
      intervals.push({
        start: cell.columnIndex,
        end: cell.columnIndex + Math.max(1, cell.columnSpan) - 1,
      });
  }
  for (const merge of merges) {
    if (row.index >= merge.startRow && row.index < merge.endRow)
      intervals.push({ start: merge.startColumn, end: merge.endColumn - 1 });
  }
  intervals.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function nextBlockerStart(intervals: readonly Interval[], after: number) {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (intervals[middle]!.start > after) high = middle;
    else low = middle + 1;
  }
  return intervals[low]?.start ?? null;
}

function previousBlockerEnd(intervals: readonly Interval[], before: number) {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (intervals[middle]!.end < before) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? null : intervals[low - 1]!.end;
}

/** White (or near-white) lines paint nothing on the white sheet surface. */
function isInvisibleColor(color: string): boolean {
  const hex = color.trim().toLowerCase();
  return /^#(?:f{3}|f{6}|f{8})$/.test(hex);
}

/** Background that actually paints; an explicit white equals the sheet. */
function visibleBackground(cell: WorkspaceSheetCell): string | null {
  const background = cell.style.background ?? null;
  return background !== null && isInvisibleColor(background)
    ? null
    : background;
}

/** A rule paints only if it is neither white nor the cell's own fill. */
function isVisibleRule(color: string | null, background: string | null) {
  return (
    color !== null &&
    !isInvisibleColor(color) &&
    color.trim().toLowerCase() !== (background ?? "").toLowerCase()
  );
}

/** Free px beyond the cell, bounded by the nearest blocker and frozen edge. */
function freeExtent(
  columns: readonly LayoutColumn[],
  intervals: readonly Interval[],
  cell: WorkspaceSheetCell,
  frozenColumns: number,
  direction: "before" | "after",
  fillLimit: number,
): number {
  const first = cell.columnIndex;
  const last = cell.columnIndex + Math.max(1, cell.columnSpan) - 1;
  const frozen = first < frozenColumns;
  const lastColumn = columns.length - 1;
  if (direction === "after") {
    const limit = Math.min(
      frozen ? frozenColumns - 1 : lastColumn,
      (nextBlockerStart(intervals, last) ?? lastColumn + 1) - 1,
      fillLimit,
    );
    if (limit <= last) return 0;
    const edge = columns[limit]!;
    const own = columns[last]!;
    return edge.offset + edge.width - (own.offset + own.width);
  }
  const limit = Math.max(
    frozen ? 0 : frozenColumns,
    (previousBlockerEnd(intervals, first) ?? -1) + 1,
    fillLimit,
  );
  if (limit >= first) return 0;
  return columns[first]!.offset - columns[limit]!.offset;
}

/**
 * Text layout for each non-empty origin cell of one row. Pure function of
 * source occupancy and geometry; `columns` is the full absolute sequence.
 */
export function computeRowTextLayouts(
  row: WorkspaceSheetRow,
  grid: Pick<
    WorkspaceSheetGrid,
    "merges" | "frozenColumnCount" | "rightToLeft"
  >,
  columns: readonly LayoutColumn[],
): Map<number, CellTextLayout> {
  const layouts = new Map<number, CellTextLayout>();
  let blockers: Interval[] | undefined;
  // Text may only run over neighbors that paint the same background as its
  // own cell (a fill must always cover the text it carries, and plain text
  // must not spill across someone else's fill) and only across boundaries
  // that show no vertical rule: a visible border boxes the text in.
  const backgrounds = new Map<number, string | null>();
  const startingAt = new Map<number, WorkspaceSheetCell>();
  const endingAt = new Map<number, WorkspaceSheetCell>();
  for (const cell of row.cells) {
    backgrounds.set(cell.columnIndex, visibleBackground(cell));
    startingAt.set(cell.columnIndex, cell);
    endingAt.set(cell.columnIndex + Math.max(1, cell.columnSpan) - 1, cell);
  }
  const ruleBetween = (left: number) => {
    const before = endingAt.get(left);
    const after = startingAt.get(left + 1);
    return (
      (before !== undefined &&
        isVisibleRule(before.style.borders.right, visibleBackground(before))) ||
      (after !== undefined &&
        isVisibleRule(after.style.borders.left, visibleBackground(after)))
    );
  };
  const MAX_FILL_SCAN = 256;
  const reachLimit = (
    cell: WorkspaceSheetCell,
    direction: "before" | "after",
  ) => {
    const own = visibleBackground(cell);
    const first = cell.columnIndex;
    const last = first + Math.max(1, cell.columnSpan) - 1;
    const step = direction === "after" ? 1 : -1;
    let column = direction === "after" ? last : first;
    for (let scanned = 0; scanned < MAX_FILL_SCAN; scanned += 1) {
      const next = column + step;
      if (next < 0 || next >= columns.length) return column;
      if ((backgrounds.get(next) ?? null) !== own) return column;
      if (ruleBetween(direction === "after" ? column : next)) return column;
      column = next;
    }
    return column;
  };
  for (const cell of row.cells) {
    const { mode, forcedClip } = resolveTextMode(cell);
    const align = resolveAlignment(cell, grid.rightToLeft);
    let before = 0;
    let after = 0;
    if (mode === "overflow" && cell.display.length + cell.source.length > 0) {
      blockers ??= rowBlockers(row, grid.merges);
      const free = (direction: "before" | "after") =>
        freeExtent(
          columns,
          blockers!,
          cell,
          grid.frozenColumnCount,
          direction,
          reachLimit(cell, direction),
        );
      // Left-aligned text runs off the physical right edge and vice versa;
      // column index grows to the right in LTR and to the left in RTL.
      const rightIsAfter = !grid.rightToLeft;
      if (align === "center") {
        const symmetric = Math.min(free("before"), free("after"));
        before = symmetric;
        after = symmetric;
      } else if (align === "left") {
        if (rightIsAfter) after = free("after");
        else before = free("before");
      } else if (align === "right") {
        if (rightIsAfter) before = free("before");
        else after = free("after");
      }
    }
    layouts.set(cell.columnIndex, { mode, forcedClip, align, before, after });
  }
  return layouts;
}

/** Conservative upper bound on the rendered width of one text, in px. */
export function estimateTextExtent(
  text: string,
  fontSizePoints: number | null,
  indent: number,
): number {
  const fontPx = ((fontSizePoints ?? 10) * 96) / 72;
  let longest = 0;
  for (const line of text.split("\n")) {
    longest = Math.max(longest, [...line].length);
  }
  // One em per character bounds every common font, including full-width CJK.
  return longest * fontPx + indent * 3 * fontPx;
}

/**
 * Inline-offset interval an overflowing text can paint into, or null when it
 * stays inside its cell (no mounting required beyond the cell itself).
 */
export function overflowPaintInterval(
  layout: CellTextLayout,
  cellStart: number,
  cellWidth: number,
  textExtent: number,
  paddingStart: number,
  paddingEnd: number,
): [number, number] | null {
  if (layout.mode !== "overflow" || (layout.before === 0 && layout.after === 0))
    return null;
  const total = layout.before + cellWidth + layout.after;
  const used = Math.min(total, textExtent + paddingStart + paddingEnd);
  const corridorStart = cellStart - layout.before;
  if (layout.align === "left" || layout.align === "right") {
    // Alignment names are physical; the corridor already lies on one side.
    return layout.before > 0
      ? [cellStart + cellWidth - used, cellStart + cellWidth]
      : [cellStart, cellStart + used];
  }
  const center = corridorStart + total / 2;
  return [center - used / 2, center + used / 2];
}
