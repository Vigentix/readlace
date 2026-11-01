import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const xlsxReadOverride = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();
  return {
    ...actual,
    read: (...args: Parameters<typeof actual.read>) =>
      xlsxReadOverride.value ?? actual.read(...args),
  };
});

import {
  MAX_SOURCE_DIMENSION_PIXEL_SIZE,
  parseWorkspaceSheetGrid,
  parseWorkspaceSheetPage,
} from "./google-workspace-reader";
import {
  MAX_LOCAL_COLUMNS,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_EXPANDED_BYTES,
  MAX_LOCAL_MERGES,
  MAX_LOCAL_ROWS,
  MAX_LOCAL_SHEETS,
  LocalSpreadsheetError,
  parseLocalSpreadsheet,
  type LocalSpreadsheetWorkerResponse,
} from "./local-spreadsheet";

function workbookBytes(
  sheets: { name: string; sheet: XLSX.WorkSheet }[],
  bookType: "xlsx" | "xlsm" = "xlsx",
  vbaraw?: Uint8Array,
) {
  const workbook = XLSX.utils.book_new();
  for (const { name, sheet } of sheets)
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  if (vbaraw) workbook.vbaraw = vbaraw;
  const bytes = XLSX.write(workbook, {
    type: "array",
    bookType,
    bookVBA: Boolean(vbaraw),
    cellStyles: true,
  });
  return bytes as ArrayBuffer;
}

function csv(value: string) {
  return new TextEncoder().encode(value).buffer as ArrayBuffer;
}

function rewriteWorksheetBytes(
  base: ArrayBuffer,
  transform: (xml: string) => string,
  compression = false,
) {
  const archive = XLSX.CFB.read(Buffer.from(base), { type: "buffer" });
  const index = archive.FullPaths.findIndex((path: string) =>
    path.endsWith("/xl/worksheets/sheet1.xml"),
  );
  const entry = archive.FileIndex[index]!;
  entry.content = Buffer.from(
    transform(new TextDecoder().decode(entry.content)),
  );
  return new Uint8Array(
    XLSX.CFB.write(archive, {
      type: "buffer",
      fileType: "zip",
      compression,
    }),
  ).buffer as ArrayBuffer;
}

function zipMembers(bytes: ArrayBuffer) {
  const data = new DataView(bytes);
  const end = bytes.byteLength - 22;
  let cursor = data.getUint32(end + 16, true);
  return Array.from({ length: data.getUint16(end + 10, true) }, () => {
    const central = cursor;
    const local = data.getUint32(cursor + 42, true);
    const nameLength = data.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(
      new Uint8Array(bytes, cursor + 46, nameLength),
    );
    cursor +=
      46 +
      nameLength +
      data.getUint16(cursor + 30, true) +
      data.getUint16(cursor + 32, true);
    return { central, local, name };
  });
}

function patchedWorksheetBytes(
  dimension: string,
  rowXml = "",
  worksheetXml = "",
) {
  const base = workbookBytes([
    { name: "Sparse", sheet: XLSX.utils.aoa_to_sheet([["Near"]]) },
  ]);
  const archive = XLSX.CFB.read(Buffer.from(base), { type: "buffer" });
  const index = archive.FullPaths.findIndex((path: string) =>
    path.endsWith("/xl/worksheets/sheet1.xml"),
  );
  const entry = archive.FileIndex[index];
  if (!entry?.content) throw new Error("missing generated worksheet fixture");
  let xml = new TextDecoder()
    .decode(entry.content)
    .replace(/<dimension ref="[^"]+"\/>/, `<dimension ref="${dimension}"/>`);
  if (rowXml) xml = xml.replace("</sheetData>", `${rowXml}</sheetData>`);
  if (worksheetXml)
    xml = xml.replace("</worksheet>", `${worksheetXml}</worksheet>`);
  entry.content = Buffer.from(xml);
  const output = XLSX.CFB.write(archive, { type: "buffer", fileType: "zip" });
  return new Uint8Array(output).buffer as ArrayBuffer;
}

function sparseLargeRangeBytes() {
  return patchedWorksheetBytes(
    "A1:XFD100000",
    '<row r="100000"><c r="XFD100000" t="inlineStr"><is><t>Far</t></is></c></row>',
  );
}

