import { describe, expect, it } from "vitest";
import type { WorkspaceSheetTextRun } from "./google-workspace-reader";
import { originalSegments, translatedSegments } from "./spreadsheet-rich-text";

const run = (
  text: string,
  patch: Partial<WorkspaceSheetTextRun> = {},
): WorkspaceSheetTextRun => ({
  text,
  color: null,
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  ...patch,
});

const RED = "#ff0000";

describe("rich text segments", () => {
  it("keeps every source run with its own style", () => {
    const segments = originalSegments([
      run("black\n"),
      run("struck red", { color: RED, strikethrough: true }),
    ]);
    expect(segments.map((segment) => segment.text)).toEqual([
      "black\n",
      "struck red",
    ]);
    expect(segments[1]!.style).toMatchObject({
      color: RED,
      strikethrough: true,
    });
  });

  it("maps translated lines onto the style of the matching source line", () => {
    const segments = translatedSegments(
      [run("説明\n"), run("※赤い行\n", { color: RED }), run("最後")],
      "Mô tả\n※Dòng đỏ\nCuối",
    );
    expect(
      segments.map((segment) => [segment.text, segment.style.color]),
    ).toEqual([
      ["Mô tả\n", null],
      ["※Dòng đỏ\n", RED],
      ["Cuối", null],
    ]);
  });

  it("gives a single-line source its dominant style", () => {
    const segments = translatedSegments(
      [
        run("※以下の表には", { color: RED }),
        run("[設定]", { color: "#4a86e8" }),
      ],
      "※Trong bảng dưới đây [cài đặt]",
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.style.color).toBe(RED);
  });

  it("keeps strikethrough only on the line it covered", () => {
    const segments = translatedSegments(
      [
        run("PDF発行どこいった？\n", { color: RED, strikethrough: true }),
        run("成績管理に移動", { color: RED }),
      ],
      "PDF đâu rồi?\nChuyển sang quản lý điểm",
    );
    expect(segments.map((segment) => segment.style.strikethrough)).toEqual([
      true,
      false,
    ]);
  });

  it("maps proportionally when the line count changes", () => {
    const segments = translatedSegments(
      [
        run("一\n"),
        run("二\n", { color: RED }),
        run("三\n"),
        run("四", { color: RED }),
      ],
      "a b c d",
    );
    expect(segments).toHaveLength(1);
  });

  it("carries a blank line through with the previous style", () => {
    const segments = translatedSegments(
      [run("赤\n\n", { color: RED }), run("黒")],
      "Đỏ\n\nĐen",
    );
    expect(segments.map((segment) => segment.style.color)).toEqual([RED, null]);
  });

  it("keeps a struck first sentence struck on a single line", () => {
    const segments = translatedSegments(
      [
        run("PDF発行どこいった？", { color: RED, strikethrough: true }),
        run("成績管理のHR詳細に移動（白黒タブ切り替え）", { color: RED }),
      ],
      "PDF đã đi đâu? Chuyển sang chi tiết HR của quản lý điểm (chuyển tab đen trắng)",
    );
    expect(
      segments.map((segment) => [
        segment.text.trim().slice(0, 7),
        segment.style.strikethrough,
      ]),
    ).toEqual([
      ["PDF đã ", true],
      ["Chuyển ", false],
    ]);
  });

  it("maps sentences by relative position when the sentence counts differ", () => {
    const segments = translatedSegments(
      [run("赤い文。", { color: RED }), run("黒い文。黒い文。")],
      "Câu đỏ rất dài. Câu đen một. Câu đen hai. Câu đen ba.",
    );
    expect(segments.map((segment) => segment.style.color)).toEqual([RED, null]);
    expect(segments[0]!.text).toContain("Câu đỏ");
  });
});
