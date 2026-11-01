import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import {
  defaultWorkspaceSheetCellStyle,
  type WorkspaceSheetCell,
  type WorkspaceSheetGrid,
  type WorkspaceSheetPage,
} from "@/lib/google-workspace-reader";
import { UiLocaleScope } from "@/lib/i18n/react";
import SheetsGrid from "./SheetsGrid";

const style: WorkspaceSheetCell["style"] = {
  ...defaultWorkspaceSheetCellStyle(),
  vertical: "top",
  wrapStrategy: "wrap",
};

function cell(rowIndex: number, columnIndex: number, source: string) {
  const anchor = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
  return {
    id: anchor.toLowerCase(),
    anchor,
    source,
    display: source,
    kind: "text",
    translatable: true,
    sourceHash: `hash-${anchor}`,
    rowIndex,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    style,
  } satisfies WorkspaceSheetCell;
}

function grid(
  rowCount: number,
  columns: WorkspaceSheetGrid["columns"],
  merges: WorkspaceSheetGrid["merges"] = [],
): WorkspaceSheetGrid {
  return {
    sheetId: "42",
    title: "Grid fixture",
    generation: 1,
    rowCount,
    lastUsedColumn: columns.length - 1,
    columns,
    frozenRowCount: 0,
    frozenColumnCount: 0,
    rightToLeft: false,
    hideGridlines: false,
    merges,
    defaultStyle: defaultWorkspaceSheetCellStyle(),
    defaultRowPixelSize: 21,
    defaultColumnPixelSize: 100,
  };
}

function page(rows: WorkspaceSheetPage["rows"]): WorkspaceSheetPage {
  return {
    sheetId: "42",
    generation: 1,
    startRow: 0,
    rowCount: rows.length,
    rows,
    cursor: null,
  };
}

function renderGrid(
  sheetGrid: WorkspaceSheetGrid,
  sheetPage: WorkspaceSheetPage,
  options: {
    translations?: ReadonlyMap<string, string>;
    presentation?: "original" | "translation";
    onNearPageEnd?: (startRow?: number) => void;
    onViewportRecordsChange?: (ids: string[]) => void;
  } = {},
) {
  return render(
    <SheetsGrid
      grid={sheetGrid}
      pages={[sheetPage]}
      translations={options.translations ?? new Map()}
      presentation={options.presentation ?? "translation"}
      onNearPageEnd={options.onNearPageEnd ?? vi.fn()}
      onViewportRecordsChange={options.onViewportRecordsChange ?? vi.fn()}
    />,
  );
}

afterEach(() => vi.unstubAllGlobals());

test("preserves narrow source columns and explicit annotation colors after translation", () => {
  const item = cell(0, 0, "Annotation");
  item.style = { ...item.style, color: "#ff0000" };
  const { container } = renderGrid(
    grid(1, [
      { index: 0, pixelSize: 24, hidden: false },
      { index: 1, pixelSize: 80, hidden: false },
    ]),
    page([{ index: 0, pixelSize: 21, hidden: false, cells: [item] }]),
    { translations: new Map([[item.id, "Chú thích"]]) },
  );
  const header = container.querySelector<HTMLElement>(".sheets-grid-header")!;
  // The view pads to Google Sheets' minimum of 26 columns with default blanks.
  expect(header.style.gridTemplateColumns).toBe(
    `24px 80px${" 100px".repeat(24)}`,
  );
  const displayed = screen.getByRole("gridcell", { name: "A1: Chú thích" });
  expect(
    (displayed as HTMLElement).style.getPropertyValue("--sheet-cell-color"),
  ).toBe("#ff0000");
});

test("keeps hidden rows at zero height and out of the mounted grid", () => {
  const sheetGrid = grid(3, [{ index: 0, pixelSize: 100, hidden: false }]);
  const sheetPage = page([
    { index: 0, pixelSize: 24, hidden: false, cells: [cell(0, 0, "A1")] },
    { index: 1, pixelSize: 80, hidden: true, cells: [cell(1, 0, "Hidden")] },
    { index: 2, pixelSize: 30, hidden: false, cells: [cell(2, 0, "A3")] },
  ]);
  const { container } = renderGrid(sheetGrid, sheetPage);

  expect(container.querySelector('[data-sheet-row-index="1"]')).toBeNull();
  expect(screen.queryByRole("gridcell", { name: "A2: Hidden" })).toBeNull();
  expect(container.querySelector('[data-sheet-row-index="2"]')).toHaveAttribute(
    "data-sheet-row-offset",
    "24",
  );
});

