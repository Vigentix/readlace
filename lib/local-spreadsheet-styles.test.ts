import { expect, it, vi } from "vitest";
import type { WorkBook } from "xlsx";
import {
  localSpreadsheetCellStyles,
  localSpreadsheetDigitWidth,
  retainLocalSpreadsheetStyleFiles,
} from "./local-spreadsheet-styles";

const STYLES_XML =
  '<styleSheet><fonts count="1"><font><sz val="10"/><name val="Arial"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf fontId="0" fillId="1" borderId="0" xfId="0" applyFill="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" builtinId="0" xfId="0"/></cellStyles></styleSheet>';

function fixture(target = "worksheets/source.xml", external = false) {
  const bytes = (xml: string) => ({ content: new TextEncoder().encode(xml) });
  return {
    SheetNames: ["Test"],
    Sheets: { Test: {} },
    Workbook: { Sheets: [{ name: "Test", id: "rId8" }] },
    Styles: {
      Fonts: [{ bold: 1 }],
      Fills: [{}],
      CellXf: [{ fontId: 0, fillId: 0, borderId: 0 }],
    },
    files: {
      "xl/_rels/workbook.xml.rels": bytes(
        `<Relationships><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"${external ? ' TargetMode="External"' : ""}/></Relationships>`,
      ),
      "xl/worksheets/source.xml": bytes(
        '<worksheet><sheetData><row r="1"><c r="A1" s="0"/><c r="B1" s="0"/><c r="A99" s="0"/></row></sheetData></worksheet>',
      ),
      "xl/styles.xml": bytes(STYLES_XML),
      "xl/vbaProject.bin": { content: new Uint8Array([1, 2, 3]) },
      "xl/media/image.png": { content: new Uint8Array([4, 5, 6]) },
    },
    keys: ["xl/vbaProject.bin", "xl/worksheets/source.xml", "xl/styles.xml"],
  };
}

it("reads only styles within selected content bounds", () => {
  expect([
    ...localSpreadsheetCellStyles(fixture() as WorkBook, 0, 0, 0).keys(),
  ]).toEqual(["A1"]);
});

it.each([
  ["https://example.test/worksheet.xml", false],
  ["../../outside.xml", false],
  ["worksheets/source.xml", true],
])(
  "rejects external and package-escaping relationship targets %s",
  (target, external) => {
    expect(
      localSpreadsheetCellStyles(
        fixture(target, external) as WorkBook,
        0,
        99,
        3,
      ).size,
    ).toBe(0);
  },
);

it("drops VBA and arbitrary raw attachments after extracting safe style files", () => {
  const workbook = fixture();
  retainLocalSpreadsheetStyleFiles(workbook as WorkBook);
  expect(Object.keys(workbook.files)).toEqual([
    "xl/_rels/workbook.xml.rels",
    "xl/worksheets/source.xml",
    "xl/styles.xml",
  ]);
  expect(workbook.keys).toEqual(["xl/worksheets/source.xml", "xl/styles.xml"]);
});

it("does not inspect oversized worksheet XML", () => {
  const workbook = fixture();
  workbook.files["xl/worksheets/source.xml"].content = new Uint8Array(
    20 * 1024 * 1024 + 1,
  );
  expect(localSpreadsheetCellStyles(workbook as WorkBook, 0, 0, 0).size).toBe(
    0,
  );
});

it("releases raw style entries when their aggregate retention budget is exceeded", () => {
  const workbook = fixture();
  workbook.files["xl/worksheets/source.xml"].content = new Uint8Array(
    20 * 1024 * 1024,
  );
  expect(retainLocalSpreadsheetStyleFiles(workbook as WorkBook)).toBe(false);
  expect(workbook.files).toEqual({});
  expect(workbook.keys).toEqual([]);
});

it("bounds the style map for a densely formatted content rectangle", () => {
  const workbook = fixture();
  workbook.files["xl/worksheets/source.xml"].content = new TextEncoder().encode(
    `<worksheet>${Array.from({ length: 10_100 }, (_, index) => `<c r="A${index + 1}" s="0"/>`).join("")}</worksheet>`,
  );
  expect(
    localSpreadsheetCellStyles(workbook as WorkBook, 0, 10_099, 0).size,
  ).toBe(10_001);
});

