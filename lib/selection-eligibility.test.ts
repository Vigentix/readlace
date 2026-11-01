import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";

import { readEligibleSelection } from "./selection-eligibility";

function selectRange(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectText(text: Text, start = 0, end = text.length) {
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  selectRange(range);
}

beforeEach(() => {
  document.documentElement.innerHTML = "<head></head><body></body>";
  window.getSelection()?.removeAllRanges();
});

it("accepts nonblank page text and a contenteditable=false island", () => {
  const paragraph = document.createElement("p");
  paragraph.textContent = "Page text";
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.innerHTML = '<span contenteditable="false">Safe island</span>';
  document.body.append(paragraph, editor);

  selectText(paragraph.firstChild as Text);
  expect(readEligibleSelection()?.text).toBe("Page text");
  selectText(editor.firstElementChild!.firstChild as Text);
  expect(readEligibleSelection()?.text).toBe("Safe island");
});

it("rejects blank, collapsed and multi-range selections", () => {
  const paragraph = document.createElement("p");
  paragraph.textContent = "   ";
  document.body.append(paragraph);
  selectText(paragraph.firstChild as Text);
  expect(readEligibleSelection()).toBeNull();

  window.getSelection()!.removeAllRanges();
  expect(readEligibleSelection()).toBeNull();
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 2,
  } as Selection);
  expect(readEligibleSelection()).toBeNull();
});

it("rejects input, textarea and contenteditable selections", () => {
  for (const element of [
    document.createElement("input"),
    document.createElement("textarea"),
  ]) {
    document.body.append(element);
    const range = document.createRange();
    range.selectNode(element);
    selectRange(range);
    expect(readEligibleSelection()).toBeNull();
  }

  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.textContent = "Editable";
  document.body.append(editor);
  selectText(editor.firstChild as Text);
  expect(readEligibleSelection()).toBeNull();
});

it("rejects a range crossing editable text between false islands", () => {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.innerHTML =
    '<span contenteditable="false">Safe one</span> editable <span contenteditable="false">Safe two</span>';
  document.body.append(editor);
  const range = document.createRange();
  range.setStart(editor.firstElementChild!.firstChild as Text, 0);
  const last = editor.lastElementChild!.firstChild as Text;
  range.setEnd(last, last.length);
  selectRange(range);

  expect(readEligibleSelection()).toBeNull();
});

it("rejects a selection rooted outside the page document", () => {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const text = document.createTextNode("Shadow text");
  shadow.append(text);
  document.body.append(host);
  const range = {
    startContainer: text,
    endContainer: text,
  } as unknown as Range;
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
  } as unknown as Selection);

  expect(readEligibleSelection()).toBeNull();
});

it("stays a DOM-only bootstrap dependency", () => {
  const source = readFileSync("lib/selection-eligibility.ts", "utf8");
  expect(source).not.toMatch(/from ["'](?:react|react-dom|@base-ui)/);
});

it("pins compact UI size tokens to pixels and keeps the panel at 360px", () => {
  const css = readFileSync("assets/selection.css", "utf8");
  for (const declaration of [
    "--spacing: 4px !important",
    "--text-xs: 12px !important",
    "--text-xs--line-height: 16px !important",
    "--text-sm: 14px !important",
    "--text-sm--line-height: 20px !important",
    "--radius-md: 6px !important",
    "--radius-lg: 8px !important",
  ]) {
    expect(css).toContain(declaration);
  }
  expect(css).toContain("width: min(360px, calc(100vw - 16px))");
});