test("keeps mounted overscan columns out of viewport translation eligibility", async () => {
  const columns = Array.from({ length: 6 }, (_, index) => ({
    index,
    pixelSize: 100,
    hidden: false,
  }));
  const cells = columns.map(({ index }) => cell(0, index, `Column ${index}`));
  const onViewportRecordsChange = vi.fn();
  const { container } = renderGrid(
    grid(1, columns),
    page([{ index: 0, pixelSize: 21, hidden: false, cells }]),
    { onViewportRecordsChange },
  );
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 100 },
    clientHeight: { configurable: true, value: 100 },
  });
  onViewportRecordsChange.mockClear();
  fireEvent.scroll(viewport);

  expect(
    await screen.findByRole("gridcell", { name: "C1: Column 2" }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(onViewportRecordsChange).toHaveBeenLastCalledWith(["a1"]),
  );
});

test("emits each ordered viewport record sequence only once", async () => {
  const sheetGrid = grid(1, [
    { index: 0, pixelSize: 100, hidden: false },
    { index: 1, pixelSize: 100, hidden: false },
    { index: 2, pixelSize: 100, hidden: false },
  ]);
  const sharedA = { ...cell(0, 0, "First"), id: "shared" };
  const sharedB = { ...cell(0, 1, "Duplicate"), id: "shared" };
  const third = cell(0, 2, "Third");
  const callbacks = {
    onNearPageEnd: vi.fn(),
    onViewportRecordsChange: vi.fn(),
  };
  const renderPage = (translatable = true) => [
    page([
      {
        index: 0,
        pixelSize: 21,
        hidden: false,
        cells: [
          { ...sharedA, translatable },
          { ...sharedB, translatable },
          { ...third, translatable },
        ],
      },
    ]),
  ];
  const { rerender } = render(
    <SheetsGrid
      grid={sheetGrid}
      pages={renderPage()}
      translations={new Map()}
      presentation="translation"
      {...callbacks}
    />,
  );

  await waitFor(() =>
    expect(callbacks.onViewportRecordsChange).toHaveBeenCalledWith([
      "shared",
      "c1",
    ]),
  );
  expect(callbacks.onViewportRecordsChange).toHaveBeenCalledTimes(1);
  callbacks.onViewportRecordsChange.mockClear();

  rerender(
    <SheetsGrid
      grid={sheetGrid}
      pages={renderPage()}
      translations={new Map([[third.id, "Translated"]])}
      presentation="original"
      {...callbacks}
    />,
  );
  expect(callbacks.onViewportRecordsChange).not.toHaveBeenCalled();

  rerender(
    <SheetsGrid
      grid={sheetGrid}
      pages={renderPage(false)}
      translations={new Map()}
      presentation="translation"
      {...callbacks}
    />,
  );
  await waitFor(() =>
    expect(callbacks.onViewportRecordsChange).toHaveBeenCalledWith([]),
  );
  expect(callbacks.onViewportRecordsChange).toHaveBeenCalledTimes(1);
});

test("resolves selected-cell details from the current reloaded page", () => {
  const sheetGrid = grid(1, [{ index: 0, pixelSize: 100, hidden: false }]);
  const original = cell(0, 0, "Before edit");
  const callbacks = {
    onNearPageEnd: vi.fn(),
    onViewportRecordsChange: vi.fn(),
  };
  const { rerender } = render(
    <SheetsGrid
      grid={sheetGrid}
      pages={[
        page([{ index: 0, pixelSize: 21, hidden: false, cells: [original] }]),
      ]}
      translations={new Map()}
      presentation="original"
      {...callbacks}
    />,
  );
  fireEvent.focus(screen.getByRole("gridcell", { name: "A1: Before edit" }));
  expect(
    screen.getByRole("complementary", { name: "Selected cell details" }),
  ).toHaveTextContent("Before edit");

  rerender(
    <SheetsGrid
      grid={sheetGrid}
      pages={[]}
      translations={new Map()}
      presentation="original"
      {...callbacks}
    />,
  );
  expect(
    screen.getByRole("complementary", { name: "Selected cell details" }),
  ).not.toHaveTextContent("Before edit");

  const edited = {
    ...original,
    source: "After edit",
    display: "After edit",
    sourceHash: "hash-after-edit",
  };
  rerender(
    <SheetsGrid
      grid={sheetGrid}
      pages={[
        page([{ index: 0, pixelSize: 21, hidden: false, cells: [edited] }]),
      ]}
      translations={new Map()}
      presentation="original"
      {...callbacks}
    />,
  );
  expect(
    screen.getByRole("complementary", { name: "Selected cell details" }),
  ).toHaveTextContent("After edit");
});

