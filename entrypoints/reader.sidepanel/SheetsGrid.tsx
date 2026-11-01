import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import {
  MAX_SOURCE_DIMENSION_PIXEL_SIZE,
  WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE,
  type WorkspaceSheetCell,
  type WorkspaceSheetCellStyle,
  type WorkspaceSheetGrid,
  type WorkspaceSheetMerge,
  type WorkspaceSheetPage,
  type WorkspaceSheetRow,
} from "@/lib/google-workspace-reader";
import {
  MAX_OVERFLOW_ORIGIN_COLUMNS,
  computeRowTextLayouts,
  estimateTextExtent,
  overflowPaintInterval,
  type CellTextLayout,
} from "@/lib/spreadsheet-layout";
import {
  boundBlockToSource,
  cellContentHeight,
  fitCellText,
} from "@/lib/spreadsheet-autofit";
import {
  originalSegments,
  translatedSegments,
} from "@/lib/spreadsheet-rich-text";
import { readerMessages } from "@/lib/i18n/catalog/reader";
import { useMessages } from "@/lib/i18n/react";

const ROW_HEADER_WIDTH = 44;
const MIN_VIEW_COLUMNS = 26;

function decorationOf(style: {
  underline: boolean;
  strikethrough: boolean;
}): string | undefined {
  return (
    [style.underline && "underline", style.strikethrough && "line-through"]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
/** Above scrolling rows and below the column header (z-index 30). */
const FROZEN_ROW_Z_BASE = 4;
const NO_MERGES: readonly WorkspaceSheetMerge[] = [];
const NO_IDS: ReadonlySet<string> = new Set();
/** Stagger between neighboring columns of a revealed batch, and its cap. */
const REVEAL_STAGGER_MS = 24;
const REVEAL_STAGGER_MAX_MS = 240;

interface MeasuredLayout {
  readonly heights: ReadonlyMap<string, number>;
  readonly wrap: ReadonlySet<string>;
}
const EMPTY_MEASURED: MeasuredLayout = { heights: new Map(), wrap: new Set() };
const OVERSCAN_COLUMNS = 2;

type Presentation = "original" | "translation";

interface SheetsGridSelection {
  rowIndex: number;
  columnIndex: number;
}

interface SheetsGridProps {
  grid: WorkspaceSheetGrid;
  pages: readonly WorkspaceSheetPage[];
  translations: ReadonlyMap<string, string>;
  presentation: Presentation;
  includeNextViewport?: boolean;
  onNearPageEnd: (startRow?: number) => void;
  onViewportRecordsChange: (recordIds: string[]) => void;
}

interface ColumnMetric {
  index: number;
  width: number;
  offset: number;
  hidden: boolean;
}

interface MergeGeometry {
  width: number;
  height: number;
  vertical: boolean;
}

type CellVariables = CSSProperties & {
  "--sheet-cell-background": string;
  "--sheet-cell-color": string;
  "--sheet-border-top": string;
  "--sheet-border-right": string;
  "--sheet-border-bottom": string;
  "--sheet-border-left": string;
};

function columnName(index: number) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

// Source sizes are kept exact; the ceiling only bounds untrusted geometry.
function sourceDimension(pixelSize: number, fallback: number) {
  const size =
    Number.isFinite(pixelSize) && pixelSize > 0 ? pixelSize : fallback;
  return Math.min(MAX_SOURCE_DIMENSION_PIXEL_SIZE, Math.max(1, size));
}

function cellDisplay(cell: WorkspaceSheetCell | null) {
  if (!cell) return "";
  return cell.kind === "formula" ? cell.display : cell.source || cell.display;
}

function readableColors(background: string | null, color: string | null) {
  const safeBackground = background ?? "#ffffff";
  const luminance = (value: string) => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
    if (!match) return null;
    const channels = match.slice(1).map((channel) => {
      const normalized = Number.parseInt(channel, 16) / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (
      channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    );
  };
  const backgroundLuminance = luminance(safeBackground);
  if (color && luminance(color) !== null)
    return { background: safeBackground, color };
  return {
    background: safeBackground,
    color:
      backgroundLuminance !== null && backgroundLuminance < 0.18
        ? "#ffffff"
        : "#0f172a",
  };
}

function cellVariables(style: WorkspaceSheetCellStyle): CellVariables {
  const colors = readableColors(style.background, style.color);
  // A filled cell paints over the gridline, so runs of equally filled cells
  // read as one block; only explicit borders stay visible.
  const gridline = style.background ? colors.background : "#e2e8f0";
  return {
    "--sheet-cell-background": colors.background,
    "--sheet-cell-color": colors.color,
    "--sheet-border-top": style.borders.top ?? gridline,
    "--sheet-border-right": style.borders.right ?? gridline,
    "--sheet-border-bottom": style.borders.bottom ?? gridline,
    "--sheet-border-left": style.borders.left ?? gridline,
    borderTopStyle: style.borderLines.top?.style ?? "solid",
    borderRightStyle: style.borderLines.right?.style ?? "solid",
    borderBottomStyle: style.borderLines.bottom?.style ?? "solid",
    borderLeftStyle: style.borderLines.left?.style ?? "solid",
    borderTopWidth: `${style.borderLines.top?.width ?? 1}px`,
    borderRightWidth: `${style.borderLines.right?.width ?? 1}px`,
    borderBottomWidth: `${style.borderLines.bottom?.width ?? 1}px`,
    borderLeftWidth: `${style.borderLines.left?.width ?? 1}px`,
  };
}

function SheetsGrid({
  grid,
  pages,
  translations,
  presentation,
  includeNextViewport = true,
  onNearPageEnd,
  onViewportRecordsChange,
}: SheetsGridProps) {
  const t = useMessages(readerMessages);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({
    width: 640,
    height: 480,
    firstColumn: 0,
    lastColumn: 6,
    top: 0,
  });
  const [focused, setFocused] = useState<{ row: number; column: number }>();
  const [selected, setSelected] = useState<SheetsGridSelection>();
  const scrollFrame = useRef<number | undefined>(undefined);
  const lastPageScroll = useRef<number | undefined>(undefined);
  const lastViewportRecordIds = useRef<readonly string[]>([]);
  // Browser-measured truth, collected after layout: per-cell content height
  // and the cells whose text overflows their paint box and must wrap. Both only
  // ever describe what the real fonts need, so they correct the canvas estimate.
  const [measured, setMeasured] = useState<MeasuredLayout>(EMPTY_MEASURED);
  // Cells already measured for their current texts and wrap decision; scrolling
  // must not re-measure them.
  const measuredSignatures = useRef(new Map<string, string>());
  // Presentation-only motion (ui-enhancement Decision 7). Translations that
  // arrived in the latest update settle from indigo into the cell's ink, and
  // toggling Translation/Original crossfades the sheet. Both are opacity and
  // color only and never feed measurement or geometry.
  const [motion, setMotion] = useState(() => ({
    translations,
    presentation,
    revealed: NO_IDS,
    toggled: false,
  }));
  if (
    motion.translations !== translations ||
    motion.presentation !== presentation
  ) {
    const revealed = new Set<string>();
    if (motion.presentation === presentation)
      for (const [id, text] of translations)
        if (motion.translations.get(id) !== text) revealed.add(id);
    setMotion({
      translations,
      presentation,
      revealed,
      toggled: motion.toggled || motion.presentation !== presentation,
    });
  }
  const revealed =
    motion.translations === translations && motion.presentation === presentation
      ? motion.revealed
      : NO_IDS;

  const columns = useMemo(() => {
    const metrics: ColumnMetric[] = [];
    let offset = 0;
    for (const column of grid.columns) {
      const width = column.hidden
        ? 0
        : sourceDimension(column.pixelSize, grid.defaultColumnPixelSize);
      metrics.push({
        index: column.index,
        width,
        offset,
        hidden: column.hidden,
      });
      offset += width;
    }
    // Google Sheets always shows a minimum number of columns. Text that runs
    // past the last used column (a long URL in column A) needs the empty
    // columns beside it, so the view pads with default-width blanks.
    while (metrics.length < MIN_VIEW_COLUMNS) {
      const width = sourceDimension(
        grid.defaultColumnPixelSize,
        WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE,
      );
      metrics.push({
        index: metrics.length,
        width,
        offset,
        hidden: false,
      });
      offset += width;
    }
    return { metrics, totalWidth: offset };
  }, [grid.columns, grid.defaultColumnPixelSize]);

  const allRows = useMemo(
    () =>
      pages
        .flatMap((page) => page.rows)
        .toSorted((left, right) => left.index - right.index),
    [pages],
  );
  const rows = useMemo(() => allRows.filter((row) => !row.hidden), [allRows]);
  const pageStarts = useMemo(
    () => new Set(pages.map(({ startRow }) => startRow)),
    [pages],
  );

  const rowLayouts = useMemo(() => {
    const layouts = new Map<number, ReadonlyMap<number, CellTextLayout>>();
    for (const row of rows) {
      const computed = new Map(
        computeRowTextLayouts(row, grid, columns.metrics),
      );
      for (const cell of row.cells) {
        const layout = computed.get(cell.columnIndex);
        if (layout)
          computed.set(
            cell.columnIndex,
            boundBlockToSource(
              cell,
              layout,
              columns.metrics[cell.columnIndex]?.width ?? 0,
              cellDisplay(cell),
            ),
          );
      }
      layouts.set(row.index, computed);
    }
    return layouts;
  }, [columns.metrics, grid, rows]);

  // Row geometry: source heights, grown (never shrunk) so every source and
  // translated text of a single-row cell is fully visible. Using both texts
  // keeps Original and Translation on one geometry; column widths never move.
  // Canvas estimates are per cell and only change with the cell's own texts or
  // corridor, so scrolling and measurement passes never recompute them.
  const [estimates] = useState(
    () => new Map<string, { key: string; height: number }>(),
  );
  const rowGeometry = useMemo(() => {
    const fallback = grid.defaultRowPixelSize;
    const offsets = new Map<number, number>();
    const heights = new Map<number, number>();
    const spanRequirements: { cell: WorkspaceSheetCell; height: number }[] = [];
    for (const row of allRows) {
      let contentHeight = 0;
      if (!row.hidden)
        for (const cell of row.cells) {
          const browserHeight = measured.heights.get(cell.id);
          if (browserHeight !== undefined) {
            if (cell.rowSpan > 1)
              spanRequirements.push({ cell, height: browserHeight });
            else contentHeight = Math.max(contentHeight, browserHeight);
            continue;
          }
          // Cells the browser has not measured yet use the canvas estimate.
          const layout = rowLayouts.get(row.index)?.get(cell.columnIndex);
          const translated = translations.get(cell.id);
          const key = `${layout?.mode}|${layout?.before}|${layout?.after}|${translated ?? ""}`;
          let estimate = estimates.get(cell.id);
          if (estimate?.key !== key) {
            estimate = {
              key,
              height: cellContentHeight(cell, columns.metrics, layout, [
                cellDisplay(cell),
                translated,
              ]),
            };
            estimates.set(cell.id, estimate);
          }
          if (cell.rowSpan > 1)
            spanRequirements.push({ cell, height: estimate.height });
          else contentHeight = Math.max(contentHeight, estimate.height);
        }
      const height = row.hidden
        ? 0
        : sourceDimension(Math.max(row.pixelSize, contentHeight), fallback);
      heights.set(row.index, height);
    }
    // Reserve only the missing span height, in its last visible loaded row.
    // Later overlapping spans see earlier growth; final prefix offsets are the
    // sole source of merge, frozen-row and scroll geometry.
    for (const { cell, height } of spanRequirements) {
      let available = 0;
      let lastVisible: number | undefined;
      for (
        let index = cell.rowIndex;
        index < cell.rowIndex + cell.rowSpan;
        index += 1
      ) {
        const rowHeight = heights.get(index) ?? fallback;
        available += rowHeight;
        if (heights.has(index) && rowHeight > 0) lastVisible = index;
      }
      if (lastVisible !== undefined && height > available)
        heights.set(
          lastVisible,
          heights.get(lastVisible)! + height - available,
        );
    }
    let offset = 0;
    let previous = -1;
    for (const row of allRows) {
      offset += Math.max(0, row.index - previous - 1) * fallback;
      offsets.set(row.index, offset);
      offset += heights.get(row.index)!;
      previous = row.index;
    }
    // Prefix sums of how far each loaded row departs from the default height,
    // so a row offset is a binary search instead of a scan of every row.
    const loaded = allRows.map((row) => row.index);
    const extra: number[] = [0];
    for (const row of allRows)
      extra.push(
        extra.at(-1)! + (heights.get(row.index) ?? fallback) - fallback,
      );
    const offsetAt = (rowIndex: number) => {
      let low = 0;
      let high = loaded.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (loaded[middle]! < rowIndex) low = middle + 1;
        else high = middle;
      }
      return rowIndex * fallback + extra[low]!;
    };
    return {
      offsets,
      heights,
      offsetAt,
      totalHeight:
        offset + Math.max(0, grid.rowCount - previous - 1) * fallback,
    };
  }, [
    allRows,
    columns.metrics,
    grid.defaultRowPixelSize,
    grid.rowCount,
    estimates,
    measured.heights,
    rowLayouts,
    translations,
  ]);

  const mergeGeometries = useMemo(() => {
    const geometries = new Map<string, MergeGeometry>();
    for (const merge of grid.merges) {
      const startColumn = columns.metrics[merge.startColumn];
      const endOffset =
        columns.metrics[merge.endColumn]?.offset ?? columns.totalWidth;
      if (!startColumn) continue;
      geometries.set(`${merge.startRow}:${merge.startColumn}`, {
        width: endOffset - startColumn.offset,
        height:
          rowGeometry.offsetAt(merge.endRow) -
          rowGeometry.offsetAt(merge.startRow),
        vertical: merge.endRow - merge.startRow > 1,
      });
    }
    return geometries;
  }, [columns, grid.merges, rowGeometry]);

  // Merges indexed by every row they cover: a cell resolves its merge from
  // its own row instead of scanning every merge of the sheet.
  const mergesByRow = useMemo(() => {
    const byRow = new Map<number, WorkspaceSheetMerge[]>();
    for (const merge of grid.merges)
      for (let index = merge.startRow; index < merge.endRow; index += 1) {
        const list = byRow.get(index);
        if (list) list.push(merge);
        else byRow.set(index, [merge]);
      }
    return byRow;
  }, [grid.merges]);

  const cellMap = useMemo(() => {
    const cells = new Map<string, WorkspaceSheetCell>();
    for (const row of rows) {
      for (const cell of row.cells) {
        cells.set(`${cell.rowIndex}:${cell.columnIndex}`, cell);
      }
    }
    return cells;
  }, [rows]);
  const residentRowIndexes = useMemo(
    () => new Set(rows.map(({ index }) => index)),
    [rows],
  );

  const visibleColumns = useMemo(
    () => columns.metrics.filter((column) => !column.hidden),
    [columns.metrics],
  );

  // Overflowing text belongs to its origin cell even when that cell's column
  // is scrolled out: keep the nearest bounded set of origins whose paint
  // corridor still intersects the viewport mounted.
  const overflowOrigins = useMemo(() => {
    const first = visibleColumns[viewport.firstColumn];
    const last = visibleColumns[viewport.lastColumn];
    if (!first || !last) return [] as number[];
    const viewStart = first.offset;
    const viewEnd = last.offset + last.width;
    const distances = new Map<number, number>();
    for (const row of rows) {
      const layouts = rowLayouts.get(row.index);
      for (const cell of row.cells) {
        const layout = layouts?.get(cell.columnIndex);
        const column = columns.metrics[cell.columnIndex];
        if (
          !layout ||
          !column ||
          layout.mode !== "overflow" ||
          (layout.before === 0 && layout.after === 0)
        )
          continue;
        const text =
          presentation === "translation"
            ? (translations.get(cell.id) ?? cellDisplay(cell))
            : cellDisplay(cell);
        if (!text) continue;
        const interval = overflowPaintInterval(
          layout,
          column.offset,
          column.width,
          estimateTextExtent(text, cell.style.fontSize, cell.style.indent),
          cell.style.padding.left,
          cell.style.padding.right,
        );
        if (!interval || interval[1] <= viewStart || interval[0] >= viewEnd)
          continue;
        const distance = Math.max(
          0,
          viewStart - column.offset,
          column.offset - viewEnd,
        );
        const previous = distances.get(cell.columnIndex);
        if (previous === undefined || distance < previous)
          distances.set(cell.columnIndex, distance);
      }
    }
    return [...distances]
      .toSorted((left, right) => left[1] - right[1] || left[0] - right[0])
      .slice(0, MAX_OVERFLOW_ORIGIN_COLUMNS)
      .map(([index]) => index);
  }, [
    columns.metrics,
    presentation,
    rowLayouts,
    rows,
    translations,
    viewport.firstColumn,
    viewport.lastColumn,
    visibleColumns,
  ]);

  const mountedColumns = useMemo(() => {
    if (!visibleColumns.length) return [];
    const first = viewport.firstColumn;
    const last = viewport.lastColumn;
    const mounted = new Set<number>();
    for (
      let index = Math.max(0, first - OVERSCAN_COLUMNS);
      index <= Math.min(visibleColumns.length - 1, last + OVERSCAN_COLUMNS);
      index += 1
    ) {
      mounted.add(visibleColumns[index]!.index);
    }
    for (const column of visibleColumns) {
      if (column.index < grid.frozenColumnCount) mounted.add(column.index);
    }
    for (const index of overflowOrigins) mounted.add(index);
    if (selected) mounted.add(selected.columnIndex);
    for (const merge of grid.merges) {
      for (
        let column = merge.startColumn;
        column < merge.endColumn;
        column += 1
      ) {
        if (mounted.has(column)) mounted.add(merge.startColumn);
      }
    }
    return columns.metrics.filter((column) => mounted.has(column.index));
  }, [
    columns.metrics,
    grid,
    overflowOrigins,
    selected,
    viewport.firstColumn,
    viewport.lastColumn,
    visibleColumns,
  ]);

  const mountedColumnIndexes = useMemo(
    () => new Set(mountedColumns.map(({ index }) => index)),
    [mountedColumns],
  );
  const viewportColumnIndexes = useMemo(() => {
    const indexes = new Set(
      visibleColumns
        .filter(
          (column, index) =>
            column.index < grid.frozenColumnCount ||
            (index >= viewport.firstColumn && index <= viewport.lastColumn),
        )
        .map(({ index }) => index),
    );
    // Visible overflow text still belongs to (and is translated with) its origin.
    for (const index of overflowOrigins) indexes.add(index);
    return indexes;
  }, [
    grid.frozenColumnCount,
    overflowOrigins,
    viewport.firstColumn,
    viewport.lastColumn,
    visibleColumns,
  ]);
  const mountedHiddenColumns = useMemo(() => {
    return columns.metrics.filter(
      ({ hidden, index }) =>
        hidden &&
        (index < grid.frozenColumnCount ||
          mountedColumnIndexes.has(index - 1) ||
          mountedColumnIndexes.has(index + 1)),
    );
  }, [columns.metrics, grid.frozenColumnCount, mountedColumnIndexes]);

  const templateColumns = useMemo(
    () => columns.metrics.map(({ width }) => `${width}px`).join(" "),
    [columns.metrics],
  );

  const selectCell = useCallback((rowIndex: number, columnIndex: number) => {
    const selection: SheetsGridSelection = {
      rowIndex,
      columnIndex,
    };
    setFocused({ row: rowIndex, column: columnIndex });
    setSelected(selection);
  }, []);

  const updateViewport = useCallback(
    (element: HTMLDivElement) => {
      const left = Math.abs(element.scrollLeft);
      element.style.setProperty("--sheet-scroll-inline", `${left}px`);
      const width = element.clientWidth || 640;
      const start = Math.max(0, left - ROW_HEADER_WIDTH);
      const end = Math.max(start + 1, left + width - ROW_HEADER_WIDTH);
      const firstColumn = Math.max(
        0,
        visibleColumns.findIndex(
          (column) => column.offset + column.width > start,
        ),
      );
      let lastColumn = firstColumn;
      while (
        lastColumn + 1 < visibleColumns.length &&
        visibleColumns[lastColumn + 1]!.offset < end
      )
        lastColumn += 1;
      const next = {
        width,
        height: element.clientHeight || 480,
        firstColumn,
        lastColumn,
        top: element.scrollTop,
      };
      setViewport((current) =>
        Object.keys(next).every(
          (key) =>
            current[key as keyof typeof next] ===
            next[key as keyof typeof next],
        )
          ? current
          : next,
      );
    },
    [visibleColumns],
  );

  const handleCellKeyDown = useCallback(
    (
      event: KeyboardEvent<HTMLDivElement>,
      rowIndex: number,
      columnIndex: number,
    ) => {
      if (
        ![
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      event.preventDefault();
      const mergeAt = (row: number, column: number) =>
        mergesByRow
          .get(row)
          ?.find(
            (merge) => column >= merge.startColumn && column < merge.endColumn,
          );
      const currentMerge = mergeAt(rowIndex, columnIndex);
      const currentRow = rows.findIndex(({ index }) => index === rowIndex);
      const currentColumn = visibleColumns.findIndex(
        ({ index }) => index === columnIndex,
      );
      let targetRow = rowIndex;
      let targetColumn = columnIndex;
      if (event.key === "ArrowDown")
        targetRow =
          rows.find(
            ({ index }) => index >= (currentMerge?.endRow ?? rowIndex + 1),
          )?.index ?? rowIndex;
      else if (event.key === "ArrowUp")
        targetRow = rows[Math.max(0, currentRow - 1)]?.index ?? rowIndex;
      else if (event.key === (grid.rightToLeft ? "ArrowLeft" : "ArrowRight"))
        targetColumn =
          visibleColumns.find(
            ({ index }) =>
              index >= (currentMerge?.endColumn ?? columnIndex + 1),
          )?.index ?? columnIndex;
      else if (event.key === (grid.rightToLeft ? "ArrowRight" : "ArrowLeft"))
        targetColumn =
          visibleColumns[Math.max(0, currentColumn - 1)]?.index ?? columnIndex;
      else
        targetColumn =
          (event.key === "Home" ? visibleColumns[0] : visibleColumns.at(-1))
            ?.index ?? columnIndex;
      const destinationMerge = mergeAt(targetRow, targetColumn);
      if (destinationMerge) {
        targetRow = destinationMerge.startRow;
        targetColumn = destinationMerge.startColumn;
      }
      if (
        !residentRowIndexes.has(targetRow) ||
        columns.metrics[targetColumn]?.hidden
      )
        return;
      selectCell(targetRow, targetColumn);
      const root = viewportRef.current;
      const column = columns.metrics[targetColumn];
      if (root && column) {
        const frozenWidth =
          ROW_HEADER_WIDTH +
          columns.metrics
            .filter(({ index }) => index < grid.frozenColumnCount)
            .reduce((sum, { width }) => sum + width, 0);
        const left = Math.abs(root.scrollLeft);
        const width = root.clientWidth || 640;
        if (targetColumn >= grid.frozenColumnCount) {
          const start = ROW_HEADER_WIDTH + column.offset;
          const end = start + column.width;
          let nextLeft = left;
          if (start < left + frozenWidth)
            nextLeft = Math.max(0, start - frozenWidth);
          else if (end > left + width) nextLeft = Math.max(0, end - width);
          root.scrollLeft = grid.rightToLeft ? -nextLeft : nextLeft;
        }
        if (targetRow >= grid.frozenRowCount) {
          const top = rowGeometry.offsetAt(targetRow) + 28;
          const bottom =
            top +
            (rowGeometry.heights.get(targetRow) ?? grid.defaultRowPixelSize);
          const frozenHeight = 28 + rowGeometry.offsetAt(grid.frozenRowCount);
          if (top < root.scrollTop + frozenHeight)
            root.scrollTop = Math.max(0, top - frozenHeight);
          else if (bottom > root.scrollTop + (root.clientHeight || 480))
            root.scrollTop = Math.max(0, bottom - (root.clientHeight || 480));
        }
        updateViewport(root);
      }
      requestAnimationFrame(() =>
        viewportRef.current
          ?.querySelector<HTMLElement>(
            `[data-cell-address="${columnName(targetColumn)}${targetRow + 1}"]`,
          )
          ?.focus({ preventScroll: true }),
      );
    },
    [
      columns.metrics,
      grid.defaultRowPixelSize,
      grid.frozenColumnCount,
      grid.frozenRowCount,
      grid.rightToLeft,
      mergesByRow,
      residentRowIndexes,
      rowGeometry,
      rows,
      selectCell,
      updateViewport,
      visibleColumns,
    ],
  );

  const processScroll = useCallback(
    (element: HTMLDivElement) => {
      updateViewport(element);
      if (lastPageScroll.current === element.scrollTop) return;
      lastPageScroll.current = element.scrollTop;
      if (grid.columns.length === 0) return;
      let firstVisibleRow: number | undefined;
      let lastVisibleRow: number | undefined;
      const viewportRect = element.getBoundingClientRect();
      for (const row of element.querySelectorAll<HTMLElement>(
        "[data-sheet-row-index]",
      )) {
        const index = Number(row.dataset.sheetRowIndex);
        if (index < grid.frozenRowCount) continue;
        const rowRect = row.getBoundingClientRect();
        if (
          rowRect.height > 0 &&
          rowRect.bottom > viewportRect.top &&
          rowRect.top < viewportRect.bottom
        ) {
          firstVisibleRow ??= index;
          lastVisibleRow = index;
        }
      }
      firstVisibleRow ??= Math.floor(
        element.scrollTop / grid.defaultRowPixelSize,
      );
      const viewportBottom =
        element.scrollTop + Math.max(1, element.clientHeight);
      lastVisibleRow ??= Math.min(
        grid.rowCount - 1,
        Math.floor(viewportBottom / grid.defaultRowPixelSize),
      );
      const visiblePageStart = Math.floor(firstVisibleRow / 100) * 100;
      if (!pageStarts.has(visiblePageStart)) {
        onNearPageEnd(visiblePageStart);
        return;
      }
      const page = pages.find(
        ({ startRow, rowCount }) =>
          firstVisibleRow >= startRow && firstVisibleRow < startRow + rowCount,
      );
      if (
        page?.cursor?.kind === "sheets" &&
        lastVisibleRow >= page.startRow + page.rowCount - 20
      )
        onNearPageEnd(page.cursor.nextRow);
    },
    [
      grid.defaultRowPixelSize,
      grid.frozenRowCount,
      grid.rowCount,
      grid.columns.length,
      onNearPageEnd,
      pageStarts,
      pages,
      updateViewport,
    ],
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      // Coalesce events in one frame; only column-boundary changes rerender rows.
      if (scrollFrame.current !== undefined) return;
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = undefined;
        processScroll(element);
      });
    },
    [processScroll],
  );
  useEffect(
    () => () => {
      if (scrollFrame.current !== undefined)
        cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => updateViewport(element);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateViewport]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const viewportRect = element.getBoundingClientRect();
    const viewportHeight = Math.max(
      1,
      viewportRect.height || element.clientHeight || viewport.height,
    );
    const bottom =
      viewportRect.bottom + (includeNextViewport ? viewportHeight : 0);
    const rowsByIndex = new Map(rows.map((row) => [row.index, row]));
    const records: { row: number; column: number; id: string }[] = [];
    let measured = false;
    for (const rowElement of element.querySelectorAll<HTMLElement>(
      "[data-sheet-row-index]",
    )) {
      const row = rowsByIndex.get(Number(rowElement.dataset.sheetRowIndex));
      if (!row) continue;
      const rect = rowElement.getBoundingClientRect();
      if (rect.height <= 0) continue;
      measured = true;
      if (rect.bottom <= viewportRect.top || rect.top >= bottom) continue;
      for (const cell of row.cells) {
        if (
          cell.translatable &&
          Array.from(
            { length: Math.max(1, cell.columnSpan) },
            (_, index) => cell.columnIndex + index,
          ).some((columnIndex) => viewportColumnIndexes.has(columnIndex))
        ) {
          records.push({
            row: cell.rowIndex,
            column: cell.columnIndex,
            id: cell.id,
          });
        }
      }
    }
    if (!measured) {
      const fallbackBottom =
        viewport.top + viewport.height * (includeNextViewport ? 2 : 1);
      for (const row of rows) {
        const top = rowGeometry.offsets.get(row.index) ?? 0;
        const height =
          rowGeometry.heights.get(row.index) ?? grid.defaultRowPixelSize;
        if (top + height < viewport.top || top > fallbackBottom) continue;
        for (const cell of row.cells) {
          if (
            cell.translatable &&
            Array.from(
              { length: Math.max(1, cell.columnSpan) },
              (_, index) => cell.columnIndex + index,
            ).some((columnIndex) => viewportColumnIndexes.has(columnIndex))
          )
            records.push({
              row: cell.rowIndex,
              column: cell.columnIndex,
              id: cell.id,
            });
        }
      }
    }
    records.sort(
      (left, right) => left.row - right.row || left.column - right.column,
    );
    const nextRecordIds = [...new Set(records.map(({ id }) => id))];
    if (
      nextRecordIds.length === lastViewportRecordIds.current.length &&
      nextRecordIds.every(
        (recordId, index) => recordId === lastViewportRecordIds.current[index],
      )
    )
      return;
    lastViewportRecordIds.current = nextRecordIds;
    onViewportRecordsChange(nextRecordIds);
  }, [
    onViewportRecordsChange,
    grid.defaultRowPixelSize,
    includeNextViewport,
    rowGeometry,
    rows,
    presentation,
    translations,
    viewport.height,
    viewportColumnIndexes,
    viewport.top,
  ]);

  // Row windowing: mount only rows intersecting the viewport plus one
  // viewport behind and two ahead (the translation lookahead), the frozen
  // rows, and the selected row so keyboard focus survives scrolling. Rows
  // outside the window are replaced by the existing spacer geometry.
  const renderedRows = useMemo(() => {
    const span = Math.max(viewport.height, 320);
    const start = viewport.top - span;
    const end = viewport.top + viewport.height + span * 2;
    return rows.filter((row) => {
      if (row.index < grid.frozenRowCount || row.index === selected?.rowIndex)
        return true;
      const top = rowGeometry.offsets.get(row.index) ?? 0;
      const height =
        rowGeometry.heights.get(row.index) ?? grid.defaultRowPixelSize;
      const spanHeight = Math.max(
        height,
        ...(mergesByRow.get(row.index) ?? [])
          .filter((merge) => merge.startRow === row.index)
          .map(
            (merge) =>
              mergeGeometries.get(`${merge.startRow}:${merge.startColumn}`)
                ?.height ?? 0,
          ),
      );
      return top + spanHeight >= start && top <= end;
    });
  }, [
    grid.defaultRowPixelSize,
    grid.frozenRowCount,
    mergeGeometries,
    mergesByRow,
    rowGeometry,
    rows,
    selected?.rowIndex,
    viewport.height,
    viewport.top,
  ]);

  // Measure the mounted text layers in the real browser (fonts, line boxes
  // and diacritics differ from any canvas estimate) before paint. Every cell is
  // measured with both its source and translated text so Original and
  // Translation share one geometry. Results only add wrap decisions and
  // content heights, so the layout converges after at most a few passes.
  useLayoutEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const byId = new Map<string, WorkspaceSheetCell>();
    for (const row of renderedRows)
      for (const cell of row.cells) byId.set(cell.id, cell);
    interface Probe {
      id: string;
      layer: HTMLElement;
      alternate?: HTMLElement;
    }
    const probes: Probe[] = [];
    const pendingSignatures = new Map<string, string>();
    for (const layer of root.querySelectorAll<HTMLElement>(
      ".sheets-grid-cell > .sheets-cell-text-layer",
    )) {
      const cellElement = layer.parentElement!;
      const id = cellElement.dataset.cellId;
      const cell = id ? byId.get(id) : undefined;
      if (!id || !cell) continue;
      const source = cellDisplay(cell);
      const translated = translations.get(id) ?? source;
      const signature = `${measured.wrap.has(id) ? 1 : 0}|${source}|${translated}`;
      if (measuredSignatures.current.get(id) === signature) continue;
      pendingSignatures.set(id, signature);
      const other = presentation === "translation" ? source : translated;
      const shown = layer.querySelector<HTMLElement>(".sheets-cell-text");
      let alternate: HTMLElement | undefined;
      if (shown && other && other !== shown.textContent) {
        alternate = layer.cloneNode(true) as HTMLElement;
        alternate.style.visibility = "hidden";
        alternate.setAttribute("aria-hidden", "true");
        alternate.removeAttribute("data-cell-id");
        const text = alternate.querySelector<HTMLElement>(".sheets-cell-text");
        if (text) text.textContent = other;
        cellElement.appendChild(alternate);
      }
      probes.push({ id, layer, alternate });
    }
    const heights = new Map(measured.heights);
    const wrap = new Set(measured.wrap);
    let changed = false;
    const readLayer = (layer: HTMLElement) => {
      const text = layer.querySelector<HTMLElement>(".sheets-cell-text");
      // No layout box (detached or display: none): nothing to trust.
      if (!text || text.offsetHeight === 0)
        return { height: 0, overflows: false };
      const computed = getComputedStyle(layer);
      const padX =
        (Number.parseFloat(computed.paddingLeft) || 0) +
        (Number.parseFloat(computed.paddingRight) || 0);
      const padY =
        (Number.parseFloat(computed.paddingTop) || 0) +
        (Number.parseFloat(computed.paddingBottom) || 0);
      const corridor =
        (Number(layer.dataset.before) || 0) +
        (Number(layer.dataset.after) || 0);
      const capacity = layer.clientWidth - padX + corridor;
      return {
        // Two 1px cell borders sit between the row box and the text layer.
        height: Math.ceil(text.offsetHeight + padY) + 2,
        overflows:
          layer.dataset.wrappable === "true" &&
          capacity > 0 &&
          text.offsetWidth > capacity + 0.5,
      };
    };
    const readings = probes.map(({ id, layer, alternate }) => ({
      id,
      shown: readLayer(layer),
      other: alternate ? readLayer(alternate) : undefined,
    }));
    for (const { alternate } of probes) alternate?.remove();
    for (const { id, shown, other } of readings) {
      // Only a measured (laid out) cell is done; hidden panels measure later.
      if (shown.height > 0)
        measuredSignatures.current.set(id, pendingSignatures.get(id)!);
      if (shown.overflows || other?.overflows) {
        if (!wrap.has(id)) {
          wrap.add(id);
          changed = true;
        }
      }
      // Heights are only trusted once the cell is in its final wrap mode.
      const height = Math.max(shown.height, other?.height ?? 0);
      if (height > 1 && Math.abs((heights.get(id) ?? 0) - height) > 0.5) {
        heights.set(id, height);
        changed = true;
      }
    }
    if (changed) setMeasured({ heights, wrap });
  }, [measured, presentation, renderedRows, translations]);

  const gridRowStyle = useMemo(
    () =>
      ({
        gridTemplateColumns: templateColumns,
        minWidth: `${ROW_HEADER_WIDTH + columns.totalWidth}px`,
        paddingInlineStart: `${ROW_HEADER_WIDTH}px`,
      }) satisfies CSSProperties,
    [columns.totalWidth, templateColumns],
  );

  const firstMounted = mountedColumns[0]?.index;
  const residentSelected =
    selected &&
    (residentRowIndexes.size === 0 || residentRowIndexes.has(selected.rowIndex))
      ? selected
      : undefined;
  const residentFocused =
    focused &&
    (residentRowIndexes.size === 0 || residentRowIndexes.has(focused.row))
      ? focused
      : undefined;
  const selectedCell = residentSelected
    ? (cellMap.get(
        `${residentSelected.rowIndex}:${residentSelected.columnIndex}`,
      ) ?? null)
    : null;
  const selectedAddress = residentSelected
    ? `${columnName(residentSelected.columnIndex)}${residentSelected.rowIndex + 1}`
    : "";

  return (
    <div className="sheets-grid-layout">
      <div
        ref={viewportRef}
        className={
          grid.hideGridlines
            ? "sheets-grid-viewport hide-gridlines"
            : "sheets-grid-viewport"
        }
        dir={grid.rightToLeft ? "rtl" : "ltr"}
        onScroll={handleScroll}
      >
        <div
          className="sheets-grid"
          data-presentation={motion.toggled ? presentation : undefined}
          role="grid"
          dir={grid.rightToLeft ? "rtl" : "ltr"}
          aria-label={t.t("reader.grid.sheet", { title: grid.title })}
          aria-colcount={grid.lastUsedColumn + 2}
          aria-rowcount={grid.rowCount + 1}
        >
          <div className="sheets-grid-header" role="row" style={gridRowStyle}>
            <div
              className="sheets-grid-corner"
              role="columnheader"
              aria-label={t.t("reader.grid.rowNumbers")}
            />
            {mountedColumns.map((column) => (
              <div
                key={column.index}
                className={
                  column.index < grid.frozenColumnCount
                    ? "sheets-column-header frozen"
                    : "sheets-column-header"
                }
                role="columnheader"
                aria-colindex={column.index + 2}
                style={{
                  gridColumn: column.index + 1,
                  insetInlineStart:
                    column.index < grid.frozenColumnCount
                      ? `${ROW_HEADER_WIDTH + column.offset}px`
                      : undefined,
                }}
              >
                {columnName(column.index)}
              </div>
            ))}
            {mountedHiddenColumns.map((column) => (
              <span
                key={`hidden-${column.index}`}
                className="sheets-hidden-column"
                role="note"
                aria-label={t.t("reader.grid.hiddenColumn", {
                  column: columnName(column.index),
                })}
                style={{
                  insetInlineStart: `${ROW_HEADER_WIDTH + column.offset}px`,
                }}
              />
            ))}
          </div>

          {renderedRows.map((row, index) => {
            const previousRow = renderedRows[index - 1];
            const previousEnd = previousRow
              ? (rowGeometry.offsets.get(previousRow.index) ?? 0) +
                (rowGeometry.heights.get(previousRow.index) ??
                  grid.defaultRowPixelSize)
              : 0;
            const gap = Math.max(
              0,
              (rowGeometry.offsets.get(row.index) ?? 0) - previousEnd,
            );
            return (
              <Fragment key={row.index}>
                {gap ? (
                  <div aria-hidden="true" style={{ height: `${gap}px` }} />
                ) : null}
                <SheetRow
                  row={row}
                  grid={grid}
                  rowOffset={rowGeometry.offsets.get(row.index) ?? 0}
                  firstRow={renderedRows[0]?.index}
                  rowStyle={gridRowStyle}
                  mountedColumns={mountedColumns}
                  cellMap={cellMap}
                  mergeGeometries={mergeGeometries}
                  rowMerges={mergesByRow.get(row.index)}
                  layouts={rowLayouts.get(row.index)}
                  rowHeight={
                    rowGeometry.heights.get(row.index) ??
                    grid.defaultRowPixelSize
                  }
                  translations={translations}
                  revealed={revealed}
                  forcedWrap={measured.wrap}
                  presentation={presentation}
                  focused={residentFocused}
                  firstMounted={firstMounted}
                  onFocusCell={selectCell}
                  onKeyDown={handleCellKeyDown}
                />
              </Fragment>
            );
          })}
          {rowGeometry.totalHeight >
          (renderedRows.at(-1)
            ? (rowGeometry.offsets.get(renderedRows.at(-1)!.index) ?? 0) +
              (rowGeometry.heights.get(renderedRows.at(-1)!.index) ??
                grid.defaultRowPixelSize)
            : 0) ? (
            <div
              aria-hidden="true"
              style={{
                height: `${
                  rowGeometry.totalHeight -
                  (renderedRows.at(-1)
                    ? (rowGeometry.offsets.get(renderedRows.at(-1)!.index) ??
                        0) +
                      (rowGeometry.heights.get(renderedRows.at(-1)!.index) ??
                        grid.defaultRowPixelSize)
                    : 0)
                }px`,
              }}
            />
          ) : null}
        </div>
      </div>

      {residentSelected ? (
        <aside
          className="selected-cell-details"
          aria-label={t.t("reader.cell.details")}
        >
          <strong>{selectedAddress}</strong>
          <dl>
            <div>
              <dt>{t.t("reader.cell.source")}</dt>
              <dd>{selectedCell?.source || t.t("reader.grid.blank")}</dd>
            </div>
            {selectedCell?.kind === "formula" ? (
              <div>
                <dt>{t.t("reader.cell.displayed")}</dt>
                <dd>{selectedCell.display || t.t("reader.grid.blank")}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t.t("reader.cell.translation")}</dt>
              <dd>
                {(selectedCell
                  ? translations.get(selectedCell.id)
                  : undefined) ?? t.t("reader.cell.notTranslated")}
              </dd>
            </div>
          </dl>
        </aside>
      ) : null}
    </div>
  );
}