it("measures the actual Normal style font through its nonzero style XF and font indexes", () => {
  const workbook = {
    ...fixture(),
    Styles: {
      Fonts: [
        { name: "Arial", sz: 10 },
        { name: "Courier New", sz: 12 },
      ],
    },
  };
  workbook.files["xl/styles.xml"].content = new TextEncoder().encode(
    '<styleSheet><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><sz val="12"/><name val="Courier New"/></font></fonts><cellStyleXfs count="2"><xf fontId="0"/><xf fontId="1"/></cellStyleXfs><cellStyles count="1"><cellStyle name="Normal" builtinId="0" xfId="1"/></cellStyles></styleSheet>',
  );
  const context = { font: "", measureText: () => ({ width: 10.2 }) };
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return context;
      }
    },
  );
  try {
    expect(localSpreadsheetDigitWidth(workbook as WorkBook)).toBe(11);
    expect(context.font).toBe('16px "Courier New"');
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  '<cellStyleXfs><xf fontId="0"/></cellStyleXfs><cellStyles><cellStyle builtinId="0" xfId="99"/></cellStyles>',
  '<cellStyleXfs><xf fontId="99"/></cellStyleXfs><cellStyles><cellStyle builtinId="0" xfId="0"/></cellStyles>',
  '<cellStyleXfs><xf fontId="0"/></cellStyleXfs><cellStyles><cellStyle builtinId="0" xfId="-1"/></cellStyles>',
  '<cellStyleXfs><xf fontId="0"/></cellStyleXfs><cellStyles><cellStyle builtinId="0" xfId="0"/><cellStyle builtinId="0" xfId="0"/></cellStyles>',
])(
  "uses the pixel fallback for an explicitly invalid Normal mapping",
  (xml) => {
    const workbook = {
      ...fixture(),
      Styles: { Fonts: [{ name: "Arial", sz: 10 }] },
    };
    workbook.files["xl/styles.xml"].content = new TextEncoder().encode(
      `<styleSheet>${xml}</styleSheet>`,
    );
    const getContext = vi.fn(() => ({
      font: "",
      measureText: () => ({ width: 7.5 }),
    }));
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext = getContext;
      },
    );
    try {
      expect(localSpreadsheetDigitWidth(workbook as WorkBook)).toBeNull();
      expect(getContext).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

function styled(stylesXml: string, cells: string) {
  const workbook = fixture();
  workbook.files["xl/styles.xml"].content = new TextEncoder().encode(
    `<styleSheet>${stylesXml}</styleSheet>`,
  );
  workbook.files["xl/worksheets/source.xml"].content = new TextEncoder().encode(
    `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
  );
  return workbook as WorkBook;
}

const FILL_FONT =
  '<fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><i/><sz val="14"/><name val="Meiryo"/><color rgb="FFFF0000"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill></fills>' +
  '<borders count="1"><border/></borders>';

it("resolves font family, size and flags from the XF font", () => {
  const workbook = styled(
    `${FILL_FONT}<cellStyleXfs count="1"><xf fontId="0"/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="1" borderId="0" xfId="0"/><xf fontId="1" fillId="1" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" builtinId="0" xfId="0"/></cellStyles>`,
    '<c r="A1" s="1"/>',
  );
  const style = localSpreadsheetCellStyles(workbook, 0, 0, 0).get("A1")!;
  expect(style).toMatchObject({
    fontFamily: "Meiryo",
    fontSize: 14,
    bold: true,
    italic: true,
    color: "#ff0000",
    background: "#00ff00",
  });
});

it("keeps wrap, clip(fill), shrink-to-fit and indent as separate attributes", () => {
  const xfs = [
    '<xf fontId="0" fillId="1" xfId="0" applyAlignment="1"><alignment wrapText="1" horizontal="left" indent="2"/></xf>',
    '<xf fontId="0" fillId="1" xfId="0" applyAlignment="1"><alignment shrinkToFit="1"/></xf>',
    '<xf fontId="0" fillId="1" xfId="0" applyAlignment="1"><alignment horizontal="fill"/></xf>',
    '<xf fontId="0" fillId="1" xfId="0" applyAlignment="1"><alignment textRotation="90" readingOrder="2"/></xf>',
  ].join("");
  const workbook = styled(
    `${FILL_FONT}<cellStyleXfs count="1"><xf fontId="0"/></cellStyleXfs><cellXfs count="4">${xfs}</cellXfs>`,
    '<c r="A1" s="0"/><c r="B1" s="1"/><c r="C1" s="2"/><c r="D1" s="3"/>',
  );
  const styles = localSpreadsheetCellStyles(workbook, 0, 0, 3);
  expect(styles.get("A1")).toMatchObject({
    wrapStrategy: "wrap",
    horizontal: "left",
    indent: 2,
    shrinkToFit: false,
  });
  expect(styles.get("B1")).toMatchObject({
    shrinkToFit: true,
    wrapStrategy: "overflow",
  });
  expect(styles.get("C1")).toMatchObject({
    horizontal: "fill",
    wrapStrategy: "clip",
  });
  expect(styles.get("D1")).toMatchObject({ rotation: 90, direction: "rtl" });
});

it("inherits alignment from the parent cell style unless applyAlignment is 0", () => {
  const workbook = styled(
    `${FILL_FONT}<cellStyleXfs count="1"><xf fontId="0"><alignment horizontal="center" wrapText="1"/></xf></cellStyleXfs>` +
      '<cellXfs count="2"><xf fontId="0" fillId="1" xfId="0"/><xf fontId="0" fillId="1" xfId="0" applyAlignment="0"/></cellXfs>',
    '<c r="A1" s="0"/><c r="B1" s="1"/>',
  );
  const styles = localSpreadsheetCellStyles(workbook, 0, 0, 1);
  expect(styles.get("A1")).toMatchObject({
    horizontal: "center",
    wrapStrategy: "wrap",
  });
  expect(styles.get("B1")).toMatchObject({
    horizontal: "general",
    wrapStrategy: "overflow",
  });
});

it("does not retain an unstyled blank cell", () => {
  const workbook = styled(
    `${FILL_FONT}<cellStyleXfs count="1"><xf fontId="0"/></cellStyleXfs><cellXfs count="1"><xf fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>`,
    '<c r="A1" s="0"/>',
  );
  expect(localSpreadsheetCellStyles(workbook, 0, 0, 0).size).toBe(0);
});