test("words grid labels and selected-cell details in Vietnamese without changing geometry", () => {
  const sheetGrid = grid(1, [
    { index: 0, pixelSize: 100, hidden: false },
    { index: 1, pixelSize: 100, hidden: true },
    { index: 2, pixelSize: 100, hidden: false },
  ]);
  const translated = cell(0, 0, "Hello");
  const untranslated = cell(0, 2, "World");
  const sheetPage = page([
    {
      index: 0,
      pixelSize: 21,
      hidden: false,
      cells: [translated, untranslated],
    },
  ]);
  const props = {
    grid: sheetGrid,
    pages: [sheetPage],
    translations: new Map([[translated.id, "Xin chào"]]),
    presentation: "translation" as const,
    onNearPageEnd: vi.fn(),
    onViewportRecordsChange: vi.fn(),
  };
  const english = render(<SheetsGrid {...props} />);
  const englishRows = Array.from(
    english.container.querySelectorAll<HTMLElement>("[data-sheet-row-index]"),
  ).map((row) => row.getAttribute("style"));
  english.unmount();

  const { container } = render(
    <UiLocaleScope locale="vi">
      <SheetsGrid {...props} />
    </UiLocaleScope>,
  );
  expect(
    screen.getByRole("grid", { name: "Trang tính Grid fixture" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: "Số dòng" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("note", { name: "Cột B bị ẩn" })).toBeInTheDocument();

  fireEvent.focus(screen.getByRole("gridcell", { name: "A1: Xin chào" }));
  const details = screen.getByRole("complementary", {
    name: "Chi tiết ô đang chọn",
  });
  expect(details).toHaveTextContent("Bản gốcHello");
  expect(details).toHaveTextContent("Bản dịchXin chào");

  fireEvent.focus(screen.getByRole("gridcell", { name: "C1: World" }));
  expect(
    screen.getByRole("complementary", { name: "Chi tiết ô đang chọn" }),
  ).toHaveTextContent("Bản dịchChưa dịch");
  // Only text changes: row geometry matches the English render.
  expect(
    Array.from(
      container.querySelectorAll<HTMLElement>("[data-sheet-row-index]"),
    ).map((row) => row.getAttribute("style")),
  ).toEqual(englishRows);
});

test("clears evicted-row selection and restores a resident tab stop", async () => {
  const sheetGrid = grid(2, [{ index: 0, pixelSize: 100, hidden: false }]);
  const callbacks = {
    onNearPageEnd: vi.fn(),
    onViewportRecordsChange: vi.fn(),
  };
  const { rerender } = render(
    <SheetsGrid
      grid={sheetGrid}
      pages={[
        page([
          {
            index: 0,
            pixelSize: 21,
            hidden: false,
            cells: [cell(0, 0, "Evicted")],
          },
        ]),
      ]}
      translations={new Map()}
      presentation="original"
      {...callbacks}
    />,
  );
  fireEvent.focus(screen.getByRole("gridcell", { name: "A1: Evicted" }));
  expect(
    screen.getByRole("complementary", { name: "Selected cell details" }),
  ).toHaveTextContent("Evicted");

  rerender(
    <SheetsGrid
      grid={sheetGrid}
      pages={[
        page([
          {
            index: 1,
            pixelSize: 21,
            hidden: false,
            cells: [cell(1, 0, "Resident")],
          },
        ]),
      ]}
      translations={new Map()}
      presentation="original"
      {...callbacks}
    />,
  );

  await waitFor(() =>
    expect(
      screen.queryByRole("complementary", { name: "Selected cell details" }),
    ).toBeNull(),
  );
  expect(
    screen.getByRole("gridcell", { name: "A2: Resident" }),
  ).toHaveAttribute("tabindex", "0");
});

test("grows a vertical merge for translation and preserves its geometry through scroll and presentation", async () => {
  const columns = [
    { index: 0, pixelSize: 100, hidden: false },
    { index: 1, pixelSize: 100, hidden: false },
    { index: 2, pixelSize: 80, hidden: false },
    { index: 3, pixelSize: 120, hidden: false },
    ...Array.from({ length: 8 }, (_, index) => ({
      index: index + 4,
      pixelSize: 100,
      hidden: false,
    })),
  ];
  const origin = { ...cell(0, 2, "Merged"), rowSpan: 3, columnSpan: 2 };
  const sheetPage = page([
    { index: 0, pixelSize: 21, hidden: false, cells: [origin] },
    { index: 1, pixelSize: 30, hidden: false, cells: [cell(1, 2, "Covered")] },
    { index: 2, pixelSize: 24, hidden: false, cells: [cell(2, 3, "Covered")] },
    { index: 3, pixelSize: 21, hidden: false, cells: [cell(3, 0, "After")] },
  ]);
  const sheetGrid = grid(4, columns, [
    { startRow: 0, endRow: 3, startColumn: 2, endColumn: 4 },
  ]);
  const long =
    "A long translated value that wraps beyond three source rows ".repeat(12);
  const { container, rerender } = renderGrid(sheetGrid, sheetPage, {
    translations: new Map([[origin.id, long]]),
  });
  const merged = screen.getByRole("gridcell", {
    name: /^C1: A long/,
  });
  expect(merged).toHaveAttribute("aria-rowspan", "3");
  expect(merged).toHaveAttribute("aria-colspan", "2");
  const height = Number.parseFloat(merged.style.height);
  expect(height).toBeGreaterThan(75);
  expect(merged).toHaveStyle({
    width: "200px",
    height: `${height}px`,
    gridColumn: "3 / span 2",
    insetInlineStart: "0px",
  });
  expect(screen.queryByRole("gridcell", { name: /C[23]:/ })).toBeNull();
  expect(screen.queryByRole("gridcell", { name: /D[23]:/ })).toBeNull();
  const after = () =>
    container.querySelector('[data-sheet-row-index="3"]') as HTMLElement;
  expect(after()).toHaveAttribute("data-sheet-row-offset", String(height));

  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  Object.defineProperty(viewport, "clientWidth", {
    configurable: true,
    value: 100,
  });
  viewport.scrollLeft = 1_000;
  fireEvent.scroll(viewport);
  await waitFor(() =>
    expect(screen.queryByRole("gridcell", { name: /C1: A long/ })).toBeNull(),
  );
  expect(after()).toHaveAttribute("data-sheet-row-offset", String(height));
  viewport.scrollLeft = 0;
  fireEvent.scroll(viewport);
  await screen.findByRole("gridcell", { name: /C1: A long/ });
  expect(after()).toHaveAttribute("data-sheet-row-offset", String(height));
  expect(screen.getByRole("gridcell", { name: /C1: A long/ })).toHaveStyle({
    height: `${height}px`,
  });
  rerender(
    <SheetsGrid
      grid={sheetGrid}
      pages={[sheetPage]}
      translations={new Map([[origin.id, long]])}
      presentation="original"
      onNearPageEnd={vi.fn()}
      onViewportRecordsChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("gridcell", { name: "C1: Merged" })).toHaveStyle({
    height: `${height}px`,
  });
  expect(after()).toHaveAttribute("data-sheet-row-offset", String(height));
});

test("overlapping vertical merges share final grown row geometry", () => {
  const columns = [
    { index: 0, pixelSize: 100, hidden: false },
    { index: 1, pixelSize: 100, hidden: false },
  ];
  const first = { ...cell(0, 0, "A merge"), rowSpan: 3 };
  const second = { ...cell(0, 1, "B merge"), rowSpan: 2 };
  const { container } = renderGrid(
    grid(4, columns, [
      { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 },
      { startRow: 0, endRow: 2, startColumn: 1, endColumn: 2 },
    ]),
    page([
      { index: 0, pixelSize: 21, hidden: false, cells: [first, second] },
      { index: 1, pixelSize: 21, hidden: false, cells: [] },
      { index: 2, pixelSize: 21, hidden: false, cells: [] },
      { index: 3, pixelSize: 21, hidden: false, cells: [cell(3, 0, "After")] },
    ]),
    {
      translations: new Map([
        [first.id, "Very long ".repeat(40)],
        [second.id, "Also long ".repeat(40)],
      ]),
    },
  );
  const firstHeight = Number.parseFloat(
    screen.getByRole("gridcell", { name: /^A1:/ }).style.height,
  );
  const secondHeight = Number.parseFloat(
    screen.getByRole("gridcell", { name: /^B1:/ }).style.height,
  );
  expect(firstHeight).toBeGreaterThan(63);
  expect(secondHeight).toBeGreaterThan(42);
  const row2 = Number(
    container.querySelector<HTMLElement>('[data-sheet-row-index="2"]')!.dataset
      .sheetRowOffset,
  );
  const row3 = Number(
    container.querySelector<HTMLElement>('[data-sheet-row-index="3"]')!.dataset
      .sheetRowOffset,
  );
  expect(secondHeight).toBe(row2);
  expect(firstHeight).toBe(row3);
});

test("does not request pages when the sheet has no logical columns", () => {
  const onNearPageEnd = vi.fn();
  const emptyPage: WorkspaceSheetPage = {
    ...page([]),
    rowCount: 100,
    cursor: { kind: "sheets", nextRow: 100 },
  };
  const { container } = renderGrid(grid(200, []), emptyPage, {
    onNearPageEnd,
  });
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 4_200 },
    scrollTop: { configurable: true, value: 4_100, writable: true },
  });
  fireEvent.scroll(viewport);
  expect(onNearPageEnd).not.toHaveBeenCalled();
});