interface SheetRowProps {
  row: WorkspaceSheetRow;
  grid: WorkspaceSheetGrid;
  rowOffset: number;
  firstRow?: number;
  rowStyle: CSSProperties;
  mountedColumns: readonly ColumnMetric[];
  cellMap: ReadonlyMap<string, WorkspaceSheetCell>;
  mergeGeometries: ReadonlyMap<string, MergeGeometry>;
  rowMerges: readonly WorkspaceSheetMerge[] | undefined;
  layouts: ReadonlyMap<number, CellTextLayout> | undefined;
  rowHeight: number;
  translations: ReadonlyMap<string, string>;
  /** Cells whose translation arrived in the latest update. */
  revealed: ReadonlySet<string>;
  forcedWrap: ReadonlySet<string>;
  presentation: Presentation;
  focused?: { row: number; column: number };
  firstMounted?: number;
  onFocusCell: (rowIndex: number, columnIndex: number) => void;
  onKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    rowIndex: number,
    columnIndex: number,
  ) => void;
}

const VERTICAL_ALIGNMENT = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
} as const;

function textLayerStyle(
  style: WorkspaceSheetCellStyle,
  layout: CellTextLayout,
  rightToLeft: boolean,
): CSSProperties {
  // The origin cell may extend its paint corridor toward either neighbor;
  // columns grow rightward in LTR and leftward in RTL.
  const left = rightToLeft ? layout.after : layout.before;
  const right = rightToLeft ? layout.before : layout.after;
  // Excel indent is three space widths of the font, applied on the text side.
  const indent = style.indent * 3 * 0.278;
  return {
    left: `${-left}px`,
    right: `${-right}px`,
    paddingTop: `${style.padding.top}px`,
    paddingBottom: `${style.padding.bottom}px`,
    // Single-line overflow keeps its content box on the cell (the corridor
    // is padding it may paint into); wrapped text uses the whole corridor.
    paddingLeft: `calc(${(layout.mode === "wrap" ? 0 : left) + style.padding.left}px + ${layout.align === "left" ? indent : 0}em)`,
    paddingRight: `calc(${(layout.mode === "wrap" ? 0 : right) + style.padding.right}px + ${layout.align === "right" ? indent : 0}em)`,
    alignItems: VERTICAL_ALIGNMENT[style.vertical],
    justifyContent:
      layout.align === "right"
        ? "flex-end"
        : layout.align === "center"
          ? "center"
          : "flex-start",
  };
}