function savedStyleBytes(dimension?: string) {
  const base = workbookBytes([
    {
      name: "Styled",
      sheet: XLSX.utils.aoa_to_sheet([
        ["A", null, "C"],
        [null, null, "End"],
      ]),
    },
  ]);
  const archive = XLSX.CFB.read(Buffer.from(base), { type: "buffer" });
  for (let index = 0; index < archive.FullPaths.length; index += 1) {
    const path = archive.FullPaths[index]!;
    const entry = archive.FileIndex[index];
    if (!entry?.content) continue;
    let xml = new TextDecoder().decode(entry.content);
    if (path.endsWith("/xl/styles.xml")) {
      xml = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <fonts count="2"><font><sz val="10"/><name val="Arial"/><color rgb="FF000000"/></font><font><sz val="10"/><name val="Arial"/><b/><i/><color rgb="FFFF0000"/></font></fonts>
        <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF123456"/></patternFill></fill></fills>
        <borders count="2"><border/><border><top style="thin"><color rgb="FFABCDEF"/></top><right style="thin"/><bottom style="thin"><color rgb="FF000000"/></bottom><left/></border></borders>
        <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
        <cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs>
      </styleSheet>`;
    } else if (path.endsWith("/xl/workbook.xml")) {
      xml = xml.replace('r:id="rId1"', 'r:id="rId8"');
    } else if (path.endsWith("/xl/_rels/workbook.xml.rels")) {
      xml = xml
        .replace('Id="rId1"', 'Id="rId8"')
        .replace(
          'Target="worksheets/sheet1.xml"',
          'Target="worksheets/sheet9.xml"',
        );
    } else if (path.endsWith("/xl/worksheets/sheet1.xml")) {
      if (dimension)
        xml = xml.replace(
          /<dimension ref="[^"]+"\/>/,
          `<dimension ref="${dimension}"/>`,
        );
      xml = xml
        .replace('<c r="A1"', '<c r="A1" s="1"')
        .replace('<c r="C1"', '<c r="C1" s="1"')
        .replace("</row>", '<c r="B1" s="1"/></row>')
        .replace(
          "</sheetData>",
          '<row r="99"><c r="K99" s="1"/></row></sheetData>',
        )
        .replace(
          "<sheetData>",
          '<cols><col min="1" max="1" width="11.38" customWidth="1"/><col min="2" max="2" width="5.75" customWidth="1" hidden="1"/></cols><sheetData>',
        );
      archive.FullPaths[index] = path.replace("sheet1.xml", "sheet9.xml");
      entry.name = "sheet9.xml";
    }
    if (path.endsWith(".xml") || path.endsWith(".rels"))
      entry.content = Buffer.from(xml);
  }
  return new Uint8Array(
    XLSX.CFB.write(archive, { type: "buffer", fileType: "zip" }),
  ).buffer as ArrayBuffer;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "LocalSpreadsheetError",
    code,
  });
}

describe("local spreadsheet parser", () => {
  it.each(["frozen", "frozenSplit"])(
    "reads %s pane, RTL and hidden gridlines from real saved worksheet XML",
    async (state) => {
      const base = workbookBytes([
        {
          name: "Views",
          sheet: XLSX.utils.aoa_to_sheet([
            ["Top", "B", "C"],
            ["Second"],
            ["Third"],
          ]),
        },
      ]);
      const bytes = rewriteWorksheetBytes(base, (xml) =>
        xml
          .replace('<row r="1">', '<row r="1" ht="15.75" customHeight="1">')
          .replace(
            /<sheetViews>[\s\S]*?<\/sheetViews>/,
            `<sheetViews><sheetView workbookViewId="1"/><sheetView workbookViewId="0" rightToLeft="1" showGridLines="0"><pane state="${state}" xSplit="2" ySplit="1" topLeftCell="C2"/></sheetView></sheetViews>`,
          ),
      );
      const workbook = await parseLocalSpreadsheet(bytes, "views.xlsx");
      const selected = await workbook.selectSheet(0);
      expect(selected.grid).toMatchObject({
        frozenRowCount: 1,
        frozenColumnCount: 2,
        rightToLeft: true,
        hideGridlines: true,
      });
      expect(parseWorkspaceSheetGrid(selected.grid)).toEqual(selected.grid);
      expect(selected.page.rows[0]!.pixelSize).toBe(21);
    },
  );

  it("does not treat ordinary split panes as frozen rows and columns", async () => {
    const bytes = rewriteWorksheetBytes(
      workbookBytes([
        { name: "Split", sheet: XLSX.utils.aoa_to_sheet([["A", "B"], ["C"]]) },
      ]),
      (xml) =>
        xml.replace(
          /<sheetViews>[\s\S]*?<\/sheetViews>/,
          '<sheetViews><sheetView workbookViewId="0"><pane state="split" xSplit="2000" ySplit="1000"/></sheetView></sheetViews>',
        ),
    );
    const workbook = await parseLocalSpreadsheet(bytes, "split.xlsx");
    expect((await workbook.selectSheet(0)).grid).toMatchObject({
      frozenRowCount: 0,
      frozenColumnCount: 0,
      rightToLeft: false,
      hideGridlines: false,
    });
  });

  it("retains inline rich text without sharedStrings.xml in real compressed XLSX bytes", async () => {
    const bytes = rewriteWorksheetBytes(
      workbookBytes([
        {
          name: "Inline",
          sheet: XLSX.utils.aoa_to_sheet([["", "placeholder"], ["Plain"]]),
        },
      ]),
      (xml) =>
        xml
          .replace(/<c r="A1"[\s\S]*?<\/c>/, '<c r="A1" s="0"/>')
          .replace(
            /<c r="B1"[\s\S]*?<\/c>/,
            '<c r="B1" t="inlineStr"><is><r><t xml:space="preserve">Black &amp; </t></r><r><rPr><b/><i/><u/><strike/><color rgb="FFFF0000"/></rPr><t>Red</t></r></is></c>',
          ),
      true,
    );
    expect(
      zipMembers(bytes).some(({ name }) => name.endsWith("sharedStrings.xml")),
    ).toBe(false);
    const workbook = await parseLocalSpreadsheet(bytes, "inline.xlsx");
    const selected = await workbook.selectSheet(0);
    const cell = selected.page.rows[0]!.cells[0]!;
    expect(cell.anchor).toBe("B1");
    expect(cell.source).toBe("Black & Red");
    expect(cell.runs).toEqual([
      expect.objectContaining({
        text: "Black & ",
        bold: false,
        italic: false,
        strikethrough: false,
      }),
      {
        text: "Red",
        color: "#ff0000",
        bold: true,
        italic: true,
        underline: true,
        strikethrough: true,
      },
    ]);
    expect(selected.page.rows[1]!.cells[0]!.runs).toBeUndefined();
    expect(parseWorkspaceSheetPage(selected.page, selected.grid)).toEqual(
      selected.page,
    );
  });

  it("rejects declared ZIP expansion before SheetJS reads a small package", async () => {
    const bytes = workbookBytes([
      { name: "Safe", sheet: XLSX.utils.aoa_to_sheet([["Safe"]]) },
    ]);
    const data = new DataView(bytes);
    const member = zipMembers(bytes).find(({ name }) =>
      name.endsWith("sheet1.xml"),
    )!;
    data.setUint32(member.central + 24, MAX_LOCAL_EXPANDED_BYTES + 1, true);
    data.setUint32(member.local + 22, MAX_LOCAL_EXPANDED_BYTES + 1, true);
    // Use deflate metadata so the cap, rather than stored-size equality, rejects it.
    data.setUint16(member.central + 10, 8, true);
    data.setUint16(member.local + 8, 8, true);
    const read = vi.spyOn(XLSX, "read");
    await expectCode(
      parseLocalSpreadsheet(bytes, "declared.xlsx"),
      "content-too-large",
    );
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("bounds observed deflate output when both ZIP headers understate a small member", async () => {
    const bytes = rewriteWorksheetBytes(
      workbookBytes([
        { name: "Safe", sheet: XLSX.utils.aoa_to_sheet([["Safe"]]) },
      ]),
      (xml) => xml,
      true,
    );
    const data = new DataView(bytes);
    const member = zipMembers(bytes).find(({ name }) =>
      name.endsWith("sheet1.xml"),
    )!;
    expect(data.getUint16(member.central + 10, true)).toBe(8);
    data.setUint32(member.central + 24, 16, true);
    data.setUint32(member.local + 22, 16, true);
    const read = vi.spyOn(XLSX, "read");
    await expectCode(
      parseLocalSpreadsheet(bytes, "understated.xlsx"),
      "content-too-large",
    );
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("rejects mismatched local ZIP size and truncated central directory before reading", async () => {
    const bytes = workbookBytes([
      { name: "Safe", sheet: XLSX.utils.aoa_to_sheet([["Safe"]]) },
    ]);
    const member = zipMembers(bytes)[0]!;
    new DataView(bytes).setUint32(member.local + 22, 0xffff, true);
    await expectCode(
      parseLocalSpreadsheet(bytes, "mismatch.xlsx"),
      "invalid-workbook",
    );
    await expectCode(
      parseLocalSpreadsheet(bytes.slice(0, -10), "truncated.xlsx"),
      "invalid-workbook",
    );
  });

  it("hashes repeated sources once and keeps hashes and covered merge cells exact", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Repeated", "Repeated"],
      ["Repeated"],
      ["Unique"],
    ]);
    sheet["!merges"] = [XLSX.utils.decode_range("A1:B1")];
    const workbook = await parseLocalSpreadsheet(
      workbookBytes([{ name: "Hash", sheet }]),
      "hash.xlsx",
    );
    const digest = vi.spyOn(crypto.subtle, "digest");
    const selected = await workbook.selectSheet(0);
    const cells = selected.page.rows.flatMap(({ cells }) => cells);
    expect(cells.map(({ anchor }) => anchor)).toEqual(["A1", "A2", "A3"]);
    expect(cells[0]!.sourceHash).toEqual(cells[1]!.sourceHash);
    expect(cells[2]!.sourceHash).not.toEqual(cells[0]!.sourceHash);
    expect(digest).toHaveBeenCalledTimes(2);
    digest.mockRestore();
  });
  it("keeps painted blanks inside the saved dimension as part of the sheet extent", async () => {
    const workbook = await parseLocalSpreadsheet(
      savedStyleBytes("A1:K99"),
      "styles.xlsx",
    );
    const selected = await workbook.selectSheet(0);
    expect(selected.grid).toMatchObject({ rowCount: 99, lastUsedColumn: 10 });
    const anchors = selected.page.rows.flatMap((row) =>
      row.cells.map((cell) => cell.anchor),
    );
    expect(anchors).toContain("K99");
  });

  it("restores saved OOXML fonts, alignment, fills and side borders through worksheet relationships", async () => {
    const workbook = await parseLocalSpreadsheet(
      savedStyleBytes(),
      "styles.xlsx",
    );
    const selected = await workbook.selectSheet(0);
    expect(selected.grid).toMatchObject({ rowCount: 2, lastUsedColumn: 2 });
    const cells = selected.page.rows.flatMap((row) => row.cells);
    expect(cells.map((cell) => cell.anchor)).toEqual(["A1", "B1", "C1", "C2"]);
    expect(cells[0]!.style).toEqual({
      background: "#123456",
      color: "#ff0000",
      bold: true,
      italic: true,
      underline: false,
      strikethrough: false,
      fontFamily: "Arial",
      fontSize: 10,
      horizontal: "center",
      vertical: "middle",
      wrapStrategy: "wrap",
      shrinkToFit: false,
      direction: null,
      rotation: 0,
      indent: 0,
      padding: { top: 0, right: 2, bottom: 0, left: 2 },
      borders: {
        top: "#abcdef",
        right: "#000000",
        bottom: "#000000",
        left: null,
      },
      borderLines: {
        top: { style: "solid", width: 1 },
        right: { style: "solid", width: 1 },
        bottom: { style: "solid", width: 1 },
        left: null,
      },
    });
    expect(cells[1]).toMatchObject({
      kind: "blank",
      source: "",
      display: "",
      translatable: false,
      style: cells[0]!.style,
    });
    expect(cells[1]!.sourceHash).toMatch(/^[0-9a-f]{40}$/);
    expect(parseWorkspaceSheetGrid(selected.grid)).toEqual(selected.grid);
    expect(parseWorkspaceSheetPage(selected.page, selected.grid)).toEqual(
      selected.page,
    );
  });

  it("measures the Normal font maximum digit width instead of trusting SheetJS MDW guesses", async () => {
    const context = {
      font: "",
      measureText: (digit: string) => ({ width: digit === "8" ? 7.5 : 7.1 }),
    };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return context;
        }
      },
    );
    try {
      const workbook = await parseLocalSpreadsheet(
        savedStyleBytes(),
        "widths.xlsx",
      );
      const selected = await workbook.selectSheet(0);
      expect(context.font).toBe('13.333333333333334px "Arial"');
      expect(selected.grid.columns).toEqual([
        { index: 0, pixelSize: 91, hidden: false },
        { index: 1, pixelSize: 46, hidden: true },
        // No saved width: Excel's default column from the same measured Normal
        // font digit width (8 chars + 5px padding rounded up to 8px), not 100.
        { index: 2, pixelSize: 72, hidden: false },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps saved merged perimeter borders when the far corner is an empty cell", async () => {
    const archive = XLSX.CFB.read(Buffer.from(savedStyleBytes()), {
      type: "buffer",
    });
    const index = archive.FullPaths.findIndex((path: string) =>
      path.endsWith("/xl/worksheets/sheet9.xml"),
    );
    const entry = archive.FileIndex[index]!;
    entry.content = Buffer.from(
      new TextDecoder()
        .decode(entry.content)
        .replace('<c r="A1" s="1"', '<c r="A1" s="0"')
        .replace(
          "</worksheet>",
          '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
        ),
    );
    const bytes = new Uint8Array(
      XLSX.CFB.write(archive, { type: "buffer", fileType: "zip" }),
    ).buffer as ArrayBuffer;
    const workbook = await parseLocalSpreadsheet(bytes, "merged.xlsx");
    const selected = await workbook.selectSheet(0);
    const anchor = selected.page.rows[0]!.cells[0]!;
    expect(anchor).toMatchObject({
      anchor: "A1",
      columnSpan: 2,
      translatable: true,
      style: {
        borders: {
          top: "#abcdef",
          right: "#000000",
          bottom: "#000000",
          left: null,
        },
      },
    });
    expect(
      selected.page.rows[0]!.cells.some((cell) => cell.anchor === "B1"),
    ).toBe(false);
    expect(parseWorkspaceSheetPage(selected.page, selected.grid)).toEqual(
      selected.page,
    );
  });

  it("retains the existing saved pixel-width fallback when Worker font measurement is unavailable", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );
    try {
      const workbook = await parseLocalSpreadsheet(
        savedStyleBytes(),
        "fallback.xlsx",
      );
      const selected = await workbook.selectSheet(0);
      expect(selected.grid.columns[0]!.pixelSize).toBeGreaterThan(91);
      expect(selected.grid.columns[2]!.pixelSize).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("parses quoted, multiline and delimiter-containing CSV fields as raw strings", async () => {
    const workbook = await parseLocalSpreadsheet(
      csv('Name,Note\r\n"Alpha","Line 1\nLine 2"\r\n"001","a,b"'),
      "sample.csv",
    );
    const selected = await workbook.selectSheet(0);

    expect(workbook.metadata.sheets).toEqual([{ index: 0, name: "Sheet1" }]);
    expect(selected.grid).toMatchObject({
      rowCount: 3,
      lastUsedColumn: 1,
    });
    expect(
      selected.page.rows.flatMap((row) =>
        row.cells.map((cell) => [cell.anchor, cell.source]),
      ),
    ).toEqual([
      ["A1", "Name"],
      ["B1", "Note"],
      ["A2", "Alpha"],
      ["B2", "Line 1\nLine 2"],
      ["A3", "001"],
      ["B3", "a,b"],
    ]);
  });

  it("normalizes XLSX worksheets, absolute blanks, cached formulas, merges and dimensions", async () => {
    const first = XLSX.utils.aoa_to_sheet([
      ["Hello", { t: "s", f: '"Cached text"', v: "Cached text" }],
      [],
      ["After blank"],
    ]);
    first["!merges"] = [XLSX.utils.decode_range("A3:B3")];
    first["!cols"] = [{ wpx: 144 }, { wpx: 80, hidden: true }];
    // Saved OOXML height is in points; 24.75pt and 20.25pt are 33px and 27px.
    first["!rows"] = [{ hpt: 24.75 }, { hpt: 20.25, hidden: true }];
    const second = XLSX.utils.aoa_to_sheet([["Second sheet"]]);
    const workbook = await parseLocalSpreadsheet(
      workbookBytes([
        { name: "First", sheet: first },
        { name: "Second", sheet: second },
      ]),
      "sample.xlsx",
    );

    expect(workbook.metadata.sheets).toEqual([
      { index: 0, name: "First" },
      { index: 1, name: "Second" },
    ]);
    const selected = await workbook.selectSheet(0);
    expect(selected.grid.columns).toEqual([
      { index: 0, pixelSize: 144, hidden: false },
      { index: 1, pixelSize: 80, hidden: true },
    ]);
    expect(selected.grid.merges).toEqual([
      { startRow: 2, endRow: 3, startColumn: 0, endColumn: 2 },
    ]);
    expect(selected.page.rows[0]).toMatchObject({
      index: 0,
      pixelSize: 33,
      hidden: false,
    });
    expect(selected.page.rows[1]).toMatchObject({
      index: 1,
      pixelSize: 27,
      hidden: true,
      cells: [],
    });
    const formula = selected.page.rows[0]!.cells[1]!;
    expect(formula).toMatchObject({
      anchor: "B1",
      source: '="Cached text"',
      display: "Cached text",
      kind: "formula",
      translatable: true,
    });
    expect(formula.sourceHash).toMatch(/^[0-9a-f]{40}$/);
    // No saved formatting: the cell carries the workbook's resolved default.
    expect(formula.style).toEqual(selected.grid.defaultStyle);
    expect(formula.style).toMatchObject({
      wrapStrategy: "overflow",
      horizontal: "general",
      shrinkToFit: false,
    });
    expect(selected.page.rows[2]!.cells[0]).toMatchObject({
      anchor: "A3",
      rowSpan: 1,
      columnSpan: 2,
    });
    expect(
      (await workbook.selectSheet(1)).page.rows[0]!.cells[0],
    ).toMatchObject({ anchor: "A1", source: "Second sheet" });
  });

  it("accepts XLSM worksheet data without exposing a VBA blob", async () => {
    const workbook = await parseLocalSpreadsheet(
      workbookBytes(
        [{ name: "Macro sheet", sheet: XLSX.utils.aoa_to_sheet([["Safe"]]) }],
        "xlsm",
        new Uint8Array([1, 2, 3, 4]),
      ),
      "sample.xlsm",
    );
    const selected = await workbook.selectSheet(0);

    expect(selected.page.rows[0]!.cells[0]).toMatchObject({
      source: "Safe",
      translatable: true,
    });
    expect(
      JSON.stringify({ metadata: workbook.metadata, selected }),
    ).not.toMatch(/vba|macro.*blob|1,2,3,4/i);
  });

  it("normalizes fractional XLSM row and column pixels for the shared grid contract", async () => {
    const sheet: XLSX.WorkSheet = {
      A1: { t: "s", v: "Merged" },
      C4: { t: "s", v: "Last" },
      "!ref": "A1:C4",
      "!rows": [
        { hpx: 20.6 },
        { hpx: 0.4, hidden: true },
        { hpx: 0 },
        { hpx: 1_000_000 },
      ],
      "!cols": [
        { wpx: 100.6 },
        { wpx: 0.4, hidden: true },
        { wpx: Number.NaN },
      ],
      "!merges": [XLSX.utils.decode_range("A1:B1")],
    };
    const fixture = workbookBytes(
      [{ name: "Formatted", sheet: XLSX.utils.aoa_to_sheet([["fixture"]]) }],
      "xlsm",
    );
    xlsxReadOverride.value = {
      SheetNames: ["Formatted"],
      Sheets: { Formatted: sheet },
    };

    try {
      const workbook = await parseLocalSpreadsheet(fixture, "formatted.xlsm");
      const selected = await workbook.selectSheet(0);

      expect(selected.grid).toMatchObject({
        rowCount: 4,
        lastUsedColumn: 2,
        columns: [
          { index: 0, pixelSize: 101, hidden: false },
          { index: 1, pixelSize: 1, hidden: true },
          { index: 2, pixelSize: 100, hidden: false },
        ],
        merges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 2 }],
      });
      expect(
        selected.page.rows.map(({ pixelSize, hidden }) => ({
          pixelSize,
          hidden,
        })),
      ).toEqual([
        { pixelSize: 21, hidden: false },
        { pixelSize: 1, hidden: true },
        // No saved height: Excel's 15pt default row, not a Reader constant.
        { pixelSize: 20, hidden: false },
        { pixelSize: MAX_SOURCE_DIMENSION_PIXEL_SIZE, hidden: false },
      ]);
      // Source sizes are exact below the data-safety ceiling, never a 420/600px cap.
      expect(
        selected.page.rows.every(
          (row) => row.pixelSize <= MAX_SOURCE_DIMENSION_PIXEL_SIZE,
        ),
      ).toBe(true);
      expect(
        selected.page.rows.flatMap((row) =>
          row.cells.map((cell) => [cell.anchor, cell.source]),
        ),
      ).toEqual([
        ["A1", "Merged"],
        ["C4", "Last"],
      ]);

      const parsedGrid = parseWorkspaceSheetGrid(selected.grid);
      expect(parsedGrid).toEqual(selected.grid);
      expect(parseWorkspaceSheetPage(selected.page, parsedGrid!)).toEqual(
        selected.page,
      );
    } finally {
      xlsxReadOverride.value = null;
    }
  });

  it("emits sequential 100-row pages without collapsing internal blank rows", async () => {
    const sheet: XLSX.WorkSheet = {
      A1: { t: "s", v: "First" },
      A101: { t: "s", v: "Next page" },
      "!ref": "A1:A101",
    };
    const workbook = await parseLocalSpreadsheet(
      workbookBytes([{ name: "Pages", sheet }]),
      "pages.xlsx",
    );
    const first = await workbook.selectSheet(0);
    const second = workbook.loadPage(100);

    expect(first.page).toMatchObject({
      startRow: 0,
      rowCount: 100,
      cursor: { kind: "sheets", nextRow: 100 },
    });
    expect(first.page.rows).toHaveLength(100);
    expect(second).toMatchObject({ startRow: 100, rowCount: 1, cursor: null });
    expect(second.rows[0]!.cells[0]).toMatchObject({
      anchor: "A101",
      source: "Next page",
    });
  });

  it("emits no rows for an empty grid", async () => {
    const workbook = await parseLocalSpreadsheet(
      workbookBytes([{ name: "Empty", sheet: XLSX.utils.aoa_to_sheet([]) }]),
      "empty.xlsx",
    );
    const selected = await workbook.selectSheet(0);

    expect(selected.grid).toMatchObject({ rowCount: 1, lastUsedColumn: -1 });
    expect(selected.page).toMatchObject({
      startRow: 0,
      rowCount: 1,
      rows: [],
      cursor: null,
    });
  });

  it("normalizes an in-limit sparse XFD100000 range by populated cells", async () => {
    const workbook = await parseLocalSpreadsheet(
      sparseLargeRangeBytes(),
      "sparse.xlsx",
    );
    const selected = await workbook.selectSheet(0);
    const finalPage = workbook.loadPage(99_900);

    expect(selected.grid).toMatchObject({
      rowCount: 100_000,
      lastUsedColumn: 16_383,
    });
    expect(selected.grid.columns).toHaveLength(16_384);
    expect(selected.page.rows[0]!.cells[0]).toMatchObject({
      anchor: "A1",
      source: "Near",
    });
    expect(finalPage.rows[99]!.cells[0]).toMatchObject({
      anchor: "XFD100000",
      source: "Far",
    });
  }, 1_000);

  it("ignores an oversized declared range and distant formatting-only cell", async () => {
    const workbook = await parseLocalSpreadsheet(
      patchedWorksheetBytes(
        "A1:XFE100001",
        '<row r="100001"><c r="XFE100001" s="0"/></row>',
      ),
      "format-tail.xlsx",
    );
    const selected = await workbook.selectSheet(0);

    expect(selected.grid).toMatchObject({ rowCount: 1, lastUsedColumn: 0 });
    expect(selected.page.rows[0]!.cells).toHaveLength(1);
  });

  it("rejects distant content and merges even when declared range is ignored", async () => {
    const farContent = await parseLocalSpreadsheet(
      patchedWorksheetBytes(
        "A1:XFE100001",
        '<row r="100001"><c r="XFE100001" t="inlineStr"><is><t>Far</t></is></c></row>',
      ),
      "far-content.xlsx",
    );
    await expectCode(farContent.selectSheet(0), "dimensions-too-large");

    const farMerge = await parseLocalSpreadsheet(
      patchedWorksheetBytes(
        "A1:XFE100002",
        "",
        '<mergeCells count="1"><mergeCell ref="XFE100001:XFE100002"/></mergeCells>',
      ),
      "far-merge.xlsx",
    );
    await expectCode(farMerge.selectSheet(0), "dimensions-too-large");
  });

  it("rejects unsupported, oversized, encrypted and malformed files explicitly", async () => {
    await expectCode(
      parseLocalSpreadsheet(csv("a"), "sample.xls"),
      "unsupported-file-type",
    );
    await expectCode(
      parseLocalSpreadsheet(
        new ArrayBuffer(MAX_LOCAL_FILE_BYTES + 1),
        "big.csv",
      ),
      "file-too-large",
    );
    await expectCode(
      parseLocalSpreadsheet(
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer,
        "protected.xlsx",
      ),
      "encrypted-workbook",
    );
    await expectCode(
      parseLocalSpreadsheet(new Uint8Array([1, 2, 3]).buffer, "broken.xlsx"),
      "invalid-workbook",
    );
  });

  it("enforces sheet, row and column limits", async () => {
    const sheets = Array.from({ length: MAX_LOCAL_SHEETS + 1 }, (_, index) => ({
      name: `S${index + 1}`,
      sheet: XLSX.utils.aoa_to_sheet([[index]]),
    }));
    await expectCode(
      parseLocalSpreadsheet(workbookBytes(sheets), "sheets.xlsx"),
      "too-many-sheets",
    );

    for (const input of [
      `${"x\n".repeat(MAX_LOCAL_ROWS)}x`,
      Array.from({ length: MAX_LOCAL_COLUMNS + 1 }, () => "x").join(","),
    ]) {
      const workbook = await parseLocalSpreadsheet(
        csv(input),
        "dimensions.csv",
      );
      await expectCode(workbook.selectSheet(0), "dimensions-too-large");
    }
  });

  it("accepts the merge bound and rejects one additional merge", async () => {
    const mergeSheet = (count: number) => {
      const sheet = XLSX.utils.aoa_to_sheet([["Anchor"]]);
      sheet["!merges"] = Array.from({ length: count }, (_, index) => ({
        s: { r: index, c: 0 },
        e: { r: index, c: 1 },
      }));
      sheet["!ref"] = `A1:B${count}`;
      return sheet;
    };
    const atBound = await parseLocalSpreadsheet(
      workbookBytes([{ name: "Merges", sheet: mergeSheet(MAX_LOCAL_MERGES) }]),
      "merges.xlsx",
    );
    expect((await atBound.selectSheet(0)).grid.merges).toHaveLength(
      MAX_LOCAL_MERGES,
    );

    const overBound = await parseLocalSpreadsheet(
      workbookBytes([
        { name: "Merges", sheet: mergeSheet(MAX_LOCAL_MERGES + 1) },
      ]),
      "merges.xlsx",
    );
    await expectCode(overBound.selectSheet(0), "content-too-large");
  });

  it("enforces populated-record and source-unit limits per selected sheet", async () => {
    const records = `Value\n${"x\n".repeat(10_000)}`;
    const manyRecords = await parseLocalSpreadsheet(
      csv(records),
      "records.csv",
    );
    await expectCode(manyRecords.selectSheet(0), "content-too-large");

    const longSource = await parseLocalSpreadsheet(
      csv(`"${"x".repeat(256_001)}"`),
      "source.csv",
    );
    await expectCode(longSource.selectSheet(0), "content-too-large");
  });

  it("counts a retained formula source even when its cached display is empty", async () => {
    const sheet: XLSX.WorkSheet = {
      A1: {
        t: "s",
        f: "x".repeat(256_001),
        v: "",
      },
      "!ref": "A1",
    };
    const workbook = await parseLocalSpreadsheet(
      workbookBytes([{ name: "Formula", sheet }]),
      "formula.xlsx",
    );

    await expectCode(workbook.selectSheet(0), "content-too-large");
  });

  it("rejects invalid sheet indexes and page cursors", async () => {
    const workbook = await parseLocalSpreadsheet(csv("Value"), "sample.csv");
    await expectCode(workbook.selectSheet(1), "invalid-request");
    expect(() => workbook.loadPage(0)).toThrow(LocalSpreadsheetError);
    await workbook.selectSheet(0);
    expect(() => workbook.loadPage(1)).toThrowError("invalid-request");
  });
});

describe("local spreadsheet worker protocol", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns only normalized data and supports page, sheet and dispose requests", async () => {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const responses: LocalSpreadsheetWorkerResponse[] = [];
    const close = vi.fn();
    vi.stubGlobal("self", {
      addEventListener: (
        _type: string,
        callback: (event: MessageEvent<unknown>) => void,
      ) => {
        listener = callback;
      },
      postMessage: (response: LocalSpreadsheetWorkerResponse) =>
        responses.push(response),
      close,
    });
    await import("../entrypoints/reader.sidepanel/local-spreadsheet.worker");
    expect(listener).toBeTypeOf("function");

    const bytes = csv("One\nTwo");
    listener!({
      data: { type: "parse", requestId: "parse-1", fileName: "a.csv", bytes },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toMatchObject({
      type: "parsed",
      requestId: "parse-1",
      metadata: { fileName: "a.csv" },
      sheet: { sheetIndex: 0, sheetName: "Sheet1" },
    });
    expect(JSON.stringify(responses[0])).not.toContain("workbook");

    listener!({
      data: { type: "load-page", requestId: "page-1", startRow: 0 },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(responses).toHaveLength(2));
    expect(responses[1]).toMatchObject({
      type: "page",
      requestId: "page-1",
      page: { startRow: 0 },
    });

    listener!({
      data: { type: "select-sheet", requestId: "sheet-1", sheetIndex: 0 },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(responses).toHaveLength(3));
    expect(responses[2]).toMatchObject({ type: "sheet", requestId: "sheet-1" });

    listener!({ data: { type: "dispose", requestId: "done" } } as MessageEvent);
    await vi.waitFor(() => expect(responses).toHaveLength(4));
    expect(responses[3]).toEqual({ type: "disposed", requestId: "done" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects malformed requests with a strict protocol error", async () => {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const responses: LocalSpreadsheetWorkerResponse[] = [];
    vi.stubGlobal("self", {
      addEventListener: (
        _type: string,
        callback: (event: MessageEvent<unknown>) => void,
      ) => {
        listener = callback;
      },
      postMessage: (response: LocalSpreadsheetWorkerResponse) =>
        responses.push(response),
      close: vi.fn(),
    });
    await import("../entrypoints/reader.sidepanel/local-spreadsheet.worker");

    listener!({
      data: { type: "load-page", requestId: "bad", startRow: 0, extra: true },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(responses).toHaveLength(1));
    expect(responses[0]).toEqual({
      type: "error",
      requestId: "bad",
      error: "invalid-request",
    });
  });

  it("keeps the runs of a rich-text cell with resolved colors and strikethrough", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Black\nStruck red"], ["Plain"]]),
      "Rich",
    );
    const base = XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      bookSST: true,
    }) as ArrayBuffer;
    const archive = XLSX.CFB.read(Buffer.from(base), { type: "buffer" });
    const index = archive.FullPaths.findIndex((path: string) =>
      path.endsWith("/xl/sharedStrings.xml"),
    );
    const entry = archive.FileIndex[index]!;
    const xml = new TextDecoder()
      .decode(entry.content)
      .replace(
        /<si><t[^>]*>Black\nStruck red<\/t><\/si>/,
        '<si><r><rPr><rFont val="Arial"/><color rgb="FF000000"/></rPr><t xml:space="preserve">Black\n</t></r><r><rPr><rFont val="Arial"/><strike/><color rgb="FFFF0000"/></rPr><t>Struck red</t></r></si>',
      );
    expect(xml).toContain("<strike/>");
    entry.content = Buffer.from(xml);
    const bytes = new Uint8Array(
      XLSX.CFB.write(archive, { type: "buffer", fileType: "zip" }),
    ).buffer as ArrayBuffer;
    const parsed = await parseLocalSpreadsheet(bytes, "rich.xlsx");
    const selected = await parsed.selectSheet(0);
    const cells = selected.page.rows.flatMap((row) => row.cells);
    const rich = cells.find((cell) => cell.anchor === "A1")!;
    expect(rich.runs).toEqual([
      expect.objectContaining({
        text: "Black\n",
        color: "#000000",
        strikethrough: false,
      }),
      expect.objectContaining({
        text: "Struck red",
        color: "#ff0000",
        strikethrough: true,
      }),
    ]);
    expect(cells.find((cell) => cell.anchor === "A2")!.runs).toBeUndefined();
  });
});