test("coalesces scroll events and skips row reads within a horizontal column window", () => {
  let frame: FrameRequestCallback | undefined;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const { container } = renderGrid(
    grid(
      1,
      Array.from({ length: 12 }, (_, index) => ({
        index,
        pixelSize: 100,
        hidden: false,
      })),
    ),
    page([
      { index: 0, pixelSize: 21, hidden: false, cells: [cell(0, 0, "Text")] },
    ]),
  );
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  Object.defineProperty(viewport, "clientWidth", {
    configurable: true,
    value: 100,
  });
  fireEvent.scroll(viewport);
  act(() => frame!(0));
  const rowRead = vi.spyOn(
    container.querySelector<HTMLElement>("[data-sheet-row-index]")!,
    "getBoundingClientRect",
  );
  requestFrame.mockClear();
  for (const left of [1, 2, 3]) {
    viewport.scrollLeft = left;
    fireEvent.scroll(viewport);
  }
  expect(requestFrame).toHaveBeenCalledTimes(1);
  act(() => frame!(0));
  expect(rowRead).not.toHaveBeenCalled();
  expect(viewport.style.getPropertyValue("--sheet-scroll-inline")).toBe("3px");
  rowRead.mockRestore();
});

test("grows rows to show long text and keeps Original and Translation on one geometry", () => {
  const columns = [
    { index: 0, pixelSize: 24, hidden: false },
    { index: 1, pixelSize: 24, hidden: false },
  ];
  const item = {
    ...cell(0, 0, "Short"),
    style: { ...style, wrapStrategy: "wrap" as const },
  };
  const sheetGrid = grid(2, columns);
  const sheetPage = page([
    { index: 0, pixelSize: 21, hidden: false, cells: [item] },
    { index: 1, pixelSize: 33, hidden: false, cells: [cell(1, 1, "Next")] },
  ]);
  const translations = new Map([[item.id, "A much longer translated value"]]);
  const heights = (presentation: "original" | "translation") => {
    const view = render(
      <SheetsGrid
        grid={sheetGrid}
        pages={[sheetPage]}
        translations={translations}
        presentation={presentation}
        onNearPageEnd={vi.fn()}
        onViewportRecordsChange={vi.fn()}
      />,
    );
    const rows = [
      ...view.container.querySelectorAll<HTMLElement>("[data-sheet-row-index]"),
    ].map((row) => [row.style.height, row.dataset.sheetRowOffset]);
    view.unmount();
    return rows;
  };
  const original = heights("original");
  expect(heights("translation")).toEqual(original);
  // The wrapped translation needs more than the 21px source height; rows
  // grow, never shrink, and offsets follow the grown heights.
  expect(Number.parseInt(original[0]![0]!, 10)).toBeGreaterThan(21);
  expect(Number.parseInt(original[1]![0]!, 10)).toBeGreaterThanOrEqual(33);
  expect(original[1]![1]).toBe(String(Number.parseInt(original[0]![0]!, 10)));
});