const SheetRow = memo(function SheetRow({
  row,
  grid,
  rowOffset,
  firstRow,
  rowStyle,
  mountedColumns,
  cellMap,
  mergeGeometries,
  rowMerges,
  layouts,
  rowHeight,
  translations,
  revealed,
  forcedWrap,
  presentation,
  focused,
  firstMounted,
  onFocusCell,
  onKeyDown,
}: SheetRowProps) {
  // Context, not a prop: a locale switch re-renders memoized rows without
  // changing their geometry inputs.
  const blank = useMessages(readerMessages).t("reader.grid.blank");
  const merges = rowMerges ?? NO_MERGES;
  const hasVerticalMerge = merges.some(
    (merge) =>
      merge.startRow === row.index && merge.endRow - merge.startRow > 1,
  );
  return (
    <div
      data-sheet-row-index={row.index}
      data-sheet-row-offset={rowOffset}
      className={[
        "sheets-grid-row",
        row.index < grid.frozenRowCount && "frozen",
        hasVerticalMerge && "has-vertical-merge",
      ]
        .filter(Boolean)
        .join(" ")}
      role="row"
      aria-rowindex={row.index + 2}
      style={{
        ...rowStyle,
        height: `${rowHeight}px`,
        top:
          row.index < grid.frozenRowCount ? `${28 + rowOffset}px` : undefined,
        // Frozen rows are opaque: an earlier row must stack above later ones
        // or they paint over a merged cell that spans down from it.
        zIndex:
          row.index < grid.frozenRowCount
            ? FROZEN_ROW_Z_BASE + Math.max(0, grid.frozenRowCount - row.index)
            : undefined,
      }}
    >
      <div className="sheets-row-header" role="rowheader">
        {row.index + 1}
      </div>
      {mountedColumns.map((column) => {
        const merge = merges.find(
          (candidate) =>
            row.index >= candidate.startRow &&
            row.index < candidate.endRow &&
            column.index >= candidate.startColumn &&
            column.index < candidate.endColumn,
        );
        if (
          merge &&
          (row.index !== merge.startRow || column.index !== merge.startColumn)
        ) {
          return null;
        }
        const cell = cellMap.get(`${row.index}:${column.index}`) ?? null;
        const style = cell?.style ?? grid.defaultStyle;
        const sourceLayout = cell ? layouts?.get(column.index) : undefined;
        const address = `${columnName(column.index)}${row.index + 1}`;
        const translation = cell ? translations.get(cell.id) : undefined;
        const source = cellDisplay(cell);
        const value =
          presentation === "translation" ? (translation ?? source) : source;
        const reveal =
          presentation === "translation" &&
          translation !== undefined &&
          cell !== null &&
          revealed.has(cell.id);
        // Rich-text cells keep each run's color and decorations; a
        // translation follows the style of the matching source line.
        const segments =
          cell?.runs && value
            ? presentation === "translation" && translation !== undefined
              ? translatedSegments(cell.runs, translation)
              : originalSegments(cell.runs)
            : null;
        const frozen = column.index < grid.frozenColumnCount;
        const selected =
          focused?.row === row.index && focused.column === column.index;
        const span = merge
          ? merge.endColumn - merge.startColumn
          : Math.max(1, cell?.columnSpan ?? 1);
        const mergeGeometry = merge
          ? mergeGeometries.get(`${merge.startRow}:${merge.startColumn}`)
          : undefined;
        // Text that does not fit its source mode wraps inside its own cell;
        // the row height already reserves its line boxes.
        const fit =
          cell && sourceLayout && value
            ? fitCellText(
                cell,
                value,
                sourceLayout,
                mergeGeometry?.width ?? column.width,
              )
            : undefined;
        // Overflow keeps its corridor (wrapping across it); clip text wraps
        // inside the cell.
        const wrapsText =
          fit?.wrap ||
          (cell !== null &&
            (cell.kind === "text" || cell.kind === "formula") &&
            forcedWrap.has(cell.id));
        const layout =
          sourceLayout && wrapsText
            ? sourceLayout.mode === "overflow"
              ? { ...sourceLayout, mode: "wrap" as const }
              : { ...sourceLayout, mode: "wrap" as const, before: 0, after: 0 }
            : sourceLayout;
        return (
          <div
            key={`${row.index}:${column.index}`}
            className={[
              "sheets-grid-cell",
              frozen && "frozen",
              selected && "selected",
              mergeGeometry?.vertical && "vertical-merge",
            ]
              .filter(Boolean)
              .join(" ")}
            role="gridcell"
            aria-colindex={column.index + 2}
            aria-colspan={span > 1 ? span : undefined}
            aria-rowspan={
              merge && merge.endRow - merge.startRow > 1
                ? merge.endRow - merge.startRow
                : undefined
            }
            aria-label={`${address}: ${value || blank}`}
            aria-selected={selected}
            data-cell-address={address}
            data-cell-id={cell?.id}
            data-row-spans={cell && cell.rowSpan > 1 ? "true" : undefined}
            data-text-mode={layout?.mode}
            data-forced-clip={layout?.forcedClip ?? undefined}
            data-vertical-merge-key={
              mergeGeometry?.vertical
                ? `${merge!.startRow}:${merge!.startColumn}`
                : undefined
            }
            tabIndex={
              selected ||
              (!focused &&
                column.index === firstMounted &&
                row.index === firstRow)
                ? 0
                : -1
            }
            style={{
              ...cellVariables(style),
              position: mergeGeometry?.vertical ? "absolute" : undefined,
              gridColumn: `${column.index + 1} / span ${span}`,
              width: mergeGeometry ? `${mergeGeometry.width}px` : undefined,
              // Absolute grid children are already anchored to their grid area.
              insetInlineStart: mergeGeometry?.vertical
                ? frozen
                  ? "var(--sheet-scroll-inline, 0px)"
                  : "0px"
                : frozen
                  ? `${ROW_HEADER_WIDTH + column.offset}px`
                  : undefined,
              height: mergeGeometry?.vertical
                ? `${mergeGeometry.height}px`
                : undefined,
              fontFamily: style.fontFamily
                ? `"${style.fontFamily}", sans-serif`
                : undefined,
              fontSize: style.fontSize ? `${style.fontSize}pt` : undefined,
              fontWeight: style.bold ? 700 : undefined,
              fontStyle: style.italic ? "italic" : undefined,
            }}
            onFocus={() => onFocusCell(row.index, column.index)}
            onKeyDown={(event) => onKeyDown(event, row.index, column.index)}
          >
            {layout && value ? (
              <span
                className="sheets-cell-text-layer"
                data-before={layout.mode === "wrap" ? 0 : layout.before}
                data-after={layout.mode === "wrap" ? 0 : layout.after}
                data-wrappable={
                  layout.mode !== "wrap" &&
                  cell !== null &&
                  (cell.kind === "text" || cell.kind === "formula")
                    ? "true"
                    : undefined
                }
                style={textLayerStyle(style, layout, grid.rightToLeft)}
              >
                <span
                  className="sheets-cell-text"
                  dir={style.direction ?? (grid.rightToLeft ? "rtl" : "ltr")}
                  data-reveal={reveal ? "" : undefined}
                  style={
                    {
                      textAlign: layout.align,
                      // Decorations are not inherited by the absolutely
                      // positioned text layer, so they are set on the text.
                      textDecoration: segments
                        ? undefined
                        : decorationOf(style),
                      // A revealed batch settles left to right in render order.
                      "--reveal-delay": reveal
                        ? `${Math.min(
                            REVEAL_STAGGER_MAX_MS,
                            Math.max(
                              0,
                              column.index - (mountedColumns[0]?.index ?? 0),
                            ) * REVEAL_STAGGER_MS,
                          )}ms`
                        : undefined,
                    } as CSSProperties
                  }
                >
                  {segments
                    ? segments.map((segment, index) => (
                        <span
                          key={index}
                          style={{
                            color: segment.style.color
                              ? readableColors(
                                  style.background,
                                  segment.style.color,
                                ).color
                              : undefined,
                            fontWeight: segment.style.bold ? 700 : 400,
                            fontStyle: segment.style.italic
                              ? "italic"
                              : "normal",
                            textDecoration:
                              decorationOf(segment.style) ?? "none",
                          }}
                        >
                          {segment.text}
                        </span>
                      ))
                    : value}
                </span>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

export default memo(SheetsGrid);