function styled(
  item: WorkspaceSheetCell,
  patch: Partial<WorkspaceSheetCell["style"]>,
) {
  item.style = { ...item.style, ...patch };
  return item;
}

function narrowColumns() {
  return grid(
    1,
    [0, 1, 2].map((index) => ({ index, pixelSize: 40, hidden: false })),
  );
}

function threeColumns() {
  return grid(
    1,
    [0, 1, 2].map((index) => ({ index, pixelSize: 100, hidden: false })),
  );
}

test("paints overflow across empty neighbors and stops at a populated cell", () => {
  const origin = styled(cell(0, 0, "Note"), {
    wrapStrategy: "overflow",
  });
  const blocker = styled(cell(0, 2, "Blocker"), { wrapStrategy: "overflow" });
  const { container } = renderGrid(
    narrowColumns(),
    page([
      { index: 0, pixelSize: 21, hidden: false, cells: [origin, blocker] },
    ]),
    { translations: new Map([[origin.id, "Chú thích"]]) },
  );
  const cellA = container.querySelector<HTMLElement>(
    '[data-text-mode="overflow"]',
  )!;
  const layer = cellA.querySelector<HTMLElement>(".sheets-cell-text-layer")!;
  expect(layer.style.right).toBe("-40px");
  expect(layer.style.left).toBe("0px");
  expect(layer.textContent).toBe("Chú thích");
  expect(container.querySelectorAll(".sheets-cell-text-layer")).toHaveLength(2);
});

test("plain text in a wide cell runs across empty plain neighbors like the source", () => {
  const origin = styled(cell(0, 0, "A long annotation"), {
    wrapStrategy: "overflow",
  });
  const { container } = renderGrid(
    threeColumns(),
    page([{ index: 0, pixelSize: 21, hidden: false, cells: [origin] }]),
  );
  const layer = container.querySelector<HTMLElement>(
    ".sheets-cell-text-layer",
  )!;
  expect(layer.style.right).toBe("-2500px");
});

test("a filled cell wide enough to wrap keeps its text inside itself even beside empty cells", () => {
  const origin = styled(cell(0, 0, "A long annotation"), {
    wrapStrategy: "overflow",
    background: "#ffff00",
  });
  const { container } = renderGrid(
    threeColumns(),
    page([{ index: 0, pixelSize: 21, hidden: false, cells: [origin] }]),
  );
  const layer = container.querySelector<HTMLElement>(
    ".sheets-cell-text-layer",
  )!;
  expect(layer.style.right).toBe("0px");
  expect(layer.style.left).toBe("0px");
});

test("clip and wrap cells stay inside their own footprint", () => {
  const clip = styled(cell(0, 0, "Clipped"), { wrapStrategy: "clip" });
  const wrap = styled(cell(0, 1, "Wrapped"), { wrapStrategy: "wrap" });
  const { container } = renderGrid(
    threeColumns(),
    page([{ index: 0, pixelSize: 21, hidden: false, cells: [clip, wrap] }]),
  );
  for (const mode of ["clip", "wrap"]) {
    const layer = container.querySelector<HTMLElement>(
      `[data-text-mode="${mode}"] .sheets-cell-text-layer`,
    )!;
    expect(layer.style.left).toBe("0px");
    expect(layer.style.right).toBe("0px");
  }
});

test("a same-fill blank neighbor does not block overflow but a whitespace one does", () => {
  const origin = styled(cell(0, 0, "Text"), {
    wrapStrategy: "overflow",
    background: "#ffff00",
  });
  const blank = styled(cell(0, 1, ""), {
    wrapStrategy: "overflow",
    background: "#ffff00",
  });
  Object.assign(blank, { kind: "blank", translatable: false });
  const open = renderGrid(
    narrowColumns(),
    page([{ index: 0, pixelSize: 21, hidden: false, cells: [origin, blank] }]),
  );
  expect(
    open.container.querySelector<HTMLElement>(".sheets-cell-text-layer")!.style
      .right,
  ).toBe("-40px");
  open.unmount();
  const space = styled(cell(0, 1, " "), { wrapStrategy: "overflow" });
  const blocked = renderGrid(
    narrowColumns(),
    page([{ index: 0, pixelSize: 21, hidden: false, cells: [origin, space] }]),
  );
  expect(
    blocked.container.querySelector<HTMLElement>(".sheets-cell-text-layer")!
      .style.right,
  ).toBe("0px");
});

test("keeps an overflow origin outside the viewport mounted while its corridor is visible", async () => {
  const columns = Array.from({ length: 40 }, (_, index) => ({
    index,
    pixelSize: 100,
    hidden: false,
  }));
  const mountedAddresses = (text: string) => {
    const origin = styled(cell(0, 2, "Origin"), { wrapStrategy: "overflow" });
    const view = renderGrid(
      grid(1, columns),
      page([{ index: 0, pixelSize: 21, hidden: false, cells: [origin] }]),
      { translations: new Map([[origin.id, text]]) },
    );
    const viewport = view.container.querySelector<HTMLElement>(
      ".sheets-grid-viewport",
    )!;
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      value: 300,
    });
    viewport.scrollLeft = 800;
    fireEvent.scroll(viewport);
    return { view, viewport };
  };
  // A text far wider than its corridor start reaches the scrolled viewport.
  const long = mountedAddresses("x".repeat(60));
  await waitFor(() =>
    expect(
      long.view.container.querySelector('[data-cell-address="C1"]'),
    ).not.toBeNull(),
  );
  long.view.unmount();
  // A short text cannot reach it, so the origin is not kept mounted.
  const short = mountedAddresses("x");
  await waitFor(() =>
    expect(
      short.view.container.querySelector('[data-cell-address="K1"]'),
    ).not.toBeNull(),
  );
  expect(
    short.view.container.querySelector('[data-cell-address="C1"]'),
  ).toBeNull();
});

test("auto-fits a stored-height-less wrap row to its source text, identically in both presentations", () => {
  const item = cell(0, 0, "word ".repeat(60));
  const autoRow = {
    index: 0,
    pixelSize: 21,
    hidden: false,
    autoHeight: true as const,
    cells: [item],
  };
  const heights = (presentation: "original" | "translation") => {
    const view = render(
      <SheetsGrid
        grid={grid(1, [{ index: 0, pixelSize: 100, hidden: false }])}
        pages={[page([autoRow])]}
        translations={new Map([[item.id, "x ".repeat(400)]])}
        presentation={presentation}
        onNearPageEnd={vi.fn()}
        onViewportRecordsChange={vi.fn()}
      />,
    );
    const height = view.container.querySelector<HTMLElement>(
      "[data-sheet-row-index]",
    )!.style.height;
    view.unmount();
    return height;
  };
  const original = heights("original");
  expect(Number.parseInt(original, 10)).toBeGreaterThan(21);
  expect(heights("translation")).toBe(original);
});

test("mounts only a window of rows and keeps the frozen and selected rows", () => {
  const sheetGrid = {
    ...grid(400, [{ index: 0, pixelSize: 100, hidden: false }]),
    frozenRowCount: 1,
  };
  const rows = Array.from({ length: 100 }, (_, index) => ({
    index,
    pixelSize: 21,
    hidden: false,
    cells: [cell(index, 0, `Row ${index + 1}`)],
  }));
  const { container } = renderGrid(sheetGrid, page(rows));
  const mounted = () =>
    [...container.querySelectorAll("[data-sheet-row-index]")].map((row) =>
      Number((row as HTMLElement).dataset.sheetRowIndex),
    );
  expect(mounted().length).toBeLessThan(80);
  expect(mounted()).toContain(0);
  expect(mounted()).not.toContain(90);
  // Selecting a row keeps it mounted even when scrolled far away.
  fireEvent.focus(screen.getByRole("gridcell", { name: /A3:/ }));
  const viewport = container.querySelector<HTMLElement>(
    ".sheets-grid-viewport",
  )!;
  viewport.scrollTop = 1_800;
  fireEvent.scroll(viewport);
  return waitFor(() => {
    expect(mounted()).toContain(2);
    expect(mounted()).toContain(0);
    expect(mounted()).toContain(86);
    expect(mounted().length).toBeLessThan(80);
  });
});

test("an earlier frozen row stacks above later ones so a merge spanning down stays visible", () => {
  const sheetGrid = {
    ...grid(
      4,
      [{ index: 0, pixelSize: 100, hidden: false }],
      [{ startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 }],
    ),
    frozenRowCount: 3,
  };
  const rows = Array.from({ length: 4 }, (_, index) => ({
    index,
    pixelSize: 28,
    hidden: false,
    cells: [cell(index, 0, `Row ${index + 1}`)],
  }));
  const { container } = renderGrid(sheetGrid, page(rows));
  const z = (index: number) =>
    container.querySelector<HTMLElement>(`[data-sheet-row-index="${index}"]`)!
      .style.zIndex;
  expect(Number(z(0))).toBeGreaterThan(Number(z(1)));
  expect(Number(z(1))).toBeGreaterThan(Number(z(2)));
  expect(z(3)).toBe("");
});

test("keeps strikethrough on the text layer in Original and Translation", () => {
  const origin = styled(cell(0, 0, "Struck"), {
    wrapStrategy: "overflow",
    strikethrough: true,
    underline: true,
  });
  const translations = new Map([[origin.id, "Gạch ngang"]]);
  for (const presentation of ["original", "translation"] as const) {
    const { container, unmount } = renderGrid(
      threeColumns(),
      page([{ index: 0, pixelSize: 21, hidden: false, cells: [origin] }]),
      { translations, presentation },
    );
    const text = container.querySelector<HTMLElement>(".sheets-cell-text")!;
    expect(text.style.textDecoration).toBe("underline line-through");
    unmount();
  }
});

test("renders rich-text runs with their own color and follows source lines in the translation", () => {
  const origin = styled(cell(0, 0, "Black\nStruck red"), {
    wrapStrategy: "wrap",
  });
  const run = (text: string, patch = {}) => ({
    text,
    color: null,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    ...patch,
  });
  Object.assign(origin, {
    runs: [
      run("Black\n"),
      run("Struck red", { color: "#ff0000", strikethrough: true }),
    ],
  });
  const translations = new Map([[origin.id, "Đen\nĐỏ gạch"]]);
  const spans = (presentation: "original" | "translation") => {
    const view = renderGrid(
      threeColumns(),
      page([{ index: 0, pixelSize: 40, hidden: false, cells: [origin] }]),
      { translations, presentation },
    );
    const result = [
      ...view.container.querySelectorAll<HTMLElement>(".sheets-cell-text span"),
    ].map((span) => [
      span.textContent,
      span.style.color,
      span.style.textDecoration,
    ]);
    view.unmount();
    return result;
  };
  expect(spans("original")).toEqual([
    ["Black\n", "", "none"],
    ["Struck red", "rgb(255, 0, 0)", "line-through"],
  ]);
  expect(spans("translation")).toEqual([
    ["Đen\n", "", "none"],
    ["Đỏ gạch", "rgb(255, 0, 0)", "line-through"],
  ]);
});

test.each([
  { rightToLeft: false, towardD: "ArrowRight", towardA: "ArrowLeft" },
  { rightToLeft: true, towardD: "ArrowLeft", towardA: "ArrowRight" },
])(
  "keyboard arrows follow the visual direction, skip merges/hidden cells and mount destinations (RTL=$rightToLeft)",
  async ({ rightToLeft, towardD, towardA }) => {
    const columns = Array.from({ length: 30 }, (_, index) => ({
      index,
      pixelSize: 100,
      hidden: index === 2,
    }));
    const origin = { ...cell(0, 0, "Merge"), rowSpan: 2, columnSpan: 2 };
    const sheetGrid = grid(3, columns, [
      { startRow: 0, endRow: 2, startColumn: 0, endColumn: 2 },
    ]);
    sheetGrid.frozenColumnCount = 1;
    sheetGrid.rightToLeft = rightToLeft;
    const { container } = renderGrid(
      sheetGrid,
      page([
        { index: 0, pixelSize: 21, hidden: false, cells: [origin] },
        { index: 1, pixelSize: 21, hidden: false, cells: [] },
        {
          index: 2,
          pixelSize: 21,
          hidden: false,
          cells: [cell(2, 0, "Below")],
        },
      ]),
    );
    const merged = screen.getByRole("gridcell", { name: "A1: Merge" });
    fireEvent.focus(merged);
    fireEvent.keyDown(merged, { key: towardD });
    const next = await screen.findByRole("gridcell", { name: "D1: Blank" });
    await waitFor(() => expect(next).toHaveFocus());
    fireEvent.keyDown(next, { key: towardA });
    await waitFor(() => expect(merged).toHaveFocus());
    fireEvent.keyDown(merged, { key: "ArrowDown" });
    const below = screen.getByRole("gridcell", { name: "A3: Below" });
    await waitFor(() => expect(below).toHaveFocus());
    expect(screen.queryByRole("gridcell", { name: "AD3: Blank" })).toBeNull();
    fireEvent.keyDown(below, { key: "End" });
    const last = await screen.findByRole("gridcell", { name: "AD3: Blank" });
    await waitFor(() => expect(last).toHaveFocus());
    expect(
      Math.abs(
        container.querySelector<HTMLElement>(".sheets-grid-viewport")!
          .scrollLeft,
      ),
    ).toBeGreaterThan(0);
    fireEvent.keyDown(last, { key: "Home" });
    await waitFor(() => expect(below).toHaveFocus());
  },
);

test("reveals only newly arrived translations and crossfades presentation toggles without changing geometry", () => {
  const first = cell(0, 0, "見積");
  const second = cell(0, 1, "納期");
  const sheetGrid = grid(1, [
    { index: 0, pixelSize: 24, hidden: false },
    { index: 1, pixelSize: 80, hidden: false },
  ]);
  const sheetPage = page([
    { index: 0, pixelSize: 21, hidden: false, cells: [first, second] },
  ]);
  const view = (
    translations: ReadonlyMap<string, string>,
    presentation: "original" | "translation" = "translation",
  ) => (
    <SheetsGrid
      grid={sheetGrid}
      pages={[sheetPage]}
      translations={translations}
      presentation={presentation}
      onNearPageEnd={vi.fn()}
      onViewportRecordsChange={vi.fn()}
    />
  );
  const initial = new Map([[first.id, "Quote"]]);
  const { container, rerender } = render(view(initial));
  const text = (id: string) =>
    container.querySelector<HTMLElement>(
      `[data-cell-id="${id}"] .sheets-cell-text`,
    )!;
  const geometry = () =>
    [
      ...container.querySelectorAll<HTMLElement>(
        ".sheets-grid-header, .sheets-grid-row",
      ),
    ].map((row) => [row.style.gridTemplateColumns, row.style.height]);
  const grid0 = container.querySelector<HTMLElement>(".sheets-grid")!;
  const before = geometry();

  // Translations already present at mount do not replay the reveal.
  expect(text(first.id)).not.toHaveAttribute("data-reveal");
  expect(grid0).not.toHaveAttribute("data-presentation");

  rerender(
    view(
      new Map([
        [first.id, "Quote"],
        [second.id, "Delivery date"],
      ]),
    ),
  );
  expect(text(second.id)).toHaveAttribute("data-reveal", "");
  expect(text(second.id).style.getPropertyValue("--reveal-delay")).toBe("24ms");
  expect(text(first.id)).not.toHaveAttribute("data-reveal");

  const translated = new Map([
    [first.id, "Quote"],
    [second.id, "Delivery date"],
  ]);
  rerender(view(translated, "original"));
  expect(grid0).toHaveAttribute("data-presentation", "original");
  expect(text(second.id)).not.toHaveAttribute("data-reveal");
  rerender(view(translated, "translation"));
  expect(grid0).toHaveAttribute("data-presentation", "translation");
  // A toggle crossfades the sheet; it does not replay the cell reveal.
  expect(text(second.id)).not.toHaveAttribute("data-reveal");
  expect(geometry()).toEqual(before);
});
